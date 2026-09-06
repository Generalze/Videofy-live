/** @author masterzee001 */
/**
 * The rules of a recording, with nowhere to put it.
 *
 * WHY THIS FILE EXISTS. There are two archives now -- one that keeps a
 * broadcast in this process and one that keeps it on a disk -- and there will
 * be more. Every one of them has to enforce the same things: a run may not
 * take another run's media, an exact repeat is a retry and a changed repeat is
 * corruption, a recording cannot be called available while material it needs
 * is missing, and a deleted recording never comes back. Written twice, those
 * rules drift, and the drift shows up as one storage backend quietly accepting
 * what another refuses.
 *
 * So the rules live here, once, and know nothing about storage. They decide;
 * an archive does. `judgeSegment` says whether this fragment should be stored,
 * ignored or refused, and the caller is free to spend a second copying bytes
 * before calling `recordSegment` -- or to spend nothing at all, which is what
 * the in-memory one does.
 *
 * WHAT AN ARCHIVE STILL OWNS: where the bytes go, how they are made durable,
 * how concurrent callers are ordered, and how any of that survives a restart.
 * None of which changes a single rule below.
 */

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ReplayBeginRequest, ReplayRecord, ReplayRetentionReceipt } from './archive.js';
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
  type ReplayFailure,
  type ReplayFailureReason,
} from './outcome.js';
import { decideRetention, type ReplayRetention, type ReplayVisibility } from './policy.js';

/* ------------------------------------------------------- retained material */

/**
 * One retained fragment: what was offered, and where the archive put it.
 *
 * BOTH REFERENCES MATTER, AND THEY ARE NOT THE SAME ONE.
 *
 * `offered` is the description the live path handed over, and its
 * `storageReference` points into the live spool -- a location with an expiry
 * date, since the spool prunes as the audience advances and is released when
 * the broadcast ends. It is kept verbatim because it is the IDENTITY of this
 * fragment: a retry offering the same segment id must be compared against what
 * was originally offered, or an archive that substitutes its own path would
 * find every ordinary retry looking like a conflict.
 *
 * `archiveReference` is where the archive owns the bytes. It is what a caller
 * is shown, because that is the copy that will still be there next month.
 *
 * An archive that owns nothing sets the two equal, and callers see exactly the
 * object they offered.
 */
export interface RetainedSegment {
  readonly offered: ProgrammeMediaSegment;
  readonly archiveReference: string;
}

export interface RetainedInitialisation {
  readonly offered: ReplayInitialisation;
  readonly archiveReference: string;
}

/** The mutable inside of a recording. `ReplayRecord` is the copy callers see. */
export interface RecordingState {
  readonly identity: ProgrammeRunIdentity;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly startedAtMs: number;
  status: ReplayStatus;
  finalisedAtMs: number | null;
  segments: RetainedSegment[];
  initialisations: RetainedInitialisation[];
  failure: ReplayFailure | null;
  history: ReplayStatusChange[];
}

/* -------------------------------------------------------------- judgements */

/** Whether material should be stored, was already held, or is refused. */
export type Judgement =
  | { readonly kind: 'store' }
  /** Already held, byte for byte. A retry, and not an error. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refused'; readonly failure: ReplayFailure };

export type BeginJudgement =
  /** The operator asked for no replay. The caller must remember this run. */
  | { readonly kind: 'declined'; readonly failure: ReplayFailure }
  | { readonly kind: 'refused'; readonly failure: ReplayFailure }
  | { readonly kind: 'open'; readonly state: RecordingState };

/** What an archive already knows about a run before it is asked to open one. */
export interface RunKnowledge {
  /** A previous `begin` for this run was declined by a `none` policy. */
  readonly declined: boolean;
  /** The status of the recording this archive already holds, if any. */
  readonly existingStatus: ReplayStatus | null;
}

function refused(reason: ReplayFailureReason, detail: string): { kind: 'refused'; failure: ReplayFailure } {
  return { kind: 'refused', failure: replayFailure(reason, detail) };
}

/**
 * Whether a recording may be opened, and what it looks like if so.
 *
 * The retention is re-checked whatever its type says: the union cannot express
 * that an expiry is in the FUTURE, and a channel setting read from a database
 * in a later wave arrives as loose numbers rather than as a union somebody
 * constructed carefully. A policy that failed to resolve is refused rather
 * than quietly becoming one, because this package invents no defaults.
 */
export function judgeBegin(request: ReplayBeginRequest, known: RunKnowledge): BeginJudgement {
  const decided = decideRetention(
    request.retention.policy === 'expire'
      ? { policy: 'expire', expiresAtMs: request.retention.expiresAtMs }
      : { policy: request.retention.policy },
    request.startedAtMs,
  );
  if (!decided.ok) return { kind: 'refused', failure: decided.failure };
  const retention = decided.value;
  const runId = request.identity.runId;

  if (retention.policy === 'none') {
    return {
      kind: 'declined',
      failure: replayFailure('policy-forbids-replay', `run ${runId} is configured to keep no replay`),
    };
  }

  /*
   * A RUN THAT WAS DECLINED STAYS DECLINED. Reopening it under a different
   * policy would mean part of a broadcast was recorded and part was not, which
   * is a recording nobody asked for and an operator cannot reason about.
   */
  if (known.declined) {
    return refused('policy-forbids-replay', `run ${runId} is configured to keep no replay`);
  }

  /*
   * A SECOND BEGIN IS REFUSED. A caller that opens a recording twice for one
   * run has either lost track of the broadcast or is racing another writer,
   * and quietly returning the existing record would let the second caller
   * carry on believing it owns something it does not.
   */
  if (known.existingStatus !== null) {
    return refused(
      'lifecycle-transition-refused',
      `run ${runId} already has a replay in status ${known.existingStatus}`,
    );
  }

  return {
    kind: 'open',
    state: {
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
    },
  };
}

/** Whether this recording is still taking material. The complaint, or null. */
export function refusalIfClosed(state: RecordingState): ReplayFailure | null {
  if (state.status === 'recording') return null;
  return replayFailure(
    'lifecycle-transition-refused',
    `a replay in status ${state.status} no longer accepts media`,
  );
}

/**
 * Whether an initialisation offer should be stored, ignored, or refused.
 *
 * A generation is accepted once, identified by its number within the run --
 * which is how the live path already names it. But only an EXACT repeat is a
 * repeat: the same generation pointing at different material means two
 * producers disagree about what decodes this recording, and letting the first
 * arrival win would settle that silently and leave a replay that fails at
 * playback with nothing left to ask.
 */
export function judgeInitialisation(
  state: RecordingState,
  runId: string,
  initialisation: ReplayInitialisation,
): Judgement {
  const closed = refusalIfClosed(state);
  if (closed !== null) return { kind: 'refused', failure: closed };

  if (initialisation.runId !== runId) {
    return refused(
      'run-mismatch',
      `initialisation for run ${initialisation.runId} was offered to the replay of run ${runId}`,
    );
  }

  const held = state.initialisations.find(
    (candidate) => candidate.offered.generation === initialisation.generation,
  );
  if (held !== undefined) {
    const conflict = initialisationConflict(held.offered, initialisation);
    if (conflict !== null) return refused('initialisation-conflict', conflict);
    return { kind: 'duplicate' };
  }
  return { kind: 'store' };
}

/**
 * Whether a segment offer should be stored, ignored, or refused.
 *
 * RUN ISOLATION IS CHECKED FIRST and never resolved. Two airings of one
 * programme are two broadcasts; accepting one recording's media into the other
 * would produce a replay that nothing downstream could tell was wrong, because
 * every segment in it is individually valid.
 */
export function judgeSegment(
  state: RecordingState,
  runId: string,
  segment: ProgrammeMediaSegment,
): Judgement {
  const closed = refusalIfClosed(state);
  if (closed !== null) return { kind: 'refused', failure: closed };

  if (segment.runId !== runId) {
    return refused(
      'run-mismatch',
      `media for run ${segment.runId} was offered to the replay of run ${runId}`,
    );
  }

  const unfit = segmentUnfitForReplay(segment);
  if (unfit !== null) return refused('segment-invalid', unfit);

  const held = state.segments.find(
    (candidate) => candidate.offered.segmentId === segment.segmentId,
  );
  if (held !== undefined) {
    const conflict = segmentConflict(held.offered, segment);
    if (conflict !== null) return refused('segment-conflict', conflict);
    return { kind: 'duplicate' };
  }
  return { kind: 'store' };
}

/* ---------------------------------------------------------------- mutation */

export function recordInitialisation(
  state: RecordingState,
  offered: ReplayInitialisation,
  archiveReference: string,
): void {
  state.initialisations.push({ offered, archiveReference });
}

export function recordSegment(
  state: RecordingState,
  offered: ProgrammeMediaSegment,
  archiveReference: string,
): void {
  state.segments.push({ offered, archiveReference });
}

export function move(state: RecordingState, to: ReplayStatus, atMs: number): void {
  state.status = to;
  state.history.push({ status: to, atMs });
}

/** Write the failure onto the record. Returns it, for the caller to report. */
export function recordFailure(
  state: RecordingState,
  reason: ReplayFailureReason,
  detail: string,
  atMs: number,
): ReplayFailure {
  const failure = replayFailure(reason, detail);
  state.failure = failure;
  move(state, 'failed', atMs);
  return failure;
}

/** The material is gone. What the record says about it goes with it. */
export function releaseMedia(state: RecordingState): void {
  state.segments = [];
  state.initialisations = [];
}

/* ------------------------------------------------------------ finalisation */

/** Whether finalisation may begin. Moves to `processing` when it may. */
export function beginFinalisation(state: RecordingState, atMs: number): ReplayFailure | null {
  if (!canTransition(state.status, 'processing')) {
    return replayFailure(
      'lifecycle-transition-refused',
      `a replay in status ${state.status} cannot be finalised`,
    );
  }
  move(state, 'processing', atMs);
  return null;
}

/**
 * The checks that stand between a kept recording and a playable one.
 *
 * Both describe material that is undecodable rather than merely disappointing:
 * nothing to play, or fragments whose initialisation was never kept. Returns
 * the complaint, or null when the recording is whole.
 */
export function finalisationComplaint(
  state: RecordingState,
  runId: string,
): { readonly reason: ReplayFailureReason; readonly detail: string } | null {
  if (state.segments.length === 0) {
    return {
      reason: 'no-media-retained',
      detail: `run ${runId} finished having retained no replay media`,
    };
  }
  const missing = missingInitGenerations(
    state.segments.map((entry) => entry.offered),
    state.initialisations.map((entry) => entry.offered),
  );
  if (missing.length > 0) {
    return {
      reason: 'initialisation-missing',
      detail: `run ${runId} retained segments needing initialisation generations ${missing.join(', ')}, which were never retained`,
    };
  }
  return null;
}

/* ------------------------------------------------------------ presentation */

/**
 * What a caller is shown for one fragment: the archive's copy of it.
 *
 * When the archive substituted nothing -- because it owns nothing -- the
 * offered object is handed back UNCHANGED rather than rebuilt. A caller
 * comparing what it offered against what is held should find the same object,
 * and an implementation detail is a poor reason for it not to.
 */
export function publicSegment(entry: RetainedSegment): ProgrammeMediaSegment {
  if (entry.archiveReference === entry.offered.storageReference) return entry.offered;
  return { ...entry.offered, storageReference: entry.archiveReference };
}

export function publicInitialisation(entry: RetainedInitialisation): ReplayInitialisation {
  if (entry.archiveReference === entry.offered.storageReference) return entry.offered;
  return { ...entry.offered, storageReference: entry.archiveReference };
}

/**
 * What a caller is given: a copy, never the archive's own arrays.
 *
 * A record handed out by reference is a record a caller can edit, and the edit
 * that matters is the one that sets a status.
 */
export function snapshotOf(state: RecordingState): ReplayRecord {
  const segments = state.segments.map(publicSegment);
  const initialisations = state.initialisations.map(publicInitialisation);
  return {
    identity: state.identity,
    retention: state.retention,
    visibility: state.visibility,
    status: state.status,
    startedAtMs: state.startedAtMs,
    finalisedAtMs: state.finalisedAtMs,
    expiresAtMs: state.retention.policy === 'expire' ? state.retention.expiresAtMs : null,
    segments,
    initialisations,
    bytes: retainedBytes(segments, initialisations),
    failure: state.failure,
    history: [...state.history],
  };
}

export function receiptOf(state: RecordingState, stored: boolean): ReplayRetentionReceipt {
  return {
    stored,
    segmentCount: state.segments.length,
    initialisationCount: state.initialisations.length,
    bytes: retainedBytes(
      state.segments.map((entry) => entry.offered),
      state.initialisations.map((entry) => entry.offered),
    ),
  };
}
