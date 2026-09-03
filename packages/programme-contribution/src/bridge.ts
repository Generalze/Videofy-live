/** @author masterzee001 */
/**
 * The broadcaster's own media, on its way to the protected encoder.
 *
 * The gateway already terminates the broadcaster's WebRTC peer and already has
 * the decoded audio and video. Sending that back out as RTMP so it can be read
 * in again would encode the programme twice, add a network hop between two
 * parts of one server, and -- worst -- create a second contribution path that
 * can drift from the first. There would then be an ugly question with no good
 * answer: which feed is the actual programme?
 *
 * So this is the bridge, and it does three things that are easy to get wrong.
 *
 * IT KEEPS ONE CLOCK. Both media derive their position from a single
 * run-relative reading. Two callbacks each sampling the wall clock agree for a
 * while and then separate, permanently, and the symptom is lips that stop
 * matching words some minutes in.
 *
 * IT PACES RATHER THAN FORWARDS. FFmpeg reading raw video derives every
 * timestamp from the frame COUNT, so handing it whatever arrives produces a
 * broadcast whose clock is the network's. Frames are repeated to fill a gap
 * and dropped to absorb a burst, against the clock rather than against each
 * other.
 *
 * IT PUSHES BACK. The queues are bounded. A slow encoder must never block the
 * gateway's media callbacks -- that would degrade the TRUE LIVE audience, who
 * have nothing to do with the protected one -- and it must never be hidden by
 * dropping enough frames to look healthy. Overflow is a state somebody is told
 * about.
 */

import {
  ContributionClock,
  framesDueBy,
  samplesDueBy,
  type MonotonicSource,
} from './clock.js';

export interface ContributionVideoFormat {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export interface ContributionAudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * Where paced media goes. Implemented by whatever is feeding the encoder.
 *
 * Deliberately not a Node stream: the bridge must be testable without a
 * process, and the only thing it needs of its destination is somewhere to put
 * bytes and a way to know it is falling behind.
 */
export interface ContributionOutput {
  /** One I420 video frame, exactly the declared size. */
  writeVideo(frame: Uint8Array): void;
  /** Interleaved signed 16-bit samples at the declared rate. */
  writeAudio(samples: Int16Array): void;
  /** True while the destination is accepting without buffering unboundedly. */
  readonly ready: boolean;
}

export type ContributionState =
  /** No contribution has arrived yet. */
  | 'idle'
  /** Media is arriving and being paced into the encoder. */
  | 'running'
  /** The source has gone. The clock is held; the run is not over. */
  | 'interrupted'
  /** Arriving faster than the encoder consumes, and the queues are full. */
  | 'overloaded'
  /** The input's shape changed; the encoder generation has to be replaced. */
  | 'format-changed'
  /** Unrecoverable. */
  | 'failed';

export interface ContributionStatus {
  readonly state: ContributionState;
  readonly videoQueueDepth: number;
  readonly audioQueueDepth: number;
  /** How far into the broadcast the contribution has reached. */
  readonly elapsedMs: number;
  /** Frames repeated to fill a gap, and frames dropped to absorb a burst. */
  readonly repeatedFrames: number;
  readonly droppedFrames: number;
  /** Samples of silence inserted where audio did not arrive. */
  readonly paddedSamples: number;
  readonly detail: string | null;
}

export interface ContributionBridgeOptions {
  /**
   * How many frames may wait for the encoder.
   *
   * Small on purpose. A deep queue does not fix a slow encoder, it hides one
   * -- and it hides it by adding latency to a broadcast whose whole point is a
   * measured delay.
   */
  readonly maxVideoFrames?: number;
  readonly maxAudioChunks?: number;
  readonly monotonic?: MonotonicSource;
  /** Told when the input's shape changes and a new generation is needed. */
  readonly onFormatChange?: (video: ContributionVideoFormat) => void;
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_MAX_VIDEO_FRAMES = 30;
const DEFAULT_MAX_AUDIO_CHUNKS = 200;

export class ProgrammeContributionBridge {
  private readonly clock: ContributionClock;
  private readonly videoQueue: Uint8Array[] = [];
  private readonly audioQueue: Int16Array[] = [];
  private videoFormat: ContributionVideoFormat | null = null;
  private audioFormat: ContributionAudioFormat | null = null;
  private lastVideoFrame: Uint8Array | null = null;
  private framesWritten = 0;
  private samplesWritten = 0;
  /**
   * Where the CURRENT encoder generation began, in run time.
   *
   * The encoder's own output always starts at its own zero, and the collector
   * downstream offsets it back into programme time. So the pacing question is
   * "how much is due since THIS generation began", not since the broadcast
   * did -- asking the second one after a restart makes the bridge try to
   * replay the whole programme into a fresh encoder in one tick.
   */
  private generationStartedAtMs = 0;
  private repeatedFrames = 0;
  private droppedFrames = 0;
  private paddedSamples = 0;
  private state: ContributionState = 'idle';
  private detail: string | null = null;

  constructor(
    private readonly output: ContributionOutput,
    private readonly options: ContributionBridgeOptions = {},
  ) {
    this.clock = new ContributionClock(options.monotonic);
  }

  status(): ContributionStatus {
    return {
      state: this.state,
      videoQueueDepth: this.videoQueue.length,
      audioQueueDepth: this.audioQueue.length,
      elapsedMs: this.clock.elapsedMs(),
      repeatedFrames: this.repeatedFrames,
      droppedFrames: this.droppedFrames,
      paddedSamples: this.paddedSamples,
      detail: this.detail,
    };
  }

  /** The established video shape, once one frame has arrived. */
  get establishedVideoFormat(): ContributionVideoFormat | null {
    return this.videoFormat;
  }

  /**
   * A contribution has begun, or come back.
   *
   * The clock resumes rather than restarts: a WebRTC reconnect replaces the
   * transport and not the programme, so the returning media continues from
   * where the last frame left off.
   */
  begin(): void {
    if (this.state === 'failed') return;
    this.clock.start();
    this.state = 'running';
    this.detail = null;
  }

  /** The source has gone. Not a failure, and not the end of the run. */
  interrupt(reason: string): void {
    if (this.state === 'failed') return;
    this.clock.stop();
    this.state = 'interrupted';
    this.detail = reason;
  }

  fail(reason: string): void {
    this.clock.stop();
    this.state = 'failed';
    this.detail = reason;
  }

  /**
   * One decoded video frame from the broadcaster.
   *
   * Called straight from a WebRTC sink callback, so it does the least possible:
   * a shape check, a bounded push, and nothing that can block. Anything slow
   * here is slow on the gateway's media thread, which the TRUE LIVE audience
   * is also using.
   */
  pushVideo(frame: Uint8Array, format: ContributionVideoFormat): void {
    if (this.state === 'failed') return;
    if (this.videoFormat === null) {
      this.videoFormat = format;
    } else if (
      format.width !== this.videoFormat.width ||
      format.height !== this.videoFormat.height
    ) {
      /*
       * A REAL SOURCE CHANGES SHAPE. A camera rotates, a screen share starts,
       * bandwidth adaptation steps the resolution down. The encoder cannot be
       * fed two sizes on one raw input, so this is reported and the caller
       * closes the generation and opens another -- keeping the run, the
       * programme time and the previous initialisation object.
       */
      this.state = 'format-changed';
      this.detail = `the source changed from ${this.videoFormat.width}x${this.videoFormat.height} to ${format.width}x${format.height}`;
      this.options.onFormatChange?.(format);
      return;
    }

    const limit = this.options.maxVideoFrames ?? DEFAULT_MAX_VIDEO_FRAMES;
    if (this.videoQueue.length >= limit) {
      /*
       * OVERFLOW IS A STATE, NOT A SILENT DROP. Discarding enough frames to
       * keep up would make an encoder that cannot cope look like a healthy
       * broadcast, and the audience would be the first to know.
       */
      this.droppedFrames += 1;
      this.state = 'overloaded';
      this.detail = 'the encoder is not consuming video as fast as it arrives';
      this.options.onProblem?.('programme contribution video queue is full', {
        droppedFrames: this.droppedFrames,
      });
      return;
    }
    this.videoQueue.push(frame);
  }

  /** One block of decoded audio samples from the broadcaster. */
  pushAudio(samples: Int16Array, format: ContributionAudioFormat): void {
    if (this.state === 'failed') return;
    this.audioFormat ??= format;
    const limit = this.options.maxAudioChunks ?? DEFAULT_MAX_AUDIO_CHUNKS;
    if (this.audioQueue.length >= limit) {
      this.state = 'overloaded';
      this.detail = 'the encoder is not consuming audio as fast as it arrives';
      this.options.onProblem?.('programme contribution audio queue is full', {
        depth: this.audioQueue.length,
      });
      return;
    }
    this.audioQueue.push(samples);
  }

  /**
   * Hand the encoder exactly as much as the clock says is due.
   *
   * Driven by a timer rather than by arrival, because the encoder's input rate
   * must be the programme's clock and not the network's. Everything about
   * keeping audio and video together is in here, and all of it comes from one
   * reading of one clock.
   */
  pump(): void {
    if (this.state !== 'running' && this.state !== 'overloaded') return;
    if (!this.output.ready) return;
    // One reading, both media. Two readings is how they separate.
    const sinceGenerationMs = this.clock.elapsedMs() - this.generationStartedAtMs;
    this.pumpVideo(sinceGenerationMs);
    this.pumpAudio(sinceGenerationMs);
    if (this.state === 'overloaded' && this.videoQueue.length === 0 && this.audioQueue.length === 0) {
      this.state = 'running';
      this.detail = null;
    }
  }

  private pumpVideo(elapsedMs: number): void {
    const format = this.videoFormat;
    if (format === null) return;
    const due = framesDueBy(elapsedMs, format.frameRate);

    while (this.framesWritten < due) {
      const next = this.videoQueue.shift();
      if (next !== undefined) {
        this.lastVideoFrame = next;
        this.output.writeVideo(next);
      } else if (this.lastVideoFrame !== null) {
        /*
         * NOTHING ARRIVED AND THE CLOCK MOVED. The last frame is repeated
         * rather than the position left short: a frame short is a frame of
         * drift, and the encoder derives its timestamps from the count, so it
         * never comes back. A freeze is visible and honest; drift is neither.
         */
        this.repeatedFrames += 1;
        this.output.writeVideo(this.lastVideoFrame);
      } else {
        // Nothing has ever arrived. There is nothing to repeat, and inventing
        // a frame would be inventing programme content.
        return;
      }
      this.framesWritten += 1;
    }

    /*
     * A BACKLOG IS DROPPED, NOT PLAYED OUT. Frames that arrived faster than
     * the clock are behind time by the moment they would be written, and
     * writing them would push every later frame further behind.
     */
    const backlog = this.options.maxVideoFrames ?? DEFAULT_MAX_VIDEO_FRAMES;
    while (this.videoQueue.length > backlog / 2) {
      this.videoQueue.shift();
      this.droppedFrames += 1;
    }
  }

  private pumpAudio(elapsedMs: number): void {
    const format = this.audioFormat;
    if (format === null) return;
    const due = samplesDueBy(elapsedMs, format.sampleRate) * format.channels;

    while (this.samplesWritten < due) {
      const next = this.audioQueue.shift();
      if (next !== undefined) {
        this.output.writeAudio(next);
        this.samplesWritten += next.length;
        continue;
      }
      /*
       * SILENCE RATHER THAN A GAP. The encoder's audio position is the sample
       * count; leaving it short moves audio earlier than video for the rest of
       * the broadcast. A moment of silence is what actually happened.
       */
      const missing = due - this.samplesWritten;
      if (missing <= 0) break;
      const padding = new Int16Array(Math.min(missing, format.sampleRate * format.channels));
      this.output.writeAudio(padding);
      this.samplesWritten += padding.length;
      this.paddedSamples += padding.length;
      break;
    }
  }

  /**
   * Begin a new encoder generation after a format change.
   *
   * The counters that belong to the ENCODER reset; the clock does not. The
   * broadcast continues at the programme time it had reached, which is what
   * keeps captions and adverts pointing at the right moments.
   */
  restartGeneration(): void {
    // The encoder's counters reset because its output restarts at its own
    // zero. The CLOCK does not, which is what keeps the broadcast continuous.
    this.generationStartedAtMs = this.clock.elapsedMs();
    this.framesWritten = 0;
    this.samplesWritten = 0;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.lastVideoFrame = null;
    this.videoFormat = null;
    this.audioFormat = null;
    if (this.state === 'format-changed') {
      this.state = 'running';
      this.detail = null;
    }
  }
}
