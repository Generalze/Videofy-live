/** @author masterzee001 */
/**
 * Identity minting and host-key verification.
 *
 * Room ids are public ("room_" + 12 random characters). Host keys are secrets
 * ("host_" + 24 random characters) shown exactly once at creation; only the
 * sha256 hash of a host key is ever stored. Verification hashes the presented
 * key and compares the hashes with timingSafeEqual, so the comparison cost
 * never depends on how much of the key was right.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ROOM_ID_PREFIX = 'room_';
export const HOST_KEY_PREFIX = 'host_';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// The largest multiple of the alphabet size below 256; bytes at or above it
// are rejected so every character stays equally likely (no modulo bias).
const UNBIASED_LIMIT = 248;

function randomIdentifier(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < UNBIASED_LIMIT) {
        out += ALPHABET.charAt(byte % ALPHABET.length);
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export function mintRoomId(): string {
  return `${ROOM_ID_PREFIX}${randomIdentifier(12)}`;
}

export function mintHostKey(): string {
  return `${HOST_KEY_PREFIX}${randomIdentifier(24)}`;
}

export function hashHostKey(hostKey: string): string {
  return createHash('sha256').update(hostKey, 'utf8').digest('hex');
}

export function verifyHostKey(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashHostKey(presented), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return stored.length === presentedHash.length && timingSafeEqual(stored, presentedHash);
}
