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
