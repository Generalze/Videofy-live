/** @author masterzee001 */
/**
 * RTP packets, per RFC 3550.
 *
 * Three different clocks meet in this header and must never be substituted for
 * one another, because each answers a different question:
 *
 *   sequenceNumber  ORDER. 16-bit, +1 per packet, wraps at 65535. Answers
 *                   "did anything go missing, and in what order did it leave?"
 *   rtpTimestamp    MEDIA TIME. Advances by the samples in the packet, in the
 *                   codec's own clock rate (8000 Hz for G.711). Answers "where
 *                   in the sound does this belong?" It does NOT advance during
 *                   silence suppression, and it starts at a random offset.
 *   arrivedAtMs     WALL CLOCK on our side. Answers "when did we see it?" —
 *                   the only one of the three that measures the network.
 *
 * Conflating them is the classic RTP defect: using sequence numbers as time
 * makes jitter invisible, and using arrival time as media time makes every
 * network hiccup sound like the speaker paused.
 */

export interface RtpPacket {
  payloadType: number;
  sequenceNumber: number;
  /** Codec clock, NOT milliseconds and NOT a wall clock. */
  rtpTimestamp: number;
  ssrc: number;
  /** RFC 3550 marker bit; on audio it commonly flags a talkspurt start. */
  marker: boolean;
  payload: Buffer;
  /** Our receive time. Stamped by the reader, never read off the wire. */
  arrivedAtMs: number;
}

export class RtpParseError extends Error {
  constructor(
    readonly code: 'too-short' | 'bad-version' | 'truncated',
    message: string,
  ) {
    super(message);
    this.name = 'RtpParseError';
  }
}

const MIN_HEADER_BYTES = 12;

/**
 * Parse one datagram. Refuses rather than guesses: a malformed packet on a
 * live call is a packet to drop and count, not a reason to end the call, so
 * every caller is expected to catch this and carry on.
 */
export function parseRtpPacket(datagram: Buffer, arrivedAtMs: number): RtpPacket {
  if (datagram.length < MIN_HEADER_BYTES) {
    throw new RtpParseError('too-short', `RTP datagram of ${datagram.length} bytes is shorter than a header.`);
  }
  const version = datagram[0]! >> 6;
  if (version !== 2) {
    throw new RtpParseError('bad-version', `RTP version ${version} is not supported.`);
  }
  const hasPadding = (datagram[0]! & 0b0010_0000) !== 0;
  const hasExtension = (datagram[0]! & 0b0001_0000) !== 0;
  const csrcCount = datagram[0]! & 0b0000_1111;

  let offset = MIN_HEADER_BYTES + csrcCount * 4;
  if (datagram.length < offset) {
    throw new RtpParseError('truncated', 'RTP datagram ends inside its CSRC list.');
  }
  if (hasExtension) {
    // Extension header: 16-bit profile, 16-bit length in 32-bit words.
    if (datagram.length < offset + 4) {
      throw new RtpParseError('truncated', 'RTP datagram ends inside its extension header.');
    }
    const words = datagram.readUInt16BE(offset + 2);
    offset += 4 + words * 4;
    if (datagram.length < offset) {
      throw new RtpParseError('truncated', 'RTP extension length runs past the datagram.');
    }
  }

  let end = datagram.length;
  if (hasPadding) {
    const padding = datagram[end - 1]!;
    // A padding count of 0, or one larger than the remaining payload, is
    // nonsense; treating it as truth would silently eat real audio.
    if (padding === 0 || end - padding < offset) {
      throw new RtpParseError('truncated', 'RTP padding count is impossible.');
    }
    end -= padding;
  }

  return {
    payloadType: datagram[1]! & 0b0111_1111,
    marker: (datagram[1]! & 0b1000_0000) !== 0,
    sequenceNumber: datagram.readUInt16BE(2),
    rtpTimestamp: datagram.readUInt32BE(4),
    ssrc: datagram.readUInt32BE(8),
    payload: datagram.subarray(offset, end),
    arrivedAtMs,
  };
}

export interface RtpSerializeInput {
  payloadType: number;
  sequenceNumber: number;
  rtpTimestamp: number;
  ssrc: number;
  marker?: boolean;
  payload: Buffer;
}

export function serializeRtpPacket(input: RtpSerializeInput): Buffer {
  const header = Buffer.alloc(MIN_HEADER_BYTES);
  header[0] = 0b1000_0000; // version 2, no padding, no extension, no CSRC
  header[1] = (input.marker === true ? 0b1000_0000 : 0) | (input.payloadType & 0b0111_1111);
  // Both counters wrap by contract; masking here means callers may simply
  // increment forever without thinking about 16- and 32-bit edges.
  header.writeUInt16BE(input.sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(input.rtpTimestamp >>> 0, 4);
  header.writeUInt32BE(input.ssrc >>> 0, 8);
  return Buffer.concat([header, input.payload]);
}

/**
 * Distance from `from` to `to` across the 16-bit wrap, as a signed value.
 * Positive means `to` is later. Without this, sequence 0 arriving after 65535
 * reads as a jump backwards of 65535 and every wrap looks like catastrophe.
 */
export function sequenceDelta(from: number, to: number): number {
  const delta = (to - from) & 0xffff;
  return delta > 0x7fff ? delta - 0x10000 : delta;
}
