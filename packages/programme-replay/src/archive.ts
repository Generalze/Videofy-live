/** @author masterzee001 */
/**
 * Where a finished broadcast goes, seen only as what a caller may ask of it.
 *
 * THE POINT OF A PORT HERE is that WP-R1-A has no storage at all and the next
 * wave has a filesystem, and the one after that may have an object store. If
 * the domain rules -- run isolation, idempotence, initialisation completeness,
 * the state machine -- live inside whichever storage happened to be written
 * first, each of those waves reimplements them and each gets them slightly
 * differently. Declared here, they are the same rules whatever is underneath.
 *
 * KEYED BY RUN, like everything else that owns a broadcast in this repository:
 * the media store, the timeline store and the writer lease all take a `runId`
 * first. A per-run handle would read nicely and would give a caller holding a
 * stale one a way to write into a broadcast that has ended.
 *
 * EVERY METHOD IS TOTAL AND ASYNCHRONOUS. Total because a live caller needs a
 * value rather than an exception; asynchronous because the implementation that
 * matters talks to a disk, and a port that is synchronous today cannot become
 * durable tomorrow without changing every caller.
 *
 * WHAT IS DELIBERATELY ABSENT: no scheduler, no expiry worker, no HTTP, no
 * manifest, no database. Deleting and expiring are operations a caller invokes
 * when it has decided to; nothing in this package decides on its own.
 *
 * ARCHIVE OWNERSHIP -- THE RULE THAT MATTERS MOST FOR THE DURABLE BACKEND.
 *
 * A `ProgrammeMediaSegment` arriving here was produced for the LIVE path, and
 * its `storageReference` points into the live spool. That spool prunes as the
 * output cursor advances and is released when the broadcast ends, which is
 * roughly the moment a replay starts being useful. A retained reference is
 * therefore a reference with an expiry date that nothing in this contract can
 * see.
 *
 *     LIVE SPOOL                 REPLAY ARCHIVE
 *     seg_001.m4s
 *          |  completed, durable
 *          +----------------->   retainSegment(...)
 *                                     |
 *                                     |  copy or persist independently
 *                                     |
 *                                     +--> archive owns the media
 *          <-- only now may the spool prune the source
 *
 * So: A DURABLE IMPLEMENTATION MUST OBTAIN AN INDEPENDENT DURABLE COPY, OR AN
 * ARCHIVE-OWNED REFERENCE, BEFORE ACKNOWLEDGING RETENTION -- and no Replay
 * implementation may assume the incoming `storageReference` stays valid for
 * the lifetime of the replay. A successful receipt is the archive saying it
 * owns the material, not that it has written down where somebody else keeps
 * it.
 *
 * Such a backend may keep the media identity and timing exactly as offered
 * while substituting its own reference. If it does, it must still remember the
 * reference it was OFFERED, because that is what duplicate detection compares
 * against; comparing against the substituted one would make every ordinary
 * retry look like a conflict.
 *
 * The in-memory archive models ownership without copying bytes: correct for
 * pinning behaviour, and honest that it is not storage. The real copy is a
 * later wave.
 */

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ReplayStatus, ReplayStatusChange } from './lifecycle.js';
import type { ReplayInitialisation } from './media.js';
import type { ReplayFailure, ReplayFailureReason, ReplayOutcome } from './outcome.js';
import type { ReplayRetention, ReplayVisibility } from './policy.js';

/**
 * Everything known about one programme recording.
 *
 * SCOPED TO A RUN, NOT A PROGRAMME. `identity` carries the channel, the
 * programme and the run, and it is the run that decides what media belongs
 * here: two airings of one programme are two recordings, and a segment from
 * last night is not media for tonight.
 */
export interface ReplayRecord {
  readonly identity: ProgrammeRunIdentity;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly status: ReplayStatus;
  readonly startedAtMs: number;
  /** When it reached `available`, or null while it has not. */
  readonly finalisedAtMs: number | null;
  /**
   * The exact instant retention ends, when the policy states one.
   *
   * Null for `keep`. Read from the retention rather than recomputed, so the
   * expiry a record reports is the expiry it was configured with and not one
   * derived from anything that might drift.
   */
  readonly expiresAtMs: number | null;
  readonly segments: readonly ProgrammeMediaSegment[];
  readonly initialisations: readonly ReplayInitialisation[];
  /** Retained bytes: media and initialisation material together. */
  readonly bytes: number;
  /** Why it failed, when it did. Null otherwise. */
  readonly failure: ReplayFailure | null;
  /**
   * Every state this replay has been in, in order.
   *
   * Kept because the interesting question about a replay that is `failed` is
   * almost always how far it got, and because `processing` is otherwise
   * invisible: a finalisation that succeeds passes through it too quickly for
   * anybody to observe, and a rule nobody can observe is a rule nobody can
   * check.
   */
  readonly history: readonly ReplayStatusChange[];
}

/** What a caller must say to open a recording. */
export interface ReplayBeginRequest {
  readonly identity: ProgrammeRunIdentity;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  /** Wall-clock instant the recording opened, for the record and for expiry. */
  readonly startedAtMs: number;
}

/**
 * What the archive holds after accepting -- or declining to re-accept -- an
 * offer of material.
 *
 * `stored` false is NOT a failure. It is how the archive says it already had
 * this exact thing, which happens whenever a poll re-reads a playlist or a
 * recovery replays a journal. The counts and the byte total come back with it
 * so a caller can see for itself that the duplicate changed nothing.
 */
export interface ReplayRetentionReceipt {
  /** False when this exact material was already retained. */
  readonly stored: boolean;
  readonly segmentCount: number;
  readonly initialisationCount: number;
  readonly bytes: number;
}

/**
 * The lifecycle of one programme recording, from first segment to removal.
 *
 * A caller on the live path uses `begin`, `retainInitialisation` and
 * `retainSegment`, and does not care what any of them answer beyond recording
 * it. Everything else happens after the broadcast is over.
 */
export interface ProgrammeReplayArchive {
  /**
   * Open a recording for a run.
   *
   * A `none` retention is REFUSED here rather than accepted and then ignored,
   * with `policy-forbids-replay`. There is no honest status for a recording
   * that was never meant to exist: `recording` would be a lie an operator
   * could see in a list, and inventing a seventh state to mean "not one of
   * these" would put the absence of a replay inside the type that describes
   * replays. A refusal at the door says it once, and the archive keeps saying
   * it for that run.
   */
  begin(request: ReplayBeginRequest): Promise<ReplayOutcome<ReplayRecord>>;

  /**
   * Keep the initialisation material for an encoder generation.
   *
   * IDEMPOTENT ONLY FOR AN EXACT REPEAT. The same generation offered again
   * with the same reference and size is a retry, and leaves one copy and one
   * byte total. The same generation offered with DIFFERENT material is
   * refused as `initialisation-conflict`: one of the two decodes the fragments
   * this recording kept and the other does not, and letting the first arrival
   * win would settle that silently and wrongly.
   */
  retainInitialisation(
    runId: string,
    initialisation: ReplayInitialisation,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>>;

  /**
   * Keep a completed segment.
   *
   * `runId` names the RECORDING and the segment names its own run; a
   * disagreement is refused with `run-mismatch` rather than resolved. Silently
   * trusting either one would let last night's media into tonight's replay,
   * which is a tenancy failure that nothing downstream could detect.
   *
   * IDEMPOTENT ONLY FOR AN EXACT REPEAT, on the same terms as
   * `retainInitialisation`. A segment id offered again describing different
   * media -- another stretch of programme time, another size, another object,
   * another generation -- is refused as `segment-conflict`.
   *
   * A successful receipt means the archive OWNS this material. See the
   * ownership rule at the top of this file: a durable implementation acquires
   * its own copy or reference before answering.
   */
  retainSegment(
    runId: string,
    segment: ProgrammeMediaSegment,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>>;

  /**
   * The programme is over: make the recording whole, or say why it is not.
   *
   * This is the only route to `available`, and it is where a replay is checked
   * rather than assumed -- every retained segment must have the initialisation
   * material it needs, and there must be something to serve. A recording that
   * fails the check becomes `failed` with the reason, and the refusal returned
   * to the caller carries the same reason.
   */
  finalise(runId: string): Promise<ReplayOutcome<ReplayRecord>>;

  /**
   * Record that this recording cannot be made, and why.
   *
   * For the caller that learns from somewhere else -- an encoder that died, a
   * spool that could not be read -- that there is no point finalising.
   */
  fail(
    runId: string,
    reason: ReplayFailureReason,
    detail: string,
  ): Promise<ReplayOutcome<ReplayRecord>>;

  /**
   * Let a recording go because its retention ran out.
   *
   * NOT A WORKER. Nothing in this package watches a clock; a caller that has
   * one decides. Refused unless the retention actually states an expiry and
   * that instant has passed, so "expired" always means what it says.
   *
   * RETRY-SAFE. Expiring an already-expired recording succeeds and changes
   * nothing: no second transition, no new history entry, no media returning.
   * The cleanup that will eventually call this is at-least-once by nature -- a
   * process can remove an object and die before recording that it did -- and
   * the next attempt has to be able to repeat the instruction rather than
   * raise an incident about work that is already done.
   */
  expire(runId: string, nowMs: number): Promise<ReplayOutcome<ReplayRecord>>;

  /**
   * Remove a recording.
   *
   * The retained material becomes unreachable through this port and the record
   * says `deleted`.
   *
   * RETRY-SAFE, for the same reason as `expire`. Deleting an already-deleted
   * recording succeeds as a no-op: the status stays `deleted`, no second
   * transition is written, and nothing comes back. The instruction is "make
   * sure this is gone", and it is; a cleanup pass that runs twice must not be
   * distinguishable from one that ran once by anything except the log.
   *
   * NONE OF WHICH WEAKENS THE TERMINAL RULES. `deleted` still has no outgoing
   * transition, so a delete that arrives late still cannot be followed by a
   * finalisation, and nothing can return to `recording` or `available`.
   */
  delete(runId: string): Promise<ReplayOutcome<ReplayRecord>>;

  /** What this archive knows about a run, or null if it holds no recording. */
  describe(runId: string): Promise<ReplayRecord | null>;
}
