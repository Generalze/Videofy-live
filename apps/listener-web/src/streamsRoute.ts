/** @author masterzee001 */
/**
 * The public channel route: /streams/<handle>.
 *
 * FOUNDER DIRECTIVE (A, 30 Aug 2026, LOCKED): "public canonical route
 * /streams/<handle> with opaque links still working". A channel keeps its
 * opaque, account-derived id internally and on every link that already
 * exists (/c/<channelId>, ?c=, ?channel=); the handle is the human-readable
 * name a person can say aloud, and this file is the whole of how a browser
 * path becomes one.
 *
 * The parser is pure and takes the parts of a location, so it is testable
 * without a DOM and so the same rule can be applied to a link before it is
 * followed. Resolution (handle -> channelId) goes through the account
 * service's public route and is kept here beside the parser, with the fetch
 * injected, so the whole route can be exercised in node.
 */
import {
  CHANNEL_HANDLE_SHAPE,
  isChannelCategory,
  isChannelVisibility,
  type PublicChannelProfile,
} from '@videofy-live/shared-types';

/**
 * The shape of a handle: the ONE rule shared-types owns (lower-case letters,
 * digits and underscore, three to twenty-four long), the same the account
 * service enforces when a handle is chosen. A path that fails it cannot name
 * a channel and is not sent anywhere.
 */
export const CHANNEL_HANDLE: RegExp = CHANNEL_HANDLE_SHAPE;

export interface StreamsRoute {
  /** The handle from the path, lower-cased. */
  readonly handle: string;
}

/**
 * Read the handle from a pathname, or null when this is not a streams page.
 *
 * MATCHED AS A PATH SEGMENT, NOT AS A PREFIX, for the same reason /c/ is:
 * staging may serve this app under /listen, and a rule anchored to the start
 * of the path works locally and fails silently where it is deployed. The
 * segment after `streams/` must be the LAST one -- `/streams/abc/extra` is
 * not a channel page and is not guessed at.
 *
 * Upper case is folded rather than refused. A handle typed from a poster or
 * read aloud arrives however the person typed it; the canonical form is
 * lower-case and that is what is resolved.
 */
export function parseStreamsRoute(pathname: string): StreamsRoute | null {
  const segment = /(?:^|\/)streams\/([^/?#]+)\/?$/.exec(pathname)?.[1];
  if (segment === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const handle = decoded.toLowerCase();
  return CHANNEL_HANDLE.test(handle) ? { handle } : null;
}

/** Whether a value could be a handle at all; used before building a link to one. */
export function isChannelHandle(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_HANDLE.test(value);
}

/**
 * The canonical public link for a channel with a handle.
 *
 * Root-relative to the ORIGIN, never to where this app is mounted: the
 * directive names the route as /streams/<handle> and the edge serves it
 * there, whatever path the viewer bundle itself lives under.
 */
export function streamsUrl(origin: string, handle: string): string {
  return `${origin.replace(/\/+$/, '')}/streams/${encodeURIComponent(handle)}`;
}

/**
 * Where /c/ links go when the page was opened at /streams/<handle>.
 *
 * `channelBasePath` reads the mount from the page path, which is right for
 * /listen/c/<id> and wrong for /streams/<handle> -- that path says nothing
 * about where the bundle lives. Vite's BASE_URL does ('/listen/' on staging,
 * '/' in development), so it is the source here.
 */
export function listenerMountBase(viteBaseUrl: string): string {
  const trimmed = viteBaseUrl.replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * What the account service says about a channel, from GET /streams/:handle:
 * the public profile, never the owner (shared-types PublicChannelProfile).
 */
export type StreamsChannelProfile = PublicChannelProfile;

/** Channel ids are opaque and fixed-alphabet; the same rule channelSelection applies to a link. */
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read a profile defensively: the account route is landing in a concurrent
 * lane, and a body that is not the profile it promised must read as "not a
 * channel" rather than as a channel with undefined everywhere.
 */
export function parseStreamsChannelProfile(body: unknown): StreamsChannelProfile | null {
  if (body === null || typeof body !== 'object') return null;
  const candidate = body as Record<string, unknown>;
  const channelId = candidate['channelId'];
  const handle = candidate['handle'];
  const displayName = candidate['displayName'];
  if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return null;
  if (typeof handle !== 'string' || !CHANNEL_HANDLE.test(handle)) return null;
  if (typeof displayName !== 'string' || displayName.trim().length === 0) return null;
  const visibility = candidate['visibility'];
  const category = candidate['category'];
  const description = candidate['description'];
  return {
    channelId,
    handle,
    displayName,
    description: typeof description === 'string' ? description : '',
    category: isChannelCategory(category) ? category : null,
    // A profile without a tier is a public page that was found by its handle.
    visibility: isChannelVisibility(visibility) ? visibility : 'public',
    avatarUrl: optionalString(candidate['avatarUrl']),
    bannerUrl: optionalString(candidate['bannerUrl']),
  };
}

/** The account service's public route for a handle. */
export function streamsProfileUrl(accountBase: string, handle: string): string {
  return `${accountBase.replace(/\/+$/, '')}/streams/${encodeURIComponent(handle)}`;
}

/**
 * How the handle in the address bar stands right now.
 *
 * `unknown` and `failed` are deliberately different words: the first is an
 * answer (there is no such channel) and the second is the absence of one
 * (the lookup did not complete). A viewer holding a poster with a handle on
 * it should not be told the channel does not exist because their connection
 * dropped.
 */
export type StreamsResolution =
  | { readonly state: 'resolving'; readonly handle: string }
  | { readonly state: 'found'; readonly handle: string; readonly profile: StreamsChannelProfile }
  | { readonly state: 'unknown'; readonly handle: string }
  | { readonly state: 'failed'; readonly handle: string };

/** The one slice of fetch this needs, so a test can hand in a fake. */
export type StreamsFetch = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export async function resolveStreamsHandle(
  accountBase: string,
  handle: string,
  fetchImpl: StreamsFetch,
): Promise<StreamsResolution> {
  if (!CHANNEL_HANDLE.test(handle)) return { state: 'unknown', handle };
  try {
    const response = await fetchImpl(streamsProfileUrl(accountBase, handle), {
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return { state: 'unknown', handle };
    if (!response.ok) return { state: 'failed', handle };
    const profile = parseStreamsChannelProfile(await response.json().catch(() => null));
    // A 200 that is not a profile is a broken answer, not a missing channel.
    if (profile === null) return { state: 'failed', handle };
    return { state: 'found', handle, profile };
  } catch {
    return { state: 'failed', handle };
  }
}

/** Where the viewer reaches the account service; staging mounts it at /auth. */
export function readAccountBase(env: { readonly VITE_ACCOUNT_URL?: string | undefined }): string {
  const configured = env.VITE_ACCOUNT_URL;
  return configured !== undefined && configured.length > 0 ? configured : 'http://localhost:3006';
}

/** The account service's public route for a channel's profile by opaque id. */
export function channelProfileUrl(accountBase: string, channelId: string): string {
  return `${accountBase.replace(/\/+$/, '')}/channels/${encodeURIComponent(channelId)}/profile`;
}

/**
 * The identity behind an opaque link, for the door of a private programme.
 *
 * A private or locked channel is never in the directory, so at its door the
 * directory cannot name it. FOUNDER DIRECTIVE (A, 30 Aug 2026, LOCKED): never
 * show "a fallback name like 'Channel abc123' when an identity exists". The
 * public profile-by-id route is what makes the opaque link carry its
 * identity. Null means no profile was read -- absent, or not answered -- and
 * the caller falls back honestly.
 */
export async function resolveChannelProfileById(
  accountBase: string,
  channelId: string,
  fetchImpl: StreamsFetch,
): Promise<StreamsChannelProfile | null> {
  if (!CHANNEL_ID.test(channelId)) return null;
  try {
    const response = await fetchImpl(channelProfileUrl(accountBase, channelId), {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseStreamsChannelProfile(await response.json().catch(() => null));
  } catch {
    return null;
  }
}
