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
 */
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type ChannelSummary as WireChannelSummary } from '@videofy-live/shared-types';
import { isChannelCategory, type ChannelCategory } from '../programmes/channelCategories';

/**
 * The wire summary with the category parsed. Declared through Omit so it
 * stays correct whether or not the installed shared-types already carries
 * the `category` field (it is landing in a concurrent lane).
 */
export type ChannelSummary = Omit<WireChannelSummary, 'category'> & {
  readonly category: ChannelCategory | null;
};

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
  return {
    channelId,
    displayName,
    live: candidate['live'] === true,
    visibility,
    category: isChannelCategory(category) ? category : null,
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
