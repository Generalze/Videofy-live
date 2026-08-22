/** @author masterzee001 */
/**
 * The binary framing: a 24-byte big-endian header and a payload.
 *
 * ```text
 * offset  size  field                type
 * ------  ----  -------------------  --------
 * 0       1     protocolVersion      uint8
 * 1       1     messageType          uint8
 * 2       2     flags                uint16
 * 4       4     streamId             uint32
 * 8       4     wireSequence         uint32
 * 12      8     platformTimestampMs  float64
 * 20      4     payloadLength        uint32
 * 24      …     payload
 * ```
 *
 * `platformTimestampMs` is float64 because a JavaScript number already is one:
 * every integral millisecond up to 2^53 is exact, no BigInt is allocated per
 * frame, and the value round-trips identically to what the adapter computed.
 *
 * Decoding validates before it trusts anything. This parser faces adapter
 * processes across a network, so "the length field said so" is not a reason to
 * allocate.
 */
import {
  CONNECTION_STREAM_ID,
  HEADER_BYTES,
  Limits,
  MessageType,
  PROTOCOL_VERSION,
  RESERVED_FLAGS_MASK,
  WireProtocolError,
  isKnownMessageType,
  type MessageTypeCode,
} from './protocol.js';

export interface WireFrame {
  readonly messageType: MessageTypeCode;
  readonly flags: number;
  readonly streamId: number;
  readonly wireSequence: number;
  /** Media time from the adapter. Finite and non-negative; see `decodeFrame`. */
  readonly platformTimestampMs: number;
  /** Raw payload: PCM for MEDIA, UTF-8 JSON for everything else. */
  readonly payload: Buffer;
}

export type WireFrameInput = Omit<WireFrame, 'flags'> & { readonly flags?: number };

/** The largest payload this message type may carry. */
function payloadLimitFor(messageType: number): number {
  // Translated media is audio and is bounded like audio. Sizing it as a
  // control payload would let a 64 KiB "frame" of speech through, which is two
  // full seconds -- a limit that only rejects the absurd does half its job.
  return messageType === MessageType.MEDIA || messageType === MessageType.TRANSLATED_MEDIA
    ? Limits.MEDIA_PAYLOAD_BYTES
    : Limits.CONTROL_PAYLOAD_BYTES;
}

export function encodeFrame(frame: WireFrameInput): Buffer {
  const flags = frame.flags ?? 0;
  const payload = frame.payload;
  const limit = payloadLimitFor(frame.messageType);
  if (payload.length > limit) {
    throw new WireProtocolError(
      'payload-too-large',
      `Payload of ${payload.length} bytes exceeds the ${limit}-byte limit for this message type.`,
    );
  }
  if (!Number.isFinite(frame.platformTimestampMs) || frame.platformTimestampMs < 0) {
    throw new WireProtocolError(
      'invalid-timestamp',
      'platformTimestampMs must be finite and non-negative.',
    );
  }

  const buffer = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  buffer.writeUInt8(PROTOCOL_VERSION, 0);
  buffer.writeUInt8(frame.messageType, 1);
  buffer.writeUInt16BE(flags, 2);
  buffer.writeUInt32BE(frame.streamId, 4);
  // Unsigned 32-bit, so a caller that has already wrapped its own counter is
  // encoded rather than rejected.
  buffer.writeUInt32BE(frame.wireSequence >>> 0, 8);
  buffer.writeDoubleBE(frame.platformTimestampMs, 12);
  buffer.writeUInt32BE(payload.length, 20);
  payload.copy(buffer, HEADER_BYTES);
  return buffer;
}

export function decodeFrame(buffer: Buffer): WireFrame {
  if (buffer.length < HEADER_BYTES) {
    throw new WireProtocolError(
      'truncated-header',
      `Frame is ${buffer.length} bytes; the header alone is ${HEADER_BYTES}.`,
    );
  }

  const version = buffer.readUInt8(0);
  if (version !== PROTOCOL_VERSION) {
    // Refused outright rather than parsed hopefully. The alternative — accept,
    // ignore the unrecognised field, lose the audio quietly — is the failure
    // this protocol is versioned to prevent.
    throw new WireProtocolError(
      'unsupported-version',
      `Protocol version ${version} is not supported; this build speaks ${PROTOCOL_VERSION}.`,
    );
  }

  const messageType = buffer.readUInt8(1);
  if (!isKnownMessageType(messageType)) {
    throw new WireProtocolError(
      'unknown-message-type',
      `Message type 0x${messageType.toString(16)} is not defined in this protocol version.`,
    );
  }

  const flags = buffer.readUInt16BE(2);
  if ((flags & RESERVED_FLAGS_MASK) !== 0) {
    // A reserved bit set means the sender believes in a protocol we do not
    // implement. Ignoring it would silently discard whatever it signified.
    throw new WireProtocolError('reserved-flags-set', 'Reserved flag bits are set.');
  }

  const streamId = buffer.readUInt32BE(4);
  const wireSequence = buffer.readUInt32BE(8);
  const platformTimestampMs = buffer.readDoubleBE(12);
  const payloadLength = buffer.readUInt32BE(20);

  const limit = payloadLimitFor(messageType);
  if (payloadLength > limit) {
    // Checked against the LIMIT before the buffer, so an absurd length is
    // refused at the header rather than after trying to satisfy it.
    throw new WireProtocolError(
      'payload-too-large',
      `Declared payload of ${payloadLength} bytes exceeds the ${limit}-byte limit.`,
    );
  }
  if (buffer.length !== HEADER_BYTES + payloadLength) {
    throw new WireProtocolError(
      'length-mismatch',
      `Declared payload of ${payloadLength} bytes does not match the ${
        buffer.length - HEADER_BYTES
      } bytes present.`,
    );
  }

  if (messageType === MessageType.MEDIA) {
    if (streamId === CONNECTION_STREAM_ID) {
      throw new WireProtocolError(
        'invalid-stream-id',
        'Media frames must name a stream; 0 is reserved for connection-scoped messages.',
      );
    }
    if (payloadLength === 0 || payloadLength % 2 !== 0) {
      throw new WireProtocolError(
        'invalid-media-length',
        `A PCM16 payload cannot be empty or of odd length; got ${payloadLength} bytes.`,
      );
    }
    if (!Number.isFinite(platformTimestampMs) || platformTimestampMs < 0) {
      // NaN and the infinities encode and decode perfectly well as binary64,
      // and would then poison every downstream comparison that touched them.
      throw new WireProtocolError(
        'invalid-timestamp',
        'platformTimestampMs must be finite and non-negative.',
      );
    }
  }

  return {
    messageType,
    flags,
    streamId,
    wireSequence,
    platformTimestampMs,
    payload: buffer.subarray(HEADER_BYTES),
  };
}

/**
 * Distance between two wire sequences, as a signed 32-bit difference.
 *
 * A wrap at 2^32 reads as a small forward step, which is what it is, rather
 * than as a jump backwards of four billion. At fifty frames a second a wrap is
 * 2.7 years away, but "unreachable" is not a specification — and the same
 * arithmetic on 16-bit RTP sequences is already load-bearing in the SIP
 * adapter's jitter buffer.
 */
export function sequenceDistance(from: number, to: number): number {
  return (to - from) | 0;
}
