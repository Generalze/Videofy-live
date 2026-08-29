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
 * A listener socket, not an HTTP poll, because there is no HTTP form of the
 * directory and inventing one would be a second source of truth.
 */
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type ChannelSummary } from '@videofy-live/shared-types';

export type { ChannelSummary };

export interface ChannelDirectorySubscription {
  close(): void;
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
    const channels = payload.filter(
      (entry): entry is ChannelSummary =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as ChannelSummary).channelId === 'string' &&
        typeof (entry as ChannelSummary).displayName === 'string',
    );
    onDirectory(channels);
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
