/**
 * Verification tokens and OTP challenges.
 *
 * The same shape serves email links and phone codes because the security
 * properties are identical: random, single-use, expiring, hashed at rest,
 * attempt-limited and resend-throttled. Two separate implementations would
 * drift, and the one that drifted would be the one nobody re-read.
 *
 * WHY HASHED. The stored record is the thing an attacker reaches through a file
 * read, a backup, a log or a support screenshot. A plaintext token in that
 * record is a working verification link for every pending account at once. The
 * hash makes the stored copy useless on its own — the same reason passwords are
 * not stored either.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ChallengeChannel = 'email' | 'phone';

export interface ChallengeRecord {
  readonly channel: ChallengeChannel;
  /** SHA-256 of the token. The token itself is never stored. */
  readonly tokenHash: string;
  /** The address or number this challenge was issued for, normalised. */
  readonly target: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly attempts: number;
  /** Set once consumed, so a replay is refused rather than re-accepted. */
  readonly consumedAtMs: number | null;
}

export interface ChallengePolicy {
  readonly ttlMs: number;
  readonly maxAttempts: number;
  /** Minimum gap between issuing challenges for the same target. */
  readonly resendCooldownMs: number;
}

/**
 * An emailed link can be long and opaque; a code typed off a phone screen
 * cannot. Six digits with a short life and a hard attempt cap is the standard
 * trade, and the cap is what makes six digits acceptable at all — without it,
 * a million guesses is an afternoon.
 */
export const EMAIL_POLICY: ChallengePolicy = {
  ttlMs: 30 * 60 * 1000,
  maxAttempts: 8,
  resendCooldownMs: 60 * 1000,
};

export const PHONE_POLICY: ChallengePolicy = {
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A URL-safe opaque token for an email link. */
export function createLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A numeric code for a phone. Rejection sampling, so digits stay uniform. */
export function createOtpCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const candidate = randomBytes(4).readUInt32BE(0);
    if (candidate < limit) return String(candidate % max).padStart(digits, '0');
  }
}

export function issueChallenge(input: {
  channel: ChallengeChannel;
  target: string;
  token: string;
  nowMs: number;
  policy: ChallengePolicy;
}): ChallengeRecord {
  return {
    channel: input.channel,
    tokenHash: hashToken(input.token),
    target: input.target,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + input.policy.ttlMs,
    attempts: 0,
    consumedAtMs: null,
  };
}

export type ChallengeVerdict =
  | { readonly ok: true; readonly record: ChallengeRecord }
  | {
      readonly ok: false;
      readonly reason: 'expired' | 'consumed' | 'too-many-attempts' | 'mismatch' | 'wrong-target';
      readonly record: ChallengeRecord;
    };

/**
 * Check a presented token.
 *
 * Constant-time comparison on the HASHES, not the tokens: comparing the raw
 * strings with `===` leaks how many leading characters were right, which turns
 * a six-digit code into six separate one-digit problems.
 *
 * Every outcome returns the updated record, because a failed attempt must still
 * be counted. A verifier that only persists on success gives an attacker
 * unlimited free guesses.
 */
export function verifyChallenge(input: {
  record: ChallengeRecord;
  token: string;
  target: string;
  nowMs: number;
  policy: ChallengePolicy;
}): ChallengeVerdict {
  const attempted: ChallengeRecord = { ...input.record, attempts: input.record.attempts + 1 };

  if (input.record.consumedAtMs !== null) {
    return { ok: false, reason: 'consumed', record: input.record };
  }
  if (input.nowMs > input.record.expiresAtMs) {
    return { ok: false, reason: 'expired', record: attempted };
  }
  if (input.record.attempts >= input.policy.maxAttempts) {
    return { ok: false, reason: 'too-many-attempts', record: input.record };
  }
  // A token issued for one address must not verify another. Without this a
  // pending change-of-email challenge could be used to confirm the old one.
  if (input.record.target !== input.target) {
    return { ok: false, reason: 'wrong-target', record: attempted };
  }

  const expected = Buffer.from(input.record.tokenHash, 'hex');
  const presented = Buffer.from(hashToken(input.token), 'hex');
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, reason: 'mismatch', record: attempted };
  }

  return { ok: true, record: { ...attempted, consumedAtMs: input.nowMs } };
}

/** Whether a fresh challenge may be issued yet, for resend throttling. */
export function mayResend(input: {
  previous: ChallengeRecord | null;
  nowMs: number;
  policy: ChallengePolicy;
}): { ok: true } | { ok: false; retryAfterMs: number } {
  if (input.previous === null) return { ok: true };
  const earliest = input.previous.issuedAtMs + input.policy.resendCooldownMs;
  if (input.nowMs >= earliest) return { ok: true };
  return { ok: false, retryAfterMs: earliest - input.nowMs };
}
