import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';

export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

export interface ListenerLanguageSocket {
  emit(event: typeof SOCKET_EVENTS.JOIN_LANGUAGE, targetLanguage: string): unknown;
}

export function joinCurrentListenerLanguage(
  socket: ListenerLanguageSocket,
  getTargetLanguage: () => string,
): void {
  socket.emit(SOCKET_EVENTS.JOIN_LANGUAGE, getTargetLanguage());
}

export function resolveSocketTransportOptions(
  transport: string | undefined,
): Pick<SocketClientOptions, 'transports' | 'upgrade'> {
  if (transport === 'polling') {
    return {
      transports: ['polling'],
      upgrade: false,
    };
  }

  return {};
}

export function createListenerSocketOptions(): SocketClientOptions {
  return {
    query: { role: 'listener' },
    ...resolveSocketTransportOptions(import.meta.env['VITE_SOCKET_TRANSPORT']),
  };
}
