/** @author masterzee001 */
/**
 * Host-key hygiene: host_ keys hash to sha256 hex, verification is hash-compare
 * only (timingSafeEqual over equal-length digests), and minted identifiers
 * always carry their prefixes at the promised lengths.
 */
import { describe, expect, it } from 'vitest';
import { hashHostKey, mintHostKey, mintRoomId, verifyHostKey } from '../ids.js';

describe('identifier minting', () => {
  it('mints room_ room ids of 12 random characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const roomId = mintRoomId();
      expect(roomId).toMatch(/^room_[A-Za-z0-9]{12}$/);
      seen.add(roomId);
    }
    expect(seen.size).toBe(50);
  });

  it('mints host_ host keys of 24 random characters', () => {
    const hostKey = mintHostKey();
    expect(hostKey).toMatch(/^host_[A-Za-z0-9]{24}$/);
    expect(mintHostKey()).not.toBe(hostKey);
  });
});

describe('host-key verification', () => {
  it('accepts the key whose hash was stored', () => {
    const hostKey = mintHostKey();
    expect(verifyHostKey(hostKey, hashHostKey(hostKey))).toBe(true);
  });

  it('rejects wrong keys of any shape without throwing', () => {
    const stored = hashHostKey(mintHostKey());
    for (const wrong of ['', 'host_short', mintHostKey(), 'x'.repeat(1000), 'host_']) {
      expect(verifyHostKey(wrong, stored)).toBe(false);
    }
  });

  it('hashes to lowercase sha256 hex — the only stored representation', () => {
    expect(hashHostKey('host_examplekeyexamplekey12')).toMatch(/^[0-9a-f]{64}$/);
  });
});
