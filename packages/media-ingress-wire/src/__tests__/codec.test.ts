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
  decodeIngressFrame,
  encodeAbort,
  encodeAudio,
  encodeError,
  encodeFinish,
  encodeOpen,
  encodeReady,
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
    const open = encodeOpen({ sessionId: 's', streamId: 'st', serviceCategory: 'call' });
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
        serviceCategory: 'call',
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      }),
    );
    if (!result.ok || result.frame.kind !== 'open') throw new Error('expected open');
    expect(result.frame.open).toMatchObject({
      sessionId: 'cs_1',
      streamId: 'st_1',
      serviceCategory: 'call',
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

  it('an OPEN without a service category is refused', () => {
    const tampered = Buffer.concat([
      Buffer.from([IngressMessageType.OPEN]),
      Buffer.from(
        JSON.stringify({ sessionId: 's', streamId: 'st', version: INGRESS_PROTOCOL_VERSION }),
        'utf8',
      ),
    ]);
    // 'call' and 'programme' take different execution paths; guessing which
    // one a peer meant would silently put a live call on the batch path.
    expect(decodeIngressFrame(tampered)).toMatchObject({ ok: false, code: 'malformed-frame' });
  });
});
