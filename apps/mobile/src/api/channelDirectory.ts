/** @author masterzee001 */
/**
 * The public programme directory, as the gateway publishes it.
 *
 * SAME CONTRACT AS THE WEB LISTENER. The gateway emits `channel:directory`
 * to every listener socket on connect and again whenever a channel goes
 * live or off; the web directory reads exactly this, so the phone's C7
 * Streams surface cannot drift from it. Only channels the gateway chose to
 * list arrive here (public, and private-by-link when addressed); nothing on
 * the phone decides visibility.
 *
 * CATEGORY IS READ, NEVER INFERRED (founder ruling 29 Aug 2026): a channel's
 * category is "an explicit, controlled channel-side field ... set by the
 * operator". The wire carries it as `category`; the phone keeps it when it
 * is a known id and reads null when it is absent or unknown. Nothing here
 * turns a name, a visibility or a live flag into a category.
 *
 * A listener socket, not an HTTP poll, because there is no HTTP form of the
 * directory and inventing one would be a second source of truth.
 *
 * IDENTITY IS READ FROM THE ROW (founder directive A, 30 Aug 2026, LOCKED):
 * "C7 Streams discovery uses persisted identity (name, avatar, handle,
 * category, live status, current programme)". The row carries `handle`,
 * `avatarUrl` and `currentProgramme`; each reads as null when absent or
 * malformed, and nothing on the phone derives one from anything else.
 */
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type ChannelSummary as WireChannelSummary } from '@videofy-live/shared-types';
import { isChannelCategory, type ChannelCategory } from '../programmes/channelCategories';

/**
 * The wire summary with the category and the identity parsed. Declared
 * through Omit so it stays correct whether the installed shared-types dist
 * already carries these fields or predates them.
 */
export type ChannelSummary = Omit<
  WireChannelSummary,
  'category' | 'handle' | 'avatarUrl' | 'currentProgramme'
> & {
  readonly category: ChannelCategory | null;
  /** The @handle without its @, or null when the channel has no persisted identity yet. */
  readonly handle: string | null;
  /** A public account path (/channels/<id>/avatar) or an absolute URL; null for no picture. */
  readonly avatarUrl: string | null;
  /** The programme on air, only meaningful while live; null when unknown. */
  readonly currentProgramme: string | null;
};

/**
 * The shape of a handle: shared-types CHANNEL_HANDLE_SHAPE, repeated here so
 * the phone reads the same rule whether or not its installed dist has it. A
 * value off this shape is not a handle and reads as null.
 */
const CHANNEL_HANDLE_SHAPE = /^[a-z0-9_]{3,24}$/;

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export interface ChannelDirectorySubscription {
  close(): void;
}

function isVisibility(value: unknown): value is WireChannelSummary['visibility'] {
  return value === 'public' || value === 'private' || value === 'locked';
}

/** One directory row read defensively; null when it is not a channel summary. */
export function parseChannelSummary(entry: unknown): ChannelSummary | null {
  if (entry === null || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;
  const channelId = candidate['channelId'];
  const displayName = candidate['displayName'];
  if (typeof channelId !== 'string' || typeof displayName !== 'string') return null;
  const visibility = candidate['visibility'];
  // No visibility is not "public": a row the gateway did not tier is not a channel.
  if (!isVisibility(visibility)) return null;
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

/** The whole `channel:directory` payload; anything that is not a list is an empty one. */
export function parseChannelDirectory(payload: unknown): ChannelSummary[] {
  if (!Array.isArray(payload)) return [];
  const channels: ChannelSummary[] = [];
  for (const entry of payload) {
    const parsed = parseChannelSummary(entry);
    if (parsed !== null) channels.push(parsed);
  }
  return channels;
}

export function subscribeChannelDirectory(
  gatewayUrl: string,
  onDirectory: (channels: readonly ChannelSummary[]) => void,
  onState?: (state: 'connecting' | 'connected' | 'disconnected') => void,
): ChannelDirectorySubscription {
  const socket: Socket = io(gatewayUrl, { query: { role: 'listener' }, reconnection: true });
  onState?.('connecting');
  socket.on('connect', () => onState?.('connected'));
  socket.on('disconnect', () => onState?.('disconnected'));
  socket.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, (payload: unknown) => {
    if (!Array.isArray(payload)) return;
    onDirectory(parseChannelDirectory(payload));
  });
  return {
    close() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}

/** The viewer page for a channel, on the web listener. */
export function listenerUrlFor(listenBaseUrl: string, channelId: string): string {
  return `${listenBaseUrl.replace(/\/+$/, '')}/c/${encodeURIComponent(channelId)}`;
}

/**
 * The public canonical page for a channel with a handle: /streams/<handle>
 * at the web origin (directive A). The viewer itself keeps opening the
 * opaque listener link above; this is the link a person SHARES.
 */
export function streamsUrlFor(webBaseUrl: string, handle: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/streams/${encodeURIComponent(handle)}`;
}

/**
 * Where a channel's picture is fetched from.
 *
 * The account service serves it publicly at GET /channels/<id>/avatar and
 * the row names it as `avatarUrl`, relative to that service; staging mounts
 * the service at /auth. An absolute URL is used as given. Null means no
 * picture, and the initials tile is shown instead.
 */
export function channelAvatarUri(accountBaseUrl: string, avatarUrl: string | null): string | null {
  if (avatarUrl === null || avatarUrl.length === 0) return null;
  if (/^(?:https?:)?\/\//i.test(avatarUrl) || avatarUrl.startsWith('data:')) return avatarUrl;
  const base = accountBaseUrl.replace(/\/+$/, '');
  return avatarUrl.startsWith('/') ? `${base}${avatarUrl}` : `${base}/${avatarUrl}`;
}
