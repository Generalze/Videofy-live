/** @author masterzee001 */
/**
 * Turning a password into something safe to store.
 *
 * scrypt from node:crypto, deliberately: it is memory-hard, it is in the
 * standard library, and adding a dependency to the one module that handles
 * credentials means auditing somebody else's release process every time it
 * updates. Nothing here is novel, and it should not be — this is a place to
 * implement a known-good construction exactly, not to have ideas.
 *
 * Every stored hash records the parameters it was made with, so the cost can be
 * raised later without invalidating anyone's password: an old hash verifies
 * under its own parameters and can be re-hashed on the next successful sign-in.
 * A scheme that hard-codes its cost is a scheme that can never be strengthened.
 *
 * A password is NEVER logged, never returned, never placed in an error, and
 * never compared with `===`.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` picks the overload without options, which silently drops the cost
 * parameters — the ONLY thing that makes this expensive to attack. Typed
 * explicitly so passing them is checked rather than accepted and ignored.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Cost parameters. N=2^15 with r=8 is roughly 32 MB and tens of milliseconds
 * per hash — slow enough to make offline guessing expensive, fast enough that
 * signing in does not feel broken.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** scrypt refuses to allocate past this; the default 32 MB is under what N needs. */
const MAX_MEMORY = 96 * 1024 * 1024;

/**
 * Minimum length, and no composition rules.
 *
 * Forcing a capital and a symbol produces `Password1!` and a sticky note; length
 * is what actually costs an attacker. Twelve rather than the more common eight
 * because this account authorises speaking in somebody's voice, and an account
 * takeover here is not a leaked shopping list.
 */
export const MIN_PASSWORD_LENGTH = 12;
/** Long enough for any real passphrase; past this it is someone probing scrypt. */
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordRejection =
  | 'too-short'
  | 'too-long'
  | 'same-as-email';

export function rejectPassword(password: string, email: string): PasswordRejection | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too-short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too-long';
  // The single most guessable password for a given account.
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'same-as-email';
  return null;
}

export function describePasswordRejection(rejection: PasswordRejection): string {
  switch (rejection) {
    case 'too-short':
      return `Use at least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols.`;
    case 'too-long':
      return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    case 'same-as-email':
      return 'Your password cannot be your email address.';
  }
}

/** `scrypt$N$r$p$salt$hash`, all parameters recorded so cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Whether a password matches a stored hash.
 *
 * Returns false for a malformed record rather than throwing: a damaged row must
 * fail closed, and an exception here would turn a bad record into a 500 that
 * tells a caller their account exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string, string, string, string, string, string,
  ];
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A record asking for more memory than we will allocate is refused rather
  // than honoured; otherwise a tampered row becomes a denial-of-service knob.
  if (n <= 0 || n > 1_048_576 || r <= 0 || r > 32 || p <= 0 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(rawHash, 'base64');
    actual = await scryptAsync(password, Buffer.from(rawSalt, 'base64'), expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}
