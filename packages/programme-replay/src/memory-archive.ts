/** @author masterzee001 */
/**
 * An archive that keeps everything in this process, and nothing after it.
 *
 * WHAT IT IS FOR. Every rule this package enforces is a rule about behaviour
 * rather than about storage -- a run may not accept another run's media, a
 * repeated segment may not be counted twice, a recording may not be called
 * available while material it needs is missing -- and none of them needs a
 * disk to be true or to be tested. Landing them against an implementation with
 * no I/O is what lets the durable one be judged against something.
 *
 * IT OWNS NOTHING, and says so. The bytes stay wherever the caller put them,
 * so the archive reference it reports IS the offered one, and a caller sees
 * back exactly the object it handed over. That is honest for a store which
 * cannot outlive its process, and it is the one property `FilesystemReplayArchive`
 * exists to change.
 *
 * The rules themselves are in `recording.ts` and are shared with every other
 * archive. What is left here is a Map.
 */

import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type {
  ProgrammeReplayArchive,
  ReplayBeginRequest,
  ReplayRecord,
  ReplayRetentionReceipt,
} from './archive.js';
import { canTransition } from './lifecycle.js';
import type { ReplayInitialisation } from './media.js';
import {
  replayOk,
  replayRefused,
  type ReplayFailureReason,
  type ReplayOutcome,
} from './outcome.js';
import {
  beginFinalisation,
  finalisationComplaint,
  judgeBegin,
  judgeInitialisation,
  judgeSegment,
  move,
  receiptOf,
  recordFailure,
  recordInitialisation,
  recordSegment,
  releaseMedia,
  snapshotOf,
  type RecordingState,
} from './recording.js';

export class InMemoryReplayArchive implements ProgrammeReplayArchive {
  private readonly recordings = new Map<string, RecordingState>();

  /**
   * Runs whose operator asked for no replay.
   *
   * REMEMBERED RATHER THAN FORGOTTEN. Without this, a segment offered for a
   * `none` run would be refused as `unknown-replay` -- true in a narrow sense
   * and misleading in every useful one, because it reads as "something is
   * wrong with the wiring" when the answer is "the operator chose this". The
   * distinction is exactly what a caller deciding whether to alert needs.
   */
  private readonly declined = new Set<string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async begin(request: ReplayBeginRequest): Promise<ReplayOutcome<ReplayRecord>> {
    const runId = request.identity.runId;
    const judgement = judgeBegin(request, {
      declined: this.declined.has(runId),
      existingStatus: this.recordings.get(runId)?.status ?? null,
    });

    if (judgement.kind === 'declined') {
      this.declined.add(runId);
      return { ok: false, failure: judgement.failure };
    }
    if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };

    this.recordings.set(runId, judgement.state);
    return replayOk(snapshotOf(judgement.state));
  }

  async retainInitialisation(
    runId: string,
    initialisation: ReplayInitialisation,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    const judgement = judgeInitialisation(state, runId, initialisation);
    if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
    if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

    // Nothing is copied: this archive owns no bytes, so the reference it
    // reports is the one it was given.
    recordInitialisation(state, initialisation, initialisation.storageReference);
    return replayOk(receiptOf(state, true));
  }

  async retainSegment(
    runId: string,
    segment: ProgrammeMediaSegment,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    const judgement = judgeSegment(state, runId, segment);
    if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
    if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

    recordSegment(state, segment, segment.storageReference);
    return replayOk(receiptOf(state, true));
  }

  async finalise(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    const refusal = beginFinalisation(state, this.now());
    if (refusal !== null) return { ok: false, failure: refusal };

    const complaint = finalisationComplaint(state, runId);
    if (complaint !== null) {
      return {
        ok: false,
        failure: recordFailure(state, complaint.reason, complaint.detail, this.now()),
      };
    }

    state.finalisedAtMs = this.now();
    move(state, 'available', this.now());
    return replayOk(snapshotOf(state));
  }

  async fail(
    runId: string,
    reason: ReplayFailureReason,
    detail: string,
  ): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    if (!canTransition(state.status, 'failed')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${state.status} cannot be failed`,
      );
    }

    /*
     * SUCCEEDS. The caller asked us to write down that the recording is not
     * going to happen, and we did. The failure is on the record, not in the
     * outcome -- a refusal here would mean "we could not even record that",
     * which is a different and much rarer thing.
     */
    recordFailure(state, reason, detail, this.now());
    return replayOk(snapshotOf(state));
  }

  async expire(runId: string, nowMs: number): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    /*
     * ALREADY EXPIRED IS A SUCCESS, and it is checked FIRST -- before the
     * policy and before the clock. The cleanup that will eventually call this
     * is at-least-once by nature: a process can release an object and die
     * before recording that it did, and the retry may well arrive carrying a
     * different `nowMs`. Making it re-argue its case against an expiry it has
     * already honoured would turn finished work into an incident.
     */
    if (state.status === 'expired') return replayOk(snapshotOf(state));

    if (state.retention.policy !== 'expire') {
      return replayRefused(
        'lifecycle-transition-refused',
        `run ${runId} is retained under policy ${state.retention.policy}, which never expires`,
      );
    }
    if (nowMs < state.retention.expiresAtMs) {
      return replayRefused(
        'lifecycle-transition-refused',
        `run ${runId} expires at ${state.retention.expiresAtMs} and it is ${nowMs}`,
      );
    }
    if (!canTransition(state.status, 'expired')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${state.status} cannot expire`,
      );
    }

    releaseMedia(state);
    move(state, 'expired', this.now());
    return replayOk(snapshotOf(state));
  }

  async delete(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const state = found.value;

    /*
     * THE SECOND DELETE SUCCEEDS AS A NO-OP. The instruction is "make sure
     * this is gone", and it is. A future cleanup worker deleting an object and
     * dying before it records that it did will repeat the command, and a
     * refusal there would raise an incident about work already finished.
     *
     * This does not soften the terminal rules: `deleted` still has no outgoing
     * transition, so a late finaliser is still refused.
     */
    if (state.status === 'deleted') return replayOk(snapshotOf(state));

    if (!canTransition(state.status, 'deleted')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${state.status} cannot be deleted`,
      );
    }

    releaseMedia(state);
    move(state, 'deleted', this.now());
    return replayOk(snapshotOf(state));
  }

  async describe(runId: string): Promise<ReplayRecord | null> {
    const state = this.recordings.get(runId);
    return state === undefined ? null : snapshotOf(state);
  }

  /* ------------------------------------------------------------- internals */

  /** A recording this archive holds, or the reason there is not one. */
  private recording(runId: string): ReplayOutcome<RecordingState> {
    if (this.declined.has(runId)) {
      return replayRefused('policy-forbids-replay', `run ${runId} is configured to keep no replay`);
    }
    const state = this.recordings.get(runId);
    if (state === undefined) {
      return replayRefused('unknown-replay', `no replay was begun for run ${runId}`);
    }
    return replayOk(state);
  }
}
