/** @author masterzee001 */
/**
 * Translated speech travelling OUT to an adapter.
 *
 * THE DIRECTION IS A MESSAGE TYPE, NOT AN INFERENCE. `MEDIA` means "an adapter
 * captured this from its endpoint"; `TRANSLATED_MEDIA` means "Videofy produced
 * this and wants it played". Working out which was meant from whichever socket
 * happened to receive it would make the protocol's meaning depend on the
 * deployment topology -- and the first proxy, relay or test harness that sat in
 * the middle would silently invert it. Each end refuses the direction it is not
 * supposed to receive, by name.
 *
 * WHY THE PAYLOAD CARRIES ITS OWN HEADER. The wire frame already has a
 * `streamId`, a `wireSequence` and a `platformTimestampMs`, and none of them is
 * what translated audio needs. `wireSequence` counts frames on a CONNECTION;
 * translated audio is ordered within a `(segmentId, generation)` that outlives
 * any particular connection and survives a reconnect. Reusing the connection
 * counter for it would tie a sentence's ordering to the socket that happened to
 * carry it.
 *
 * WHAT THIS DELIBERATELY DOES NOT CONTAIN: a codec name, a sample rate other
 * than the engine's, an RTP anything. The platform speaks PCM16 at 16 kHz and
 * the adapter converts at its own boundary. A G.711 payload type appearing in
 * this file would mean SIP had reached back into the translation pipeline.
 */
import { WireProtocolError } from './protocol.js';

/**
 * 14 bytes, laid out as:
 *
 *     0..3    generation, u32 big-endian
 *     4..7    sequence within (targetLanguage, segmentId, generation), u32 BE
 *     8..9    segmentId length in bytes, u16 big-endian
 *     10      flags (bit 0: final)
 *     11      targetLanguage length in bytes, u8
 *     12..13  reserved, must be zero
 *     14..    segmentId utf8, targetLanguage utf8, PCM16 little-endian samples
 *
 * No 64-bit field, and therefore no field that silently spans into another --
 * the mistake the ingress header made once, where a flags byte sat inside a
 * double and left a clock that was merely a little wrong.
 *
 * NO PROTOCOL VERSION BUMP, deliberately, and worth stating: `TRANSLATED_MEDIA`
 * is new in this wave and has never been released, so no deployed adapter
 * either sends or parses it. Bumping the whole adapter protocol would force
 * every existing adapter to be rebuilt for a message none of them has ever
 * seen. The first-party media-ingress protocol DID bump, because its
 * translated-audio frame had shipped.
 */
export const TRANSLATED_MEDIA_HEADER_BYTES = 14;

/** Bounded before allocation; a length read from a peer is an instruction. */
export const MAX_TRANSLATED_LANGUAGE_BYTES = 32;

const LANGUAGE_TAG = /^[A-Za-z0-9-]{1,32}$/;

export const TranslatedMediaFlags = {
  NONE: 0,
  /** The last frame of this generation. Nothing further may follow it. */
  FINAL: 1 << 0,
} as const;

export const TRANSLATED_MEDIA_RESERVED_FLAGS = ~TranslatedMediaFlags.FINAL & 0xff;

export interface TranslatedMediaPayload {
  /**
   * WHICH LANGUAGE this audio is in.
   *
   * One utterance is synthesised once per distinct target language, so several
   * independent frame streams share a `segmentId` and are told apart only by
   * this. A conference leg receiving Spanish and French would otherwise merge
   * them into one stuttering sequence.
   */
  readonly targetLanguage: string;
  /** Platform-owned utterance identity. The adapter never mints one. */
  readonly segmentId: string;
  /** Which synthesis attempt. Higher supersedes lower. */
  readonly generation: number;
  /** Order within (segmentId, generation). Starts at 0, never repeats. */
  readonly sequence: number;
  readonly final: boolean;
  /** 16 kHz mono PCM16. The engine format, converted only at the SIP boundary. */
  readonly samples: Int16Array;
}

const MAX_U32 = 0xffff_ffff;

export function encodeTranslatedMedia(payload: TranslatedMediaPayload): Buffer {
  if (!Number.isInteger(payload.generation) || payload.generation < 0 || payload.generation > MAX_U32) {
    throw new WireProtocolError('invalid-generation', `generation out of range: ${payload.generation}`);
  }
  if (!Number.isInteger(payload.sequence) || payload.sequence < 0 || payload.sequence > MAX_U32) {
    throw new WireProtocolError('invalid-sequence', `sequence out of range: ${payload.sequence}`);
  }
  const idBytes = Buffer.from(payload.segmentId, 'utf8');
  if (idBytes.length === 0 || idBytes.length > 0xffff) {
    throw new WireProtocolError('invalid-segment-id', 'segmentId must be 1..65535 bytes');
  }
  if (!LANGUAGE_TAG.test(payload.targetLanguage)) {
    throw new WireProtocolError('invalid-language', 'targetLanguage is not a language tag');
  }
  const languageBytes = Buffer.from(payload.targetLanguage, 'utf8');

  const buffer = Buffer.allocUnsafe(
    TRANSLATED_MEDIA_HEADER_BYTES +
      idBytes.length +
      languageBytes.length +
      payload.samples.length * 2,
  );
  buffer.writeUInt32BE(payload.generation, 0);
  buffer.writeUInt32BE(payload.sequence, 4);
  buffer.writeUInt16BE(idBytes.length, 8);
  buffer.writeUInt8(payload.final ? TranslatedMediaFlags.FINAL : 0, 10);
  buffer.writeUInt8(languageBytes.length, 11);
  buffer.writeUInt16BE(0, 12);
  idBytes.copy(buffer, TRANSLATED_MEDIA_HEADER_BYTES);
  languageBytes.copy(buffer, TRANSLATED_MEDIA_HEADER_BYTES + idBytes.length);

  const audioAt = TRANSLATED_MEDIA_HEADER_BYTES + idBytes.length + languageBytes.length;
  for (let index = 0; index < payload.samples.length; index += 1) {
    // Little-endian, stated. The frame header above is big-endian by network
    // convention; the two disagree deliberately and both are written down.
    buffer.writeInt16LE(payload.samples[index]!, audioAt + index * 2);
  }
  return buffer;
}

/**
 * Decode, or throw a NAMED protocol error.
 *
 * Throws rather than returning an outcome because the caller is already inside
 * a wire-frame handler that turns protocol errors into a scoped violation with
 * a code. Returning a second kind of failure here would give that handler two
 * error channels to keep in step.
 */
export function decodeTranslatedMedia(buffer: Buffer): TranslatedMediaPayload {
  if (buffer.length < TRANSLATED_MEDIA_HEADER_BYTES) {
    throw new WireProtocolError(
      'truncated-header',
      `Translated media payload is ${buffer.length} bytes; the header alone is ${TRANSLATED_MEDIA_HEADER_BYTES}.`,
    );
  }
  const flags = buffer.readUInt8(10);
  if ((flags & TRANSLATED_MEDIA_RESERVED_FLAGS) !== 0 || buffer.readUInt16BE(12) !== 0) {
    // A reserved bit set means the peer speaks a dialect we do not. Ignoring it
    // would silently discard whatever it meant.
    throw new WireProtocolError('reserved-bits-set', `Reserved bits set: flags 0x${flags.toString(16)}`);
  }
  // EVERY length checked against the real buffer BEFORE anything is allocated.
  const idLength = buffer.readUInt16BE(8);
  const languageLength = buffer.readUInt8(11);
  if (languageLength === 0 || languageLength > MAX_TRANSLATED_LANGUAGE_BYTES) {
    throw new WireProtocolError('invalid-language', `targetLanguage length ${languageLength}`);
  }
  const languageAt = TRANSLATED_MEDIA_HEADER_BYTES + idLength;
  const audioAt = languageAt + languageLength;
  if (idLength === 0 || buffer.length < audioAt) {
    // Trusting a length field against a shorter buffer is how a parser reads
    // whatever memory happened to follow it.
    throw new WireProtocolError('invalid-segment-id', 'segmentId does not fit within the payload');
  }
  const targetLanguage = buffer.subarray(languageAt, audioAt).toString('utf8');
  if (!LANGUAGE_TAG.test(targetLanguage)) {
    throw new WireProtocolError('invalid-language', 'targetLanguage is not a language tag');
  }
  const audioBytes = buffer.length - audioAt;
  if (audioBytes % 2 !== 0) {
    throw new WireProtocolError(
      'odd-payload-length',
      'Half a sample: truncating would shift every later sample by a byte.',
    );
  }

  const samples = new Int16Array(audioBytes / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(audioAt + index * 2);
  }
  return {
    targetLanguage,
    segmentId: buffer.subarray(TRANSLATED_MEDIA_HEADER_BYTES, languageAt).toString('utf8'),
    generation: buffer.readUInt32BE(0),
    sequence: buffer.readUInt32BE(4),
    final: (flags & TranslatedMediaFlags.FINAL) !== 0,
    samples,
  };
}
