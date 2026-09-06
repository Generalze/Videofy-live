/** @author masterzee001 */
/**
 * The maintenance that happens after everybody has stopped watching.
 *
 * WHAT THIS IS NOT. It is not the thing that decides who may watch a replay.
 * That decision belongs to `planReplayPlayback`, which takes an instant and
 * refuses the moment a retention runs out -- whether or not any of the work
 * below has ever run. Stated the other way round, and it is the rule this whole
 * file is arranged around:
 *
 *     A CLEANUP WORKER MUST NEVER BE THE THING ENFORCING VIEWER ACCESS.
 *
 * A worker can be late, wedged, restarting, or deliberately off during an
 * incident. If access depended on it, "kept for thirty days" would quietly mean
 * "thirty days, or until somebody notices". So this releases BYTES, and nothing
 * that happens or fails to happen here changes who is allowed to see anything.
 *
 * THE CATALOGUE IS A PROJECTION AND IS NEVER THE SOURCE OF EXPIRY TRUTH.
 *
 * The airing catalogue is a product database: it is queried by history pages,
 * it can be stale, it can be down, and it is a different service's problem when
 * it is. Driving expiry from it would mean an outage there kept expired media
 * alive indefinitely -- retention silently becoming "until the catalogue is
 * healthy", which is exactly the failure a retention promise is supposed to
 * exclude. Candidates therefore come from the ARCHIVE'S OWN state, and the
 * catalogue is told afterwards as a courtesy.
 *
 * THAT PERMISSION IS NARROW. Enumerating archive state for maintenance is
 * allowed; it is a caretaker walking its own shelves. It is NOT a discovery
 * API, and nothing on a product surface may be built on it -- history and
 * discovery go through the catalogue, which is the thing that was designed to
 * be read by other software.
 *
 * ONE RUN'S FAILURE MUST NOT STOP THE BATCH. Every candidate is attempted, its
 * outcome recorded, and the loop carries on. A single corrupt run that halted
 * maintenance would hold every other recording on the box past its retention,
 * turning one broken thing into an estate-wide breach of the same promise.
 */

import type { ProgrammeReplayArchive, ReplayRecord } from './archive.js';
import type { ReplayStatus } from './lifecycle.js';
import { expiryOf, type ReplayRetention } from './policy.js';

/* --------------------------------------------------------- the candidates */

/**
 * The little maintenance needs to know about a run before it decides.
 *
 * DELIBERATELY NOT A `ReplayRecord`. A candidate list is a scan, and a scan
 * that had to materialise every segment of every recording on the box would be
 * unbounded in memory for no reason. What is here is enough to sort and filter;
 * the authoritative read happens per run, one at a time.
 */
export interface ReplayLifecycleCandidate {
  readonly runId: string;
  readonly status: ReplayStatus;
  readonly retention: ReplayRetention;
  /** The instant retention ends, or null when the policy states none. */
  readonly expiresAtMs: number | null;
}

export interface ReplayLifecycleQuery {
  /** The instant maintenance is being run for. */
  readonly nowMs: number;
  /** How long after the logical cutoff bytes may still be held. See below. */
  readonly graceMs: number;
  /** A bound on how much this pass will look at. Never unbounded. */
  readonly limit: number;
}

/**
 * Where maintenance finds work, which is the archive's own metadata.
 *
 * IMPLEMENTED BY THE ARCHIVES THEMSELVES, alongside `ProgrammeReplayArchive`
 * and separately from it. The public archive contract is frozen and describes
 * one recording at a time; this is a second, narrower interface for the
 * caretaker, and keeping them apart is what stops a maintenance scan from
 * drifting into the contract that product code depends on.
 *
 * FOR LIFECYCLE MAINTENANCE ONLY. Not a discovery API, not a history API, and
 * not something a route may be built on.
 */
export interface ReplayLifecycleCandidateSource {
  /**
   * Runs whose retention has elapsed and whose grace has also elapsed.
   *
   * Bounded by `limit`. An implementation may return fewer, and may return them
   * in any order: the worker re-reads and re-checks every one of them against
   * the authoritative record before it touches anything.
   */
  dueForExpiry(query: ReplayLifecycleQuery): Promise<readonly ReplayLifecycleCandidate[]>;
}

/**
 * Whether this run's bytes may be released yet.
 *
 * TWO CUTOFFS, AND THEY ARE NOT THE SAME CUTOFF.
 *
 *   `expiresAtMs` is the LOGICAL one: the instant an audience stops being
 *   allowed to watch. Enforced on every request, by the clock, and nothing here
 *   can move it.
 *
 *   `expiresAtMs + graceMs` is the PHYSICAL one: the instant the bytes may
 *   actually go. A positive grace buys an operator a window in which a
 *   recording released by mistake -- a policy typo, a wrong duration -- can
 *   still be recovered from the store, and it costs nothing in privacy terms
 *   BECAUSE THE LOGICAL CUTOFF ALREADY REFUSED EVERYBODY. A grace period
 *   extends recoverability, never access.
 *
 * `graceMs` IS REQUIRED AND HAS NO DEFAULT HERE. This package does not invent
 * product decisions -- see the retention policy module, which refuses to
 * default a policy or a visibility for the same reason. Zero is a perfectly
 * good answer and it has to be somebody's answer, stated at the point of
 * composition, not a number that appeared in a domain file.
 */
export function readyToRelease(
  retention: ReplayRetention,
  nowMs: number,
  graceMs: number,
): boolean {
  const at = expiryOf(retention);
  if (at === null) return false;
  return nowMs >= at + graceMs;
}

/* ------------------------------------------------------------ the outcome */

export type ReplayMaintenanceOutcome =
  /** The archive moved it. */
  | 'expired'
  /** Already where it needed to be, or not eligible after a fresh read. */
  | 'skipped'
  /** The archive refused, or could not be reached. */
  | 'failed';

export interface ReplayMaintenanceEntry {
  readonly runId: string;
  readonly outcome: ReplayMaintenanceOutcome;
  /** Why, in words. Never a path: this is read by operators and by logs. */
  readonly detail: string;
  /**
   * Whether the catalogue was told, and whether it took it.
   *
   * `false` IS NOT A FAILED EXPIRY. The bytes are gone and the archive says so;
   * the history page is briefly behind. Those are not the same severity and
   * conflating them would either raise incidents about bookkeeping or, far
   * worse, make somebody retry an expiry because a projection was down.
   */
  readonly catalogueSynced: boolean;
}

export interface ReplayMaintenanceReport {
  readonly examined: number;
  readonly expired: number;
  readonly skipped: number;
  readonly failed: number;
  /** Expiries the archive completed and the catalogue did not take. */
  readonly catalogueLagged: number;
  readonly entries: readonly ReplayMaintenanceEntry[];
  /** Set when the pass could not start at all. Nothing was touched. */
  readonly refusal: string | null;
}

/** Somewhere to send the projection afterwards. Never consulted for truth. */
export interface ReplayCatalogueSync {
  sync(record: ReplayRecord): Promise<void>;
}

export interface ReplayExpiryPassOptions {
  readonly archive: ProgrammeReplayArchive;
  readonly candidates: ReplayLifecycleCandidateSource;
  /** Optional: without one, expiry still happens and history simply lags. */
  readonly catalogue?: ReplayCatalogueSync;
  readonly nowMs: number;
  /** Required. See `readyToRelease`: this package invents no product defaults. */
  readonly cleanupGraceMs: number;
  /** A bound on the pass. Required for the same reason: no hidden batch size. */
  readonly limit: number;
  readonly onEntry?: (entry: ReplayMaintenanceEntry) => void;
}

function entryOf(
  runId: string,
  outcome: ReplayMaintenanceOutcome,
  detail: string,
  catalogueSynced = false,
): ReplayMaintenanceEntry {
  return { runId, outcome, detail, catalogueSynced };
}

/**
 * One bounded, retry-safe pass of retention maintenance.
 *
 * IDEMPOTENT BY CONSTRUCTION. Everything it does is an instruction the archive
 * already treats as retry-safe: expiring an expired recording succeeds and
 * changes nothing. So a pass that dies halfway and is run again is
 * indistinguishable from one that finished, which is the only shape that makes
 * a scheduled job safe to restart.
 *
 * EVERY CANDIDATE IS RE-READ BEFORE IT IS ACTED ON. The scan produced a list;
 * between the scan and the act, a run may have been deleted, failed, already
 * expired, or -- if the scan was over stale metadata -- may never have been
 * eligible. The authority is the archive's answer now, not the list.
 */
export async function runReplayExpiryPass(
  options: ReplayExpiryPassOptions,
): Promise<ReplayMaintenanceReport> {
  const empty = {
    examined: 0,
    expired: 0,
    skipped: 0,
    failed: 0,
    catalogueLagged: 0,
    entries: [] as readonly ReplayMaintenanceEntry[],
  };

  /*
   * REFUSED BEFORE ANYTHING IS TOUCHED. A negative or nonsensical grace is a
   * composition mistake, and running the pass with a silently corrected value
   * would release bytes against a rule nobody wrote.
   */
  if (!Number.isSafeInteger(options.cleanupGraceMs) || options.cleanupGraceMs < 0) {
    return {
      ...empty,
      refusal: `cleanupGraceMs must be a whole number of milliseconds, zero or more; got ${String(options.cleanupGraceMs)}`,
    };
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    return { ...empty, refusal: `limit must be a whole number of runs, one or more; got ${String(options.limit)}` };
  }
  if (!Number.isSafeInteger(options.nowMs)) {
    return { ...empty, refusal: `nowMs must be a whole number of milliseconds; got ${String(options.nowMs)}` };
  }

  let candidates: readonly ReplayLifecycleCandidate[];
  try {
    candidates = await options.candidates.dueForExpiry({
      nowMs: options.nowMs,
      graceMs: options.cleanupGraceMs,
      limit: options.limit,
    });
  } catch (error) {
    /*
     * THE SCAN ITSELF FAILING IS NOT A RUN FAILING. Nothing was attempted, so
     * nothing is reported as failed -- a pass that reported N failures because
     * it could not list anything would be describing work it never did.
     */
    return { ...empty, refusal: `the archive could not be scanned for expiry: ${describe(error)}` };
  }

  const entries: ReplayMaintenanceEntry[] = [];
  const record = (entry: ReplayMaintenanceEntry): void => {
    entries.push(entry);
    try {
      options.onEntry?.(entry);
    } catch {
      /*
       * A CALLER'S LOGGER MUST NOT STOP MAINTENANCE. `onEntry` is somebody
       * else's function -- a metric, a log line, a notification -- and a
       * throwing one would otherwise abandon every remaining run in the batch
       * and hold them all past their retention. The entry is already recorded;
       * whoever wanted to hear about it simply did not.
       */
    }
  };

  for (const candidate of candidates.slice(0, options.limit)) {
    /*
     * ONE RUN'S FAILURE DOES NOT STOP THE BATCH.
     *
     * The load-bearing guards are inside `expireOne`, around each call that
     * reaches the archive or the catalogue; those are what turn a throwing
     * implementation into a recorded failure and a continued loop, and they are
     * what the falsification exercises.
     *
     * THIS ONE IS DEFENCE IN DEPTH AND UNREACHABLE TODAY, which is worth saying
     * rather than dressing up: with the inner guards in place nothing in
     * `expireOne` can throw. It stays because the alternative -- relying on a
     * future edit to remember to guard whatever it adds -- is how a sweep starts
     * abandoning the rest of an estate over one bad row.
     */
    try {
      record(await expireOne(candidate, options));
    } catch (error) {
      record(entryOf(candidate.runId, 'failed', `maintenance threw: ${describe(error)}`));
    }
  }

  return {
    examined: entries.length,
    expired: entries.filter((entry) => entry.outcome === 'expired').length,
    skipped: entries.filter((entry) => entry.outcome === 'skipped').length,
    failed: entries.filter((entry) => entry.outcome === 'failed').length,
    catalogueLagged: entries.filter((entry) => entry.outcome === 'expired' && !entry.catalogueSynced)
      .length,
    entries,
    refusal: null,
  };
}

async function expireOne(
  candidate: ReplayLifecycleCandidate,
  options: ReplayExpiryPassOptions,
): Promise<ReplayMaintenanceEntry> {
  const runId = candidate.runId;

  /*
   * 1. THE AUTHORITATIVE READ. The scan is a hint; this is the truth. A run
   *    that has been deleted, failed, or already expired since the scan is
   *    handled here rather than argued with by the archive.
   */
  let held: ReplayRecord | null;
  try {
    held = await options.archive.describe(runId);
  } catch (error) {
    return entryOf(runId, 'failed', `the archive could not describe this run: ${describe(error)}`);
  }
  if (held === null) {
    return entryOf(runId, 'skipped', 'the archive holds no recording for this run');
  }

  // 2. VERIFY, against the record rather than against the candidate.
  if (held.status === 'expired' || held.status === 'deleted') {
    return entryOf(runId, 'skipped', `already ${held.status}`);
  }
  if (held.retention.policy !== 'expire') {
    return entryOf(runId, 'skipped', `retained under policy ${held.retention.policy}, which never expires`);
  }
  if (!readyToRelease(held.retention, options.nowMs, options.cleanupGraceMs)) {
    /*
     * The scan said it was due and the record says otherwise. Not an error --
     * a stale scan is exactly what re-reading is for -- and emphatically not
     * something to force.
     */
    return entryOf(runId, 'skipped', 'not yet due once the grace period is counted');
  }

  /*
   * 3. THE ARCHIVE DOES THE WORK. `expire` is retry-safe and refuses anything
   *    the lifecycle forbids, so this is the one place a transition happens.
   *    The instant passed is the pass's instant, not the grace-adjusted one:
   *    the archive is being asked whether retention has elapsed, and it has.
   */
  let outcome;
  try {
    outcome = await options.archive.expire(runId, options.nowMs);
  } catch (error) {
    return entryOf(runId, 'failed', `the archive threw while expiring: ${describe(error)}`);
  }
  if (!outcome.ok) {
    return entryOf(runId, 'failed', `${outcome.failure.reason}: ${outcome.failure.detail}`);
  }

  /*
   * 4. AND THEN THE CATALOGUE IS TOLD, which is bookkeeping.
   *
   * A failure here is DIAGNOSTIC. The bytes are released and the archive says
   * so; the history page is briefly behind, and reconciliation repairs it
   * later. Reporting this as a failed expiry would invite somebody to retry an
   * operation that already succeeded, and would raise an incident about a
   * projection.
   */
  let catalogueSynced = true;
  if (options.catalogue !== undefined) {
    try {
      await options.catalogue.sync(outcome.value);
    } catch {
      catalogueSynced = false;
    }
  }
  return entryOf(runId, 'expired', 'retention elapsed and the media was released', catalogueSynced);
}

/* --------------------------------------------------------------- deletion */

/**
 * One durable request to remove a recording.
 *
 * A REQUEST, NOT AN INSTRUCTION TO OBEY BLINDLY. It names a run and nothing
 * else; whether that run may be removed right now is decided against the
 * archive at the moment of processing, because the request may have been queued
 * before the broadcast even ended.
 */
export interface ReplayDeletionRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly requestedAtMs: number;
  /** How many times this has been attempted. For visibility, not for policy. */
  readonly attempts: number;
}

export type ReplayDeletionSettlement =
  /** Removed, or already gone. Either way the request is finished with. */
  | 'done'
  /** Not now: the broadcast is still live or still finishing. Try later. */
  | 'defer'
  /** The archive refused or was unreachable. Try later, and say why. */
  | 'retry';

/**
 * A durable queue of deletion requests.
 *
 * AT-LEAST-ONCE, WHICH IS WHY EVERYTHING BELOW IS IDEMPOTENT. A worker can
 * remove a recording and die before recording that it did; the next pass must
 * be able to repeat the instruction rather than raise an incident about work
 * that is already done. `delete` on the archive is retry-safe for exactly this
 * reason.
 *
 * `claim` MUST NOT HAND THE SAME REQUEST TO TWO WORKERS AT ONCE. An
 * implementation over a real database does that with row locks that skip what
 * is already taken; without it, two workers race on one run and the loser's
 * report describes a state that was never true.
 */
export interface ReplayDeletionQueue {
  claim(limit: number, nowMs: number): Promise<readonly ReplayDeletionRequest[]>;
  settle(
    requestId: string,
    settlement: ReplayDeletionSettlement,
    detail: string,
    nowMs: number,
  ): Promise<void>;
}

export interface ReplayDeletionPassOptions {
  readonly archive: ProgrammeReplayArchive;
  readonly queue: ReplayDeletionQueue;
  readonly catalogue?: ReplayCatalogueSync;
  readonly nowMs: number;
  readonly limit: number;
  readonly onEntry?: (entry: ReplayDeletionEntry) => void;
}

export interface ReplayDeletionEntry {
  readonly requestId: string;
  readonly runId: string;
  readonly settlement: ReplayDeletionSettlement;
  readonly detail: string;
  readonly catalogueSynced: boolean;
}

export interface ReplayDeletionReport {
  readonly claimed: number;
  readonly done: number;
  readonly deferred: number;
  readonly retried: number;
  readonly catalogueLagged: number;
  readonly entries: readonly ReplayDeletionEntry[];
  readonly refusal: string | null;
}

/**
 * One bounded pass of deletion work.
 *
 * A LIVE BROADCAST IS NEVER DESTROYED BY A BACKGROUND REQUEST. A run that is
 * still `recording` or `processing` is DEFERRED, not deleted: the request may
 * have been made minutes ago about a programme that has since gone back on air,
 * or about one whose finalisation is in flight, and a queue worker is the last
 * thing that should be allowed to reach into either. It comes back to the same
 * request later, when the answer is unambiguous.
 */
export async function runReplayDeletionPass(
  options: ReplayDeletionPassOptions,
): Promise<ReplayDeletionReport> {
  const empty = {
    claimed: 0,
    done: 0,
    deferred: 0,
    retried: 0,
    catalogueLagged: 0,
    entries: [] as readonly ReplayDeletionEntry[],
  };
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    return { ...empty, refusal: `limit must be a whole number of requests, one or more; got ${String(options.limit)}` };
  }

  let claimed: readonly ReplayDeletionRequest[];
  try {
    claimed = await options.queue.claim(options.limit, options.nowMs);
  } catch (error) {
    return { ...empty, refusal: `deletion requests could not be claimed: ${describe(error)}` };
  }

  const entries: ReplayDeletionEntry[] = [];
  for (const request of claimed) {
    let entry: ReplayDeletionEntry;
    try {
      entry = await deleteOne(request, options);
    } catch (error) {
      entry = {
        requestId: request.requestId,
        runId: request.runId,
        settlement: 'retry',
        detail: `deletion threw: ${describe(error)}`,
        catalogueSynced: false,
      };
    }
    /*
     * SETTLED EVEN WHEN SETTLING ITSELF FAILS. A request that cannot be marked
     * done will be claimed again, and `delete` is retry-safe, so the second
     * pass is a no-op that settles correctly. One bad request does not stop the
     * others.
     */
    try {
      await options.queue.settle(entry.requestId, entry.settlement, entry.detail, options.nowMs);
    } catch {
      // Left claimed; the claim's own visibility timeout brings it back.
    }
    entries.push(entry);
    options.onEntry?.(entry);
  }

  return {
    claimed: entries.length,
    done: entries.filter((entry) => entry.settlement === 'done').length,
    deferred: entries.filter((entry) => entry.settlement === 'defer').length,
    retried: entries.filter((entry) => entry.settlement === 'retry').length,
    catalogueLagged: entries.filter((entry) => entry.settlement === 'done' && !entry.catalogueSynced)
      .length,
    entries,
    refusal: null,
  };
}

async function deleteOne(
  request: ReplayDeletionRequest,
  options: ReplayDeletionPassOptions,
): Promise<ReplayDeletionEntry> {
  const base = { requestId: request.requestId, runId: request.runId, catalogueSynced: false };

  let held: ReplayRecord | null;
  try {
    held = await options.archive.describe(request.runId);
  } catch (error) {
    return { ...base, settlement: 'retry', detail: `the archive could not be read: ${describe(error)}` };
  }

  /*
   * NOTHING TO DELETE IS SUCCESS. The instruction is "make sure this is gone",
   * and it is: either it never existed here, or an earlier attempt finished the
   * job and died before saying so.
   */
  if (held === null) {
    return { ...base, settlement: 'done', detail: 'the archive holds no recording for this run' };
  }
  if (held.status === 'deleted') {
    return { ...base, settlement: 'done', detail: 'already deleted' };
  }

  /*
   * A LIVE OR FINISHING BROADCAST IS DEFERRED, NEVER DESTROYED. The request may
   * predate this run going back on air, or arrive while finalisation is in
   * flight. Neither is a state a background queue may reach into.
   */
  if (held.status === 'recording' || held.status === 'processing') {
    return {
      ...base,
      settlement: 'defer',
      detail: `this broadcast is ${held.status}; deletion waits for it to finish`,
    };
  }

  let outcome;
  try {
    outcome = await options.archive.delete(request.runId);
  } catch (error) {
    return { ...base, settlement: 'retry', detail: `the archive threw while deleting: ${describe(error)}` };
  }
  if (!outcome.ok) {
    return {
      ...base,
      settlement: 'retry',
      detail: `${outcome.failure.reason}: ${outcome.failure.detail}`,
    };
  }

  let catalogueSynced = true;
  if (options.catalogue !== undefined) {
    try {
      await options.catalogue.sync(outcome.value);
    } catch {
      // Bookkeeping, exactly as in expiry. The media is gone regardless.
      catalogueSynced = false;
    }
  }
  return { ...base, settlement: 'done', detail: 'the recording was removed', catalogueSynced };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
