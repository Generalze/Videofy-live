/** @author masterzee001 */
/**
 * A broadcast's timeline, on disk, one line at a time.
 *
 * WHY A JOURNAL AND NOT A DATABASE. This service has no database and adding
 * one to hold a few thousand small records per broadcast would be new
 * infrastructure for a problem the service's existing persistence already
 * solves: it already spools media to disk. A timeline is an append-only
 * sequence of small metadata records, which is exactly what a journal is good
 * at, and recovery is a sequential read rather than a query.
 *
 * WHAT IS WRITTEN IS METADATA. References, positions and durations. No audio,
 * no transcript text, no vocabulary, no creative content -- a broadcast's
 * structure is small and worth keeping; its content belongs in the spool and
 * under quite different retention rules.
 *
 * DURABILITY IS CLAIMED ONLY WHERE IT IS TRUE. Every write is appended and
 * flushed; a write that fails returns false rather than throwing, because the
 * caller's correct response is to stop promising a safety delay, not to crash
 * a live broadcast. `health` is checked before a promise is made, so an
 * unwritable spool is discovered before going on air rather than during it.
 */

import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FenceGuard } from '@videofy-live/programme-timeline';
import type {
  PersistedRun,
  ProgrammeTimelineEvent,
  ProgrammeTimelineStore,
  TimelineStoreHealth,
} from '@videofy-live/programme-timeline';

/** Ids reach the filesystem, so they are checked before they become a path. */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export interface JournalTimelineStoreOptions {
  readonly directory: string;
  /** Injectable so tests can drive a failing disk without one. */
  /**
   * The authority that says which token is current for a run.
   *
   * Absent means the deployment has not adopted leases and the store writes
   * unfenced, which is honest for a single-writer deployment. Present, it is
   * consulted on an interval so a superseded process stops writing without
   * waiting for its own lease renewal to fail.
   */
  readonly sharedFence?: { highestIssued(runId: string): Promise<number | null> };
  /** How often the shared fence is re-read. Bounds the exposure window. */
  readonly revalidateMs?: number;
  readonly io?: {
    readonly appendFile: typeof appendFile;
    readonly writeFile: typeof writeFile;
    readonly readFile: typeof readFile;
    readonly mkdir: typeof mkdir;
    readonly rm: typeof rm;
  };
}

export class JournalTimelineStore implements ProgrammeTimelineStore {
  /**
   * The fence, applied to every write that reaches disk.
   *
   * A lease that is checked only when acquired protects nothing: the process
   * that matters is the one that already held ownership, stalled, lost it, and
   * woke up still believing. Its writes arrive looking perfectly ordinary, and
   * this is the only place they can be recognised as coming from a previous
   * life.
   */
  private readonly fence = new FenceGuard();
  private fenceToken: number | null = null;
  /**
   * Set once the volume has shown a higher token, and never cleared.
   *
   * A process that has been superseded does not become valid again by waiting,
   * and a store that re-admitted itself after a transient read failure would
   * be exactly the split-brain writer the fence exists to stop.
   */
  private fencedOut = false;
  private readonly fenceCheckedAt = new Map<string, number>();

  /**
   * Present the token this process is writing under.
   *
   * Called when a lease is acquired or renewed. Until one is presented the
   * store writes unfenced, which is correct for a deployment that has not
   * adopted leases -- and is why `fencedBy` is separate from construction
   * rather than a constructor argument nobody would pass.
   */
  writeUnder(fenceToken: number): void {
    this.fenceToken = fenceToken;
  }
  private readonly io: NonNullable<JournalTimelineStoreOptions['io']>;
  private readonly revalidateMs: number;
  private ready: Promise<void> | null = null;
  private lastFailure: string | null = null;
  /**
   * One write at a time, per run.
   *
   * Callers do not await `append` -- a live broadcast cannot wait on a disk
   * -- so without this, two events written in the same tick race and the
   * journal ends up in an order the programme never happened in. An
   * append-only journal has to be append-ORDERED, or replaying it produces a
   * different broadcast from the one that aired.
   */
  private readonly writes = new Map<string, Promise<unknown>>();

  private queue<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The chain holds only its latest link, never its history.
    this.writes.set(runId, next.catch(() => undefined));
    return next;
  }

  constructor(private readonly options: JournalTimelineStoreOptions) {
    this.io = options.io ?? { appendFile, writeFile, readFile, mkdir, rm };
    this.revalidateMs = options.revalidateMs ?? 1_000;
  }

  /**
   * Paths are built from a checked id, never from one as given.
   *
   * A run id arrives over a wire. `../` in one would write another
   * broadcast's journal, and the wire already validates the shape -- this is
   * the second check, at the boundary that would actually be harmed.
   */
  private pathFor(runId: string, suffix: 'journal' | 'cursor'): string | null {
    if (!SAFE_RUN_ID.test(runId)) return null;
    return join(this.options.directory, `${runId}.${suffix}`);
  }

  private async ensureDirectory(): Promise<void> {
    this.ready ??= this.io.mkdir(this.options.directory, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async append(event: ProgrammeTimelineEvent): Promise<boolean> {
    const path = this.pathFor(event.runId, 'journal');
    if (path === null) {
      this.lastFailure = 'the run id is not a shape that may become a path';
      return false;
    }
    /*
     * QUEUED SYNCHRONOUSLY, and the fence checked INSIDE the queue.
     *
     * Awaiting anything before `queue` returns control to the caller with
     * nothing enqueued, so two events written in the same tick are ordered by
     * whichever microtask resolves first -- and `flush` has nothing to wait
     * for. An append-only journal has to be append-ORDERED, or replaying it
     * produces a different broadcast from the one that aired.
     */
    return this.queue(event.runId, async () => {
      if (!(await this.admitted(event.runId))) {
        this.lastFailure = 'this process no longer owns the broadcast';
        return false;
      }
      try {
        await this.ensureDirectory();
        /*
         * WRITTEN AND FLUSHED, not merely handed to the page cache.
         *
         * The deployment root is mounted commit=30, so an unfsynced write can
         * be thirty seconds behind the disk when power is lost -- which is most
         * of a safety buffer. A process restart would survive on the page cache
         * alone; a host losing power would not, and coming back is the whole
         * promise of this store.
         */
        // One JSON object per line: a partial final line after a hard kill is
        // discarded on load rather than corrupting everything before it.
        await this.appendDurably(path, `${JSON.stringify(event)}
`);
        this.lastFailure = null;
        return true;
      } catch (error) {
        this.lastFailure = error instanceof Error ? error.message : 'the journal could not be written';
        return false;
      }
    });
  }

  async saveCursor(runId: string, releasedThroughMs: number): Promise<boolean> {
    const path = this.pathFor(runId, 'cursor');
    if (path === null) return false;
    if (!(await this.admitted(runId))) {
      // A fenced process moving the cursor would tell the world an audience
      // had received material it never did.
      this.lastFailure = 'this process no longer owns the broadcast';
      return false;
    }
    try {
      await this.ensureDirectory();
      // Rewritten rather than appended: only the latest position matters, and
      // a cursor file that grew with the broadcast would be its own problem.
      await this.io.writeFile(path, String(Math.round(releasedThroughMs)), 'utf8');
      this.lastFailure = null;
      return true;
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : 'the cursor could not be written';
      return false;
    }
  }

  async load(runId: string): Promise<PersistedRun | null> {
    const journalPath = this.pathFor(runId, 'journal');
    if (journalPath === null) return null;
    let raw: string;
    try {
      raw = await this.io.readFile(journalPath, 'utf8');
    } catch {
      // Never written, or gone. Both mean this store cannot restore that run.
      return null;
    }

    const events: ProgrammeTimelineEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line) as ProgrammeTimelineEvent);
      } catch {
        /*
         * A TORN LAST LINE IS NOT A CORRUPT BROADCAST.
         *
         * A process killed mid-write leaves a partial record. Everything
         * before it is intact and is exactly what the audience already
         * received, so it is kept and the fragment dropped. Refusing the whole
         * journal over one truncated line would turn a recoverable restart
         * into a lost programme.
         */
        continue;
      }
    }

    let releasedThroughMs = -1;
    const cursorPath = this.pathFor(runId, 'cursor');
    if (cursorPath !== null) {
      try {
        const parsed = Number.parseInt(await this.io.readFile(cursorPath, 'utf8'), 10);
        if (Number.isFinite(parsed)) releasedThroughMs = parsed;
      } catch {
        /*
         * No cursor means nothing is known about what the audience received.
         * Left at -1, which replays from the start rather than assuming they
         * have seen material they may not have.
         */
      }
    }

    return { runId, events, releasedThroughMs };
  }

  /**
   * Is this process still entitled to write to this run?
   *
   * Unfenced deployments admit everything, which is the honest behaviour for
   * one that has not adopted leases.
   *
   * WHERE A LOCAL FENCE IS NOT ENOUGH. A stalled writer's own guard has only
   * ever seen its own token, so it admits itself for ever -- the process that
   * matters is precisely the one that cannot detect its own supersession. So
   * the volume is asked as well, because that is what a successor has already
   * written to, and once it reports a higher token this store is out
   * permanently: waiting does not restore authority.
   */
  private async admitted(runId: string): Promise<boolean> {
    if (this.fenceToken === null) return true;
    if (this.fencedOut) return false;
    if (!this.fence.admit(runId, this.fenceToken)) return false;

    const shared = this.options.sharedFence;
    if (shared === undefined) return true;
    const at = Date.now();
    const checkedAt = this.fenceCheckedAt.get(runId) ?? 0;
    /*
     * Re-read on an interval rather than on every append. A live broadcast
     * writes several events a second and a stat per event is a cost with no
     * matching risk: the exposure this bounds is the window between losing a
     * lease and noticing, and a second of it is shorter than any lease TTL.
     */
    if (at - checkedAt < this.revalidateMs) return true;
    this.fenceCheckedAt.set(runId, at);
    const highest = await shared.highestIssued(runId).catch(() => null);
    if (highest !== null && highest > this.fenceToken) {
      this.fencedOut = true;
      this.lastFailure = 'another process has taken ownership of this broadcast';
      return false;
    }
    return true;
  }

  /**
   * Append and flush to the device.
   *
   * Falls back to a plain append when the io has been injected: a test double
   * is not a disk and need not prove one.
   */
  private async appendDurably(path: string, line: string): Promise<void> {
    if (this.io.appendFile !== appendFile) {
      await this.io.appendFile(path, line, 'utf8');
      return;
    }
    const handle = await open(path, 'a');
    try {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Settle every write already queued for this run. */
  async flush(runId: string): Promise<void> {
    await this.writes.get(runId);
  }

  async release(runId: string): Promise<void> {
    // Let the queue drain first, or a delete races the writes it is deleting.
    await this.flush(runId);

    for (const suffix of ['journal', 'cursor'] as const) {
      const path = this.pathFor(runId, suffix);
      if (path === null) continue;
      try {
        await this.io.rm(path, { force: true });
      } catch {
        // A finished broadcast that could not be tidied is not worth failing.
      }
    }
  }

  async health(): Promise<TimelineStoreHealth> {
    try {
      await this.ensureDirectory();
      // Proven by writing, not by the directory existing: a full or read-only
      // disk passes every cheaper check and fails the only one that matters.
      const probe = join(this.options.directory, '.writable');
      await this.io.writeFile(probe, String(Date.now()), 'utf8');
      await this.io.rm(probe, { force: true });
      return { writable: true, reason: null };
    } catch (error) {
      const reason =
        this.lastFailure ??
        (error instanceof Error ? error.message : 'the timeline spool is not writable');
      // The next health check must re-make the directory rather than trust a
      // promise that resolved before the disk went away.
      this.ready = null;
      return { writable: false, reason };
    }
  }
}
