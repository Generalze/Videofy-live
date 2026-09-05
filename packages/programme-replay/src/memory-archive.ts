/** @author masterzee001 */
/**
 * An archive that keeps everything in this process, and nothing after it.
 *
 * WHAT IT IS FOR. Every rule in this package is a rule about behaviour rather
 * than about storage -- a run may not accept another run's media, a repeated
 * segment may not be counted twice, a recording may not be called available
 * while material it needs is missing -- and none of them needs a disk to be
 * true or to be tested. Landing them against an implementation with no I/O is
 * what lets the durable one that follows be judged against something.
 *
 * HONEST ABOUT WHAT IT IS. It does not pretend to survive a restart, and a
 * deployment that wants a replay to exist tomorrow must use a different
 * implementation of the same port. The rules do not move when it does.
 */

import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type {
  ProgrammeReplayArchive,
  ReplayBeginRequest,
  ReplayRecord,
  ReplayRetentionReceipt,
} from './archive.js';
import { canTransition, type ReplayStatus, type ReplayStatusChange } from './lifecycle.js';
import {
  initialisationConflict,
  missingInitGenerations,
  retainedBytes,
  segmentConflict,
  segmentUnfitForReplay,
  type ReplayInitialisation,
} from './media.js';
import {
  replayFailure,
  replayOk,
  replayRefused,
  type ReplayFailure,
  type ReplayFailureReason,
  type ReplayOutcome,
} from './outcome.js';
import { decideRetention, type ReplayRetention, type ReplayVisibility } from './policy.js';

/** The mutable inside of a recording. `ReplayRecord` is the copy callers see. */
interface Recording {
  readonly identity: ProgrammeRunIdentity;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly startedAtMs: number;
  status: ReplayStatus;
  finalisedAtMs: number | null;
  segments: ProgrammeMediaSegment[];
  initialisations: ReplayInitialisation[];
  failure: ReplayFailure | null;
  history: ReplayStatusChange[];
}

export class InMemoryReplayArchive implements ProgrammeReplayArchive {
  private readonly recordings = new Map<string, Recording>();

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

    /*
     * THE RETENTION IS RE-CHECKED, whatever its type says.
     *
     * Two reasons. The union cannot express that an expiry is in the FUTURE,
     * and a channel setting read from a database in a later wave arrives as
     * loose numbers and strings rather than as a union somebody constructed
     * carefully. And because this package invents no defaults, a policy that
     * failed to resolve must be refused here rather than quietly becoming one:
     * an absent or unrecognised policy is a configuration failure, and the
     * caller has to hear about it.
     */
    const decided = decideRetention(
      request.retention.policy === 'expire'
        ? { policy: 'expire', expiresAtMs: request.retention.expiresAtMs }
        : { policy: request.retention.policy },
      request.startedAtMs,
    );
    if (!decided.ok) return { ok: false, failure: decided.failure };
    const retention = decided.value;

    if (retention.policy === 'none') {
      this.declined.add(runId);
      return replayRefused(
        'policy-forbids-replay',
        `run ${runId} is configured to keep no replay`,
      );
    }

    /*
     * A RUN THAT WAS DECLINED STAYS DECLINED. Reopening it under a different
     * policy would mean part of a broadcast was recorded and part was not,
     * which is a recording nobody asked for and an operator cannot reason
     * about. Changing what is kept is a decision for the next airing.
     */
    if (this.declined.has(runId)) {
      return replayRefused(
        'policy-forbids-replay',
        `run ${runId} is configured to keep no replay`,
      );
    }

    /*
     * A SECOND BEGIN IS REFUSED. A caller that opens a recording twice for one
     * run has either lost track of the broadcast or is racing another writer,
     * and quietly returning the existing record would let the second caller
     * carry on believing it owns something it does not.
     */
    const existing = this.recordings.get(runId);
    if (existing !== undefined) {
      return replayRefused(
        'lifecycle-transition-refused',
        `run ${runId} already has a replay in status ${existing.status}`,
      );
    }

    const recording: Recording = {
      identity: request.identity,
      retention,
      visibility: request.visibility,
      startedAtMs: request.startedAtMs,
      status: 'recording',
      finalisedAtMs: null,
      segments: [],
      initialisations: [],
      failure: null,
      history: [{ status: 'recording', atMs: request.startedAtMs }],
    };
    this.recordings.set(runId, recording);
    return replayOk(snapshot(recording));
  }

  async retainInitialisation(
    runId: string,
    initialisation: ReplayInitialisation,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    const found = this.open(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    if (initialisation.runId !== runId) {
      return replayRefused(
        'run-mismatch',
        `initialisation for run ${initialisation.runId} was offered to the replay of run ${runId}`,
      );
    }

    /*
     * A GENERATION IS ACCEPTED ONCE, identified by its number within the run,
     * which is how the live path already names it. An encoder observed twice
     * by a poll, or a recovery that replayed a journal it had already
     * replayed, must not leave two copies or double the byte total.
     *
     * BUT ONLY AN EXACT REPEAT IS A REPEAT. The same generation pointing at
     * different material is two producers disagreeing about what decodes this
     * recording, and one of them is wrong. Letting the first arrival win would
     * settle that silently and leave a replay that fails at playback with
     * nothing left to ask.
     */
    const held = recording.initialisations.find(
      (candidate) => candidate.generation === initialisation.generation,
    );
    if (held !== undefined) {
      const conflict = initialisationConflict(held, initialisation);
      if (conflict !== null) return replayRefused('initialisation-conflict', conflict);
      return replayOk(receipt(recording, false));
    }

    recording.initialisations.push(initialisation);
    return replayOk(receipt(recording, true));
  }

  async retainSegment(
    runId: string,
    segment: ProgrammeMediaSegment,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    const found = this.open(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    /*
     * RUN ISOLATION IS CHECKED FIRST and never resolved. Two airings of one
     * programme are two broadcasts; accepting one recording's media into the
     * other would produce a replay that nothing downstream could tell was
     * wrong, because every segment in it is individually valid.
     */
    if (segment.runId !== runId) {
      return replayRefused(
        'run-mismatch',
        `media for run ${segment.runId} was offered to the replay of run ${runId}`,
      );
    }

    const unfit = segmentUnfitForReplay(segment);
    if (unfit !== null) return replayRefused('segment-invalid', unfit);

    /*
     * The same rule as initialisation material: an identical notification is a
     * retry and is absorbed, a segment id describing DIFFERENT media is a
     * media-integrity conflict and is refused. The second case is the one that
     * would otherwise produce a recording that is valid segment by segment and
     * wrong as a whole.
     */
    const held = recording.segments.find(
      (candidate) => candidate.segmentId === segment.segmentId,
    );
    if (held !== undefined) {
      const conflict = segmentConflict(held, segment);
      if (conflict !== null) return replayRefused('segment-conflict', conflict);
      return replayOk(receipt(recording, false));
    }

    recording.segments.push(segment);
    return replayOk(receipt(recording, true));
  }

  async finalise(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    if (!canTransition(recording.status, 'processing')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${recording.status} cannot be finalised`,
      );
    }
    this.move(recording, 'processing');

    /*
     * THIS IS THE ONLY PLACE A REPLAY IS CHECKED RATHER THAN ASSUMED, and the
     * only route to `available`. Both checks below describe material that is
     * undecodable rather than merely disappointing: nothing to play, or
     * fragments whose initialisation was never kept. A replay that failed
     * either one and still claimed to be available would be discovered by a
     * viewer weeks later, with no encoder left to ask.
     */
    if (recording.segments.length === 0) {
      return {
        ok: false,
        failure: this.recordFailure(
          recording,
          'no-media-retained',
          `run ${runId} finished having retained no replay media`,
        ),
      };
    }

    const missing = missingInitGenerations(recording.segments, recording.initialisations);
    if (missing.length > 0) {
      return {
        ok: false,
        failure: this.recordFailure(
          recording,
          'initialisation-missing',
          `run ${runId} retained segments needing initialisation generations ${missing.join(', ')}, which were never retained`,
        ),
      };
    }

    recording.finalisedAtMs = this.now();
    this.move(recording, 'available');
    return replayOk(snapshot(recording));
  }

  async fail(
    runId: string,
    reason: ReplayFailureReason,
    detail: string,
  ): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    if (!canTransition(recording.status, 'failed')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${recording.status} cannot be failed`,
      );
    }

    /*
     * SUCCEEDS. The caller asked us to write down that the recording is not
     * going to happen, and we did. The failure is on the record, not in the
     * outcome -- a refusal here would mean "we could not even record that",
     * which is a different and much rarer thing.
     */
    this.recordFailure(recording, reason, detail);
    return replayOk(snapshot(recording));
  }

  async expire(runId: string, nowMs: number): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    /*
     * ALREADY EXPIRED IS A SUCCESS, and it is checked FIRST -- before the
     * policy and before the clock. The cleanup that will eventually call this
     * is at-least-once by nature: a process can release an object and die
     * before recording that it did, and the retry may well arrive carrying a
     * different `nowMs`. Making it re-argue its case against an expiry it has
     * already honoured would turn finished work into an incident.
     *
     * Nothing is written. No second transition, no new history entry, no media
     * returning: the answer describes the state that is already true.
     */
    if (recording.status === 'expired') return replayOk(snapshot(recording));

    if (recording.retention.policy !== 'expire') {
      return replayRefused(
        'lifecycle-transition-refused',
        `run ${runId} is retained under policy ${recording.retention.policy}, which never expires`,
      );
    }
    if (nowMs < recording.retention.expiresAtMs) {
      return replayRefused(
        'lifecycle-transition-refused',
        `run ${runId} expires at ${recording.retention.expiresAtMs} and it is ${nowMs}`,
      );
    }
    if (!canTransition(recording.status, 'expired')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${recording.status} cannot expire`,
      );
    }

    this.letGo(recording);
    this.move(recording, 'expired');
    return replayOk(snapshot(recording));
  }

  async delete(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    const found = this.recording(runId);
    if (!found.ok) return { ok: false, failure: found.failure };
    const recording = found.value;

    /*
     * THE SECOND DELETE SUCCEEDS AS A NO-OP. The instruction is "make sure
     * this is gone", and it is. A future cleanup worker deleting an object and
     * dying before it records that it did will repeat the command, and a
     * refusal there would raise an incident about work that is already
     * finished.
     *
     * Nothing is written -- the status stays `deleted`, no second transition
     * is appended, and no media comes back. This does not soften the terminal
     * rules one bit: `deleted` still has no outgoing transition, so a late
     * finaliser is still refused and nothing returns to `recording` or
     * `available`.
     */
    if (recording.status === 'deleted') return replayOk(snapshot(recording));

    if (!canTransition(recording.status, 'deleted')) {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${recording.status} cannot be deleted`,
      );
    }

    this.letGo(recording);
    this.move(recording, 'deleted');
    return replayOk(snapshot(recording));
  }

  async describe(runId: string): Promise<ReplayRecord | null> {
    const recording = this.recordings.get(runId);
    return recording === undefined ? null : snapshot(recording);
  }

  /* ------------------------------------------------------------- internals */

  /** A recording this archive holds, or the reason there is not one. */
  private recording(runId: string): ReplayOutcome<Recording> {
    if (this.declined.has(runId)) {
      return replayRefused('policy-forbids-replay', `run ${runId} is configured to keep no replay`);
    }
    const recording = this.recordings.get(runId);
    if (recording === undefined) {
      return replayRefused('unknown-replay', `no replay was begun for run ${runId}`);
    }
    return replayOk(recording);
  }

  /** A recording that is still accepting material. */
  private open(runId: string): ReplayOutcome<Recording> {
    const found = this.recording(runId);
    if (!found.ok) return found;
    if (found.value.status !== 'recording') {
      return replayRefused(
        'lifecycle-transition-refused',
        `a replay in status ${found.value.status} no longer accepts media`,
      );
    }
    return found;
  }

  private move(recording: Recording, to: ReplayStatus): void {
    recording.status = to;
    recording.history.push({ status: to, atMs: this.now() });
  }

  /**
   * Write the failure onto the record and refuse.
   *
   * Both halves matter. The refusal is what the caller acts on; the record is
   * what an operator reads afterwards, and a replay that returned a failure
   * while still describing itself as recording would be the same lie told
   * twice.
   */
  private recordFailure(
    recording: Recording,
    reason: ReplayFailureReason,
    detail: string,
  ): ReplayFailure {
    const failure = replayFailure(reason, detail);
    recording.failure = failure;
    this.move(recording, 'failed');
    return failure;
  }

  /** The material is gone. What the record says about it goes with it. */
  private letGo(recording: Recording): void {
    recording.segments = [];
    recording.initialisations = [];
  }
}

function receipt(recording: Recording, stored: boolean): ReplayRetentionReceipt {
  return {
    stored,
    segmentCount: recording.segments.length,
    initialisationCount: recording.initialisations.length,
    bytes: retainedBytes(recording.segments, recording.initialisations),
  };
}

/**
 * What a caller is given: a copy, never the archive's own arrays.
 *
 * A record handed out by reference is a record a caller can edit, and the
 * edit that matters is the one that sets a status.
 */
function snapshot(recording: Recording): ReplayRecord {
  return {
    identity: recording.identity,
    retention: recording.retention,
    visibility: recording.visibility,
    status: recording.status,
    startedAtMs: recording.startedAtMs,
    finalisedAtMs: recording.finalisedAtMs,
    expiresAtMs:
      recording.retention.policy === 'expire' ? recording.retention.expiresAtMs : null,
    segments: [...recording.segments],
    initialisations: [...recording.initialisations],
    bytes: retainedBytes(recording.segments, recording.initialisations),
    failure: recording.failure,
    history: [...recording.history],
  };
}
