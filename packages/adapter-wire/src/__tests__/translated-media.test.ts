/** @author masterzee001 */
/**
 * C-AI1.1F pins for the egress payload codec.
 *
 * These exist because the RTP acceptance does NOT cover them: that suite builds
 * `TranslatedMediaPayload` objects directly and feeds the egress, so the codec
 * between the two services was never exercised by it. Three mutations to this
 * file survived the first mutation pass for exactly that reason — a codec with
 * no tests of its own, sitting behind a suite that looked like it covered it.
 */
import { describe, expect, it } from 'vitest';
import {
  MessageType,
  TRANSLATED_MEDIA_HEADER_BYTES,
  WireProtocolError,
  decodeFrame,
  decodeTranslatedMedia,
  encodeFrame,
  encodeTranslatedMedia,
  violationScope,
  type TranslatedMediaPayload,
} from '../index.js';

function payload(overrides: Partial<TranslatedMediaPayload> = {}): TranslatedMediaPayload {
  return {
    targetLanguage: 'es',
    segmentId: 'seg_42',
    generation: 3,
    sequence: 7,
    final: false,
    samples: Int16Array.from([1, -2, 32_767, -32_768]),
    ...overrides,
  };
}

describe('translated media survives the wire exactly', () => {
  it('PIN: platform identity and audio both round-trip', () => {
    const decoded = decodeTranslatedMedia(encodeTranslatedMedia(payload({ final: true })));
    expect(decoded.segmentId).toBe('seg_42');
    expect(decoded.generation).toBe(3);
    expect(decoded.sequence).toBe(7);
    expect(decoded.final).toBe(true);
    expect(Array.from(decoded.samples)).toEqual([1, -2, 32_767, -32_768]);
  });

  it('PIN: samples are little-endian, including the loudest negative one', () => {
    const encoded = encodeTranslatedMedia(payload({ segmentId: 'a', samples: Int16Array.from([-32_768]) }));
    // header + segmentId 'a' (1 byte) + targetLanguage 'es' (2 bytes)
    const audioAt = TRANSLATED_MEDIA_HEADER_BYTES + 1 + 2;
    // 0x8000 little-endian. Big-endian here would put 0x80 first and the far
    // end would hear noise where the loudest sample should be.
    expect(encoded[audioAt]).toBe(0x00);
    expect(encoded[audioAt + 1]).toBe(0x80);
    expect(Array.from(decodeTranslatedMedia(encoded).samples)).toEqual([-32_768]);
  });

  it('PIN: the final flag lives at its own byte and disturbs nothing', () => {
    const plain = decodeTranslatedMedia(encodeTranslatedMedia(payload({ final: false })));
    const flagged = decodeTranslatedMedia(encodeTranslatedMedia(payload({ final: true })));
    // The ingress header had exactly this bug once: a flag inside another
    // field, frames that still decoded, and a value that was merely a little
    // wrong. Every other field is asserted alongside the flag for that reason.
    for (const decoded of [plain, flagged]) {
      expect(decoded.generation).toBe(3);
      expect(decoded.sequence).toBe(7);
      expect(decoded.segmentId).toBe('seg_42');
      expect(Array.from(decoded.samples)).toEqual([1, -2, 32_767, -32_768]);
    }
    expect(plain.final).toBe(false);
    expect(flagged.final).toBe(true);
    expect(TRANSLATED_MEDIA_HEADER_BYTES).toBe(14);
  });

  it('a multi-byte segment id survives, because ids are bytes not characters', () => {
    const decoded = decodeTranslatedMedia(
      encodeTranslatedMedia(payload({ segmentId: 'segmento_café_✓' })),
    );
    expect(decoded.segmentId).toBe('segmento_café_✓');
  });

  it('silence is representable', () => {
    const decoded = decodeTranslatedMedia(encodeTranslatedMedia(payload({ samples: new Int16Array(0) })));
    expect(decoded.samples).toHaveLength(0);
  });
});

describe('a malformed payload is refused, and refused at the right scope', () => {
  it('PIN: a segmentId length longer than the buffer is refused, not read past', () => {
    const encoded = encodeTranslatedMedia(payload());
    encoded.writeUInt16BE(0xffff, 8);
    // Trusting a length field against a shorter buffer is how a parser reads
    // whatever memory happened to follow it.
    expect(() => decodeTranslatedMedia(encoded)).toThrow(WireProtocolError);
    try {
      decodeTranslatedMedia(encoded);
    } catch (error) {
      expect((error as WireProtocolError).code).toBe('invalid-segment-id');
    }
  });

  it('PIN: half a sample is refused rather than truncated into noise', () => {
    const encoded = Buffer.concat([encodeTranslatedMedia(payload()), Buffer.from([0x01])]);
    try {
      decodeTranslatedMedia(encoded);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as WireProtocolError).code).toBe('odd-payload-length');
    }
  });

  it('PIN: a reserved bit is a refusal, not something to ignore', () => {
    // Byte 11 is now the language length; bytes 12..13 are the reserved pair.
    for (const [offset, value] of [[10, 0b0000_0010], [12, 0x01], [13, 0x01]] as const) {
      const encoded = encodeTranslatedMedia(payload());
      encoded.writeUInt8(value, offset);
      try {
        decodeTranslatedMedia(encoded);
        throw new Error(`expected a refusal for byte ${offset}`);
      } catch (error) {
        expect((error as WireProtocolError).code).toBe('reserved-bits-set');
      }
    }
  });

  it('PIN: a payload shorter than its header is refused', () => {
    try {
      decodeTranslatedMedia(Buffer.alloc(4));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as WireProtocolError).code).toBe('truncated-header');
    }
  });

  it('PIN: one bad payload costs one frame, never the connection', () => {
    // Tearing down a call because 20 ms of one sentence was malformed is a
    // larger failure than the one that happened. Speaking the protocol
    // BACKWARDS is different, and is connection-scoped.
    for (const code of [
      'invalid-generation',
      'invalid-sequence',
      'invalid-segment-id',
      'reserved-bits-set',
      'odd-payload-length',
    ] as const) {
      expect(violationScope(code), code).toBe('frame');
    }
    expect(violationScope('wrong-direction')).toBe('connection');
  });

  it('PIN: the target language survives, and a bad one is refused', () => {
    // Several languages share a segmentId. Losing this field is what limited
    // the whole path to one language per session.
    expect(decodeTranslatedMedia(encodeTranslatedMedia(payload({ targetLanguage: 'fr' }))).targetLanguage).toBe('fr');
    expect(decodeTranslatedMedia(encodeTranslatedMedia(payload({ targetLanguage: 'zh-Hans-CN' }))).targetLanguage).toBe('zh-Hans-CN');

    // A language reaches a routing decision and a room name, so anything that
    // is not a language tag is refused rather than sanitised into one.
    for (const bad of ['', 'es;drop', 'a'.repeat(33), 'es fr']) {
      expect(() => encodeTranslatedMedia(payload({ targetLanguage: bad })), bad).toThrow(/language/);
    }
  });

  it('PIN: a language length longer than the buffer is refused before allocation', () => {
    const encoded = encodeTranslatedMedia(payload());
    encoded.writeUInt8(31, 11);
    try {
      decodeTranslatedMedia(encoded);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as WireProtocolError).code).toBe('invalid-segment-id');
    }
  });

  it('encode refuses our own bugs loudly', () => {
    expect(() => encodeTranslatedMedia(payload({ segmentId: '' }))).toThrow(/segmentId/);
    expect(() => encodeTranslatedMedia(payload({ generation: -1 }))).toThrow(/generation/);
    expect(() => encodeTranslatedMedia(payload({ sequence: 2 ** 32 }))).toThrow(/sequence/);
  });
});

describe('the egress direction is a message type, not an inference', () => {
  it('PIN: TRANSLATED_MEDIA is its own type, distinct from MEDIA', () => {
    // Working out direction from which socket received a frame would make the
    // protocol's meaning depend on the topology, and the first relay in the
    // middle would invert it silently.
    expect(MessageType.TRANSLATED_MEDIA).not.toBe(MessageType.MEDIA);
    const frame = encodeFrame({
      messageType: MessageType.TRANSLATED_MEDIA,
      streamId: 9,
      wireSequence: 4,
      platformTimestampMs: 1_756_000_000_123,
      payload: encodeTranslatedMedia(payload()),
    });
    const decoded = decodeFrame(frame);
    expect(decoded.messageType).toBe(MessageType.TRANSLATED_MEDIA);
    expect(decoded.streamId).toBe(9);
    // The CONNECTION's counter is not the sentence's sequence. Both survive,
    // separately, because they mean different things.
    expect(decoded.wireSequence).toBe(4);
    expect(decodeTranslatedMedia(decoded.payload).sequence).toBe(7);
  });

  it('PIN: translated media is bounded as audio, not as a control payload', () => {
    // A control-sized limit would admit a 64 KiB "frame" of speech: two whole
    // seconds, which is not a frame at all.
    const huge = encodeTranslatedMedia(payload({ samples: new Int16Array(16 * 1024) }));
    expect(() =>
      encodeFrame({
        messageType: MessageType.TRANSLATED_MEDIA,
        streamId: 1,
        wireSequence: 0,
        platformTimestampMs: 0,
        payload: huge,
      }),
    ).toThrow(/exceeds/);
  });
});
