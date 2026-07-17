import type { ManagerOptions, SocketOptions } from 'socket.io-client';

export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

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
