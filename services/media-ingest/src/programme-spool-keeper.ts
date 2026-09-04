/** @author masterzee001 */
/**
 * The thing that actually runs retention, and watches the volume while it does.
 *
 * `ProgrammeMediaStore.prune` has existed, been tested, and been called by
 * NOTHING outside its own tests. Combined with the sink every deployment
 * passed -- the one whose `discard` returns true without touching a file --
 * the retention policy was complete on both halves and connected on neither:
 * the window never shrank in memory, and no byte was ever removed from the
 * volume. A long broadcast filled the disk while every status stayed green.
 *
 * WHAT THIS MUST NEVER DO IS SHORTEN THE DELAY. Reducing the safety buffer is
 * the one action that would reliably free space, and it converts a storage
 * problem into a broadcast that goes to air closer to live than the people
 * relying on it were told. When the volume cannot hold the promise, the
 * promise fails loudly and the delay stays where it is.
 */

import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { BufferStatus } from '@videofy-live/programme-timeline';
import type { ProgrammeMediaStore } from './programme-media-store.js';
import { requiredSpoolBytes, type SpoolCapacityInput } from './programme-spool-readiness.js';
import { sweepInitGenerations, sweepOrphans } from './programme-spool-retention.js';
import { segmentFileName } from './programme-media-recovery.js';

/** What the volume looks like right now, and how long that can last. */
export interface SpoolPressure {
  readonly availableBytes: number | null;
  readonly retainedBytes: number;
  readonly requiredBytes: number;
  /** Writes or deletions that failed since the last sample. */
  readonly writeFailures: number;
  /**
   * How long until the volume can no longer hold the promise, at the rate it
   * is currently being consumed. Null when nothing is being consumed, or when
   * there is not yet a second sample to measure against.
   */
  readonly secondsToExhaustion: number | null;
  readonly state: 'ok' | 'degraded' | 'failed';
  readonly detail: string | null;
}

/**
 * How much warning is worth acting on.
 *
 * An hour, because degrading a protected broadcast is an operational event
 * somebody has to respond to, and a warning that arrives ninety seconds before
 * the disk fills is the same as no warning.
 */
const EXHAUSTION_HORIZON_SECONDS = 3600;

/**
 * The margin between "enough" and "comfortable".
 *
 * Below one and a half times the requirement the deployment can still hold
 * what it promised and cannot absorb a surprise -- a second run, a busier
 * scene, an encoder restart. That is degraded, not failed.
 */
const COMFORT_FACTOR = 1.5;

export interface SpoolKeeperDeps {
  readonly spoolRoot: string;
  readonly media: ProgrammeMediaStore;
  readonly timelines: {
    trackedRuns(): readonly string[];
    status(runId: string): BufferStatus | null;
  };
  readonly capacity: SpoolCapacityInput;
  /** Injected in tests; `statfs` on a real volume otherwise. */
  readonly freeBytes?: (directory: string) => Promise<number | null>;
  readonly now?: () => number;
  readonly onPressure?: (pressure: SpoolPressure) => void;
  readonly log?: {
    info(message: string, detail?: Record<string, unknown>): void;
    warn(message: string, detail?: Record<string, unknown>): void;
    error(message: string, detail?: Record<string, unknown>): void;
  };
}

export class ProgrammeSpoolKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private writeFailures = 0;
  /** Runs whose authoritative state recovery has rebuilt. */
  private readonly recovered = new Set<string>();
  private lastSample: { readonly atMs: number; readonly availableBytes: number } | null = null;
  private sweeping = false;

  constructor(private readonly deps: SpoolKeeperDeps) {}

  /**
   * A run whose retained window is authoritative again.
   *
   * The orphan sweep will not touch a run's directory until this has been
   * said. Before recovery, "not referenced" only means "not yet read", and a
   * sweep on that basis deletes the whole retained window of a broadcast that
   * is about to need it.
   */
  noteRecovered(runId: string): void {
    this.recovered.add(runId);
  }

  /** A write or deletion the volume refused. Counted, not thrown. */
  noteWriteFailure(): void {
    this.writeFailures += 1;
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass: let go of what retention allows, remove what nothing needs, and
   * then look at what the volume has left.
   *
   * Retention runs BEFORE the measurement on purpose. Measuring first would
   * report the pressure of material this pass was about to release, and could
   * degrade a healthy broadcast over space that was already free.
   */
  async sweep(): Promise<SpoolPressure> {
    if (this.sweeping) return this.pressureFrom(this.lastSample?.availableBytes ?? null, 0);
    this.sweeping = true;
    try {
      let retainedBytes = 0;
      for (const runId of this.deps.timelines.trackedRuns()) {
        retainedBytes += await this.sweepRun(runId);
      }
      const availableBytes = await this.readFreeBytes();
      const pressure = this.pressureFrom(availableBytes, retainedBytes);
      this.deps.onPressure?.(pressure);
      if (pressure.state !== 'ok') {
        this.deps.log?.warn('Programme spool under pressure', {
          state: pressure.state,
          secondsToExhaustion: pressure.secondsToExhaustion,
          detail: pressure.detail,
        });
      }
      return pressure;
    } finally {
      this.sweeping = false;
    }
  }

  /** Returns what the run still holds, in bytes. */
  private async sweepRun(runId: string): Promise<number> {
    const status = this.deps.timelines.status(runId);
    if (status === null) return 0;
    const directory = join(this.deps.spoolRoot, runId);

    const discarded = await this.deps.media.prune(
      runId,
      status.cursor.publicOutputTimeMs,
      status.configuredDelayMs,
    );

    const retainedSegmentIds = this.deps.media.retainedSegmentIds(runId);
    if (discarded > 0) {
      /*
       * Only after the fragments are gone. An initialisation object removed
       * while a fragment still names it destroys the retained window instead
       * of trimming it, so the reference set is read AFTER the prune and the
       * sweep is driven by it rather than by age.
       */
      const generations = await sweepInitGenerations({
        directory,
        retainedSegmentIds,
        onProblem: (message, detail) => {
          this.writeFailures += 1;
          this.deps.log?.warn(message, detail);
        },
      });
      if (generations.removed.length > 0) {
        this.deps.log?.info('Retired initialisation objects nothing references', {
          runId,
          removed: generations.removed,
          kept: generations.kept,
        });
      }
    }

    if (this.recovered.has(runId)) {
      const referenced = retainedSegmentIds
        .map((segmentId) => segmentFileName(segmentId))
        .filter((name): name is string => name !== null);
      const orphans = await sweepOrphans({
        directory,
        referencedFileNames: referenced,
        recovered: true,
        ...(this.deps.now === undefined ? {} : { now: this.deps.now() }),
        onProblem: (message, detail) => {
          this.writeFailures += 1;
          this.deps.log?.warn(message, detail);
        },
      });
      if (orphans.removed.length > 0) {
        this.deps.log?.info('Removed spool files no timeline committed', {
          runId,
          removed: orphans.removed.length,
          tooRecent: orphans.tooRecent,
        });
      }
    }

    return this.deps.media.retainedBytes(runId);
  }

  private async readFreeBytes(): Promise<number | null> {
    if (this.deps.freeBytes !== undefined) return this.deps.freeBytes(this.deps.spoolRoot);
    try {
      const stats = await statfs(this.deps.spoolRoot);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }

  private pressureFrom(availableBytes: number | null, retainedBytes: number): SpoolPressure {
    const requiredBytes = requiredSpoolBytes(this.deps.capacity);
    const writeFailures = this.writeFailures;
    this.writeFailures = 0;
    const nowMs = this.deps.now?.() ?? Date.now();

    let secondsToExhaustion: number | null = null;
    if (availableBytes !== null) {
      const previous = this.lastSample;
      if (previous !== null && nowMs > previous.atMs) {
        const consumedBytes = previous.availableBytes - availableBytes;
        const elapsedSeconds = (nowMs - previous.atMs) / 1000;
        const bytesPerSecond = consumedBytes / elapsedSeconds;
        /*
         * Only a volume that is actually filling has a horizon. A steady or
         * shrinking footprint would otherwise divide by roughly zero and
         * produce an alarming number from a healthy broadcast.
         */
        if (bytesPerSecond > 0) {
          secondsToExhaustion = Math.max(0, (availableBytes - requiredBytes) / bytesPerSecond);
        }
      }
      this.lastSample = { atMs: nowMs, availableBytes };
    }

    let state: SpoolPressure['state'] = 'ok';
    let detail: string | null = null;

    if (availableBytes === null) {
      /*
       * Not knowing is not the same as being fine. A volume whose free space
       * cannot be read is one this deployment cannot promise a buffer on.
       */
      state = 'degraded';
      detail = 'free space on the spool cannot be read, so the safety buffer cannot be guaranteed';
    } else if (availableBytes < requiredBytes) {
      state = 'failed';
      detail = `the spool has ${Math.round(availableBytes / 1_048_576)} MB free and the protected window needs ${Math.round(requiredBytes / 1_048_576)} MB`;
    } else if (secondsToExhaustion !== null && secondsToExhaustion < EXHAUSTION_HORIZON_SECONDS) {
      /*
       * PREDICTED, NOT AWAITED. Waiting for ENOSPC means discovering the
       * problem as a failed write in the middle of a broadcast, when there is
       * nothing left to do about it.
       */
      state = 'degraded';
      detail = `at the current rate the spool cannot hold the protected window in about ${Math.round(secondsToExhaustion / 60)} minutes`;
    } else if (availableBytes < requiredBytes * COMFORT_FACTOR) {
      state = 'degraded';
      detail = 'the spool can hold the protected window and cannot absorb another run';
    } else if (writeFailures > 0) {
      state = 'degraded';
      detail = 'the spool refused a write or a deletion since the last check';
    }

    return {
      availableBytes,
      retainedBytes,
      requiredBytes,
      writeFailures,
      secondsToExhaustion,
      state,
      detail,
    };
  }
}
