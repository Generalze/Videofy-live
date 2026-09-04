/**
 * The base64 encoder, proven by decoding its own output.
 *
 * The first draft chunked at 0x8000 bytes -- which is 2 mod 3 -- so every chunk
 * boundary emitted "=" padding mid-stream: audio the server would accept and no
 * player could decode, failing only on clips longer than the chunk. These tests
 * decode with Buffer (a known-good implementation) and compare bytes, across
 * exactly the sizes that catch boundary mistakes.
 */
import { describe, expect, it } from 'vitest';
import { bytesToBase64, formatDuration } from '../media/voiceNotes';

function roundTrip(size: number): void {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 7 + 13) & 0xff;
  const encoded = bytesToBase64(bytes.buffer);
  const decoded = Buffer.from(encoded, 'base64');
  expect(decoded.length).toBe(size);
  expect(Buffer.from(bytes).equals(decoded)).toBe(true);
  // No padding anywhere except the very end.
  expect(encoded.slice(0, -2)).not.toContain('=');
}

describe('bytesToBase64', () => {
  it('round-trips the boundary sizes that catch chunking bugs', () => {
    for (const size of [0, 1, 2, 3, 4, 32766, 32767, 32768, 32769, 100_000]) {
      roundTrip(size);
    }
  });

  it('round-trips a voice-note-sized clip', () => {
    roundTrip(1_000_000);
  });
});

describe('formatDuration', () => {
  it('renders mm:ss', () => {
    expect(formatDuration(63_000)).toBe('1:03');
    expect(formatDuration(900)).toBe('0:01');
    expect(formatDuration(null)).toBe('0:00');
  });
});
