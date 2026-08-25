/**
 * Which programme this viewer is watching, and how they got here.
 *
 * A channel has its own viewer page. There is no router in this app, so the
 * page is identified by the URL directly: `/c/<channelId>` for a link somebody
 * was given, or `?c=<channelId>` for the same thing where a static host cannot
 * rewrite paths. With neither, the viewer sees the directory of public
 * programmes and picks one -- which is the front page.
 */
import type { ChannelSummary } from '@videofy-live/shared-types';

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

  const fromPath = /^\/c\/([^/?#]+)/.exec(pathname)?.[1];
  const fromQuery = params.get('c') ?? params.get('channel');
  const candidate = fromPath ?? fromQuery ?? null;

  const channelId =
    candidate !== null && CHANNEL_ID.test(candidate) ? decodeURIComponent(candidate) : null;

  const rawCode = params.get('code');
  const code = rawCode !== null && rawCode.length > 0 && rawCode.length <= 64 ? rawCode : null;

  return { channelId, code, codeFromUrl: code !== null };
}

/**
 * The link an operator shares.
 *
 * @param code - Included only for a private programme, where the point of the
 * link is that it carries everything the recipient needs. For a public or
 * unlisted channel there is nothing to carry and adding an empty parameter
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
export function sortedDirectory(entries: readonly ChannelSummary[]): readonly ChannelSummary[] {
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
