/** @author masterzee001 */
/**
 * The remote media-adapter protocol: versions, message types, limits, outcomes.
 *
 * Pure declarations. Nothing here opens a socket, and nothing here knows what a
 * WebSocket is — the codec is testable in full without a network, so every
 * protocol property can be pinned before a port is ever bound. A failure in
 * these tests is a failure of the contract rather than of the weather.
 *
 * See docs/P6_9_REMOTE_ADAPTER_WIRE_CONTRACT.md for the reasoning.
 */

/** Bumped only for incompatible change. A mismatch refuses the connection. */
export const PROTOCOL_VERSION = 1;

/**
 * Fixed 24-byte header. Big-endian, by network convention — the PCM payload
 * that follows is little-endian, which is deliberate and pinned by test. See
 * `pcm.ts` for why the two disagree on purpose.
 */
export const HEADER_BYTES = 24;

export const MessageType = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  STREAM_OPEN: 0x10,
  STREAM_OPEN_ACK: 0x11,
  STREAM_CLOSE: 0x12,
  MEDIA: 0x20,
  SETTLEMENT: 0x30,
  DISPOSITION: 0x31,
  PING: 0x40,
  PONG: 0x41,
  ERROR: 0x50,
} as const;

export type MessageTypeName = keyof typeof MessageType;
export type MessageTypeCode = (typeof MessageType)[MessageTypeName];

const KNOWN_MESSAGE_TYPES = new Set<number>(Object.values(MessageType));

export function isKnownMessageType(code: number): code is MessageTypeCode {
  return KNOWN_MESSAGE_TYPES.has(code);
}

export function messageTypeName(code: number): MessageTypeName | 'unknown' {
  for (const [name, value] of Object.entries(MessageType)) {
    if (value === code) return name as MessageTypeName;
  }
  return 'unknown';
}

/**
 * Frame flags.
 *
 * There is deliberately no end-of-stream bit. `STREAM_CLOSE`, `participantLeft`
 * and `closeSession` already say that, and two ways to end media is one too
 * many — they would eventually disagree.
 */
export const FrameFlags = {
  NONE: 0,
  /**
   * The stream is not continuous with the frame before it.
   *
   * WIRE-GENERATED state, not a property of `AdapterAudioFrame`, which has no
   * such field. The remote client sets it after its own outbound eviction,
   * after a detected transmission gap, or on media-channel recovery, so the
   * gateway can mark the chunker discontinuous rather than splicing unrelated
   * audio into one utterance.
   */
  DISCONTINUITY: 1 << 0,
} as const;

/** Anything outside this mask must be zero; a set reserved bit is a protocol error. */
export const RESERVED_FLAGS_MASK = ~FrameFlags.DISCONTINUITY & 0xffff;

// --- limits ---------------------------------------------------------------

/**
 * Generous, but never unbounded: the gateway is an authenticated parser facing
 * adapter processes.
 */
export const Limits = {
  /** JSON control payloads. */
  CONTROL_PAYLOAD_BYTES: 64 * 1024,
  /**
   * 16 KiB rather than 64. At a fixed 16 kHz mono PCM16, 20 ms is 640 bytes and
   * half a second is about 16 KiB — twenty-five times an ordinary frame, while
   * still rejecting absurd multi-second "frames" at the header instead of after
   * allocating for them. A limit that only rejects the obviously insane is
   * doing half its job.
   */
  MEDIA_PAYLOAD_BYTES: 16 * 1024,
  STREAMS_PER_CONNECTION: 256,
  PARTICIPANTS_PER_SESSION: 64,
  OUTBOUND_QUEUE_BYTES: 8 * 1024 * 1024,
  OUTBOUND_QUEUE_FRAMES: 2000,
  OUTBOUND_QUEUE_AGE_MS: 4000,
  MALFORMED_MESSAGES_BEFORE_CLOSE: 8,
  IDLE_WITHOUT_PONG_MS: 30_000,
} as const;

/** `0` is reserved for connection-scoped messages and never names a stream. */
export const CONNECTION_STREAM_ID = 0;

// --- outcomes -------------------------------------------------------------

/**
 * Every control operation and every disposition resolves to one of these.
 *
 * No operation disappears into `Promise<void>` once it has crossed a network:
 * three separate P6.8 defects were an await with no deadline or an exit that
 * returned silently, and the last survived two rounds of fixing its siblings.
 */
export type AdapterWireOutcome =
  | 'accepted'
  | 'rejected-auth'
  | 'rejected-route'
  | 'rejected-session'
  | 'rejected-participant'
  | 'rejected-stale'
  | 'dropped-backpressure'
  | 'timed-out'
  | 'protocol-error'
  | 'internal-failure';

/**
 * Where a frame died, named by the custody boundary it died at.
 *
 * Mutually exclusive by construction. Collapsing these into one cheerful
 * `dropped` is how a degraded seam becomes indistinguishable from a degraded
 * network.
 *
 * There is no category for gateway ingress queueing because P6.9 introduces no
 * such queue — the binding drives the chunker directly. A counter that is
 * always zero is worse than no counter, because someone eventually trusts it.
 */
export type FrameLossCategory =
  /** Discarded before transmission, by our own bounded queue. */
  | 'adapter-outbound-evicted'
  /** Transmission attempted; the transport failed. */
  | 'network-send-failed'
  /** The gateway refused custody of the wire frame. */
  | 'gateway-refused'
  /**
   * The frame entered the pipeline and a later transcription chunk was evicted
   * under the chunker's own bounds. OBSERVABILITY, not a frame-level NACK: by
   * then the gateway has custody and settlement has already happened.
   */
  | 'downstream-chunk-evicted';

/** Why a decode failed. These map onto `protocol-error` at the outcome level. */
export type WireErrorCode =
  | 'truncated-header'
  | 'unsupported-version'
  | 'unknown-message-type'
  | 'reserved-flags-set'
  | 'length-mismatch'
  | 'payload-too-large'
  | 'invalid-stream-id'
  | 'invalid-media-length'
  | 'invalid-timestamp';

export class WireProtocolError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WireProtocolError';
  }
}

/**
 * How far the damage from bad input reaches. The blast radius must match the
 * scope of the fault: one bad frame must not kill every unrelated call
 * multiplexed over the same connection, and a corrupted header must not be
 * politely ignored forever.
 */
export type ProtocolViolationScope = 'frame' | 'stream' | 'connection';

export function violationScope(code: WireErrorCode): ProtocolViolationScope {
  switch (code) {
    // The frame cannot be what it claims, but the channel is still coherent.
    case 'invalid-media-length':
    case 'invalid-timestamp':
      return 'frame';
    // Scoped to one stream: the rest of the connection is unaffected.
    case 'invalid-stream-id':
      return 'stream';
    // The framing itself is untrustworthy, so nothing after it can be believed.
    case 'truncated-header':
    case 'unsupported-version':
    case 'unknown-message-type':
    case 'reserved-flags-set':
    case 'length-mismatch':
    case 'payload-too-large':
      return 'connection';
  }
}
