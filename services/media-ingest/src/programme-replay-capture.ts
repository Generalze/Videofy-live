/** @author masterzee001 */
/**
 * The join between a broadcast that is on air and the archive that keeps it.
 *
 * WP-R1-A built an archive with no caller. The live producer built segments
 * with no archive. This is the seam between them, and it exists as its own
 * file because the one rule it has to enforce is easiest to break by accident
 * inside somebody else's loop: A REPLAY PROBLEM IS NEVER A BROADCAST PROBLEM.
 *
 * WHAT IT DOES NOT DO. It does not decide whether a run should be recorded --
 * a recording exists because an upstream caller explicitly began one, and this
 * file never calls `begin`. It does not read media, re-encode anything, or
 * describe programme time; the segment it offers is the exact canonical
 * `ProgrammeMediaSegment` the live store accepted, because a second
 * description of the same bytes is a disagreement waiting to be discovered by
 * a viewer. It does not store anything durably: the queue below is process
 * memory, and WP-R1-C owns the durable copy.
 *
 * OFFERS ARE NEVER AWAITED BY THE LIVE PATH. `offer` returns immediately
 * having appended to a per-run chain. A slow object store, a hung filesystem
 * or an archive that throws therefore costs the broadcast nothing -- the
 * segment is already in the live store and the cursor has already advanced by
 * the time any of it runs.
 *
 * ONE CHAIN PER RUN, not one for the service. Programme order has to hold
 * within a broadcast -- init before the fragments that need it, segment 3
 * after segment 2 -- and must not hold between broadcasts, because a single
 * global chain would let one slow archive write stall the recording of every
 * other programme on the box.
 */

import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import {
  withoutFailingTheProgramme,
  type ProgrammeReplayArchive,
  type ReplayFailureReason,
  type ReplayInitialisation,
  type ReplayOutcome,
} from '@videofy-live/programme-replay';
import { logger } from './logger.js';

interface RunCapture {
  /** Ordered work for this run. Never rejects; every link catches. */
  chain: Promise<void>;
  /**
   * This recording is over, one way or another.
   *
   * Set the moment a failure is known rather than when the archive confirms
   * it, so the segments still arriving from a live encoder become cheap
   * no-ops immediately instead of queueing archive calls nobody will read.
   */
  terminal: boolean;
  /** Whether the terminal outcome has already been reported to the archive. */
  settled: boolean;
}

/**
 * A refusal that means "there is no recording for this run", not "something
 * went wrong".
 *
 * The archive answers `unknown-replay` when nothing was ever begun for a run,
 * which is the ordinary case for every broadcast nobody asked to record. It
 * must not mark anything failed, must not be logged, and must not stop later
 * offers: a caller may begin a recording part-way through a programme, and the
 * next segment should simply start being kept.
 */
function meansNoRecording(reason: ReplayFailureReason): boolean {
  return reason === 'unknown-replay' || reason === 'policy-forbids-replay';
}

export class ProgrammeReplayCapture {
  private readonly runs = new Map<string, RunCapture>();

  constructor(private readonly archive: ProgrammeReplayArchive) {}

  /**
   * Offer one accepted segment, and the initialisation material it needs.
   *
   * SYNCHRONOUS AND TOTAL. Called from inside the live segment loop, so it
   * neither awaits nor throws: everything that can go wrong is inside the
   * chain, and the chain swallows.
   *
   * INITIALISATION FIRST, ALWAYS. A fragment whose init was never retained is
   * not a degraded replay, it is an undecodable one, and the archive checks
   * for exactly that at finalisation. Offering the same generation again for
   * every segment is deliberate: WP-R1-A made an exact repeat idempotent, and
   * a local registry of "generations already sent" would be a second source of
   * truth about what the archive holds.
   */
  offer(runId: string, segment: ProgrammeMediaSegment, initialisation: ReplayInitialisation): void {
    const run = this.run(runId);
    if (run.terminal) return;
    this.enqueue(run, async () => {
      if (run.terminal) return;
      const kept = await this.attempt(runId, run, 'retainInitialisation', () =>
        this.archive.retainInitialisation(runId, initialisation),
      );
      if (!kept) return;
      await this.attempt(runId, run, 'retainSegment', () =>
        this.archive.retainSegment(runId, segment),
      );
    });
  }

  /**
   * The programme's own media is incomplete, so this recording cannot be made.
   *
   * SYNCHRONOUS FOR THE CALLER, which is a live durability handler that has
   * already failed the broadcast and must not now wait on an archive. The run
   * is marked terminal here and the archive is told on the chain.
   */
  failSource(runId: string, reason: ReplayFailureReason, detail: string): void {
    const run = this.run(runId);
    if (run.terminal) return;
    run.terminal = true;
    this.enqueue(run, async () => {
      await this.settle(runId, run, reason, detail);
    });
  }

  /**
   * The broadcast ended as intended: make the recording whole.
   *
   * AWAITED, unlike everything above, and only ever from an end-of-run path.
   * Finalising before the queued offers have landed would check a recording
   * against segments it has not been given yet and call it incomplete.
   */
  async finalise(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    await run.chain;
    if (run.terminal || run.settled) {
      this.runs.delete(runId);
      return;
    }
    const record = await this.archive.describe(runId).catch(() => null);
    /*
     * No recording was begun for this run, or it is already over. Neither is
     * an error, and neither is a reason to manufacture a record.
     */
    if (record === null || record.status !== 'recording') {
      this.runs.delete(runId);
      return;
    }
    run.settled = true;
    run.terminal = true;
    const outcome = await withoutFailingTheProgramme(() => this.archive.finalise(runId));
    if (!outcome.ok) {
      logger.warn('Programme replay could not be finalised', {
        runId,
        reason: outcome.failure.reason,
        operation: 'finalise',
      });
    }
    this.runs.delete(runId);
  }

  /**
   * The broadcast ended in a way that makes the recording untrue.
   *
   * Separate from `finalise` because a truncated recording must never reach
   * `available` by any route: the queued work is drained so nothing lands
   * afterwards, and then the record is failed rather than checked.
   */
  async abandon(runId: string, reason: ReplayFailureReason, detail: string): Promise<void> {
    const run = this.run(runId);
    run.terminal = true;
    await run.chain;
    await this.settle(runId, run, reason, detail);
    this.runs.delete(runId);
  }

  /** Whether anything is still queued for a run. For tests and for shutdown. */
  async settledFor(runId: string): Promise<void> {
    await this.runs.get(runId)?.chain;
  }

  /* ------------------------------------------------------------- internals */

  private run(runId: string): RunCapture {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing;
    const created: RunCapture = { chain: Promise.resolve(), terminal: false, settled: false };
    this.runs.set(runId, created);
    return created;
  }

  /**
   * Append work to a run's chain so it can never reject.
   *
   * A rejected chain would make every LATER `.then` on it skip, which is the
   * quiet way a recording stops being kept while everything still looks fine.
   */
  private enqueue(run: RunCapture, work: () => Promise<void>): void {
    run.chain = run.chain.then(work, () => undefined).catch(() => undefined);
  }

  /**
   * One archive call, with the live programme held harmless.
   *
   * Returns whether the caller should continue. A refusal that means "nothing
   * is being recorded here" stops this segment and leaves the run open; any
   * other refusal ends the recording, once, with the reason the archive gave.
   */
  private async attempt<T>(
    runId: string,
    run: RunCapture,
    operation: string,
    call: () => Promise<ReplayOutcome<T>>,
  ): Promise<boolean> {
    const outcome = await withoutFailingTheProgramme(call);
    if (outcome.ok) return true;
    if (meansNoRecording(outcome.failure.reason)) return false;
    run.terminal = true;
    await this.settle(runId, run, outcome.failure.reason, outcome.failure.detail, operation);
    return false;
  }

  /**
   * Tell the archive this recording is over and why, at most once.
   *
   * Skipped silently when the record is already terminal: a replay that failed
   * during capture and is then abandoned again at end-of-run is one failure
   * that was noticed twice, not two failures.
   */
  private async settle(
    runId: string,
    run: RunCapture,
    reason: ReplayFailureReason,
    detail: string,
    operation = 'capture',
  ): Promise<void> {
    if (run.settled) return;
    run.settled = true;
    const record = await this.archive.describe(runId).catch(() => null);
    /*
     * Nothing was ever begun for this run: there is no recording to fail, and
     * inventing one so that something could be failed would be a lie.
     */
    if (record === null || record.status !== 'recording') return;
    /*
     * REPORTED HERE AND NOWHERE ELSE, because this is the first point that
     * knows a recording exists to be abandoned.
     *
     * The callers cannot know it. A durability failure arrives from the live
     * path, which has no idea whether anybody asked for a recording, and
     * announcing the abandonment there meant every unrecorded broadcast that
     * hit a bad disk reported a failed replay it never had -- the manufactured
     * signal this wiring exists to avoid.
     *
     * Once per run: `terminal` is set before the work is queued, so the
     * fragments that follow never reach here, and a segment loop cannot fill a
     * disk with complaints about the same dead archive.
     */
    logger.warn('Programme replay abandoned', { runId, reason, operation });
    await withoutFailingTheProgramme(() => this.archive.fail(runId, reason, detail));
  }
}
