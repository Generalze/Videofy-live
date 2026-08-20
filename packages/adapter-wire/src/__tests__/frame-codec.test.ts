/** @author masterzee001 */
/**
 * The wire protocol, pinned before anything opens a port.
 *
 * The codec is pure on purpose: every property below is a property of the
 * CONTRACT, so a failure here is a failure of the design rather than of the
 * network, the scheduler, or the weather. None of these tests bind a socket.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STREAM_ID,
  FrameFlags,
  HEADER_BYTES,
  Limits,
  MessageType,
  PROTOCOL_VERSION,
  WireProtocolError,
  decodeFrame,
  encodeFrame,
  sequenceDistance,
  violationScope,
  type WireFrameInput,
} from '../index.js';
import { bytesToPcm, pcmToBytes } from '../pcm.js';

const pcm = (values: number[]): Buffer => pcmToBytes(Int16Array.from(values));

function mediaFrame(overrides: Partial<WireFrameInput> = {}): WireFrameInput {
  return {
    messageType: MessageType.MEDIA,
    streamId: 7,
    wireSequence: 101,
    platformTimestampMs: 2020,
    payload: pcm([0, 1, -1, 32767, -32768]),
    ...overrides,
  };
}

/** Decode expecting a specific protocol error, and report clearly when not. */
function expectWireError(buffer: Buffer, code: string): WireProtocolError {
  try {
    decodeFrame(buffer);
  } catch (error) {
    expect(error, `expected a WireProtocolError, got ${String(error)}`).toBeInstanceOf(
      WireProtocolError,
    );
    expect((error as WireProtocolError).code).toBe(code);
    return error as WireProtocolError;
  }
  throw new Error(`expected decode to fail with ${code}, but it succeeded`);
}

describe('framing round trip', () => {
  it('PIN: a frame survives encode and decode unchanged', () => {
    const input = mediaFrame();
    const decoded = decodeFrame(encodeFrame(input));
    expect(decoded.messageType).toBe(MessageType.MEDIA);
    expect(decoded.streamId).toBe(7);
    expect(decoded.wireSequence).toBe(101);
    expect(decoded.platformTimestampMs).toBe(2020);
    expect(decoded.flags).toBe(0);
    expect(Buffer.compare(decoded.payload, input.payload)).toBe(0);
  });

  it('PIN: PCM samples are byte-identical across the wire', () => {
    // Including both rails, because a sign error shows up at the extremes and
    // nowhere else — and 32767/-32768 are exactly where a byte swap stops
    // looking like noise and starts looking like audio.
    const samples = Int16Array.from([0, 1, -1, 255, -256, 32767, -32768, 12345, -12345]);
    const decoded = decodeFrame(encodeFrame(mediaFrame({ payload: pcmToBytes(samples) })));
    expect(Array.from(bytesToPcm(decoded.payload))).toEqual(Array.from(samples));
  });

  it('the header is exactly 24 bytes and big-endian', () => {
    const encoded = encodeFrame(mediaFrame({ streamId: 0x01020304, wireSequence: 0x0a0b0c0d }));
    expect(encoded.readUInt8(0)).toBe(PROTOCOL_VERSION);
    expect(encoded.readUInt8(1)).toBe(MessageType.MEDIA);
    // Byte order asserted by reading the bytes directly, not by trusting the
    // same helper the encoder used.
    expect([encoded[4], encoded[5], encoded[6], encoded[7]]).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect([encoded[8], encoded[9], encoded[10], encoded[11]]).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
    expect(encoded.length).toBe(HEADER_BYTES + 10);
  });

  it('PIN: the PCM payload is little-endian, whatever the header is', () => {
    // The one deliberate inconsistency in this protocol, and the one that
    // produces audio that is loud, wrong and superficially plausible if it is
    // ever quietly "fixed" for consistency.
    const encoded = encodeFrame(mediaFrame({ payload: pcmToBytes(Int16Array.from([0x0102])) }));
    const payload = encoded.subarray(HEADER_BYTES);
    expect([payload[0], payload[1]]).toEqual([0x02, 0x01]);
  });
});

describe('timestamps', () => {
  it('PIN: a large millisecond value round-trips exactly', () => {
    // float64 is exact for every integral millisecond below 2^53. If this ever
    // becomes an integer type, this is the test that notices.
    for (const value of [0, 1, 20, 1_000_000, 8_640_000_000_000, 2 ** 53 - 1]) {
      const decoded = decodeFrame(encodeFrame(mediaFrame({ platformTimestampMs: value })));
      expect(decoded.platformTimestampMs).toBe(value);
    }
  });

  it('PIN: NaN and the infinities are refused rather than encoded', () => {
    // They encode and decode perfectly well as binary64, and would then poison
    // every downstream comparison that touched them.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => encodeFrame(mediaFrame({ platformTimestampMs: value }))).toThrow(
        WireProtocolError,
      );
    }
  });

  it('PIN: a hand-built frame carrying NaN is refused on decode', () => {
    // The encoder refuses it, so a malicious or broken peer is the only way it
    // arrives — which is precisely the case that matters.
    const encoded = encodeFrame(mediaFrame());
    encoded.writeDoubleBE(Number.NaN, 12);
    expectWireError(encoded, 'invalid-timestamp');
  });
});

describe('malformed input is refused, proportionately', () => {
  it('PIN: a truncated header is a connection-scoped fault', () => {
    const error = expectWireError(encodeFrame(mediaFrame()).subarray(0, HEADER_BYTES - 1), 'truncated-header');
    expect(violationScope(error.code)).toBe('connection');
  });

  it('PIN: an unsupported protocol version is refused before anything else', () => {
    const encoded = encodeFrame(mediaFrame());
    encoded.writeUInt8(PROTOCOL_VERSION + 1, 0);
    const error = expectWireError(encoded, 'unsupported-version');
    expect(violationScope(error.code)).toBe('connection');
  });

  it('PIN: an unknown message type is refused, not ignored', () => {
    const encoded = encodeFrame(mediaFrame());
    encoded.writeUInt8(0x7f, 1);
    expectWireError(encoded, 'unknown-message-type');
  });

  it('PIN: a set reserved flag bit is refused', () => {
    // The sender believes in a protocol we do not implement. Ignoring the bit
    // would silently discard whatever it signified.
    const encoded = encodeFrame(mediaFrame());
    encoded.writeUInt16BE(FrameFlags.DISCONTINUITY | 0b10, 2);
    expectWireError(encoded, 'reserved-flags-set');
  });

  it('the discontinuity flag itself is accepted', () => {
    const decoded = decodeFrame(encodeFrame(mediaFrame({ flags: FrameFlags.DISCONTINUITY })));
    expect(decoded.flags & FrameFlags.DISCONTINUITY).toBe(FrameFlags.DISCONTINUITY);
  });

  it('PIN: a declared length that disagrees with the frame is refused', () => {
    const encoded = encodeFrame(mediaFrame());
    encoded.writeUInt32BE(encoded.length - HEADER_BYTES + 2, 20);
    expectWireError(encoded, 'length-mismatch');
  });

  it('PIN: an absurd declared length is refused at the header, not after allocating', () => {
    const encoded = encodeFrame(mediaFrame());
    encoded.writeUInt32BE(0xffffffff, 20);
    // Checked against the LIMIT before the buffer, so the mismatch check never
    // gets the chance to try to satisfy four gigabytes.
    expectWireError(encoded, 'payload-too-large');
  });

  it('PIN: a media payload above 16 KiB is refused', () => {
    const oversized = Buffer.alloc(Limits.MEDIA_PAYLOAD_BYTES + 2);
    expect(() => encodeFrame(mediaFrame({ payload: oversized }))).toThrow(WireProtocolError);
    // And the same size is fine as a control payload, whose limit is higher.
    expect(() =>
      encodeFrame({ ...mediaFrame(), messageType: MessageType.HELLO, payload: oversized }),
    ).not.toThrow();
  });

  it('PIN: a media payload that is empty or odd-length is refused', () => {
    // PCM16 with an odd byte count cannot be what it claims to be; this is not
    // a short read to tolerate.
    for (const size of [0, 1, 3, 641]) {
      const encoded = encodeFrame(mediaFrame({ payload: Buffer.alloc(size) }));
      const error = expectWireError(encoded, 'invalid-media-length');
      expect(violationScope(error.code)).toBe('frame');
    }
  });

  it('PIN: streamId 0 is reserved and never names a media stream', () => {
    const encoded = encodeFrame(mediaFrame({ streamId: CONNECTION_STREAM_ID }));
    const error = expectWireError(encoded, 'invalid-stream-id');
    // Scoped to the stream: one bad binding must not kill every unrelated call
    // multiplexed over the same connection.
    expect(violationScope(error.code)).toBe('stream');
  });

  it('a control frame may legitimately use stream 0 and an odd length', () => {
    // The media rules are media rules. Applying them to control frames would
    // forbid perfectly ordinary JSON.
    const decoded = decodeFrame(
      encodeFrame({
        messageType: MessageType.HELLO,
        streamId: CONNECTION_STREAM_ID,
        wireSequence: 0,
        platformTimestampMs: 0,
        payload: Buffer.from('{"a":1}', 'utf8'),
      }),
    );
    expect(decoded.payload.toString('utf8')).toBe('{"a":1}');
  });
});

describe('sequence arithmetic', () => {
  it('PIN: a wrap at 2^32 reads as a small forward step', () => {
    expect(sequenceDistance(4_294_967_295, 0)).toBe(1);
    expect(sequenceDistance(4_294_967_290, 4)).toBe(10);
    // And the other direction stays negative, so "behind" is still behind.
    expect(sequenceDistance(0, 4_294_967_295)).toBe(-1);
  });

  it('ordinary distances are unremarkable', () => {
    expect(sequenceDistance(100, 101)).toBe(1);
    expect(sequenceDistance(101, 100)).toBe(-1);
    expect(sequenceDistance(100, 100)).toBe(0);
  });

  it('a wrapped sequence encodes and decodes as itself', () => {
    const decoded = decodeFrame(encodeFrame(mediaFrame({ wireSequence: 4_294_967_295 })));
    expect(decoded.wireSequence).toBe(4_294_967_295);
  });
});
