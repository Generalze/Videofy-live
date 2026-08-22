/** @author masterzee001 */
/**
 * The gateway end of the realtime audio ingress.
 *
 * WHAT THIS REPLACES, and why it matters more than it looks. Audio reached
 * media-ingest as a WAV file written to a shared filesystem and announced over
 * HTTP. Two consequences followed from that one choice:
 *
 *   the two services had to share a disk, so they could not be separate hosts
 *   every partial re-sent the whole utterance so far, which is quadratic
 *
 * A persistent socket carrying frames removes both. Audio now moves as it is
 * captured, once each.
 *
 * THE CLIENT OWNS THE SEQUENCE, and the sequence is what makes loss visible.
 * If the socket backs up, this drops frames rather than growing a buffer into
 * latency nobody can recover from -- but it drops them LOUDLY: the sequence
 * still advances, so the receiver sees a gap, and the next frame carries the
 * discontinuity flag so the receiver knows the gap was deliberate rather than
 * the network's doing. Silently dropping audio is how a recogniser ends up
 * confidently joining two halves of different sentences.
 */
import { WebSocket } from 'ws';
import {
  encodeAbort,
  encodeAudio,
  encodeFinish,
  encodeOpen,
  decodeIngressFrame,
  type IngressErrorCode,
  type RealtimeServiceContext,
} from '@videofy-live/media-ingress-wire';

export interface RealtimeIngressClientOptions {
  readonly url: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly streamId: string;
  /**
   * The platform's service context, decided by session creation and carried
   * here. Typed so `programme/uploaded` cannot be passed: an upload belongs on
   * the batch path, and this client has no way to express otherwise.
   */
  readonly context: RealtimeServiceContext;
  readonly sourceLanguage?: string;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect';
  /** Beyond this many bytes buffered, audio is dropped rather than queued. */
  readonly maxBufferedBytes?: number;
  readonly openTimeoutMs?: number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  /** Injected for tests; production uses the real `ws` client. */
  readonly createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

export interface IngressClientAccounting {
  sent: number;
  droppedForBackpressure: number;
  refusals: { code: IngressErrorCode; message: string }[];
}

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export class RealtimeIngressClient {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private pendingDiscontinuity = false;
  private ended = false;
  readonly accounting: IngressClientAccounting = {
    sent: 0,
    droppedForBackpressure: 0,
    refusals: [],
  };

  constructor(private readonly options: RealtimeIngressClientOptions) {}

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN && !this.ended;
  }

  /**
   * Connect and open the stream, resolving only once the server said READY.
   *
   * Resolving on socket-open alone would be the smoke-test mistake in another
   * costume: the transport working proves nothing about whether the stream was
   * accepted, and audio sent into a stream that was refused goes nowhere while
   * every local component reports success.
   */
  async open(): Promise<void> {
    const headers: Record<string, string> =
      this.options.token === undefined ? {} : { authorization: `Bearer ${this.options.token}` };
    const socket = (this.options.createSocket ?? ((url, h) => new WebSocket(url, { headers: h })))(
      this.options.url,
      headers,
    );
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('ingress stream was not acknowledged in time'));
      }, this.options.openTimeoutMs ?? 10_000);

      const settleError = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };

      socket.on('error', settleError);
      socket.on('close', (code: number) => {
        if (!this.ended) settleError(new Error(`ingress socket closed (${code})`));
      });
      socket.on('message', (data: unknown, isBinary: boolean) => {
        if (!isBinary) return;
        const decoded = decodeIngressFrame(toBuffer(data));
        if (!decoded.ok) return;
        if (decoded.frame.kind === 'ready') {
          clearTimeout(timer);
          socket.off('error', settleError);
          resolve();
          return;
        }
        if (decoded.frame.kind === 'error') {
          this.accounting.refusals.push({
            code: decoded.frame.code,
            message: decoded.frame.message,
          });
          this.options.log?.('ingress refused a frame', { code: decoded.frame.code });
        }
      });
      socket.on('open', () => {
        socket.send(
          encodeOpen({
            sessionId: this.options.sessionId,
            streamId: this.options.streamId,
            context: this.options.context,
            ...(this.options.sourceLanguage === undefined
              ? {}
              : { sourceLanguage: this.options.sourceLanguage }),
            ...(this.options.sourceLanguageMode === undefined
              ? {}
              : { sourceLanguageMode: this.options.sourceLanguageMode }),
          }),
        );
      });
    });
  }

  /**
   * Send one frame of captured audio.
   *
   * Returns false when the frame was dropped for backpressure, so a caller that
   * cares can account for it rather than believing every frame was sent.
   */
  sendAudio(samples: Int16Array, platformTimestampMs: number, discontinuity = false): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN || this.ended) return false;

    const limit = this.options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    if (socket.bufferedAmount > limit) {
      // The sequence still advances, so the gap is visible on the far side, and
      // the next frame will say the discontinuity was deliberate. Holding the
      // audio instead would grow into latency that never recovers -- on a live
      // call, late audio is worth less than no audio.
      this.sequence += 1;
      this.pendingDiscontinuity = true;
      this.accounting.droppedForBackpressure += 1;
      return false;
    }

    socket.send(
      encodeAudio({
        sequence: this.sequence,
        platformTimestampMs,
        discontinuity: discontinuity || this.pendingDiscontinuity,
        samples,
      }),
    );
    this.sequence += 1;
    this.pendingDiscontinuity = false;
    this.accounting.sent += 1;
    return true;
  }

  /** The speaker stopped. Ask for what is owed. */
  finish(reason: string): void {
    this.end(encodeFinish({ streamId: this.options.streamId, reason }));
  }

  /** Give up on this stream. Deliberately not the same message as finish. */
  abort(reason: string): void {
    this.end(encodeAbort({ streamId: this.options.streamId, reason }));
  }

  private end(frame: Buffer): void {
    const socket = this.socket;
    if (socket === null || this.ended) return;
    this.ended = true;
    if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(1000, 'done');
        // A peer that never answers the close handshake must not hold shutdown
        // open forever.
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2000).unref?.();
      });
    }
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBufferLike);
}
