/** @author masterzee001 */
/**
 * Base64 on a phone, measured against Node's own implementation.
 *
 * The comparison is deliberate: asserting that the encoder produces "some
 * base64" would pass for an encoder that is wrong in a consistent way, and the
 * symptom of a wrong encoder here is noise coming out of somebody's phone in
 * the middle of a sentence. Every expectation below is an independent
 * implementation's answer, not this one's.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBase64ToBinaryString,
  encodeBytesBase64,
  ensureBase64Decoder,
  pcm16ToBase64,
} from '../call/pcmBase64';

/** Read a base64 payload back to samples WITHOUT using the code under test. */
function samplesFrom(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64');
  const out: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) out.push(bytes.readInt16LE(index));
  return out;
}

describe('encodeBytesBase64', () => {
  it('agrees with Node for every remainder a byte length can have', () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) % 256;
      expect(encodeBytesBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('agrees with Node on a real frame-sized payload', () => {
    // 320 samples = one 20 ms frame at 16 kHz = 640 bytes.
    const bytes = new Uint8Array(640);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 251) % 256;
    expect(encodeBytesBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('decodeBase64ToBinaryString', () => {
  it('returns the same bytes Node does, one character each', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 91 + 7) % 256;
      const decoded = decodeBase64ToBinaryString(bytes.toString('base64'));
      expect(decoded.length).toBe(length);
      for (let index = 0; index < length; index += 1) {
        expect(decoded.charCodeAt(index)).toBe(bytes[index]);
      }
    }
  });

  it('refuses a payload that is not base64 rather than skipping the bad character', () => {
    // Skipping would shift every later sample by a byte, and the rest of the
    // sentence would decode as noise instead of as speech.
    expect(() => decodeBase64ToBinaryString('AA*A')).toThrow();
  });
});

describe('ensureBase64Decoder', () => {
  it('installs a working atob when the runtime has none', () => {
    const scope: Record<string, unknown> = {};
    expect(ensureBase64Decoder(scope)).toBe('installed');
    const atob = scope['atob'] as (value: string) => string;
    expect(atob(Buffer.from([1, 2, 254]).toString('base64'))).toBe(
      String.fromCharCode(1, 2, 254),
    );
  });

  it('leaves a runtime that already has one alone', () => {
    const platform = (value: string): string => `platform:${value}`;
    const scope: Record<string, unknown> = { atob: platform };
    expect(ensureBase64Decoder(scope)).toBe('present');
    expect(scope['atob']).toBe(platform);
  });
});

describe('pcm16ToBase64', () => {
  it('carries every sample through unchanged at full gain', () => {
    const samples = Int16Array.from([0, 1, -1, 1234, -1234, 32767, -32768]);
    expect(samplesFrom(pcm16ToBase64(samples, 1))).toEqual([...samples]);
  });

  it('scales by the gain it is given', () => {
    const samples = Int16Array.from([1000, -1000, 400]);
    expect(samplesFrom(pcm16ToBase64(samples, 0.5))).toEqual([500, -500, 200]);
  });

  it('silences at gain zero instead of leaking the original voice', () => {
    const samples = Int16Array.from([20000, -20000, 5]);
    expect(samplesFrom(pcm16ToBase64(samples, 0))).toEqual([0, 0, 0]);
  });

  it('saturates rather than wrapping when a gain above one is asked for', () => {
    // A wrap turns the loudest part of a syllable into a burst at the opposite
    // polarity, which is heard as a crackle and reads as a synthesis fault.
    const samples = Int16Array.from([32767, -32768]);
    expect(samplesFrom(pcm16ToBase64(samples, 4))).toEqual([32767, -32768]);
  });

  it('treats a gain that is not a number as silence, not as full volume', () => {
    const samples = Int16Array.from([9000, -9000]);
    expect(samplesFrom(pcm16ToBase64(samples, Number.NaN))).toEqual([0, 0]);
  });

  it('keeps the quietest negative sample rather than clipping it', () => {
    // 32768 and not 32767 is the division the web sink documents; the same
    // asymmetry decides whether -32768 survives a unity gain here.
    expect(samplesFrom(pcm16ToBase64(Int16Array.from([-32768]), 1))).toEqual([-32768]);
  });
});
