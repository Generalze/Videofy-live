/** @author masterzee001 */
/**
 * The fact that a programme went out, which is not the same fact as its replay.
 *
 * WHY THESE ARE TWO THINGS. An archive answers "do the bytes exist and may they
 * be played". A catalogue answers "which airing of which programme happened on
 * which channel, and what became of its recording". Collapsing them looks
 * tidier and quietly loses history: a broadcast whose operator chose to keep
 * nothing has no replay to be a row of, and one whose replay expired last month
 * would vanish from the schedule the moment its media was released.
 *
 *     MEDIA MAY EXPIRE. HISTORY DOES NOT DISAPPEAR WITH IT.
 *
 * So the thing catalogued is an AIRING -- channel, programme, run, when -- and
 * the replay is optional state hanging off it. `none` is a first-class answer,
 * not an absent one, and it is never dressed up as a deleted or failed replay:
 * those describe recordings that existed and stopped existing, which is a
 * different thing to have happened.
 *
 * A PROJECTION, NEVER AN AUTHORITY. Everything below is derived from a
 * `ReplayRecord` the archive already committed. If this catalogue and the
 * archive ever disagree, the archive is right: it holds the media and it
 * decides what may be played. A stale catalogue makes history briefly wrong,
 * which is a bookkeeping problem. A catalogue that could authorise playback
 * would make a deleted recording watchable, which is not.
 *
 * NOTHING HERE KNOWS WHERE ANYTHING IS. No storage reference, no archive root,
 * no filesystem key, no segment list. A catalogue row is metadata about a
 * broadcast, and a database that also held paths would be an archive-path leak
 * with a schema.
 */

import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ReplayRecord } from './archive.js';
import { REPLAY_TRANSITIONS, type ReplayStatus } from './lifecycle.js';
import type { ReplayFailure, ReplayFailureReason } from './outcome.js';
import type { ReplayRetention, ReplayVisibility } from './policy.js';

/* --------------------------------------------------------- failure, safely */

/**
 * What a catalogue may say about a failed recording.
 *
 * THE REASON, AND A SENTENCE THIS FILE WROTE. Never the archive's own detail.
 *
 * A `ReplayFailure.detail` is operator text assembled where the failure
 * happened, and some of those places have a path in hand: a
 * `source-media-unavailable` names the spool file that could not be copied.
 * That is exactly right for a log on the box and exactly wrong for a product
 * database, which is queried by other things, backed up elsewhere, and read by
 * people who should never learn the shape of a volume.
 *
 * MAPPED, NOT SCRUBBED. Stripping paths out of arbitrary text means guessing at
 * every shape a path can take, on every platform, forever -- and being wrong
 * once is a leak that looks like a success. A closed set of reasons has a
 * closed set of sentences, and an unrecognised reason gets the vaguest one
 * rather than the original string.
 */
export interface ReplayFailureSummary {
  readonly reason: ReplayFailureReason;
  /** Fixed text chosen here. Never anything the failure carried. */
  readonly summary: string;
}

const FAILURE_SUMMARIES: Readonly<Record<ReplayFailureReason, string>> = {
  'retention-configuration-invalid': 'The replay retention configuration was not usable.',
  'policy-forbids-replay': 'This programme was configured to keep no replay.',
  'run-mismatch': 'Media from another broadcast was offered to this replay.',
  'segment-invalid': 'Programme media was not fit to be replayed.',
  'segment-conflict': 'Two producers disagreed about a segment of this programme.',
  'initialisation-missing': 'Replay initialisation material was missing.',
  'initialisation-conflict': 'Two producers disagreed about this replay initialisation material.',
  'no-media-retained': 'No programme media was retained for this replay.',
  'archive-unavailable': 'The replay archive was unavailable.',
  'source-media-unavailable':
    'Programme media became unavailable before replay retention completed.',
  'media-origin-failed': 'The programme media origin failed before the replay completed.',
  'lifecycle-transition-refused': 'The replay could not move to the state that was asked for.',
  'unknown-replay': 'No replay was begun for this broadcast.',
};

/** A safe sentence for a failure, keeping only its reason. */
export function summariseFailure(failure: ReplayFailure | null): ReplayFailureSummary | null {
  if (failure === null) return null;
  return {
    reason: failure.reason,
    // An unrecognised reason gets the vaguest sentence, never the raw detail:
    // a reason added later must not become a leak by being forgotten here.
    summary: FAILURE_SUMMARIES[failure.reason] ?? 'The replay failed.',
  };
}

/* ------------------------------------------------------------- the summary */

/**
 * What the catalogue keeps about a recording: enough to describe it, never
 * enough to find it.
 *
 * Counts and a byte total rather than the segments themselves. "How long and
 * how big" is what a history page asks; the list of fragments is the archive's
 * business and belongs where the fragments are.
 */
export interface ReplaySummary {
  readonly status: ReplayStatus;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly finalisedAtMs: number | null;
  readonly expiresAtMs: number | null;
  /**
   * Why it failed, in words this package chose. Never the archive's detail.
   *
   * See `summariseFailure`: the archive's own text can name a spool file, and a
   * product database is the wrong place for one.
   */
  readonly failure: ReplayFailureSummary | null;
  readonly bytes: number;
  readonly segmentCount: number;
  readonly initialisationCount: number;
}

/**
 * What became of this airing's recording.
 *
 * `none` MEANS THE OPERATOR CHOSE NOT TO KEEP ONE, and it is a shape of its
 * own rather than a missing summary. A programme that was never recorded and a
 * programme whose recording was deleted are different histories, and a viewer
 * -- or an operator wondering where last Tuesday went -- is entitled to be told
 * which one happened.
 */
export type ReplayDisposition =
  | { readonly disposition: 'none' }
  | { readonly disposition: 'replay'; readonly summary: ReplaySummary };

/** The operator asked for no recording. There is nothing to summarise. */
export const REPLAY_NOT_KEPT: ReplayDisposition = { disposition: 'none' };

/** What the catalogue should hold, given what the archive currently says. */
export function summariseReplay(record: ReplayRecord): ReplayDisposition {
  return {
    disposition: 'replay',
    summary: {
      status: record.status,
      retention: record.retention,
      visibility: record.visibility,
      finalisedAtMs: record.finalisedAtMs,
      expiresAtMs: record.expiresAtMs,
      failure: summariseFailure(record.failure),
      bytes: record.bytes,
      segmentCount: record.segments.length,
      initialisationCount: record.initialisations.length,
    },
  };
}

/* -------------------------------------------------------------- the airing */

export interface ProgrammeAiringRecord {
  readonly identity: ProgrammeRunIdentity;
  readonly startedAtMs: number;
  /** When the broadcast ended, or null while it is still on air. */
  readonly endedAtMs: number | null;
  readonly replay: ReplayDisposition;
}

/* ------------------------------------------------------------- projections */

/**
 * Whether a lifecycle status can still be reached from another one.
 *
 * NOT `canTransition`, and the difference matters. The catalogue is fed
 * SNAPSHOTS of current state, not a transition log, so it legitimately sees a
 * run go from `recording` straight to `available` when the `processing`
 * snapshot was lost or never sent. Insisting on single steps would reject
 * perfectly ordinary bookkeeping.
 *
 * What must still be refused is going BACKWARDS -- a late `recording` arriving
 * after `deleted`, a stale `available` after an expiry -- because a projection
 * that can regress will eventually show an audience a recording an operator
 * removed. Reachability over the archive's own graph gives exactly that: every
 * forward path, no path back. There is no second lifecycle model here.
 */
export function isReachableStatus(from: ReplayStatus, to: ReplayStatus): boolean {
  if (from === to) return true;
  const seen = new Set<ReplayStatus>([from]);
  const pending: ReplayStatus[] = [from];
  while (pending.length > 0) {
    const at = pending.pop();
    if (at === undefined) continue;
    for (const next of REPLAY_TRANSITIONS[at]) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return false;
}

export type ProjectionJudgement =
  /** Write it: this is the same state, or a state ahead of what is held. */
  | { readonly kind: 'apply' }
  /** A snapshot from the past arriving late. Ignored, and not an error. */
  | { readonly kind: 'stale'; readonly detail: string }
  /** The two disagree about whether this airing has a recording at all. */
  | { readonly kind: 'conflict'; readonly detail: string };

/**
 * Whether an incoming snapshot may replace what the catalogue holds.
 *
 * IDEMPOTENT BY CONSTRUCTION: the same snapshot twice is `apply` both times and
 * writes the same row, which is what makes an at-least-once reporter safe.
 */
export function judgeProjection(
  held: ReplayDisposition | null,
  incoming: ReplayDisposition,
): ProjectionJudgement {
  if (held === null) return { kind: 'apply' };

  if (held.disposition !== incoming.disposition) {
    /*
     * A run either kept a recording or it did not, and that was decided when
     * the broadcast opened. Either direction of change here means two sources
     * disagree about what happened, which is worth refusing loudly rather than
     * resolving by arrival order.
     */
    return {
      kind: 'conflict',
      detail: `this airing is recorded as ${held.disposition} and the update says ${incoming.disposition}`,
    };
  }
  if (held.disposition === 'none' || incoming.disposition === 'none') {
    return { kind: 'apply' };
  }

  if (!isReachableStatus(held.summary.status, incoming.summary.status)) {
    return {
      kind: 'stale',
      detail: `a replay at ${held.summary.status} cannot go back to ${incoming.summary.status}`,
    };
  }
  return { kind: 'apply' };
}

/* ----------------------------------------------------------------- the port */

export type AiringCatalogueRefusal =
  /** This run already exists against a different channel or programme. */
  | 'identity-conflict'
  /** Nothing has been catalogued for this run. */
  | 'unknown-airing'
  /** The airing has a recording, or has none, and the update says otherwise. */
  | 'disposition-conflict'
  /** The catalogue itself could not be read or written. */
  | 'catalogue-unavailable';

/**
 * What a catalogue failure costs the broadcast: nothing, ever.
 *
 * Same literal discipline as a Replay failure, for the same reason and one
 * more: this is BOOKKEEPING. A history row that is late is a page that is
 * briefly wrong. Letting that reach a live programme, or a recording, would
 * trade something that matters for something that does not.
 */
export interface AiringCatalogueFailure {
  readonly reason: AiringCatalogueRefusal;
  readonly detail: string;
  readonly liveImpact: 'none';
}

export type AiringOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AiringCatalogueFailure };

export function airingRefused<T>(
  reason: AiringCatalogueRefusal,
  detail: string,
): AiringOutcome<T> {
  return { ok: false, failure: { reason, detail, liveImpact: 'none' } };
}

/** One page of history, and where the next one starts. */
export interface ProgrammeAiringPage {
  readonly airings: readonly ProgrammeAiringRecord[];
  /** Pass back as `after` for the next page. Null when there is no more. */
  readonly next: AiringCursor | null;
}

/**
 * Where a page ended.
 *
 * KEYSET, NOT OFFSET. History grows while somebody is reading it, and an
 * offset moves under them: a broadcast that ends between page one and page two
 * shifts everything down and a viewer sees the same airing twice, or misses
 * one. A cursor names the last row seen, so pages stay stable however much is
 * appended.
 */
export interface AiringCursor {
  readonly startedAtMs: number;
  readonly runId: string;
}

export interface AiringQuery {
  readonly limit?: number;
  readonly after?: AiringCursor;
}

/**
 * Where programme history is kept.
 *
 * EVERY MUTATION IS IDEMPOTENT. The reporter that drives this is at-least-once
 * by nature -- a broadcast can end while the catalogue is unreachable and be
 * reported again minutes later -- so sending the same thing twice must be
 * indistinguishable from sending it once.
 *
 * NOTHING HERE PROVES MEDIA EXISTS. A row saying `available` is a record of
 * what the archive last said, not permission to serve anything. Playback asks
 * the archive.
 */
export interface ProgrammeAiringCatalogue {
  /**
   * Write down that a programme went on air.
   *
   * The identity is immutable afterwards: the same run against a different
   * channel or programme is refused rather than moved, because a broadcast
   * does not change whose it was.
   */
  recordAiring(airing: {
    readonly identity: ProgrammeRunIdentity;
    readonly startedAtMs: number;
    readonly replay?: ReplayDisposition;
  }): Promise<AiringOutcome<ProgrammeAiringRecord>>;

  /** Bring the recording summary up to date with what the archive now says. */
  projectReplay(
    runId: string,
    replay: ReplayDisposition,
  ): Promise<AiringOutcome<ProgrammeAiringRecord>>;

  /** Write down that the broadcast ended. */
  finishAiring(runId: string, endedAtMs: number): Promise<AiringOutcome<ProgrammeAiringRecord>>;

  findByRunId(runId: string): Promise<ProgrammeAiringRecord | null>;
  listByChannel(channelId: string, query?: AiringQuery): Promise<ProgrammeAiringPage>;
  listByProgramme(programmeId: string, query?: AiringQuery): Promise<ProgrammeAiringPage>;
}

/**
 * How many airings a page holds when a caller does not say.
 *
 * NOT NAMED `DEFAULT_`, deliberately. This package refuses to invent product
 * defaults -- a replay policy or a visibility it was not told -- and a test
 * enforces that by name. A page size is neither: it is the shape of one
 * response, not a decision about somebody's broadcast, and the name should not
 * suggest otherwise.
 */
export const AIRING_PAGE_SIZE = 50;
export const MAX_AIRING_PAGE = 200;

export function pageSize(query: AiringQuery | undefined): number {
  const asked = query?.limit ?? AIRING_PAGE_SIZE;
  if (!Number.isSafeInteger(asked) || asked < 1) return AIRING_PAGE_SIZE;
  return Math.min(asked, MAX_AIRING_PAGE);
}
