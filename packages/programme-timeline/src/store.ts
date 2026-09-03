/** @author masterzee001 */
/**
 * Where a broadcast's account of itself survives the process running it.
 *
 * A safety buffer held only in one process's memory is a promise with a
 * footnote. Restart the service mid-programme and the timeline is gone, the
 * output cursor resets, and an audience forty-five seconds into a protected
 * broadcast either jumps to live or stops -- neither of which the operator was
 * told could happen. Production needs the account to outlive the process.
 *
 * WHAT IS STORED IS METADATA, NEVER MEDIA. Timeline events carry references --
 * a segment id, a decision id -- because a store that held audio would be a
 * media store with an ordering problem, and their retention rules are nothing
 * alike: a broadcast's structure is small and worth keeping, its audio is
 * enormous and belongs in a spool.
 *
 * RECOVERY IS REPLAY, NOT RECONSTRUCTION. On restart a run is restored by
 * reading back what was written, in order, and putting the cursor where it
 * was. Nothing is inferred about what might have been meant.
 */

import type { ProgrammeTimelineEvent } from './index.js';

/** What a store knows about one run, enough to rebuild it exactly. */
export interface PersistedRun {
  readonly runId: string;
  readonly events: readonly ProgrammeTimelineEvent[];
  /**
   * The furthest programme time already released to the audience.
   *
   * Minus one when nothing has been released, which is not the same as zero:
   * an event at programme time zero is still owed to them.
   */
  readonly releasedThroughMs: number;
}

export interface TimelineStoreHealth {
  readonly writable: boolean;
  /** Why it is not writable, when it is not. Null when healthy. */
  readonly reason: string | null;
}

/**
 * The durable side of a programme timeline.
 *
 * Every method is bounded and total: a store that hangs holds up a live
 * broadcast, and one that throws where the caller cannot act has only moved
 * the failure. `append` returning false is how a caller learns the buffer's
 * promise can no longer be kept, which is the moment to fail closed.
 */
export interface ProgrammeTimelineStore {
  /** Persist one event. False means it was NOT stored and the promise is broken. */
  append(event: ProgrammeTimelineEvent): Promise<boolean>;
  /** Record how far the audience has been allowed to reach. */
  saveCursor(runId: string, releasedThroughMs: number): Promise<boolean>;
  /** Everything known about a run, or null if this store has never seen it. */
  load(runId: string): Promise<PersistedRun | null>;
  /** Forget a finished broadcast. */
  release(runId: string): Promise<void>;
  /** Can this store still be written to? Checked before a promise is made. */
  health(): Promise<TimelineStoreHealth>;
}

/**
 * A store that keeps everything in memory.
 *
 * For development and for every test that is not about durability. Honest
 * about what it is: `health` reports writable, because it genuinely is, and a
 * caller that needs to survive a restart must choose a different one.
 */
export class InMemoryTimelineStore implements ProgrammeTimelineStore {
  private readonly runs = new Map<string, { events: ProgrammeTimelineEvent[]; cursor: number }>();

  private run(runId: string): { events: ProgrammeTimelineEvent[]; cursor: number } {
    let run = this.runs.get(runId);
    if (run === undefined) {
      run = { events: [], cursor: -1 };
      this.runs.set(runId, run);
    }
    return run;
  }

  async append(event: ProgrammeTimelineEvent): Promise<boolean> {
    this.run(event.runId).events.push(event);
    return true;
  }

  async saveCursor(runId: string, releasedThroughMs: number): Promise<boolean> {
    this.run(runId).cursor = releasedThroughMs;
    return true;
  }

  async load(runId: string): Promise<PersistedRun | null> {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    return { runId, events: [...run.events], releasedThroughMs: run.cursor };
  }

  async release(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async health(): Promise<TimelineStoreHealth> {
    return { writable: true, reason: null };
  }
}

/**
 * A store that cannot store anything, and says so.
 *
 * What a deployment gets when durability is not configured. It reports
 * `writable: false`, so a programme asked to promise a safety delay learns
 * BEFORE going on air that the promise cannot survive a restart, rather than
 * discovering it during one.
 */
export const NO_TIMELINE_STORE: ProgrammeTimelineStore = {
  async append() {
    return false;
  },
  async saveCursor() {
    return false;
  },
  async load() {
    return null;
  },
  async release() {
    /* nothing was stored */
  },
  async health() {
    return { writable: false, reason: 'no durable timeline store is configured' };
  },
};
