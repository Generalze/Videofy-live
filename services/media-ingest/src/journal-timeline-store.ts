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

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  readonly io?: {
    readonly appendFile: typeof appendFile;
    readonly writeFile: typeof writeFile;
    readonly readFile: typeof readFile;
    readonly mkdir: typeof mkdir;
    readonly rm: typeof rm;
  };
}

export class JournalTimelineStore implements ProgrammeTimelineStore {
  private readonly io: NonNullable<JournalTimelineStoreOptions['io']>;
  private ready: Promise<void> | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: JournalTimelineStoreOptions) {
    this.io = options.io ?? { appendFile, writeFile, readFile, mkdir, rm };
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
    try {
      await this.ensureDirectory();
      // One JSON object per line: a partial final line after a hard kill is
      // discarded on load rather than corrupting everything before it.
      await this.io.appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
      this.lastFailure = null;
      return true;
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : 'the journal could not be written';
      return false;
    }
  }

  async saveCursor(runId: string, releasedThroughMs: number): Promise<boolean> {
    const path = this.pathFor(runId, 'cursor');
    if (path === null) return false;
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

  async release(runId: string): Promise<void> {
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
