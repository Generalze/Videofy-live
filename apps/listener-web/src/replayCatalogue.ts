/** @author masterzee001 */
/**
 * A channel's past broadcasts, as a viewer may see them.
 *
 * READ-ONLY AND PUBLIC. This asks the audience endpoint, which answers only for
 * channels the platform publishes and describes only recordings anybody may
 * watch. Everything a viewer has no business with -- a recording's lifecycle
 * status, its size, why one failed, whether one exists at all behind a setting
 * an operator chose -- is absent from the response by construction, not
 * stripped here.
 *
 * WHICH MEANS THIS FILE ASSUMES NOTHING ABOUT WHAT IS MISSING. `replay: null`
 * arrives for every reason there is nothing to watch, and they are deliberately
 * indistinguishable: never recorded, private, unlisted, expired, deleted,
 * failed, still on air. A client that tried to tell them apart -- by a length,
 * a timestamp, an absent key -- would be reconstructing exactly the disclosure
 * the service refused to make, and the reconstruction would be wrong anyway.
 *
 * AN AIRING WITH NOTHING TO WATCH IS STILL SHOWN. It happened, it is history,
 * and a schedule that omitted it would be a schedule that lies about the past.
 * It simply has no play button.
 *
 * A FAILURE IS AN EMPTY HISTORY AND NOT AN INVENTED ONE. A 404 means this
 * channel publishes no history -- which is the same answer it gives for a
 * channel that does not exist, on purpose -- and anything else means the
 * service could not be reached. Neither is a reason to show a viewer a
 * recording, so both come back empty and the page says nothing more.
 */

/**
 * A recording this viewer may watch.
 *
 * A WATCH URL, AND NO RUN ID. The service sends one only for a recording it is
 * already handing over; there is no identifier here for anything it withheld,
 * which is what stops a listing from disclosing the address of the recordings
 * it hid. See the note below on `replay: null`.
 */
export interface PublicReplayView {
  readonly watchUrl: string;
  readonly expiresAtMs: number | null;
}

export interface PublicAiringView {
  readonly channelId: string;
  readonly programmeId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  /** Null for every reason there is nothing to watch. One answer for all of them. */
  readonly replay: PublicReplayView | null;
}

/**
 * Where the next page starts, as the service sealed it.
 *
 * OPAQUE, AND DELIBERATELY NOT A PAIR OF FIELDS. The cursor names the last
 * airing on the page, and that name is a run id -- so a readable cursor would
 * enumerate the channel one page at a time. This client carries the token back
 * without ever knowing what is in it, which is the only handling that keeps
 * that true.
 */
export type ReplayHistoryCursor = string;

export interface ReplayHistory {
  readonly airings: readonly PublicAiringView[];
  readonly next: ReplayHistoryCursor | null;
  /** Whether the channel publishes a history at all. False is not an error. */
  readonly available: boolean;
}

export const NO_HISTORY: ReplayHistory = { airings: [], next: null, available: false };

/**
 * A response entry as one airing, or nothing.
 *
 * DEFENSIVE ABOUT SHAPE, INDIFFERENT TO ABSENCE. A malformed entry is dropped
 * rather than rendered as a row of undefineds. A missing `replay` is not
 * malformed: it is the ordinary answer.
 */
function toAiring(value: unknown): PublicAiringView | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const channelId = entry['channelId'];
  const startedAtMs = entry['startedAtMs'];
  if (typeof channelId !== 'string') return null;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;

  const replay = entry['replay'];
  let watchable: PublicReplayView | null = null;
  if (typeof replay === 'object' && replay !== null) {
    const inner = replay as Record<string, unknown>;
    const watchUrl = inner['watchUrl'];
    const expiresAtMs = inner['expiresAtMs'];
    if (typeof watchUrl === 'string' && watchUrl !== '') {
      watchable = {
        watchUrl,
        expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : null,
      };
    }
  }

  return {
    channelId,
    programmeId: typeof entry['programmeId'] === 'string' ? entry['programmeId'] : channelId,
    startedAtMs,
    endedAtMs: typeof entry['endedAtMs'] === 'number' ? entry['endedAtMs'] : null,
    replay: watchable,
  };
}

function toCursor(value: unknown): ReplayHistoryCursor | null {
  // A string, and nothing is read out of it: it is the service's sealed token.
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function fetchReplayHistory(
  accountBase: string,
  channelId: string,
  options: { readonly after?: ReplayHistoryCursor; readonly doFetch?: typeof fetch } = {},
): Promise<ReplayHistory> {
  if (channelId.trim() === '') return NO_HISTORY;
  const doFetch = options.doFetch ?? fetch;
  const after = options.after;
  /*
   * KEYSET, NEVER AN OFFSET. History grows while somebody is reading it, and an
   * offset moves under them: a broadcast that ends between two pages shows one
   * airing twice and hides another.
   */
  const query = after === undefined ? '' : `?after=${encodeURIComponent(after)}`;
  try {
    const response = await doFetch(
      `${accountBase.replace(/\/$/u, '')}/channels/${encodeURIComponent(channelId)}/airings${query}`,
    );
    /*
     * A 404 IS "THIS CHANNEL PUBLISHES NO HISTORY", and the service gives the
     * same answer for a channel that does not exist. Telling them apart here
     * would be reconstructing a distinction the service refused to make.
     */
    if (!response.ok) return NO_HISTORY;
    const body = (await response.json()) as Record<string, unknown>;
    const entries = body['airings'];
    if (!Array.isArray(entries)) return NO_HISTORY;
    return {
      airings: entries.map(toAiring).filter((entry): entry is PublicAiringView => entry !== null),
      next: toCursor(body['next']),
      available: true,
    };
  } catch {
    // An outage is not an answer about anybody's recordings.
    return NO_HISTORY;
  }
}

/**
 * Where a replay is watched.
 *
 * THE SERVICE SUPPLIES THE PATH; THIS SUPPLIES THE ORIGIN. The account service
 * sends a path (`/replays/<run>/playlist.m3u8`) because it has no business
 * knowing which host serves media, and this app prefixes its configured ingest
 * origin -- empty by default, which leaves the path relative and correct on
 * every deployment where the media service is behind the same front door.
 *
 * A path that is already absolute is passed through, and anything that is not a
 * path at all is refused: `watchUrl` arrives from the network, and a client that
 * pasted an arbitrary string into an href would be following whatever it was
 * handed.
 */
export function replayPlaybackUrl(ingestBase: string, watchUrl: string): string {
  if (/^https?:\/\//iu.test(watchUrl)) return watchUrl;
  if (!watchUrl.startsWith('/')) return '';
  return `${ingestBase.replace(/\/$/u, '')}${watchUrl}`;
}

/** When the broadcast went out, for somebody reading a list. */
export function describeAiringTime(startedAtMs: number, at: Date = new Date(startedAtMs)): string {
  return at.toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * How long is left, when there is a limit worth mentioning.
 *
 * `null` FOR AN INDEFINITE ONE, rather than the word "forever". A viewer needs
 * to be told when something is going away; being told that something is not is
 * noise on every row of the list.
 */
export function describeExpiry(expiresAtMs: number | null, nowMs: number): string | null {
  if (expiresAtMs === null) return null;
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return null;
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) return `Available for ${days} more ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.max(1, Math.round(remaining / 3_600_000));
  return `Available for ${hours} more ${hours === 1 ? 'hour' : 'hours'}`;
}
