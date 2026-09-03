/** @author masterzee001 */
/**
 * Codec pins. No socket is opened here on purpose: every protocol property is
 * provable before a port is ever bound, so a failure in this file is a failure
 * of the contract rather than of the weather.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_BYTES,
  INGRESS_PROTOCOL_VERSION,
  IngressLimits,
  IngressMessageType,
  realtimeServiceContext,
  decodeIngressFrame,
  encodeAbort,
  encodeAudio,
  encodeError,
  encodeFinish,
  encodeOpen,
  encodeReady,
  encodeTranslatedAudio,
  TRANSLATED_AUDIO_HEADER_BYTES,
} from '../index.js';

function audio(overrides: Partial<Parameters<typeof encodeAudio>[0]> = {}) {
  return encodeAudio({
    sequence: 7,
    platformTimestampMs: 12_340,
    discontinuity: false,
    samples: Int16Array.from([1, -2, 32_767, -32_768]),
    ...overrides,
  });
}

describe('audio frames survive the wire exactly', () => {
  it('PIN: sequence, platform time, discontinuity and samples all round-trip', () => {
    const result = decodeIngressFrame(audio({ discontinuity: true }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.kind !== 'audio') throw new Error('expected audio');
    expect(result.frame.audio.sequence).toBe(7);
    expect(result.frame.audio.platformTimestampMs).toBe(12_340);
    expect(result.frame.audio.discontinuity).toBe(true);
    expect(Array.from(result.frame.audio.samples)).toEqual([1, -2, 32_767, -32_768]);
  });

  it('PIN: the header is big-endian and the payload little-endian, by declaration', () => {
    const frame = audio({ sequence: 0x01020304, samples: Int16Array.from([0x0102]) });
    expect(frame[0]).toBe(IngressMessageType.AUDIO);
    // Header: network byte order.
    expect(Array.from(frame.subarray(4, 8))).toEqual([0x01, 0x02, 0x03, 0x04]);
    // Payload: the platform sample format. Inheriting the host's endianness
    // would make this correct only by coincidence.
    expect(Array.from(frame.subarray(AUDIO_HEADER_BYTES))).toEqual([0x02, 0x01]);
    expect(AUDIO_HEADER_BYTES).toBe(16);
  });

  it('PIN: the platform clock stays exact at real session magnitudes', () => {
    // Epoch milliseconds, which is what the gateway's canonical timeline uses.
    const ms = 1_756_000_000_123;
    const result = decodeIngressFrame(audio({ platformTimestampMs: ms }));
    if (!result.ok || result.frame.kind !== 'audio') throw new Error('expected audio');
    // A float that rounded here would drift media time against wire order --
    // the exact conflation P6.8 spent three passes separating.
    expect(result.frame.audio.platformTimestampMs).toBe(ms);
  });

  it('PIN: setting a flag does not disturb the platform clock', () => {
    const ms = 1_756_000_000_123;
    const plain = decodeIngressFrame(audio({ platformTimestampMs: ms, discontinuity: false }));
    const flagged = decodeIngressFrame(audio({ platformTimestampMs: ms, discontinuity: true }));
    if (!plain.ok || plain.frame.kind !== 'audio') throw new Error('expected audio');
    if (!flagged.ok || flagged.frame.kind !== 'audio') throw new Error('expected audio');
    // Header fields that overlap corrupt each other silently: the frame still
    // decodes and the clock is merely a little wrong. Both halves are asserted
    // -- an overlap can either damage the clock or lose the flag, depending on
    // which write lands last, and only checking one leaves the other open.
    expect(plain.frame.audio.platformTimestampMs).toBe(ms);
    expect(flagged.frame.audio.platformTimestampMs).toBe(ms);
    expect(plain.frame.audio.discontinuity).toBe(false);
    expect(flagged.frame.audio.discontinuity).toBe(true);
  });

  it('a silent frame is representable', () => {
    const result = decodeIngressFrame(audio({ samples: new Int16Array(0) }));
    if (!result.ok || result.frame.kind !== 'audio') throw new Error('expected audio');
    expect(result.frame.audio.samples).toHaveLength(0);
  });
});

describe('a hostile or confused peer is refused, never obeyed and never fatal', () => {
  it('PIN: half a sample is named rather than transcribed as static', () => {
    const frame = Buffer.concat([audio(), Buffer.from([0x01])]);
    const result = decodeIngressFrame(frame);
    // Truncating would shift every later sample by a byte and the rest of the
    // audio would decode as loud noise.
    expect(result).toMatchObject({ ok: false, code: 'odd-payload-length' });
  });

  it('PIN: a reserved flag bit is a protocol error, not something to ignore', () => {
    const frame = audio();
    frame.writeUInt8(0b0000_0010, 1);
    // Ignoring it would silently discard whatever a future version meant.
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'reserved-bits-set' });
  });

  it('PIN: an oversized payload is refused at the header', () => {
    const oversized = Buffer.concat([
      audio(),
      Buffer.alloc(IngressLimits.AUDIO_PAYLOAD_BYTES + 2),
    ]);
    // Refused before allocating for it, rather than after.
    expect(decodeIngressFrame(oversized)).toMatchObject({ ok: false, code: 'payload-too-large' });
  });

  it('PIN: an unknown frame type is named, never silently dropped', () => {
    // A dropped frame type is how a sender waits forever for a response to
    // something nobody parsed -- the P6.8 lesson stated as a parser rule.
    expect(decodeIngressFrame(Buffer.from([0x7e, 1, 2, 3]))).toMatchObject({
      ok: false,
      code: 'unknown-frame-type',
    });
  });

  it('PIN: a version mismatch refuses the stream rather than guessing', () => {
    const open = encodeOpen({ sessionId: 's', streamId: 'st', context: { serviceCategory: 'call', mediaMode: 'live' } });
    const body = JSON.parse(open.subarray(1).toString('utf8')) as Record<string, unknown>;
    body['version'] = INGRESS_PROTOCOL_VERSION + 1;
    const tampered = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(JSON.stringify(body), 'utf8'),
    ]);
    expect(decodeIngressFrame(tampered)).toMatchObject({
      ok: false,
      code: 'protocol-version-mismatch',
    });
  });

  it('PIN: decoding never throws, whatever arrives', () => {
    // A parser that throws on hostile input turns a bad frame into a lost
    // connection, which is a much bigger failure than the one that happened.
    const hostile = [
      Buffer.alloc(0),
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from([IngressMessageType.OPEN, 0x7b, 0x7b, 0x7b]),
      Buffer.from([IngressMessageType.AUDIO]),
      Buffer.concat([Buffer.from([IngressMessageType.OPEN]), Buffer.from('[]', 'utf8')]),
      Buffer.concat([Buffer.from([IngressMessageType.FINISH]), Buffer.from('{}', 'utf8')]),
    ];
    for (const frame of hostile) {
      const result = decodeIngressFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.code).toBe('string');
    }
  });

  it('PIN: a NaN or negative platform time is refused', () => {
    const frame = audio();
    frame.writeDoubleBE(Number.NaN, 8);
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'malformed-frame' });
    frame.writeDoubleBE(-1, 8);
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });
});

describe('encoding refuses our own bugs loudly', () => {
  it('PIN: an out-of-range sequence throws rather than reaching the wire', () => {
    // This input comes from our code, not a peer. An outcome here would invite
    // a caller to ignore it and make a corrupt frame the receiver's confusing
    // problem instead of our obvious one.
    expect(() => audio({ sequence: -1 })).toThrow(/sequence/);
    expect(() => audio({ sequence: 2 ** 32 })).toThrow(/sequence/);
    expect(() => audio({ sequence: 1.5 })).toThrow(/sequence/);
  });

  it('PIN: a NaN platform time throws rather than reaching the wire', () => {
    expect(() => audio({ platformTimestampMs: Number.NaN })).toThrow(/platformTimestampMs/);
    expect(() => audio({ platformTimestampMs: -1 })).toThrow(/platformTimestampMs/);
  });

  it('an oversized audio payload throws on encode', () => {
    expect(() => audio({ samples: new Int16Array(IngressLimits.AUDIO_PAYLOAD_BYTES) })).toThrow(
      /limit/,
    );
  });
});

describe('control frames', () => {
  it('OPEN round-trips and stamps the protocol version itself', () => {
    const result = decodeIngressFrame(
      encodeOpen({
        sessionId: 'cs_1',
        streamId: 'st_1',
        context: { serviceCategory: 'call', mediaMode: 'live' },
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      }),
    );
    if (!result.ok || result.frame.kind !== 'open') throw new Error('expected open');
    expect(result.frame.open).toMatchObject({
      sessionId: 'cs_1',
      streamId: 'st_1',
      context: { serviceCategory: 'call', mediaMode: 'live' },
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      version: INGRESS_PROTOCOL_VERSION,
    });
  });

  it('PIN: finishing and aborting are different frames, not one with a flag', () => {
    const finished = decodeIngressFrame(encodeFinish({ streamId: 'st_1', reason: 'hangup' }));
    const aborted = decodeIngressFrame(encodeAbort({ streamId: 'st_1', reason: 'superseded' }));
    // Flush what is owed, versus discard it. A single frame with a boolean
    // would eventually be sent with the wrong boolean and lose a sentence.
    expect(finished).toMatchObject({ ok: true, frame: { kind: 'finish' } });
    expect(aborted).toMatchObject({ ok: true, frame: { kind: 'abort' } });
  });

  it('READY and ERROR round-trip', () => {
    expect(decodeIngressFrame(encodeReady('st_1'))).toMatchObject({
      ok: true,
      frame: { kind: 'ready', streamId: 'st_1' },
    });
    expect(decodeIngressFrame(encodeError('audio-before-open', 'no stream'))).toMatchObject({
      ok: true,
      frame: { kind: 'error', code: 'audio-before-open' },
    });
  });

  it('PIN: an uploaded programme cannot open a realtime stream', () => {
    const tampered = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(
        JSON.stringify({
          sessionId: 's', streamId: 'st', version: INGRESS_PROTOCOL_VERSION,
          context: { serviceCategory: 'programme', mediaMode: 'uploaded' },
        }),
        'utf8',
      ),
    ]);
    // An upload already has a complete file. Admitting it here would mean the
    // batch path could be reached by whichever transport a caller picked --
    // transport deciding policy, which is the coupling P6.9 removed.
    expect(decodeIngressFrame(tampered)).toMatchObject({
      ok: false,
      code: 'uploaded-is-not-realtime',
    });
  });

  it('PIN: an absent mediaMode is refused rather than assumed live', () => {
    const tampered = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(
        JSON.stringify({
          sessionId: 's', streamId: 'st', version: INGRESS_PROTOCOL_VERSION,
          context: { serviceCategory: 'call' },
        }),
        'utf8',
      ),
    ]);
    // "It arrived on a WebSocket, so it is probably live" is exactly the
    // inference this field exists to make unnecessary.
    expect(decodeIngressFrame(tampered)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });

  it('PIN: an uploaded context cannot even be written at a call site', () => {
    // @ts-expect-error programme/uploaded is not a RealtimeServiceContext.
    const refused = () => encodeOpen({ sessionId: 's', streamId: 'st', context: { serviceCategory: 'programme', mediaMode: 'uploaded' } });
    void refused;
    // And the narrowing helper refuses it at runtime rather than defaulting.
    expect(realtimeServiceContext({ serviceCategory: 'programme', mediaMode: 'uploaded' })).toBeNull();
    // A live programme with no run identity is refused for the same reason:
    // it has no tenant, no vocabulary and no timeline to belong to.
    expect(realtimeServiceContext({ serviceCategory: 'programme', mediaMode: 'live' })).toBeNull();
    expect(
      realtimeServiceContext(
        { serviceCategory: 'programme', mediaMode: 'live' },
        { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' },
      ),
    ).toEqual({
      serviceCategory: 'programme',
      mediaMode: 'live',
      programme: { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' },
    });
    expect(realtimeServiceContext({ serviceCategory: 'call', mediaMode: 'live' })).toEqual({
      serviceCategory: 'call', mediaMode: 'live',
    });
  });

  it('an OPEN without a service category is refused', () => {
    const tampered = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(
        JSON.stringify({
          sessionId: 's', streamId: 'st', version: INGRESS_PROTOCOL_VERSION,
          context: { serviceCategory: 'nonsense', mediaMode: 'live' },
        }),
        'utf8',
      ),
    ]);
    // 'call' and 'programme' take different execution paths; guessing which
    // one a peer meant would silently put a live call on the batch path.
    expect(decodeIngressFrame(tampered)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });
});

describe('translated speech travels back frame by frame', () => {
  function translated(overrides: Partial<Parameters<typeof encodeTranslatedAudio>[0]> = {}) {
    return encodeTranslatedAudio({
      targetLanguage: 'es',
      segmentId: 'seg_42',
      generation: 2,
      sequence: 5,
      segmentStartMs: 1_756_000_000_123,
      final: false,
      samples: Int16Array.from([1, -2, 32_767]),
      ...overrides,
    });
  }

  it('PIN: platform identity and audio both survive the round trip', () => {
    const result = decodeIngressFrame(translated({ final: true }));
    if (!result.ok || result.frame.kind !== 'translated-audio') throw new Error('expected audio');
    const audio = result.frame.audio;
    // The gateway plays this in order and can abandon a superseded attempt
    // without ever learning which vendor spoke.
    expect(audio.segmentId).toBe('seg_42');
    expect(audio.generation).toBe(2);
    expect(audio.sequence).toBe(5);
    expect(audio.final).toBe(true);
    expect(audio.segmentStartMs).toBe(1_756_000_000_123);
    expect(Array.from(audio.samples)).toEqual([1, -2, 32_767]);
  });

  it('PIN: the final flag does not disturb the segment clock', () => {
    const plain = decodeIngressFrame(translated({ final: false }));
    const flagged = decodeIngressFrame(translated({ final: true }));
    if (!plain.ok || plain.frame.kind !== 'translated-audio') throw new Error('bad');
    if (!flagged.ok || flagged.frame.kind !== 'translated-audio') throw new Error('bad');
    // The inbound header had exactly this bug once: a flag one byte inside the
    // double, frames that still decoded, a clock merely a little wrong.
    expect(plain.frame.audio.segmentStartMs).toBe(1_756_000_000_123);
    expect(flagged.frame.audio.segmentStartMs).toBe(1_756_000_000_123);
    expect(plain.frame.audio.final).toBe(false);
    expect(flagged.frame.audio.final).toBe(true);
    expect(TRANSLATED_AUDIO_HEADER_BYTES).toBe(22);
  });

  it('PIN: a segmentId longer than the frame is refused, not read past', () => {
    const frame = translated();
    frame.writeUInt16BE(0xffff, 2);
    // Trusting a length field against a shorter buffer is how a parser reads
    // whatever memory happened to follow it.
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });

  it('PIN: half a sample is refused here too', () => {
    const frame = Buffer.concat([translated(), Buffer.from([0x01])]);
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'odd-payload-length' });
  });

  it('PIN: the target language survives, and several share a segmentId', () => {
    // The field this protocol version exists for. Without it one source
    // session could progressively speak exactly one language, because a second
    // pipeline's frames were indistinguishable from the first's.
    const spanish = decodeIngressFrame(translated({ targetLanguage: 'es' }));
    const french = decodeIngressFrame(translated({ targetLanguage: 'fr' }));
    if (!spanish.ok || spanish.frame.kind !== 'translated-audio') throw new Error('bad');
    if (!french.ok || french.frame.kind !== 'translated-audio') throw new Error('bad');
    expect(spanish.frame.audio.targetLanguage).toBe('es');
    expect(french.frame.audio.targetLanguage).toBe('fr');
    // Same segment, same sequence, different language: two streams, not a
    // duplicate.
    expect(spanish.frame.audio.segmentId).toBe(french.frame.audio.segmentId);
    expect(spanish.frame.audio.sequence).toBe(french.frame.audio.sequence);
  });

  it('PIN: a language that is not a language tag is refused', () => {
    for (const bad of ['', 'es fr', 'a'.repeat(33), 'es;drop']) {
      expect(() => translated({ targetLanguage: bad }), bad).toThrow(/language|limit/);
    }
  });

  it('PIN: a language length beyond the buffer is refused before allocation', () => {
    const frame = translated();
    frame.writeUInt8(31, 20);
    // A length field from a peer is an instruction to allocate. Checking it
    // against the real buffer FIRST is what stops that instruction being
    // followed.
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });

  it('PIN: an over-long language is refused BY LENGTH, before it is read', () => {
    // A long segmentId leaves room, so the buffer is big enough and only the
    // bound stops it. The DETAIL is asserted, not just the code: without the
    // bound the value would be read and then fail the tag check instead --
    // same refusal, different reason, and the difference is whether a
    // 40-byte read happened first.
    const frame = translated({ segmentId: 'x'.repeat(80) });
    frame.writeUInt8(40, 20);
    const result = decodeIngressFrame(frame);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/targetLanguage length 40/);
  });

  it('PIN: a decoded language that is not a tag is refused', () => {
    // Encode has its own guard; this proves the DECODER refuses independently,
    // which is what matters for a peer we do not control.
    const frame = translated({ targetLanguage: 'ab' });
    // Overwrite the two language bytes with something that is not a tag.
    const languageAt = TRANSLATED_AUDIO_HEADER_BYTES + Buffer.from('seg_42', 'utf8').length;
    frame.write('e;', languageAt, 'utf8');
    const result = decodeIngressFrame(frame);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/not a language tag/);
  });

  it('PIN: the reserved byte beside the language length must be zero', () => {
    const frame = translated();
    frame.writeUInt8(1, 21);
    expect(decodeIngressFrame(frame)).toMatchObject({ ok: false, code: 'reserved-bits-set' });
  });

  it('PIN: a v1 peer cannot open a stream, so its frames are never reinterpreted', () => {
    // The translated-audio frame layout changed incompatibly. The version
    // check at OPEN is what stops a v1 frame being read as the new shape: a v1
    // connection never reaches the point of sending audio.
    const open = encodeOpen({
      sessionId: 's', streamId: 'st', context: { serviceCategory: 'call', mediaMode: 'live' },
    });
    const body = JSON.parse(open.subarray(1).toString('utf8')) as Record<string, unknown>;
    expect(body['version']).toBe(INGRESS_PROTOCOL_VERSION);
    // Bumped to 3 when a programme OPEN began carrying its run identity.
    expect(INGRESS_PROTOCOL_VERSION).toBe(3);
    body['version'] = 1;
    const v1 = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(JSON.stringify(body), 'utf8'),
    ]);
    expect(decodeIngressFrame(v1)).toMatchObject({
      ok: false,
      code: 'protocol-version-mismatch',
    });
  });

  it('a nameless segment cannot be encoded', () => {
    expect(() => translated({ segmentId: '' })).toThrow(/segmentId/);
    expect(() => translated({ sequence: -1 })).toThrow(/sequence/);
    expect(() => translated({ generation: -1 })).toThrow(/generation/);
  });

  it('a multi-byte segment id survives, because ids are bytes not characters', () => {
    const result = decodeIngressFrame(translated({ segmentId: 'segmento_café_✓' }));
    if (!result.ok || result.frame.kind !== 'translated-audio') throw new Error('bad');
    expect(result.frame.audio.segmentId).toBe('segmento_café_✓');
  });
});

/*
 * A programme stream says whose it is, or it does not open.
 *
 * Before this, ingest learned a sessionId and a streamId and nothing else: it
 * could not fetch the programme's vocabulary, could not partition a timeline,
 * and two runs of one channel were indistinguishable. The identity is
 * therefore part of the OPEN contract rather than something a later message
 * might supply.
 */
describe('programme run identity on the wire', () => {
  const identity = { channelId: 'ch_abc', programmeId: 'prog_abc', runId: 'run_abc' };

  function decodeOpenWith(programme: unknown): ReturnType<typeof decodeIngressFrame> {
    const open = encodeOpen({
      sessionId: 's',
      streamId: 'st',
      context: { serviceCategory: 'programme', mediaMode: 'live', programme: identity },
    });
    const body = JSON.parse(open.subarray(1).toString('utf8')) as Record<string, unknown>;
    const context = body['context'] as Record<string, unknown>;
    if (programme === undefined) delete context['programme'];
    else context['programme'] = programme;
    return decodeIngressFrame(
      Buffer.concat([
        Buffer.from([IngressMessageType.OPEN]),
        Buffer.from(JSON.stringify(body), 'utf8'),
      ]),
    );
  }

  it('carries channel, programme and run through a round trip', () => {
    const open = encodeOpen({
      sessionId: 's',
      streamId: 'st',
      context: { serviceCategory: 'programme', mediaMode: 'live', programme: identity },
    });
    expect(decodeIngressFrame(open)).toMatchObject({
      ok: true,
      frame: { open: { context: { serviceCategory: 'programme', programme: identity } } },
    });
  });

  it('refuses a programme OPEN with no identity at all', () => {
    expect(decodeOpenWith(undefined)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });

  it('refuses a partial identity rather than filling in the rest', () => {
    // Two thirds of a tenant boundary is not a tenant boundary.
    expect(decodeOpenWith({ channelId: 'ch_abc', programmeId: 'prog_abc' })).toMatchObject({
      ok: false,
      code: 'malformed-frame',
    });
  });

  it('refuses ids that are not the shape ids take', () => {
    // A path separator in an id reaches a different programme's vocabulary.
    expect(
      decodeOpenWith({ ...identity, programmeId: '../other-programme' }),
    ).toMatchObject({ ok: false, code: 'malformed-frame' });
    expect(decodeOpenWith({ ...identity, runId: '' })).toMatchObject({
      ok: false,
      code: 'malformed-frame',
    });
  });

  it('leaves a call OPEN alone, which has no run to identify', () => {
    const open = encodeOpen({
      sessionId: 's',
      streamId: 'st',
      context: { serviceCategory: 'call', mediaMode: 'live' },
    });
    expect(decodeIngressFrame(open)).toMatchObject({ ok: true });
  });
});
