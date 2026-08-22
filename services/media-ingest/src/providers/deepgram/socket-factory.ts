/** @author masterzee001 */
/**
 * The real WebSocket behind `DeepgramSocketFactory`.
 *
 * Separated from the adapter so every test drives the adapter through an
 * injected fake and never opens a socket. The adapter holds the protocol
 * knowledge; this holds the transport, and only this file imports `ws`.
 */
import { WebSocket } from 'ws';
import type { DeepgramSocket, DeepgramSocketFactory } from './transport.js';

export function createDeepgramSocketFactory(): DeepgramSocketFactory {
  return (url, headers, handlers) => {
    const socket = new WebSocket(url, { headers });
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data: Buffer) => handlers.onMessage(data.toString('utf8')));
    socket.on('close', (code: number, reason: Buffer) =>
      handlers.onClose(reason.length > 0 ? reason.toString('utf8') : `code ${code}`),
    );
    socket.on('error', (error: Error) => handlers.onError(error));

    const adapter: DeepgramSocket = {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      get readyState() {
        return socket.readyState;
      },
    };
    return adapter;
  };
}
