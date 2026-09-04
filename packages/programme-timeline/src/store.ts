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

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
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
  /**
   * Whether the journal read back whole.
   *
   * A TORN LAST LINE AND A HOLE IN THE MIDDLE ARE DIFFERENT FAULTS. A process
   * killed mid-write leaves a partial final record; everything before it is
   * exactly what the audience already received, and dropping the fragment
   * loses nothing. A record that fails to parse with intact records AFTER it
   * is a gap: the broadcast is missing a piece somebody may already have been
   * sent, and replaying it would give the audience a different programme from
   * the one that aired.
   *
   * False does not mean the events are unusable. It means a caller must not
   * quietly carry on as though the record were complete.
   */
  readonly intact: boolean;
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
  /**
   * Write down WHOSE broadcast this is, once, when the run opens.
   *
   * THE JOURNAL RECORDED EVENTS AND NOT IDENTITY, and recovery needs both. A
   * recovered run must say which channel aired it or no audience can be
   * admitted to it: visibility is resolved per channel, and `channelOf` on a
   * run nobody can place returns null. Every unit test supplied the identity
   * directly, which is exactly why they all passed while a restarted service
   * could not name a single run it held media for.
   *
   * Optional on the interface so a store that keeps nothing stays valid; a
   * deployment whose store cannot record this simply cannot recover, and says
   * so rather than guessing a channel.
   */
  saveIdentity?(identity: ProgrammeRunIdentity): Promise<boolean>;
  /**
   * The runs this store still holds, and who they belong to.
   *
   * Enumeration is what a restart needs and `load(runId)` cannot give: at boot
   * nothing knows which runs to ask about.
   */
  listRuns?(): Promise<readonly ProgrammeRunIdentity[]>;
  /** Persist one event. False means it was NOT stored and the promise is broken. */
  append(event: ProgrammeTimelineEvent): Promise<boolean>;
  /** Record how far the audience has been allowed to reach. */
  saveCursor(runId: string, releasedThroughMs: number): Promise<boolean>;
  /** Everything known about a run, or null if this store has never seen it. */
  load(runId: string): Promise<PersistedRun | null>;
  /**
   * Wait until everything already handed to this store has been written.
   *
   * Appends are deliberately not awaited by their callers -- a live broadcast
   * cannot wait on a disk -- which means that at any instant some events are
   * in flight. Before a broadcast is released, and before anything reads back
   * what was written, somebody has to be able to ask.
   */
  flush(runId: string): Promise<void>;
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
    /*
     * Always intact. This store never wrote a partial record: it holds objects
     * in memory, so there is no half-written line to recover from. Saying so
     * explicitly rather than defaulting it keeps the field meaning the same
     * thing everywhere -- a durable store answers this from its own file, and
     * a caller must not have to know which kind it is holding.
     */
    return { runId, events: [...run.events], releasedThroughMs: run.cursor, intact: true };
  }

  async flush(): Promise<void> {
    // Memory has no in-flight state to settle.
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
  async flush() {
    /* nothing was ever in flight */
  },
  async release() {
    /* nothing was stored */
  },
  async health() {
    return { writable: false, reason: 'no durable timeline store is configured' };
  },
};
