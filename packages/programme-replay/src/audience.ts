/** @author masterzee001 */
/**
 * Who may be told what about a broadcast that has already happened.
 *
 * THREE SENTENCES DECIDE EVERYTHING IN THIS FILE, and each of them is a rule
 * somebody gets wrong the first time:
 *
 *   UNLISTED MEANS "KNOWN LINK", NOT "HIDDEN LABEL IN A PUBLIC CATALOGUE".
 *   An unlisted replay is reachable by anybody holding its address and appears
 *   in no listing anybody can browse. A catalogue that printed the title with
 *   the play button greyed out would have published the very thing the setting
 *   exists to withhold: that this recording exists and where it is.
 *
 *   PRIVATE MEANS AUTHORISATION, NOT OBSCURITY. A private replay is not an
 *   unlisted one with a longer id. Nothing here ever returns it to a public
 *   caller, however the address was arrived at.
 *
 *   PUBLIC HISTORY MUST NEVER REVEAL THAT A HIDDEN REPLAY EXISTS SIMPLY BY
 *   CHANGING THE RESPONSE SHAPE. This is the one that is easy to violate by
 *   accident and impossible to notice afterwards. If an airing with a private
 *   recording came back carrying `replay: { available: false }` while an airing
 *   that was never recorded came back with the field absent, then anybody with
 *   a browser could enumerate a channel's hidden recordings without ever being
 *   shown one. So the public shape is FIXED: every airing has the same keys,
 *   and `replay` is `null` for every reason it could be -- never recorded,
 *   private, unlisted, expired, deleted, failed, still going. One answer.
 *
 * REPLAY VISIBILITY IS AN ADDITIONAL PERMISSION, NOT A BYPASS. A `public`
 * replay on a channel the platform does not publish is still not public: the
 * channel's own authority is asked first and this only ever narrows what
 * survives it. The channel decision is passed in as a plain boolean, decided by
 * whoever owns channel visibility, because this package has no business
 * knowing what a channel access tier is called.
 *
 * AND NOTHING HERE PRODUCES A LOCATION. A view carries a run id, which is an
 * identifier the playback service will authorise for itself, and never a
 * storage reference, an archive root, an object key or a segment list. The
 * records these are built from do not contain one, and that is deliberate --
 * see `airing.ts`.
 */

import type { ReplayStatus } from './lifecycle.js';
import type { ReplayRetention, ReplayVisibility } from './policy.js';
import type {
  ProgrammeAiringRecord,
  ReplayDisposition,
  ReplayFailureSummary,
  ReplaySummary,
} from './airing.js';

/* ------------------------------------------------------------ watchability */

/**
 * Whether these bytes could be played AT ALL, before anybody asks who by.
 *
 * `available` is the only status that means "finished, complete, and on the
 * archive's shelf". `recording` and `processing` are not yet; `failed`,
 * `expired` and `deleted` are no longer. The archive says the same thing at
 * the playback door (`planReplayPlayback`), and this is not a second opinion --
 * it is the catalogue declining to advertise something the archive would then
 * refuse, which is a worse experience than not showing it.
 *
 * EXPIRY IS CHECKED HERE TOO, against the clock rather than the status. A
 * replay whose retention ran out an hour ago is still `available` until a
 * lifecycle worker gets to it, and the gap between those two moments is
 * exactly when an operator's promise that "these are kept for thirty days" is
 * either honoured or quietly broken. It is honoured.
 */
export function isWatchable(summary: ReplaySummary, nowMs: number): boolean {
  if (summary.status !== 'available') return false;
  return summary.expiresAtMs === null || nowMs < summary.expiresAtMs;
}

/**
 * Whether a stranger holding the address may watch this.
 *
 * `public` and `unlisted` both yes -- that is what distinguishes them from
 * `private`, and the difference between the two is about LISTING, decided
 * below, not about admission.
 */
export function reachableByLink(
  replay: ReplayDisposition,
  channelIsPublic: boolean,
  nowMs: number,
): boolean {
  if (!channelIsPublic) return false;
  if (replay.disposition !== 'replay') return false;
  if (!isWatchable(replay.summary, nowMs)) return false;
  return replay.summary.visibility === 'public' || replay.summary.visibility === 'unlisted';
}

/**
 * Whether this may appear in a listing a stranger can browse.
 *
 * `public` only. An unlisted recording that showed up here would be a listed
 * recording, and the operator who chose the setting would have no way of
 * knowing it had stopped meaning what it says.
 */
export function listableToPublic(
  replay: ReplayDisposition,
  channelIsPublic: boolean,
  nowMs: number,
): boolean {
  if (!reachableByLink(replay, channelIsPublic, nowMs)) return false;
  return replay.disposition === 'replay' && replay.summary.visibility === 'public';
}

/* ------------------------------------------------------------ public shape */

/**
 * What a public caller is told about a recording they may watch.
 *
 * A RUN ID AND AN EXPIRY. The run id is how playback is addressed; the expiry
 * is the one piece of retention a viewer has a legitimate use for -- "watch
 * this before Tuesday" -- and it is present only on recordings they can
 * already see, so it discloses nothing new.
 *
 * NOT the status (an audience does not need the archive's vocabulary), not the
 * visibility (they are looking at it, so it was `public`, and echoing the tier
 * back invites a client to branch on it), not the failure summary, not the
 * byte count, not the segment counts. Those are operational facts about a
 * recording and they belong to the operator.
 */
export interface PublicReplayView {
  /** How playback is addressed. Not a location; the archive resolves it. */
  readonly runId: string;
  /** When it stops being watchable, or null when it is kept indefinitely. */
  readonly expiresAtMs: number | null;
}

/**
 * One airing, as anybody may see it.
 *
 * THE SHAPE IS FIXED. Every field is always present, `replay` included, and a
 * hidden recording is `replay: null` -- the same value an airing that was never
 * recorded gets, and the same value a failed one gets. Two airings whose only
 * difference is a setting an operator chose in private must be byte-identical
 * here, and a test compares their serialised forms to keep it that way.
 *
 * AND THERE IS NO RUN ID AT THIS LEVEL, which is the second half of the same
 * rule and the easier half to get wrong.
 *
 * `replay: null` HIDES NOTHING IF THE SAME OBJECT CARRIES THE RUN ID. The
 * direct-link route is addressed by run id, and `unlisted` is defined as
 * reachable by whoever holds that address -- so a listing that printed the run
 * id beside a null replay would be handing out the address of every recording
 * it had just declined to show:
 *
 *     { startedAtMs: ..., runId: "run_secret", replay: null }
 *         -> GET /channels/<channel>/airings/run_secret
 *         -> the unlisted recording, discovered from the listing that hid it
 *
 * Worse, it is a COMPLETE enumeration rather than a lucky guess: page the
 * history with limit=1 and every run id on the channel falls out in order.
 *
 * So the run id lives only inside `replay`, and `replay` is non-null only for a
 * recording this audience may already watch. There, the run id IS the
 * capability -- it is how playback is addressed -- and disclosing it to
 * somebody being handed the recording discloses nothing new.
 */
export interface PublicAiringView {
  readonly channelId: string;
  readonly programmeId: string;
  readonly startedAtMs: number;
  /** Null while the broadcast is still on air. */
  readonly endedAtMs: number | null;
  /** Null for every reason there is nothing to watch. One answer for all of them. */
  readonly replay: PublicReplayView | null;
}

/**
 * An airing as a public listing shows it: unlisted recordings are absent.
 *
 * The AIRING still appears. It happened, it is history, and hiding the
 * broadcast because its recording is unlisted would make the schedule lie
 * about the past -- which is the failure `airing.ts` exists to prevent.
 */
export function toPublicListing(
  record: ProgrammeAiringRecord,
  channelIsPublic: boolean,
  nowMs: number,
): PublicAiringView {
  return publicView(record, listableToPublic(record.replay, channelIsPublic, nowMs));
}

/**
 * The same airing, fetched by somebody who already has its address.
 *
 * This is where `unlisted` earns its name: the recording was withheld from
 * every listing and is served to a caller who arrived with the link.
 */
export function toPublicByLink(
  record: ProgrammeAiringRecord,
  channelIsPublic: boolean,
  nowMs: number,
): PublicAiringView {
  return publicView(record, reachableByLink(record.replay, channelIsPublic, nowMs));
}

function publicView(record: ProgrammeAiringRecord, watchable: boolean): PublicAiringView {
  const summary = record.replay.disposition === 'replay' ? record.replay.summary : null;
  return {
    // NO `runId` HERE. See the note on PublicAiringView: it is the address of
    // the very recording this function may be declining to show.
    channelId: record.identity.channelId,
    programmeId: record.identity.programmeId,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    /*
     * ONE BRANCH, AND IT IS THE ONLY ONE. Every reason to withhold has already
     * collapsed into `watchable` by the time it gets here, so there is no place
     * left for a second shape to grow.
     */
    replay:
      watchable && summary !== null
        ? { runId: record.identity.runId, expiresAtMs: summary.expiresAtMs }
        : null,
  };
}

/* ------------------------------------------------------------- owner shape */

/**
 * What an operator is told about their own airing: the truth.
 *
 * INCLUDING THE THINGS THAT WENT WRONG. An operator looking at last Tuesday
 * needs to know a recording failed, and why in the words this platform chose,
 * because otherwise the page reads exactly like a broadcast they forgot to
 * record. `failure` is the mapped `ReplayFailureSummary` and never the
 * archive's own detail, for the reason `airing.ts` sets out at length.
 *
 * `watchable` IS COMPUTED, NOT STORED. An operator's history page shows a play
 * button, and it must be the same judgement the audience gets rather than a
 * status string a component interprets for itself.
 */
export interface OwnerReplayView {
  readonly runId: string;
  readonly status: ReplayStatus;
  readonly retention: ReplayRetention;
  readonly visibility: ReplayVisibility;
  readonly finalisedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly failure: ReplayFailureSummary | null;
  readonly bytes: number;
  readonly segmentCount: number;
  readonly initialisationCount: number;
  /** Whether it would play right now, by the same rule the audience gets. */
  readonly watchable: boolean;
  /**
   * Whether a stranger browsing the channel would find it.
   *
   * Answered here so the console never has to reason about the tiers itself.
   * False on a channel the platform does not publish, whatever the replay's own
   * visibility says -- which is the fact an operator most needs and is least
   * likely to work out from two settings on two different pages.
   */
  readonly listedPublicly: boolean;
}

export interface OwnerAiringView {
  readonly runId: string;
  readonly channelId: string;
  readonly programmeId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  /** Null only when the operator chose to keep no recording at all. */
  readonly replay: OwnerReplayView | null;
}

export function toOwnerView(
  record: ProgrammeAiringRecord,
  channelIsPublic: boolean,
  nowMs: number,
): OwnerAiringView {
  const base = {
    runId: record.identity.runId,
    channelId: record.identity.channelId,
    programmeId: record.identity.programmeId,
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
  };
  if (record.replay.disposition !== 'replay') return { ...base, replay: null };
  const summary = record.replay.summary;
  return {
    ...base,
    replay: {
      runId: record.identity.runId,
      status: summary.status,
      retention: summary.retention,
      visibility: summary.visibility,
      finalisedAtMs: summary.finalisedAtMs,
      expiresAtMs: summary.expiresAtMs,
      failure: summary.failure,
      bytes: summary.bytes,
      segmentCount: summary.segmentCount,
      initialisationCount: summary.initialisationCount,
      watchable: isWatchable(summary, nowMs),
      listedPublicly: listableToPublic(record.replay, channelIsPublic, nowMs),
    },
  };
}
