/** @author masterzee001 */
/**
 * What state a Replay is in, and which changes of state are meaningful.
 *
 * WHY A TABLE AND NOT A FIELD. A status held as a plain string is written by
 * whoever happens to be holding the record, and the transitions that matter
 * are the ones nobody intended: a deleted replay becoming available again
 * because a slow finaliser landed after the delete; a failed replay going back
 * to recording because a retry restarted the wrong thing. Both read as one
 * assignment in a diff, and both hand an audience a broadcast the operator
 * believed was gone. So the permitted moves are declared once, here, and
 * checked rather than remembered.
 *
 * THE STATES ARE ABOUT MEDIA, NOT ABOUT PRODUCT. `available` means the
 * retained media can be served. It says nothing about who may watch it --
 * that is visibility, which is a separate axis precisely so that making a
 * replay private is not confused with destroying it.
 */

/**
 * The life of one programme recording.
 *
 *   recording  - the programme is on air and its media is being retained.
 *   processing - the programme is over and the archive is being made whole:
 *                the moment where "we kept the bytes" is checked against
 *                "the bytes are playable".
 *   available  - the replay can be served.
 *   failed     - it cannot be served and never will be, and we know why.
 *   expired    - its retention ran out and it was let go.
 *   deleted    - somebody removed it.
 *
 * `processing` exists as a distinct state rather than a flag because the
 * check between recording and serving is where a replay is most likely to be
 * wrong: it is the only place that can discover that a retained segment's
 * initialisation material was never kept. A record that went straight from
 * recording to available would have nowhere to fail.
 */
export type ReplayStatus =
  | 'recording'
  | 'processing'
  | 'available'
  | 'failed'
  | 'expired'
  | 'deleted';

export const REPLAY_STATUSES: readonly ReplayStatus[] = [
  'recording',
  'processing',
  'available',
  'failed',
  'expired',
  'deleted',
];

export function isReplayStatus(value: unknown): value is ReplayStatus {
  return typeof value === 'string' && (REPLAY_STATUSES as readonly string[]).includes(value);
}

/**
 * Every move a replay is allowed to make, and by omission every one it is not.
 *
 * READ THE EMPTY LISTS FIRST. `deleted` goes nowhere: a removed replay is
 * removed, and a later finaliser arriving with good news must be refused
 * rather than resurrect it. `failed` and `expired` lead only to `deleted`,
 * which is a caller recording that the material is gone -- not a route back
 * into recording, which would let a retry reopen a broadcast that has ended.
 *
 * `available` cannot go back to `processing`. Re-processing a replay somebody
 * may already be watching is a new replay, not an edit of this one.
 */
export const REPLAY_TRANSITIONS: Readonly<Record<ReplayStatus, readonly ReplayStatus[]>> = {
  recording: ['processing', 'failed', 'deleted'],
  processing: ['available', 'failed', 'deleted'],
  available: ['expired', 'deleted'],
  failed: ['deleted'],
  expired: ['deleted'],
  deleted: [],
};

/** Whether a replay in `from` may become `to`. The only authority on this. */
export function canTransition(from: ReplayStatus, to: ReplayStatus): boolean {
  return REPLAY_TRANSITIONS[from].includes(to);
}

/**
 * Whether this replay will ever be servable again. It will not.
 *
 * Distinct from "has no transitions left": an expired replay may still be
 * deleted, and that is a real move. What it can never do is come back.
 */
export function isTerminalReplayStatus(status: ReplayStatus): boolean {
  return status === 'failed' || status === 'expired' || status === 'deleted';
}

/** Whether retained media may be served for a replay in this state. */
export function isServable(status: ReplayStatus): boolean {
  return status === 'available';
}

/** One step in a replay's life, kept so the record can be audited afterwards. */
export interface ReplayStatusChange {
  readonly status: ReplayStatus;
  readonly atMs: number;
}
