/** @author masterzee001 */
/**
 * The gateway's side of protected contribution.
 *
 * One broadcaster publish serves both modes. TRUE LIVE relays the received
 * tracks to listeners; PROTECTED LIVE sends the same received media into the
 * one encoder that produces segments. Nothing is published twice, nothing is
 * encoded twice, and there is only ever one answer to "which feed is the
 * actual programme".
 *
 * IT RUNS HERE BECAUSE THE FRAMES ARE HERE. Raw video at broadcast resolution
 * is enormous compared with anything encoded, and moving it to another service
 * to respect a module boundary would spend most of a core on serialisation
 * before the encoder had done anything. The encoder core is a shared package
 * for exactly this reason: the boundary moves, the frames do not.
 *
 * WHAT IT REFUSES TO DO:
 *
 *   - start for a run that is not protected. A live-delivery broadcast has no
 *     use for segments and encoding them spends a core producing material
 *     nothing reads.
 *   - let a slow encoder reach the media callbacks. Those callbacks also serve
 *     the TRUE LIVE audience, who have nothing to do with the protected one.
 *   - fall back to anything on failure. A contribution that cannot be encoded
 *     stops the protected output; it does not quietly become live.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProgrammeContributionBridge,
  RawContributionEncoder,
  type ContributionAudioFormat,
  type ContributionStatus,
  type ContributionVideoFormat,
} from '@videofy-live/programme-contribution';
import { logger } from './logger.js';

/** How often paced media is handed to the encoder. Well inside a frame. */
const PUMP_INTERVAL_MS = 10;

export interface ContributionHostDeps {
  /** The spool this deployment's media service reads segments from. */
  readonly spoolRoot: string;
  /** The frame rate the encoder is told to expect. */
  readonly frameRate?: number;
  readonly segmentSeconds?: number;
  /** Told when a run's contribution can no longer be encoded. */
  readonly onFailed?: (runId: string, reason: string) => void;
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}

interface HostedRun {
  readonly bridge: ProgrammeContributionBridge;
  /** Null until the first frame has established a shape and a process exists. */
  encoder: RawContributionEncoder | null;
  readonly timer: ReturnType<typeof setInterval>;
  generation: number;
  video: ContributionVideoFormat;
  audio: ContributionAudioFormat;
  restarting: boolean;
}

const DEFAULT_FRAME_RATE = 25;

export class ProgrammeContributionHost {
  private readonly runs = new Map<string, HostedRun>();

  constructor(private readonly deps: ContributionHostDeps) {}

  /** Whether a run is being encoded here. */
  hosts(runId: string): boolean {
    return this.runs.has(runId);
  }

  status(runId: string): ContributionStatus | null {
    return this.runs.get(runId)?.bridge.status() ?? null;
  }

  /**
   * Begin encoding a protected run's contribution.
   *
   * The first frame establishes the shape, so this cannot start until one has
   * arrived -- which is why it is driven by `pushVideo` rather than by a
   * lifecycle event. Starting an encoder against a guessed resolution and
   * correcting later would throw away the opening seconds of the programme.
   */
  private async begin(
    runId: string,
    video: ContributionVideoFormat,
    audio: ContributionAudioFormat,
    generation: number,
  ): Promise<RawContributionEncoder> {
    const directory = join(this.deps.spoolRoot, runId);
    await mkdir(directory, { recursive: true });
    const encoder = new RawContributionEncoder({
      runId,
      outputDirectory: directory,
      video,
      audio,
      initGeneration: generation,
      ...(this.deps.segmentSeconds === undefined
        ? {}
        : { segmentSeconds: this.deps.segmentSeconds }),
      onExit: (code, stderr) => {
        const existing = this.runs.get(runId);
        if (existing?.restarting === true) return;
        /*
         * The encoder went away and nobody asked it to. Protected output
         * stops: a frozen cursor with a healthy status is indistinguishable
         * from a programme that happens to be quiet.
         */
        existing?.bridge.fail('the protected encoder exited');
        this.deps.onFailed?.(runId, 'the protected encoder exited');
        logger.error('Protected contribution encoder exited', {
          runId,
          exitCode: code,
          detail: stderr.split('\n').slice(-3).join(' | ').slice(0, 500),
        });
      },
      ...(this.deps.onProblem === undefined ? {} : { onProblem: this.deps.onProblem }),
    });
    await encoder.start();
    return encoder;
  }

  /**
   * One decoded video frame from the broadcaster, on its way to the encoder.
   *
   * Called from the gateway's media callback, so it does the least possible.
   * Everything expensive -- starting a process, making a directory -- happens
   * once, off this path, on the first frame.
   */
  pushVideo(
    runId: string,
    frame: { readonly width?: number; readonly height?: number; readonly data?: unknown },
  ): void {
    const data = frame.data;
    if (!(data instanceof Uint8Array)) return;
    const width = frame.width ?? 0;
    const height = frame.height ?? 0;
    if (width <= 0 || height <= 0) return;

    const video: ContributionVideoFormat = {
      width,
      height,
      frameRate: this.deps.frameRate ?? DEFAULT_FRAME_RATE,
    };
    const hosted = this.runs.get(runId);
    if (hosted === undefined) {
      this.open(runId, video);
      return;
    }
    hosted.bridge.pushVideo(data, video);
    if (hosted.bridge.status().state === 'format-changed') void this.rotate(runId, video);
  }

  /** One block of decoded audio from the broadcaster. */
  pushAudio(
    runId: string,
    data: {
      readonly samples?: Int16Array | Float32Array;
      readonly sampleRate?: number;
      readonly channelCount?: number;
    },
  ): void {
    const samples = data.samples;
    if (!(samples instanceof Int16Array)) return;
    const hosted = this.runs.get(runId);
    if (hosted === undefined) return;
    hosted.bridge.pushAudio(samples, {
      sampleRate: data.sampleRate ?? hosted.audio.sampleRate,
      channels: data.channelCount ?? hosted.audio.channels,
    });
  }

  /**
   * The contribution has gone. The programme has not.
   *
   * The clock holds its position and the encoder keeps running, so the
   * broadcast resumes where it stopped when the broadcaster returns. Tearing
   * the encoder down on every network hiccup would produce a new generation,
   * a new initialisation object and a discontinuity for something that lasted
   * two seconds.
   */
  interrupt(runId: string, reason: string): void {
    this.runs.get(runId)?.bridge.interrupt(reason);
  }

  /** The contribution is back. Same run, same clock, same encoder. */
  resume(runId: string): void {
    this.runs.get(runId)?.bridge.begin();
  }

  /** The broadcast is over. */
  async release(runId: string): Promise<void> {
    const hosted = this.runs.get(runId);
    if (hosted === undefined) return;
    this.runs.delete(runId);
    clearInterval(hosted.timer);
    await hosted.encoder?.stop().catch(() => undefined);
  }

  private open(runId: string, video: ContributionVideoFormat): void {
    const audio: ContributionAudioFormat = { sampleRate: 48_000, channels: 1 };
    const bridge = new ProgrammeContributionBridge(
      // Replaced the moment the encoder exists; until then everything is held
      // in the bridge's bounded queues rather than written into nothing.
      { writeVideo: () => undefined, writeAudio: () => undefined, ready: false },
      {
        ...(this.deps.onProblem === undefined ? {} : { onProblem: this.deps.onProblem }),
      },
    );
    const timer = setInterval(() => bridge.pump(), PUMP_INTERVAL_MS);
    timer.unref?.();

    this.runs.set(runId, {
      bridge,
      encoder: null,
      timer,
      generation: 0,
      video,
      audio,
      restarting: false,
    });

    void this.begin(runId, video, audio, 0)
      .then((encoder) => {
        const hosted = this.runs.get(runId);
        if (hosted === undefined) {
          // The run ended while the encoder was starting. Nothing may be left
          // holding a pipe open for a broadcast that is over.
          void encoder.stop();
          return;
        }
        hosted.encoder = encoder;
        bridge.retarget(encoder);
        bridge.begin();
        logger.info('Protected contribution encoder started', {
          runId,
          width: video.width,
          height: video.height,
        });
      })
      .catch((error: unknown) => {
        bridge.fail('the protected encoder could not be started');
        this.deps.onFailed?.(runId, 'the protected encoder could not be started');
        logger.error('Protected contribution encoder could not start', {
          runId,
          message: error instanceof Error ? error.message : 'unknown failure',
        });
      });
  }

  /**
   * The source changed shape. Close this generation and open the next.
   *
   * The run, the programme time and the previous initialisation object all
   * survive: a viewer whose retained fragments were written against the old
   * one must still be able to decode them.
   */
  private async rotate(runId: string, video: ContributionVideoFormat): Promise<void> {
    const hosted = this.runs.get(runId);
    if (hosted === undefined || hosted.restarting) return;
    hosted.restarting = true;
    try {
      await hosted.encoder?.stop().catch(() => undefined);
      const generation = hosted.generation + 1;
      const encoder = await this.begin(runId, video, hosted.audio, generation);
      hosted.generation = generation;
      hosted.encoder = encoder;
      hosted.video = video;
      hosted.bridge.retarget(encoder);
      hosted.bridge.restartGeneration();
      logger.info('Protected contribution encoder rotated for a format change', {
        runId,
        generation,
        width: video.width,
        height: video.height,
      });
    } catch (error) {
      hosted.bridge.fail('the protected encoder could not be restarted');
      this.deps.onFailed?.(runId, 'the protected encoder could not be restarted');
      logger.error('Protected contribution encoder could not be rotated', {
        runId,
        message: error instanceof Error ? error.message : 'unknown failure',
      });
    } finally {
      hosted.restarting = false;
    }
  }
}
