/** @author masterzee001 */
/**
 * Byte order, and the shape of the control plane.
 *
 * The endianness tests matter more than they look. A byte-order mistake in PCM
 * does not crash: it produces audio that is loud, wrong, and superficially
 * plausible, which is the failure mode most likely to reach a listener before
 * anyone notices.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_IS_LITTLE_ENDIAN, bytesToPcm, pcmToBytes } from '../pcm.js';
import {
  createSessionRequestSchema,
  decodeJsonPayload,
  encodeJsonPayload,
  helloSchema,
  settlementSchema,
  streamOpenAckSchema,
} from '../control.js';
import { PROTOCOL_VERSION } from '../protocol.js';

const SAMPLES = Int16Array.from([0, 1, -1, 255, -256, 32767, -32768, 4660]);

describe('PCM byte order is defined by the protocol, not by the CPU', () => {
  it('PIN: the explicit path and the fast path produce identical bytes', () => {
    // The whole point. `hostLittleEndian: false` forces the explicit
    // conversion on a machine that is little-endian, which is the only way
    // that branch is ever executed in this project's lifetime — and an
    // untested branch in a byte-order conversion is a branch that will be
    // wrong when it finally runs.
    const fast = pcmToBytes(SAMPLES, { hostLittleEndian: true });
    const explicit = pcmToBytes(SAMPLES, { hostLittleEndian: false });
    expect(Buffer.compare(fast, explicit)).toBe(0);
  });

  it('PIN: decoding agrees across both paths, and round-trips', () => {
    const bytes = pcmToBytes(SAMPLES, { hostLittleEndian: false });
    expect(Array.from(bytesToPcm(bytes, { hostLittleEndian: true }))).toEqual(Array.from(SAMPLES));
    expect(Array.from(bytesToPcm(bytes, { hostLittleEndian: false }))).toEqual(Array.from(SAMPLES));
  });

  it('PIN: the bytes really are little-endian', () => {
    // Asserted against the literal expected bytes rather than against the
    // other direction of the same helper, which would pass even if both were
    // wrong in the same way.
    const bytes = pcmToBytes(Int16Array.from([0x1234, -2]), { hostLittleEndian: false });
    expect([...bytes]).toEqual([0x34, 0x12, 0xfe, 0xff]);
  });

  it('an odd byte count is malformed by definition', () => {
    expect(() => bytesToPcm(Buffer.alloc(3))).toThrow(RangeError);
  });

  it('decoding does not alias the source buffer', () => {
    // A Buffer is a slice of a pooled allocation; a view rather than a copy
    // would let the next frame overwrite the samples of this one.
    const bytes = pcmToBytes(SAMPLES);
    const samples = bytesToPcm(bytes);
    bytes.fill(0);
    expect(Array.from(samples)).toEqual(Array.from(SAMPLES));
  });

  it('encoding does not alias the caller-supplied samples', () => {
    const samples = Int16Array.from(SAMPLES);
    const bytes = pcmToBytes(samples);
    samples.fill(0);
    expect(Array.from(bytesToPcm(bytes))).toEqual(Array.from(SAMPLES));
  });

  it('the host detection is a boolean, and this run took one of the paths', () => {
    expect(typeof HOST_IS_LITTLE_ENDIAN).toBe('boolean');
  });
});

describe('control envelopes', () => {
  const validCreate = {
    protocolVersion: PROTOCOL_VERSION,
    adapterSessionRef: 'sc_9f3a1c7b',
    routeRef: 'route_17',
    idempotencyKey: 'adapter-1:route_17:sc_9f3a1c7b',
    platformSessionRef: 'call-id-from-the-sbc',
  };

  it('round-trips through a frame payload', () => {
    const decoded = decodeJsonPayload(encodeJsonPayload(validCreate), createSessionRequestSchema);
    expect(decoded).toEqual(validCreate);
  });

  it('PIN: an unknown field is refused, not quietly dropped', () => {
    // Strict schemas on purpose. A silently ignored field is how a sender and
    // a receiver come to disagree about what was requested.
    expect(() =>
      createSessionRequestSchema.parse({ ...validCreate, targetLanguage: 'es' }),
    ).toThrow();
  });

  it('PIN: a wrong protocol version is refused', () => {
    expect(() =>
      createSessionRequestSchema.parse({ ...validCreate, protocolVersion: PROTOCOL_VERSION + 1 }),
    ).toThrow();
  });

  it('PIN: HELLO carries no secret material', () => {
    // The service credential authenticates the HTTP Upgrade, before this frame
    // is read. Long-lived secrets do not belong in application frames that get
    // logged, buffered and replayed.
    const shape = Object.keys(helloSchema.shape);
    expect(shape.sort()).toEqual(['adapterInstanceId', 'protocolVersion']);
    expect(() =>
      helloSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        adapterInstanceId: 'a1',
        serviceCredential: 'hunter2',
      }),
    ).toThrow();
  });

  it('PIN: a stream id must be positive — 0 is reserved', () => {
    expect(() => streamOpenAckSchema.parse({ streamId: 0 })).toThrow();
    expect(streamOpenAckSchema.parse({ streamId: 1 }).streamId).toBe(1);
  });

  it('settlement carries a sequence, and sequence 0 is legitimate', () => {
    expect(settlementSchema.parse({ streamId: 1, settledThroughSequence: 0 })).toEqual({
      streamId: 1,
      settledThroughSequence: 0,
    });
    expect(() => settlementSchema.parse({ streamId: 1, settledThroughSequence: -1 })).toThrow();
  });
});

describe('the protocol carries no product configuration', () => {
  it('PIN: no schema names a language, a voice, a provider or an engine', () => {
    // A checked property rather than an intention. An adapter says what
    // arrived and where from; the gateway decides what the platform does about
    // it. The moment one of these words appears here, a transport adapter has
    // started deciding product behaviour.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../control.ts'), 'utf8');
    const code = source
      .split('\n')
      // Prose may explain what is deliberately absent; the schemas may not
      // contain it.
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');

    for (const forbidden of [
      'targetLanguage',
      'sourceLanguage',
      'voiceId',
      'voiceOwner',
      'provider',
      'translationMode',
      'personalVoice',
      'pacing',
      'sttEngine',
      'ttsEngine',
      'transcription',
    ]) {
      expect(code, `control schema names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('PIN: VideofySessionId never appears on the adapter wire', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['../control.ts', '../protocol.ts', '../frame-codec.ts', '../index.ts']) {
      const source = readFileSync(resolve(here, file), 'utf8');
      const code = source
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
        })
        .join('\n');
      expect(code, `${file} names VideofySessionId`).not.toContain('VideofySessionId');
    }
  });
});
