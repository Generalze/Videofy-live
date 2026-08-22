/** @author masterzee001 */
/**
 * What Nova and Flux genuinely share: authentication and audio transport.
 *
 * They share nothing else. Nova speaks Listen v1 (`Results` / `is_final` /
 * `speech_final` / `UtteranceEnd`); Flux speaks Listen v2 (`TurnInfo` with
 * turn events). They are two protocol dialects behind one vendor name, and the
 * only honest way to model that is two implementations over one transport --
 * not one parser with a model-name branch down the middle of it.
 */

/** The subset of a WebSocket these adapters need. Injectable, so tests need no network. */
export interface DeepgramSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  readonly readyState: number;
}

export interface DeepgramSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export type DeepgramSocketFactory = (
  url: string,
  headers: Record<string, string>,
  handlers: DeepgramSocketHandlers,
) => DeepgramSocket;

export const SOCKET_OPEN = 1;

/**
 * Int16 samples to little-endian bytes.
 *
 * Explicit rather than `new Uint8Array(samples.buffer)`, which inherits the
 * HOST's endianness and would silently send byte-swapped audio on a big-endian
 * machine. The same reasoning produced `pcmToBytes` in the adapter wire.
 */
export function pcmBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index]!, true);
  }
  return out;
}

/**
 * The real socket, for production.
 *
 * Deliberately the only place in these adapters that imports `ws`. Everything
 * else takes a `DeepgramSocketFactory`, which is why the protocol tests run
 * offline and fail for reasons about our parser rather than about Deepgram's
 * uptime. This function is the thin part that cannot be tested that way, and
 * it is kept thin for exactly that reason.
 */
export function createDeepgramWebSocketFactory(
  WebSocketImpl: typeof import('ws').WebSocket,
): DeepgramSocketFactory {
  return (url, headers, handlers) => {
    const socket = new WebSocketImpl(url, { headers });
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data: unknown, isBinary: boolean) => {
      // Deepgram's control traffic is JSON text. A binary frame here is audio
      // coming back, which this protocol never does; forwarding it into the
      // JSON parser would produce a confusing parse error instead of a clear
      // one about an unexpected frame.
      if (isBinary) {
        handlers.onError(new Error('Deepgram sent a binary frame; expected JSON'));
        return;
      }
      handlers.onMessage(String(data));
    });
    socket.on('close', (code: number, reason: Buffer) =>
      handlers.onClose(`${code}: ${reason.toString('utf8').slice(0, 80)}`),
    );
    socket.on('error', (error: Error) => handlers.onError(error));
    return {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      get readyState(): number {
        return socket.readyState;
      },
    };
  };
}
