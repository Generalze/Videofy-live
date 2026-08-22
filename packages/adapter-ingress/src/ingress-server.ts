/** @author masterzee001 */
/**
 * The gateway's end of the remote adapter wire.
 *
 * Terminates framing, multiplexes streams, classifies sequences, settles what
 * it took custody of, and says so when it did not. What it does NOT do is
 * decide anything about the platform: session resolution and media delivery are
 * injected, so this object can be tested in full without a gateway, a chunker,
 * or a socket.
 *
 * It also does not reorder. P6.8's jitter buffer already normalizes transport
 * reordering before `MediaAdapterPort`, and the channel is ordered besides —
 * a second reorder buffer here would give one sentence three queues to clear
 * before reaching Whisper. So it classifies and reports instead.
 */
import {
  CONNECTION_STREAM_ID,
  FrameFlags,
  Limits,
  MessageType,
  WireProtocolError,
  bytesToPcm,
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonPayload,
  helloSchema,
  sequenceDistance,
  streamCloseSchema,
  streamOpenSchema,
  violationScope,
  type AdapterWireOutcome,
  type StreamOpen,
  encodeTranslatedMedia,
  type TranslatedMediaPayload,
} from '@videofy-live/adapter-wire';

/** One frame the gateway has taken custody of. */
export interface IngressMediaFrame {
  readonly adapterSessionRef: string;
  readonly participantId: string;
  readonly wireSequence: number;
  /** The adapter's media clock. */
  readonly platformTimestampMs: number;
  /** Arrival, observed here. Kept apart from the media clock on purpose. */
  readonly gatewayReceivedAtMs: number;
  /** True when this frame does not continue the one before it. */
  readonly discontinuity: boolean;
  readonly samples: Int16Array;
}

/**
 * What the gateway does with an accepted frame.
 *
 * Step 6 supplies the binding that drives the chunker. Injected so that every
 * protocol property here is testable without one, and so that this file never
 * learns what a chunker is.
 */
export interface AdapterMediaSink {
  deliver(frame: IngressMediaFrame): AdapterWireOutcome | Promise<AdapterWireOutcome>;
}

export interface ResolvedStream {
  readonly adapterSessionRef: string;
  readonly participantId: string;
}

/**
 * Turns a STREAM_OPEN into a stream the gateway is willing to accept media on,
 * or refuses it.
 *
 * Step 5 fills this with capability resolution. Until then an implementation
 * threads the opaque capability without inspecting it — and crucially, the
 * SERVER never takes the adapter's word for which session it is writing into:
 * the resolver answers that question, from the capability.
 */
export interface StreamResolver {
  resolve(open: StreamOpen): Promise<ResolvedStream | AdapterWireOutcome>;
}

export interface IngressSocket {
  send(data: Buffer): void;
  close(): void;
}

export interface IngressConnectionDeps {
  readonly socket: IngressSocket;
  readonly sink: AdapterMediaSink;
  readonly resolver: StreamResolver;
  readonly now?: () => number;
  readonly connectionId?: string;
  /** How far ahead of the expected sequence a gap may be before it is absurd. */
  readonly maxForwardGap?: number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

interface ServerStream {
  readonly streamId: number;
  readonly adapterSessionRef: string;
  readonly participantId: string;
  /** The next sequence expected. Everything below it has been disposed of. */
  expectedSequence: number;
  /** Highest sequence given a terminal disposition, for settlement. */
  settledThrough: number;
  /** Set when the previous frame did not arrive, so the next one says so. */
  pendingDiscontinuity: boolean;
  closed: boolean;
  delivered: number;
  duplicates: number;
  missing: number;
  refused: number;
}

export class AdapterIngressConnection {
  private helloReceived = false;
  private malformed = 0;
  private nextStreamId = 1;
  private closed = false;
  private readonly streams = new Map<number, ServerStream>();
  private readonly now: () => number;
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;

  constructor(private readonly deps: IngressConnectionDeps) {
    this.now = deps.now ?? (() => Date.now());
    const sink = deps.log;
    this.log =
      sink === undefined
        ? () => {}
        : (line, detail) => {
            try {
              sink(line, detail);
            } catch {
              /* a broken reporter is not a reason to drop a call */
            }
          };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get streamCount(): number {
    return [...this.streams.values()].filter((s) => !s.closed).length;
  }

  statsFor(streamId: number): Readonly<ServerStream> | undefined {
    return this.streams.get(streamId);
  }

  /** Feed one wire message. Never throws: a bad peer is handled, not fatal. */
  async receive(data: Buffer): Promise<void> {
    if (this.closed) return;
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.handleViolation(error);
      return;
    }

    try {
      switch (frame.messageType) {
        case MessageType.HELLO:
          this.onHello(frame.payload);
          return;
        case MessageType.STREAM_OPEN:
          await this.onStreamOpen(frame.payload);
          return;
        case MessageType.STREAM_CLOSE:
          this.onStreamClose(frame.payload);
          return;
        case MessageType.MEDIA:
          await this.onMedia(frame.streamId, frame.wireSequence, frame.platformTimestampMs, frame.flags, frame.payload);
          return;
        case MessageType.TRANSLATED_MEDIA:
          // THE WRONG DIRECTION. Videofy sends this; an adapter must not. A
          // peer sending it is speaking the protocol backwards, which is a
          // connection-scoped fault rather than one bad frame.
          this.handleViolation(
            new WireProtocolError(
              'wrong-direction',
              'TRANSLATED_MEDIA travels Videofy -> adapter and must not arrive here.',
            ),
          );
          return;
        case MessageType.PONG:
          return;
        case MessageType.PING:
          this.send(MessageType.PONG, {});
          return;
        default:
          // A message this end never expects to receive is a peer that believes
          // in a protocol we do not implement.
          this.handleViolation(
            new WireProtocolError('unknown-message-type', 'Unexpected message type for a server.'),
          );
          return;
      }
    } catch (error) {
      this.handleViolation(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.deps.socket.close();
    } catch {
      /* closing a dead socket is not an error worth propagating */
    }
  }

  // --- handlers -----------------------------------------------------------

  private onHello(payload: Buffer): void {
    const hello = decodeJsonPayload(payload, helloSchema);
    this.helloReceived = true;
    this.send(MessageType.HELLO_ACK, {
      protocolVersion: hello.protocolVersion,
      connectionId: this.deps.connectionId ?? 'conn',
    });
  }

  private async onStreamOpen(payload: Buffer): Promise<void> {
    if (!this.helloReceived) {
      // Nothing may be opened on a connection that has not identified itself.
      this.refuseConnection('protocol-error', 'STREAM_OPEN before HELLO.');
      return;
    }
    if (this.streamCount >= Limits.STREAMS_PER_CONNECTION) {
      this.send(MessageType.ERROR, { code: 'internal-failure', detail: 'stream limit reached' });
      return;
    }
    const open = decodeJsonPayload(payload, streamOpenSchema);
    const resolved = await this.deps.resolver.resolve(open);
    if (typeof resolved === 'string') {
      // Refused. The adapter is told which of its assumptions was wrong rather
      // than left to infer it from silence.
      this.send(MessageType.ERROR, { code: resolved, detail: 'stream refused' });
      return;
    }
    // Allocated here, and never reused within this connection's lifetime, so a
    // frame still in a buffer somewhere cannot acquire a new meaning by
    // arriving late against a recycled number.
    const streamId = this.nextStreamId++;
    this.streams.set(streamId, {
      streamId,
      adapterSessionRef: resolved.adapterSessionRef,
      participantId: resolved.participantId,
      expectedSequence: 0,
      settledThrough: -1,
      pendingDiscontinuity: false,
      closed: false,
      delivered: 0,
      duplicates: 0,
      missing: 0,
      refused: 0,
    });
    this.send(MessageType.STREAM_OPEN_ACK, { streamId });
  }

  private onStreamClose(payload: Buffer): void {
    const request = decodeJsonPayload(payload, streamCloseSchema);
    const stream = this.streams.get(request.streamId);
    if (stream === undefined) return;
    stream.closed = true;
  }

  private async onMedia(
    streamId: number,
    wireSequence: number,
    platformTimestampMs: number,
    flags: number,
    payload: Buffer,
  ): Promise<void> {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.closed) {
      // Scoped to the stream: one unknown binding must not take down every
      // unrelated call multiplexed over the same connection.
      this.send(MessageType.ERROR, {
        code: 'rejected-stale',
        detail: 'no such stream',
        streamId,
      });
      return;
    }

    const distance = sequenceDistance(stream.expectedSequence, wireSequence);
    if (distance < 0) {
      // Its slot has passed. Counted, and NOT delivered twice — the listener
      // hearing 20 ms of speech again is worse than not hearing it.
      stream.duplicates += 1;
      return;
    }
    if (distance > (this.deps.maxForwardGap ?? 1000)) {
      // Far enough ahead that the stream is no longer credible.
      this.failStream(stream, 'protocol-error', 'sequence jumped implausibly far');
      return;
    }
    if (distance > 0) {
      // A gap. Reported rather than inferred from absence, and given a terminal
      // disposition so the sender's frames stop waiting for a settlement that
      // can never come.
      stream.missing += distance;
      this.send(MessageType.DISPOSITION, {
        streamId,
        outcome: 'lost-in-transit',
        fromSequence: stream.expectedSequence,
        toSequence: wireSequence - 1,
        count: distance,
      });
      stream.settledThrough = wireSequence - 1;
      stream.pendingDiscontinuity = true;
    }

    const outcome = await this.deps.sink.deliver({
      adapterSessionRef: stream.adapterSessionRef,
      participantId: stream.participantId,
      wireSequence,
      platformTimestampMs,
      gatewayReceivedAtMs: this.now(),
      discontinuity: (flags & FrameFlags.DISCONTINUITY) !== 0 || stream.pendingDiscontinuity,
      samples: bytesToPcm(payload),
    });
    stream.pendingDiscontinuity = false;
    stream.expectedSequence = (wireSequence + 1) >>> 0;

    if (outcome === 'accepted') {
      stream.delivered += 1;
      stream.settledThrough = wireSequence;
      // Cumulative and periodic. A round trip per 20 ms frame would serialise
      // a live conversation around network latency.
      this.send(MessageType.SETTLEMENT, { streamId, settledThroughSequence: stream.settledThrough });
      return;
    }

    stream.refused += 1;
    stream.settledThrough = wireSequence;
    this.send(MessageType.DISPOSITION, {
      streamId,
      outcome,
      fromSequence: wireSequence,
      toSequence: wireSequence,
      count: 1,
    });
    // Settled too: a refusal IS a terminal disposition, so everything at or
    // below this point is now resolved.
    this.send(MessageType.SETTLEMENT, { streamId, settledThroughSequence: stream.settledThrough });
  }

  // --- faults -------------------------------------------------------------

  private handleViolation(error: unknown): void {
    if (!(error instanceof WireProtocolError)) {
      this.refuseConnection('internal-failure', 'unhandled ingress fault');
      return;
    }
    const scope = violationScope(error.code);
    this.malformed += 1;
    this.log('adapter ingress rejected a message', { code: error.code, scope });

    if (scope === 'connection') {
      this.refuseConnection('protocol-error', error.code);
      return;
    }
    if (this.malformed >= Limits.MALFORMED_MESSAGES_BEFORE_CLOSE) {
      // Bounded, so a peer cannot stream garbage indefinitely at zero cost.
      this.refuseConnection('protocol-error', 'too many malformed messages');
      return;
    }
    this.send(MessageType.ERROR, { code: 'protocol-error', detail: error.code });
  }

  private failStream(stream: ServerStream, code: string, detail: string): void {
    stream.closed = true;
    this.send(MessageType.ERROR, { code, detail, streamId: stream.streamId });
  }

  private refuseConnection(code: string, detail: string): void {
    this.send(MessageType.ERROR, { code, detail });
    this.close();
  }

  /**
   * Send translated speech to this adapter, for one open stream.
   *
   * Returns whether the frame was handed to the socket. False is an ordinary
   * answer -- a closed connection, an unknown stream -- and the caller decides
   * what to do about it. Throwing would make a hung-up call into an exception
   * on the delivery path of every other call on the connection.
   */
  sendTranslatedMedia(
    streamId: number,
    payload: TranslatedMediaPayload,
    platformTimestampMs: number,
  ): boolean {
    if (this.closed) return false;
    try {
      this.deps.socket.send(
        encodeFrame({
          messageType: MessageType.TRANSLATED_MEDIA,
          streamId,
          // The CONNECTION's counter, which is a different thing from the
          // sequence inside the payload: that one orders a sentence and
          // survives a reconnect, this one counts frames on this socket.
          wireSequence: this.nextEgressSequence(),
          platformTimestampMs,
          payload: encodeTranslatedMedia(payload),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private egressSequence = 0;

  private nextEgressSequence(): number {
    this.egressSequence = (this.egressSequence + 1) >>> 0;
    return this.egressSequence;
  }

  private send(messageType: number, body: unknown): void {
    if (this.closed && messageType !== MessageType.ERROR) return;
    try {
      this.deps.socket.send(
        encodeFrame({
          messageType: messageType as never,
          streamId: CONNECTION_STREAM_ID,
          wireSequence: 0,
          platformTimestampMs: 0,
          payload: encodeJsonPayload(body),
        }),
      );
    } catch {
      // A socket that will not take a reply is already gone.
      this.closed = true;
    }
  }
}
