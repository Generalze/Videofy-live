import type { ManagerOptions, SocketOptions } from 'socket.io-client';

export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

export function createOperatorSocketOptions(): SocketClientOptions {
  return {
    query: { role: 'operator' },
  };
}
