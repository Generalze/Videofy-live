/** @author masterzee001 */
/**
 * The producer that makes a protected broadcast have something to protect.
 *
 * `media-origin-worker` knows how to run an encoder. `ProgrammeMediaStore`
 * knows which segments exist and when they may be discarded. Between them was
 * nothing at all -- the encoder was never started by a running service, and
 * the store was never told about a segment -- so the media half of the safety
 * buffer held exactly zero seconds of anything. This is the join.
 *
 * A SEGMENT IS FINISHED WHEN THE PLAYLIST SAYS SO, never when its file
 * appears. FFmpeg creates a segment file and writes into it for the next two
 * seconds; registering on appearance publishes a truncated fragment that a
 * player cannot decode, and does it at exactly the moment the cursor is most
 * likely to release it. The packager appends to its playlist only after
 * closing a segment, so the playlist is the completion signal.
 *
 * PROGRAMME TIME COMES FROM THE MEDIA, NOT THE CLOCK. Each segment's position
 * is the sum of the durations before it, as the packager measured them. A wall
 * clock would drift against the encoder within minutes, and every caption and
 * advert placed against programme time would drift with it.
 *
 * THE INIT SEGMENT IS REGISTERED BEFORE ANY FRAGMENT. Without it nothing that
 * follows decodes, so a manifest that offered fragments first would be a
 * manifest no player could use.
 *
 * AN ENCODER THAT DIES FAILS THE RUN. It does not stop quietly and leave the
 * cursor sitting where it was: a frozen cursor with a healthy-looking status
 * is indistinguishable from a broadcast that is merely quiet, and the audience
 * would keep waiting for material that is never coming.
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import {
  SEGMENT_SECONDS,
  initFileName,
  playlistFileName,
  runOrigin,
  type MediaOriginOptions,
  type OriginRunResult,
} from '@videofy-live/programme-contribution';
import type { ProgrammeMediaStore } from './programme-media-store.js';
import type { ProgrammeTimelineRegistry } from './programme-timeline-registry.js';
import type { ProgrammeEgressAuthority } from './programme-egress.js';
import { initSegmentId } from './programme-egress.js';
import { logger } from './logger.js';

/** A running encoder, seen only through what this file needs of it. */
export interface OriginProcess {
  /** Resolves when the encoder exits, for any reason. */
  readonly exited: Promise<OriginRunResult>;
  stop(): void;
}

export interface OriginSpawner {
  start(options: MediaOriginOptions): OriginProcess;
}

/** The production spawner: the same command the fixture test executes. */
export const FFMPEG_ORIGIN: OriginSpawner = {
  start(options) {
    const controller = new AbortController();
    /*
     * `runOrigin` owns the process and resolves rather than rejects, so a
     * failed encoder is a result to act on and never an unhandled rejection
     * during a live broadcast.
     */
    const exited = runOrigin(options, Number.MAX_SAFE_INTEGER);
    return {
      exited,
      stop: () => controller.abort(),
    };
  },
};

export interface ProgrammeMediaOriginDeps {
  readonly media: ProgrammeMediaStore;
  readonly timelines: ProgrammeTimelineRegistry;
  readonly egress: ProgrammeEgressAuthority;
  /**
   * The one directory runs may write into. Each gets a subdirectory of it.
   *
   * Null is a deployment with no spool, which cannot produce or collect
   * protected media at all. Both entry points refuse rather than inventing a
   * directory: a broadcast written somewhere nobody agreed on is worse than
   * one that never started.
   */
  readonly spoolRoot: string | null;
  readonly spawner?: OriginSpawner;
  /** How often the playlist is re-read. Half a segment, by default. */
  readonly pollMs?: number;
  readonly readPlaylist?: (path: string) => Promise<string | null>;
  readonly segmentSeconds?: number;
}

interface RunningOrigin {
  readonly process: OriginProcess;
  readonly directory: string;
  /** Segment filenames already registered, so a re-read registers nothing twice. */
  readonly seen: Set<string>;
  /** Programme time at the end of the last registered segment. */
  endProgrammeTimeMs: number;
  timer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  /** Which encoder run this is for the broadcast. Restarts advance it. */
  readonly generation: number;
}

/**
 * One entry in a packager's playlist: a duration and the file it describes.
 *
 * Parsed rather than assumed, because the durations are the only record of
 * how long each segment actually is, and they are not all equal -- a forced
 * keyframe lands on a frame boundary, not on an exact multiple of a second.
 */
export interface PlaylistEntry {
  readonly fileName: string;
  readonly durationSeconds: number;
}

export function parsePlaylist(playlist: string): readonly PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  const lines = playlist.split(/\r?\n/u);
  let pending: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(trimmed.slice('#EXTINF:'.length));
      pending = Number.isFinite(value) ? value : null;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (pending !== null) {
      entries.push({ fileName: trimmed, durationSeconds: pending });
      pending = null;
    }
  }
  return entries;
}

export class ProgrammeMediaOrigin {
  private readonly runs = new Map<string, RunningOrigin>();
  /** The highest encoder generation used for each run, across restarts. */
  private readonly generations = new Map<string, number>();
  /** Where the broadcast had reached when its encoder last stopped. */
  private readonly resumeAt = new Map<string, number>();
  private readonly spawner: OriginSpawner;
  private readonly pollMs: number;
  private readonly read: (path: string) => Promise<string | null>;
  private readonly segmentSeconds: number;

  constructor(private readonly deps: ProgrammeMediaOriginDeps) {
    this.spawner = deps.spawner ?? FFMPEG_ORIGIN;
    this.segmentSeconds = deps.segmentSeconds ?? SEGMENT_SECONDS;
    this.pollMs = deps.pollMs ?? Math.max(250, (this.segmentSeconds * 1000) / 2);
    this.read =
      deps.readPlaylist ??
      (async (path: string): Promise<string | null> => {
        try {
          return await readFile(path, 'utf8');
        } catch {
          // Absent until the packager writes its first complete segment. Not
          // an error; there is simply nothing to publish yet.
          return null;
        }
      });
  }

  /**
   * Begin producing media for a run.
   *
   * ONE PER RUN. Starting twice returns the existing producer rather than a
   * second encoder: two writers on one run would produce two segment series
   * with the same names and different content, which is the media-plane
   * version of split brain.
   */
  async start(runId: string, input: string, inputArgs?: readonly string[]): Promise<boolean> {
    if (this.runs.has(runId)) return false;
    if (this.deps.spoolRoot === null) return false;

    const directory = join(this.deps.spoolRoot, runId);
    await mkdir(directory, { recursive: true });

    /*
     * A NEW GENERATION FOR EVERY ENCODER RUN, and the previous one is left
     * exactly where it is.
     *
     * A restarted encoder can legitimately produce different codec
     * configuration, and every fragment still inside the retention window was
     * written against the old initialisation object. Overwriting it stops
     * material the audience has already been offered from decoding -- which
     * arrives as a player dying partway through a broadcast, with nothing to
     * attribute it to.
     */
    const generation = (this.generations.get(runId) ?? -1) + 1;
    this.generations.set(runId, generation);
    const programmeTimeMs = this.resumeAt.get(runId) ?? 0;

    /*
     * REGISTERED BEFORE THE ENCODER IS EVEN STARTED. The path is deterministic
     * and nothing can be published before a segment exists, so noting it early
     * costs nothing and removes the window in which a fragment could be
     * offered without the thing that decodes it.
     */
    this.deps.egress.noteInitSegment(runId, join(directory, initFileName(generation)), generation);

    const options: MediaOriginOptions = {
      runId,
      input,
      outputDirectory: directory,
      segmentSeconds: this.segmentSeconds,
      initGeneration: generation,
      ...(inputArgs === undefined ? {} : { inputArgs }),
    };
    const process = this.spawner.start(options);
    const running: RunningOrigin = {
      process,
      directory,
      seen: new Set<string>(),
      /*
       * A RESTART CONTINUES THE BROADCAST, it does not begin one. Programme
       * time picks up where the previous encoder run left off; resetting it
       * would place the new material on top of the old, and every caption and
       * advert already positioned against those moments would point at the
       * wrong thing.
       */
      endProgrammeTimeMs: programmeTimeMs,
      timer: null,
      stopping: false,
      generation,
    };
    this.runs.set(runId, running);

    running.timer = setInterval(() => {
      void this.collect(runId);
    }, this.pollMs);
    // Nothing about a broadcast should keep a process alive on its own.
    running.timer.unref?.();

    void process.exited.then((result) => {
      void this.finish(runId, result);
    });
    return true;
  }

  /**
   * Collect a run whose encoder is somebody else's.
   *
   * THE CANONICAL PATH. A browser broadcaster publishes once, over WebRTC, and
   * the gateway -- which already holds the decoded frames -- runs the encoder.
   * This service must not spawn a second one: that would be a second encode of
   * the same programme, and a second contribution path that can drift from the
   * first.
   *
   * So this registers the run and polls the same spool, and everything
   * downstream is identical. The segments, the generations, the timeline and
   * the cursor cannot tell which process produced them, which is the point.
   */
  observe(runId: string): boolean {
    if (this.runs.has(runId)) return false;
    if (this.deps.spoolRoot === null) return false;
    const generation = (this.generations.get(runId) ?? -1) + 1;
    this.generations.set(runId, generation);
    const directory = join(this.deps.spoolRoot, runId);

    this.deps.egress.noteInitSegment(runId, join(directory, initFileName(generation)), generation);
    const running: RunningOrigin = {
      // Nothing to stop and nothing to wait for: the process belongs to the
      // gateway, and pretending otherwise would let this service think it
      // could restart somebody else's encoder.
      process: { exited: new Promise<OriginRunResult>(() => undefined), stop: () => undefined },
      directory,
      seen: new Set<string>(),
      endProgrammeTimeMs: this.resumeAt.get(runId) ?? 0,
      timer: null,
      stopping: false,
      generation,
    };
    this.runs.set(runId, running);
    running.timer = setInterval(() => {
      void this.collect(runId);
    }, this.pollMs);
    running.timer.unref?.();
    return true;
  }

  /**
   * Follow the encoder into a new generation it started without us.
   *
   * The gateway rotates its encoder when the source changes shape. This side
   * has to notice, or it keeps reading a playlist nothing is writing to any
   * more and the broadcast quietly stops producing.
   */
  advanceGeneration(runId: string): boolean {
    const running = this.runs.get(runId);
    if (running === undefined) return false;
    const generation = running.generation + 1;
    this.generations.set(runId, generation);
    if (running.timer !== null) clearInterval(running.timer);
    this.runs.delete(runId);
    this.observe(runId);
    return this.runs.get(runId)?.generation === generation;
  }

  /**
   * Read the playlist and register whatever has been completed since last time.
   *
   * Public so a test can drive it deterministically rather than waiting on a
   * timer, and so a caller that has a better completion signal than a poll can
   * use it.
   */
  async collect(runId: string): Promise<number> {
    const running = this.runs.get(runId);
    if (running === undefined) return 0;

    const playlist = await this.read(
      join(running.directory, playlistFileName(running.generation)),
    );
    if (playlist === null) return 0;

    const timeline = this.deps.timelines.timeline(runId);
    let registered = 0;
    for (const entry of parsePlaylist(playlist)) {
      if (running.seen.has(entry.fileName)) continue;

      /*
       * DURABLE BEFORE REFERENCED. Nothing below this line may run until the
       * bytes are on the device.
       *
       * The timeline journal fsyncs; the encoder's segments did not. With the
       * host's ext4 committing every thirty seconds, an unclean power loss
       * could leave a durable timeline entry pointing at media that existed
       * only in page cache and is now gone -- a broadcast whose own record
       * says it published something it cannot produce.
       *
       * An orphan is the acceptable direction to fail in: media on disk that
       * no timeline mentions costs a cleanup, while a reference to media that
       * never landed costs the audience a hole nothing can fill.
       */
      const durable = await this.makeDurable(runId, running, entry.fileName);
      if (!durable) continue;
      running.seen.add(entry.fileName);

      const startMs = running.endProgrammeTimeMs;
      const endMs = startMs + Math.round(entry.durationSeconds * 1000);
      const segment: ProgrammeMediaSegment = {
        runId,
        // Opaque, and derived from the run so one broadcast's ids can never
        // collide with another's.
        /*
         * The generation is in the id, so a restarted encoder's `seg_00000`
         * can never collide with the first one's -- which would hand a viewer
         * different bytes under a name they had already been offered.
         */
        segmentId: `${runId}.g${running.generation}.${String(running.seen.size - 1).padStart(5, '0')}`,
        startProgrammeTimeMs: startMs,
        endProgrammeTimeMs: endMs,
        /*
         * Guaranteed by the command, not inspected here. The encoder forces a
         * keyframe at every boundary, and the real-FFmpeg fixture is what
         * proves it -- probing every segment in production would cost a second
         * decode of the entire broadcast to re-learn a fact that is structural.
         */
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: join(running.directory, entry.fileName),
        bytes: durable.bytes,
        initGeneration: running.generation,
      };

      if (!this.deps.media.accept(segment)) continue;
      running.endProgrammeTimeMs = endMs;
      // Remembered outside the running record, so a restart can continue from
      // here rather than from the beginning of the broadcast.
      this.resumeAt.set(runId, endMs);
      timeline?.append({
        programmeTimeMs: startMs,
        kind: 'media',
        reference: segment.segmentId,
        durationMs: endMs - startMs,
      });
      registered += 1;
    }

    // The cursor only moves once it has been told what exists.
    if (registered > 0) this.deps.timelines.buffer(runId)?.advance();
    return registered;
  }

  /**
   * Force one segment and its initialisation object to the device.
   *
   * Returns the segment's size once it is genuinely durable, or null when it
   * is not yet -- in which case the caller leaves it unseen and tries again on
   * the next poll, because a segment the encoder is still closing is a
   * transient state and not a fault.
   *
   * THE DIRECTORY IS SYNCED TOO. A file's contents being durable says nothing
   * about its NAME being durable: the directory entry lives in the parent, and
   * without that sync a crash can leave bytes on the device that nothing can
   * find. Not every platform allows opening a directory for sync, and where it
   * does not this degrades rather than refusing -- the file sync is the part
   * that matters most, and refusing to broadcast on Windows would be a
   * peculiar way to be safe.
   */
  private async makeDurable(
    runId: string,
    running: RunningOrigin,
    fileName: string,
  ): Promise<{ readonly bytes: number } | null> {
    const path = join(running.directory, fileName);
    const initPath = join(running.directory, initFileName(running.generation));
    try {
      const bytes = await this.syncFile(path);
      /*
       * A ZERO-LENGTH SEGMENT IS NOT A SEGMENT. The packager lists a file when
       * it closes it, but a file can exist and be empty for a moment, and
       * publishing that would hand a player something it cannot decode.
       */
      if (bytes === 0) return null;
      /*
       * The initialisation object must be durable BEFORE anything that needs
       * it. A fragment whose init did not survive is a fragment nothing can
       * decode, which is the same hole by another route.
       */
      await this.syncFile(initPath);
      await this.syncDirectory(running.directory);
      return { bytes };
    } catch (error) {
      /*
       * ABSENT IS NOT BROKEN, and telling them apart matters more than it
       * looks. The packager lists a segment as it closes it, and a file can be
       * named a moment before it is there to open -- so a missing file is a
       * transient state that the next poll resolves. Failing the broadcast for
       * that would stop a perfectly healthy programme every time the encoder
       * was a few milliseconds ahead of the filesystem.
       */
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return null;

      /*
       * Anything else is the device refusing. Failing the broadcast is correct
       * then: a protected programme whose media cannot be made durable cannot
       * keep the promise its cursor is making, and continuing would publish
       * material that may not survive the next minute.
       */
      this.deps.timelines
        .buffer(runId)
        ?.fail('programme media could not be made durable on this device');
      logger.error('Programme media could not be made durable', {
        runId,
        code: code ?? 'unknown',
        message: error instanceof Error ? error.message : 'unknown durability failure',
      });
      return null;
    }
  }

  private async syncFile(path: string): Promise<number> {
    const handle = await open(path, 'r+');
    try {
      // `fdatasync` is enough: the contents and the size are what a reader
      // needs, and the remaining metadata costs another write for nothing.
      await handle.datasync();
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle;
    try {
      handle = await open(directory, 'r');
    } catch {
      // Windows will not open a directory this way. The file sync above is
      // the part that protects the bytes; this protects the name.
      return;
    }
    try {
      await handle.sync();
    } catch {
      // Some filesystems refuse to sync a directory handle. Nothing to do,
      // and nothing gained by failing a broadcast over it.
    } finally {
      await handle.close();
    }
  }

  /** Stop producing for a run, deliberately. */
  async stop(runId: string): Promise<void> {
    const running = this.runs.get(runId);
    if (running === undefined) return;
    running.stopping = true;
    if (running.timer !== null) clearInterval(running.timer);
    running.process.stop();
    // One last read: the segments completed between the last poll and the stop
    // are as much a part of the broadcast as any other.
    await this.collect(runId);
    this.runs.delete(runId);
  }

  /** Whether a producer is running for this broadcast. */
  produces(runId: string): boolean {
    return this.runs.has(runId);
  }

  private async finish(runId: string, result: OriginRunResult): Promise<void> {
    const running = this.runs.get(runId);
    if (running === undefined) return;
    if (running.timer !== null) clearInterval(running.timer);
    await this.collect(runId);
    this.runs.delete(runId);

    if (running.stopping || result.ok) return;
    /*
     * THE ENCODER DIED AND NOBODY ASKED IT TO. The buffer is failed rather
     * than left holding a cursor that will never advance again: an audience
     * waiting on a frozen cursor sees a broadcast that looks live and is not,
     * and every second of that is a second nobody knows is broken.
     */
    this.deps.timelines.buffer(runId)?.fail('the media origin stopped unexpectedly');
    logger.error('Programme media origin exited unexpectedly', {
      runId,
      exitCode: result.exitCode,
      // Bounded and last-lines-only: the useful part of an encoder failure is
      // at the end, and the whole of it is not ours to keep.
      detail: result.stderr.split('\n').slice(-3).join(' | ').slice(0, 500),
    });
  }
}
