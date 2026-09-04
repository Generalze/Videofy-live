/**
 * Which programme this viewer is watching, and how they got here.
 *
 * A channel has its own viewer page. There is no router in this app, so the
 * page is identified by the URL directly: `/c/<channelId>` for a link somebody
 * was given, or `?c=<channelId>` for the same thing where a static host cannot
 * rewrite paths. With neither, the viewer sees the directory of public
 * programmes and picks one -- which is the front page.
 */
import {
  channelCategoryLabel,
  isChannelCategory,
  type ChannelCategory,
  type ChannelSummary,
} from '@videofy-live/shared-types';

export const DEFAULT_CHANNEL_ID = 'main';

export interface ChannelSelection {
  /** The channel to join, or null to show the directory instead. */
  readonly channelId: string | null;
  /** A join code carried in the link, for a private programme. */
  readonly code: string | null;
  /**
   * Whether the code arrived in the URL.
   *
   * The caller uses this to strip it from the address bar once it has been
   * used. A code sitting in a URL is in browser history, in the referrer of
   * every outbound link, and in any screenshot of the window -- so it is
   * accepted for the convenience of a single shareable link, and then removed.
   */
  readonly codeFromUrl: boolean;
}

/** Channel ids are opaque, fixed-alphabet, and never assembled from free text. */
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/**
 * Read the channel from a location.
 *
 * Takes the parts rather than reading `window.location`, so this is testable
 * without a DOM and so a caller can resolve a link before navigating to it.
 */
export function readChannelFromLocation(pathname: string, search: string): ChannelSelection {
  const params = new URLSearchParams(search);

  /*
   * MATCHED AS A PATH SEGMENT, NOT AS A PREFIX. Staging serves this app under
   * /listen, so the browser path is /listen/c/<id> even though the server
   * strips the prefix before looking for files. Anchoring this to the start of
   * the path would have worked locally and silently failed everywhere it is
   * actually deployed.
   */
  const fromPath = /(?:^|\/)c\/([^/?#]+)/.exec(pathname)?.[1];
  const fromQuery = params.get('c') ?? params.get('channel');
  const candidate = fromPath ?? fromQuery ?? null;

  const channelId =
    candidate !== null && CHANNEL_ID.test(candidate) ? decodeURIComponent(candidate) : null;

  const rawCode = params.get('code');
  const code = rawCode !== null && rawCode.length > 0 && rawCode.length <= 64 ? rawCode : null;

  return { channelId, code, codeFromUrl: code !== null };
}

/**
 * Where this app is mounted, derived from the page it is on.
 *
 * Returns '/listen' for '/listen/c/abc' and '' for '/c/abc', so links and
 * history entries are built relative to wherever the app is actually served
 * rather than assuming the site root.
 */
export function channelBasePath(pathname: string): string {
  const beforeChannel = /^(.*?)(?:\/)c\/[^/?#]+/.exec(pathname)?.[1];
  const base = beforeChannel ?? pathname.replace(/\/+$/, '');
  return base === '/' ? '' : base;
}

/**
 * The link an operator shares.
 *
 * @param code - Included only for a private programme, where the point of the
 * link is that it carries everything the recipient needs. For a public or
 * private channel there is nothing to carry and adding an empty parameter
 * would only invite somebody to think there was.
 */
export function channelViewerUrl(origin: string, channelId: string, code?: string | null): string {
  const base = `${origin.replace(/\/$/, '')}/c/${encodeURIComponent(channelId)}`;
  if (code === undefined || code === null || code.length === 0) return base;
  return `${base}?code=${encodeURIComponent(code)}`;
}

/**
 * The URL to show in the address bar once a code has been used.
 *
 * The channel stays -- it is the page identity and reloading must return here.
 * The code goes.
 */
export function urlWithoutCode(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('code');
  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

/** The payload the gateway expects for a channel join. */
export function buildJoinPayload(
  selection: Pick<ChannelSelection, 'channelId' | 'code'>,
  targetLanguage?: string,
): { channelId: string; code?: string; targetLanguage?: string } {
  return {
    channelId: selection.channelId ?? DEFAULT_CHANNEL_ID,
    ...(selection.code !== null && selection.code.length > 0 ? { code: selection.code } : {}),
    ...(targetLanguage !== undefined ? { targetLanguage } : {}),
  };
}

/**
 * The directory, ordered for somebody deciding what to watch.
 *
 * The gateway already sorts live programmes first; this re-sorts rather than
 * trusting it, because the ordering is what the viewer reads as "what is on
 * now" and it should not depend on which server version answered.
 */
export function sortedDirectory<T extends Pick<ChannelSummary, 'live' | 'displayName'>>(
  entries: readonly T[],
): readonly T[] {
  return [...entries].sort((left, right) =>
    left.live === right.live
      ? left.displayName.localeCompare(right.displayName)
      : Number(right.live) - Number(left.live),
  );
}

/**
 * What the viewer should be shown right now.
 *
 * `needs-code` is deliberately distinct from `refused`: the first is a prompt,
 * the second is an answer. A viewer who mistypes a code should be asked again
 * rather than told the programme does not exist, and a viewer following a
 * public link should never see a code box at all.
 */
export type ViewerStage = 'directory' | 'watching' | 'needs-code' | 'refused';

export function viewerStage(input: {
  selection: Pick<ChannelSelection, 'channelId' | 'code'>;
  refusedCode: boolean;
  joined: boolean;
}): ViewerStage {
  if (input.selection.channelId === null) return 'directory';
  if (input.joined) return 'watching';
  if (input.refusedCode) return input.selection.code === null ? 'needs-code' : 'refused';
  return 'watching';
}

/**
 * A directory row carrying the channel's persisted identity.
 *
 * FOUNDER DIRECTIVE (A, 30 Aug 2026, LOCKED): "C7 Streams discovery uses
 * persisted identity (name, avatar, handle, category, live status, current
 * programme)". The gateway's channel:directory row carries `handle`,
 * `avatarUrl` and `currentProgramme` (shared-types ChannelSummary); this type
 * is an intersection so the viewer compiles against a shared-types that has
 * them and one that does not, and `parseDirectoryEntries` reads them as null
 * when a gateway does not send them rather than as undefined everywhere.
 */
export type DirectoryEntry = ChannelSummary & {
  readonly handle?: string | null;
  readonly avatarUrl?: string | null;
  readonly currentProgramme?: string | null;
};

const CHANNEL_HANDLE_SHAPE = /^[a-z0-9_]{3,24}$/;

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** One row of channel:directory read defensively; null when it is not a channel. */
export function parseDirectoryEntry(entry: unknown): DirectoryEntry | null {
  if (entry === null || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;
  const channelId = candidate['channelId'];
  const displayName = candidate['displayName'];
  if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return null;
  if (typeof displayName !== 'string') return null;
  const visibility = candidate['visibility'];
  // No tier is not "public": a row the gateway did not tier is not a channel.
  if (visibility !== 'public' && visibility !== 'private' && visibility !== 'locked') return null;
  const category = candidate['category'];
  const handle = candidate['handle'];
  return {
    channelId,
    displayName,
    live: candidate['live'] === true,
    visibility,
    category: isChannelCategory(category) ? category : null,
    handle: typeof handle === 'string' && CHANNEL_HANDLE_SHAPE.test(handle) ? handle : null,
    avatarUrl: optionalText(candidate['avatarUrl']),
    currentProgramme: optionalText(candidate['currentProgramme']),
  };
}

/** The whole channel:directory payload; anything that is not a list reads as an empty one. */
export function parseDirectoryEntries(payload: unknown): readonly DirectoryEntry[] {
  if (!Array.isArray(payload)) return [];
  const entries: DirectoryEntry[] = [];
  for (const row of payload) {
    const parsed = parseDirectoryEntry(row);
    if (parsed !== null) entries.push(parsed);
  }
  return entries;
}

/** Up to two initials from a display name, for the tile shown when there is no picture. */
export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/** "@handle", or null when the channel has none yet. */
export function channelHandleLabel(handle: string | null | undefined): string | null {
  return handle !== null && handle !== undefined && handle.length > 0 ? `@${handle}` : null;
}

/**
 * Where a channel's picture is fetched from.
 *
 * The account service serves it publicly at GET /channels/:channelId/avatar
 * and the directory row carries `avatarUrl`. An absolute URL is used as
 * given; a path is taken relative to the account base, which on staging is
 * /auth -- the edge routes that prefix to the account service. Null means
 * no picture, and the initials tile is shown instead.
 */
export function resolveChannelAvatarUrl(
  accountBase: string,
  avatarUrl: string | null | undefined,
): string | null {
  if (avatarUrl === null || avatarUrl === undefined || avatarUrl.length === 0) return null;
  if (/^(?:https?:)?\/\//i.test(avatarUrl) || avatarUrl.startsWith('data:')) return avatarUrl;
  const base = accountBase.replace(/\/+$/, '');
  return avatarUrl.startsWith('/') ? `${base}${avatarUrl}` : `${base}/${avatarUrl}`;
}

/**
 * What one directory card shows. Everything a card renders is derived here,
 * once, so the markup has no rules of its own and the rules can be tested
 * without rendering.
 */
export interface DirectoryCard {
  readonly channelId: string;
  readonly displayName: string;
  readonly handle: string | null;
  /** "@handle", ready to print. */
  readonly handleLabel: string | null;
  readonly initials: string;
  /** Resolved against the account base; null means show the initials. */
  readonly avatarUrl: string | null;
  readonly category: ChannelCategory | null;
  /** The controlled label for the category, never the raw id. */
  readonly categoryLabel: string | null;
  readonly live: boolean;
  readonly status: 'Live now' | 'Not broadcasting';
  /** The programme on air, only while the channel is live. */
  readonly currentProgramme: string | null;
}

export function directoryCard(entry: DirectoryEntry, accountBase: string): DirectoryCard {
  const handle = entry.handle ?? null;
  const category = entry.category ?? null;
  return {
    channelId: entry.channelId,
    displayName: entry.displayName,
    handle,
    handleLabel: channelHandleLabel(handle),
    initials: initialsFor(entry.displayName),
    avatarUrl: resolveChannelAvatarUrl(accountBase, entry.avatarUrl),
    category,
    categoryLabel: category === null ? null : channelCategoryLabel(category),
    live: entry.live,
    status: entry.live ? 'Live now' : 'Not broadcasting',
    currentProgramme: entry.live ? optionalText(entry.currentProgramme) : null,
  };
}

/**
 * How the door names the channel it is guarding.
 *
 * Directive A: "never expose fallback names like 'Channel abc123' when an
 * identity exists". The directory is the identity the viewer already holds;
 * only a channel it does not list falls back to its id.
 */
export function describeChannelAtDoor(
  channels: readonly DirectoryEntry[],
  channelId: string,
  known: Pick<DirectoryEntry, 'displayName' | 'handle'> | null = null,
): string {
  // The directory first; then whatever the account service said about the
  // opaque link. A private channel is only ever named by the second.
  const listed = channels.find((channel) => channel.channelId === channelId);
  const entry = listed ?? (known === null ? undefined : { displayName: known.displayName, handle: known.handle });
  if (entry === undefined || entry.displayName.trim().length === 0) return `Channel ${channelId}`;
  const handle = channelHandleLabel(entry.handle);
  return handle === null ? entry.displayName : `${entry.displayName} (${handle})`;
}
