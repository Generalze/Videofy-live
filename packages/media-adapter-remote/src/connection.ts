/** @author masterzee001 */
/**
 * One connection per adapter process, multiplexing every session it handles.
 *
 * The lifecycle is a state machine rather than a handful of booleans, for the
 * reason P6.8 spent four adversarial rounds learning: two flags that disagree
 * about whether something is alive is how a call reports itself closed while
 * still holding a socket. There is one authority here, and it answers
 * separately the questions that have separate answers.
 *
 *   DISCONNECTED → CONNECTING → CONNECTED ⇄ DEGRADED
 *                                    ↓         ↓
 *                                 RECONNECTING ┘
 *                                    ↓
 *                                 CONNECTED
 *   any state → CLOSED (terminal)
 *
 * Nothing here knows what a language, a voice or a provider is, and nothing
 * here validates a credential — Step 5 owns issuance, and this threads the
 * reserved opaque slots without inspecting them.
 */
import {
  FrameFlags,
  MessageType,
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonPayload,
  dispositionSchema,
  helloAckSchema,
  settlementSchema,
  streamOpenAckSchema,
  wireErrorSchema,
  type Disposition,
} from '@videofy-live/adapter-wire';
import { OutboundQueue, type OutboundQueueLimits, type QueuedFrame } from './outbound-queue.js';
import { pcmToBytes } from '@videofy-live/adapter-wire';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'closed';

export interface AdapterSocket {
  send(data: Buffer): void;
  close(): void;
}

export interface AdapterSocketHandlers {
  /**
   * Receives the socket it belongs to.
   *
   * Not a convenience: the connection assigns `this.socket` from the RETURN of
   * `connect`, so a factory that invoked `onOpen` synchronously would have HELLO
   * sent against a null socket and vanish without a trace. Handing the socket to
   * the handler removes the ordering hazard rather than depending on every
   * implementation deferring the callback.
   */
  onOpen(socket: AdapterSocket): void;
  onMessage(data: Buffer): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

/** Injected so every test runs without a real socket, deterministically. */
export interface AdapterSocketFactory {
  connect(handlers: AdapterSocketHandlers): AdapterSocket;
}

export interface ConnectionTimers {
  setTimer(handler: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const SYSTEM_TIMERS: ConnectionTimers = {
  setTimer(handler, delayMs) {
    const handle = setTimeout(handler, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Where a frame ended up, counted at the boundary it died at.
 *
 * Mutually exclusive by construction, and the invariant that matters:
 *
 *   accepted === queued + inFlight + settledAccepted
 *              + gatewayRefused + outboundEvicted + transportFailed
 *
 * Once `pushAudio` takes a frame, it ends in exactly one of those or is still
 * bounded and in flight. No orphans, no double counting.
 */
export interface RemoteMediaLedger {
  accepted: number;
  queued: number;
  inFlight: number;
  settledAccepted: number;
  gatewayRefused: number;
  outboundEvicted: number;
  transportFailed: number;
  accountedFor: number;
  unaccountedFor: number;
  balanced: boolean;
}

export interface StreamBinding {
  readonly adapterSessionRef: string;
  readonly participantId: string;
  readonly capability: string;
  /** Assigned by the gateway. Null until STREAM_OPEN_ACK, and NEW after reconnect. */
  streamId: number | null;
  readonly queue: OutboundQueue;
  /** Sent, not yet settled. Sequence → sample count, so settlement can account. */
  readonly inFlight: Map<number, number>;
  /** Local intent. A stream closed here is never resurrected by a reconnect. */
  closed: boolean;
}

export interface AdapterConnectionDeps {
  readonly sockets: AdapterSocketFactory;
  readonly adapterInstanceId: string;
  readonly queueLimits: OutboundQueueLimits;
  readonly now?: () => number;
  readonly timers?: ConnectionTimers;
  readonly reconnectDelayMs?: number;
  readonly idleWithoutPongMs?: number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class AdapterConnection {
  private state: ConnectionState = 'disconnected';
  private socket: AdapterSocket | null = null;
  private readonly streams = new Map<string, StreamBinding>();
  private readonly byStreamId = new Map<number, StreamBinding>();
  private readonly now: () => number;
  private readonly timers: ConnectionTimers;
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;
  private connecting: Promise<void> | null = null;
  private livenessHandle: unknown = null;
  private pendingStreamOpens: StreamBinding[] = [];

  private readonly counters = {
    accepted: 0,
    settledAccepted: 0,
    gatewayRefused: 0,
    outboundEvicted: 0,
    transportFailed: 0,
  };

  constructor(private readonly deps: AdapterConnectionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? SYSTEM_TIMERS;
    const sink = deps.log;
    // Wrapped once: a throwing log sink made a P6.8 call permanently
    // unclosable, and logging is diagnostics rather than control flow.
    this.log =
      sink === undefined
        ? () => {}
        : (line, detail) => {
            try {
              sink(line, detail);
            } catch {
              /* nowhere safe to report a broken reporter */
            }
          };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get ledger(): RemoteMediaLedger {
    let queued = 0;
    let inFlight = 0;
    for (const binding of this.streams.values()) {
      queued += binding.queue.pending;
      inFlight += binding.inFlight.size;
    }
    const c = this.counters;
    const accountedFor =
      queued + inFlight + c.settledAccepted + c.gatewayRefused + c.outboundEvicted + c.transportFailed;
    return {
      accepted: c.accepted,
      queued,
      inFlight,
      settledAccepted: c.settledAccepted,
      gatewayRefused: c.gatewayRefused,
      outboundEvicted: c.outboundEvicted,
      transportFailed: c.transportFailed,
      accountedFor,
      unaccountedFor: c.accepted - accountedFor,
      balanced: c.accepted === accountedFor,
    };
  }

  /**
   * Open the connection, or join the attempt already running.
   *
   * Armed before any await, so simultaneous callers cannot each start one.
   * Two connects racing is how a process ends up with two sockets and one
   * belief about which is current.
   */
  connect(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('Connection is closed.'));
    if (this.state === 'connected') return Promise.resolve();
    const running = this.connecting;
    if (running !== null) return running;

    this.state = this.state === 'disconnected' ? 'connecting' : 'reconnecting';
    let settle: () => void = () => {};
    let fail: (error: Error) => void = () => {};
    const attempt = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.connecting = attempt;

    this.socket = this.deps.sockets.connect({
      onOpen: (socket) => {
        this.socket = socket;
        this.sendControl(MessageType.HELLO, 0, {
          protocolVersion: 1,
          adapterInstanceId: this.deps.adapterInstanceId,
        });
      },
      onMessage: (data) => {
        try {
          this.receive(data, settle);
        } catch (error) {
          this.log('adapter wire message rejected', {
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
      },
      onClose: (reason) => this.handleDisconnect(reason, fail),
      onError: (error) => this.handleDisconnect(error.message, fail),
    });

    return attempt;
  }

  /** Bind a session+participant to a stream, once the connection is up. */
  async openStream(binding: Omit<StreamBinding, 'streamId' | 'queue' | 'inFlight' | 'closed'>): Promise<void> {
    const key = streamKey(binding.adapterSessionRef, binding.participantId);
    if (this.streams.has(key)) return;
    const stream: StreamBinding = {
      ...binding,
      streamId: null,
      inFlight: new Map(),
      closed: false,
      queue: new OutboundQueue({
        limits: this.deps.queueLimits,
        now: this.now,
        onEvicted: () => {
          this.counters.outboundEvicted += 1;
        },
      }),
    };
    this.streams.set(key, stream);
    await this.connect();
    // Only if the connect did not already open it. Establishing the connection
    // re-opens every live stream, so requesting again here sent a second
    // STREAM_OPEN for the same binding — and since ACKs correlate by order,
    // the extra one put every later stream's id out of step with its request.
    if (stream.streamId === null && !this.pendingStreamOpens.includes(stream)) {
      this.requestStreamOpen(stream);
    }
  }

  /**
   * Take custody of a frame. Returns false when the frame was NOT accepted, so
   * a caller is never told a frame is on its way when it is not.
   */
  offerAudio(
    adapterSessionRef: string,
    participantId: string,
    samples: Int16Array,
    platformTimestampMs: number,
  ): boolean {
    const stream = this.streams.get(streamKey(adapterSessionRef, participantId));
    if (stream === undefined || stream.closed) return false;
    if (this.state === 'closed') return false;
    this.counters.accepted += 1;
    stream.queue.offer({
      streamId: stream.streamId ?? 0,
      samples,
      platformTimestampMs,
      enqueuedAtMs: this.now(),
    });
    this.flush(stream);
    return true;
  }

  /** Close one stream locally. It is never reopened by a later reconnect. */
  closeStream(adapterSessionRef: string, participantId: string, reason: string): void {
    const key = streamKey(adapterSessionRef, participantId);
    const stream = this.streams.get(key);
    if (stream === undefined) return;
    stream.closed = true;
    // Whatever is still queued will never be sent; count it now rather than
    // letting it vanish with the map entry.
    stream.queue.drain();
    for (const _ of stream.inFlight.keys()) this.counters.transportFailed += 1;
    stream.inFlight.clear();
    if (stream.streamId !== null && this.state === 'connected') {
      this.sendControl(MessageType.STREAM_CLOSE, 0, { streamId: stream.streamId, reason });
      this.byStreamId.delete(stream.streamId);
    }
    this.streams.delete(key);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.livenessHandle !== null) this.timers.clearTimer(this.livenessHandle);
    this.livenessHandle = null;
    for (const stream of this.streams.values()) {
      stream.closed = true;
      stream.queue.drain();
      for (const _ of stream.inFlight.keys()) this.counters.transportFailed += 1;
      stream.inFlight.clear();
    }
    this.streams.clear();
    this.byStreamId.clear();
    try {
      this.socket?.close();
    } catch {
      /* closing a dead socket is not an error worth propagating */
    }
    this.socket = null;
    this.connecting = null;
  }

  // --- internals ----------------------------------------------------------

  private requestStreamOpen(stream: StreamBinding): void {
    if (stream.closed) return;
    if (this.state !== 'connected') {
      // Queued until the connection is up; a reconnect re-runs the same path.
      if (!this.pendingStreamOpens.includes(stream)) this.pendingStreamOpens.push(stream);
      return;
    }
    // RECORDED BEFORE SENT. Acknowledgements correlate by order, and a server
    // that answers promptly has its ACK arrive while `send` is still on the
    // stack — so recording the request afterwards meant the reply found
    // nothing outstanding and the stream never learned its id.
    if (!this.pendingStreamOpens.includes(stream)) this.pendingStreamOpens.push(stream);
    this.sendControl(MessageType.STREAM_OPEN, 0, {
      adapterSessionRef: stream.adapterSessionRef,
      participantId: stream.participantId,
      sessionCapability: stream.capability,
    });
  }

  private flush(stream: StreamBinding): void {
    if (this.state !== 'connected' || stream.streamId === null || stream.closed) return;
    for (;;) {
      const frame = stream.queue.take();
      if (frame === null) return;
      const payload = pcmToBytes(frame.samples);
      const encoded = encodeFrame({
        messageType: MessageType.MEDIA,
        streamId: stream.streamId,
        wireSequence: frame.wireSequence,
        platformTimestampMs: frame.platformTimestampMs,
        payload,
        flags: frame.discontinuity ? FrameFlags.DISCONTINUITY : 0,
      });
      try {
        this.socket?.send(encoded);
        stream.inFlight.set(frame.wireSequence, 1);
      } catch (error) {
        // Transmission attempted, transport failed. Its own category: a socket
        // that died is not the gateway refusing, and reading one as the other
        // sends an operator to the wrong system.
        this.counters.transportFailed += 1;
        stream.queue.markDiscontinuity();
        this.handleDisconnect(error instanceof Error ? error.message : 'send failed', () => {});
        return;
      }
    }
  }

  private sendControl(type: number, streamId: number, body: unknown): void {
    try {
      this.socket?.send(
        encodeFrame({
          messageType: type as never,
          streamId,
          wireSequence: 0,
          platformTimestampMs: 0,
          payload: encodeJsonPayload(body),
        }),
      );
    } catch (error) {
      this.handleDisconnect(error instanceof Error ? error.message : 'send failed', () => {});
    }
  }

  private receive(data: Buffer, settle: () => void): void {
    const frame = decodeFrame(data);
    switch (frame.messageType) {
      case MessageType.HELLO_ACK: {
        decodeJsonPayload(frame.payload, helloAckSchema);
        this.state = 'connected';
        this.connecting = null;
        this.armLiveness();
        // Re-open every live stream. A reconnect resumes TRANSPORT, never
        // authority: each stream presents its capability again and receives a
        // NEW streamId, because a reference we still remember is not evidence
        // that a session exists.
        // Not filtered here: `requestStreamOpen` refuses a closed stream
        // itself, and it is the authoritative guard because `openStream` goes
        // through it too. Two places asserting the same thing is how they come
        // to disagree.
        const toOpen = [...this.streams.values()];
        this.pendingStreamOpens = [];
        for (const stream of toOpen) {
          stream.streamId = null;
          stream.queue.resetForNewStream();
          this.requestStreamOpen(stream);
        }
        settle();
        return;
      }
      case MessageType.STREAM_OPEN_ACK: {
        const ack = decodeJsonPayload(frame.payload, streamOpenAckSchema);
        const stream = this.pendingStreamOpens.shift();
        if (stream === undefined || stream.closed) return;
        stream.streamId = ack.streamId;
        this.byStreamId.set(ack.streamId, stream);
        this.flush(stream);
        return;
      }
      case MessageType.SETTLEMENT: {
        const settlement = decodeJsonPayload(frame.payload, settlementSchema);
        this.settle(settlement.streamId, settlement.settledThroughSequence);
        return;
      }
      case MessageType.DISPOSITION: {
        this.applyDisposition(decodeJsonPayload(frame.payload, dispositionSchema));
        return;
      }
      case MessageType.PING: {
        this.sendControl(MessageType.PONG, 0, {});
        return;
      }
      case MessageType.PONG: {
        this.armLiveness();
        return;
      }
      case MessageType.ERROR: {
        const error = decodeJsonPayload(frame.payload, wireErrorSchema);
        this.log('adapter ingress reported an error', { code: error.code });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Everything at or below the settled sequence has a terminal disposition.
   * Anything a DISPOSITION did not name was accepted — so refusals are applied
   * first, and whatever is still in flight below the mark is settled accepted.
   */
  private settle(streamId: number, throughSequence: number): void {
    const stream = this.byStreamId.get(streamId);
    if (stream === undefined) return;
    for (const sequence of [...stream.inFlight.keys()]) {
      if (sequence <= throughSequence) {
        stream.inFlight.delete(sequence);
        this.counters.settledAccepted += 1;
      }
    }
  }

  private applyDisposition(disposition: Disposition): void {
    const stream = this.byStreamId.get(disposition.streamId);
    if (stream === undefined) return;
    // A frame that never arrived is not a refusal. `transportFailed` already
    // means "transmission attempted, transport failed", which is exactly what
    // happened; counting it as a gateway refusal would send an operator to
    // inspect a system that never saw the frame.
    const lost = disposition.outcome === 'lost-in-transit';
    for (let seq = disposition.fromSequence; seq <= disposition.toSequence; seq += 1) {
      if (!stream.inFlight.delete(seq)) continue;
      if (lost) this.counters.transportFailed += 1;
      else this.counters.gatewayRefused += 1;
    }
    // The run is broken from the gateway's point of view, so the next frame
    // that leaves says so.
    stream.queue.markDiscontinuity();
  }

  private armLiveness(): void {
    if (this.livenessHandle !== null) this.timers.clearTimer(this.livenessHandle);
    this.livenessHandle = this.timers.setTimer(() => {
      // A dead socket must become an explicit state rather than a healthy
      // looking one that Node has not yet emitted an event for.
      if (this.state === 'connected') this.state = 'degraded';
    }, this.deps.idleWithoutPongMs ?? 30_000);
  }

  private handleDisconnect(reason: string, fail: (error: Error) => void): void {
    if (this.state === 'closed') return;
    this.socket = null;
    this.connecting = null;
    if (this.livenessHandle !== null) this.timers.clearTimer(this.livenessHandle);
    this.livenessHandle = null;
    // Everything sent but unsettled is now unknowable. Counted as transport
    // failure rather than left in flight forever, because a frame nobody will
    // ever settle is not in flight, it is gone.
    for (const stream of this.streams.values()) {
      for (const _ of stream.inFlight.keys()) this.counters.transportFailed += 1;
      stream.inFlight.clear();
      stream.streamId = null;
      stream.queue.markDiscontinuity();
    }
    this.byStreamId.clear();
    this.pendingStreamOpens = [];
    this.state = 'reconnecting';
    this.log('adapter connection lost', { reason });
    fail(new Error(`Adapter connection lost: ${reason}`));
    const delay = this.deps.reconnectDelayMs ?? 500;
    this.timers.setTimer(() => {
      if (this.state === 'reconnecting') void this.connect().catch(() => {});
    }, delay);
  }
}

function streamKey(adapterSessionRef: string, participantId: string): string {
  return `${adapterSessionRef} ${participantId}`;
}
