/**
 * Multi-factor authentication, and step-up.
 *
 * TOTP (RFC 6238) over HMAC-SHA1, which is what every authenticator app
 * implements. NO CUSTOM CRYPTOGRAPHY: the algorithm is standard, the primitives
 * come from node:crypto, and the only judgement calls here are the parameters
 * — period, digits, drift window — each of which is stated rather than assumed.
 *
 * THE SECRET IS THE WHOLE ASSET. A TOTP secret is a bearer credential: anybody
 * holding it can mint valid codes forever. It is therefore never logged, never
 * returned after enrolment completes, and never stored beside the account in
 * plaintext — the storage boundary encrypts it, and this module refuses to hand
 * it back once enrolment is confirmed.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * How many periods either side are accepted.
 *
 * One step (±30s) absorbs ordinary clock skew and the time somebody takes to
 * type. Wider is tempting and costs real security: every extra step multiplies
 * the codes valid at any instant.
 */
export const TOTP_DRIFT_STEPS = 1;

export type MfaMethod = 'totp';

export type MfaState = 'none' | 'enrolling' | 'active' | 'revoked';

export interface MfaEnrolment {
  readonly method: MfaMethod;
  readonly state: MfaState;
  /**
   * The shared secret, base32. Held by the STORAGE layer, which is responsible
   * for encrypting it at rest; nothing in this module ever emits it after
   * enrolment is confirmed.
   */
  readonly secret: string;
  readonly createdAtMs: number;
  readonly confirmedAtMs: number | null;
  /** SHA-256 hashes of single-use recovery codes. Never the codes themselves. */
  readonly recoveryCodeHashes: readonly string[];
  readonly recoveryCodesUsed: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new Error('invalid base32 in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, which is what RFC 4226 recommends for HMAC-SHA1. */
export function createTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCodeAt(secret: string, timeMs: number): string {
  const counter = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a presented code across the drift window.
 *
 * Constant-time comparison per candidate: `===` on the strings leaks how many
 * leading digits matched, which turns one six-digit problem into six one-digit
 * problems.
 */
export function verifyTotp(secret: string, presented: string, nowMs: number): boolean {
  if (!/^\d{6}$/.test(presented)) return false;
  const presentedBuffer = Buffer.from(presented, 'utf8');

  for (let step = -TOTP_DRIFT_STEPS; step <= TOTP_DRIFT_STEPS; step += 1) {
    const candidate = totpCodeAt(secret, nowMs + step * TOTP_PERIOD_SECONDS * 1000);
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (
      candidateBuffer.length === presentedBuffer.length &&
      timingSafeEqual(candidateBuffer, presentedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans. Carries the secret, by design. */
export function totpEnrolmentUri(input: {
  secret: string;
  accountEmail: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? 'Consummate 7';
  const label = encodeURIComponent(`${issuer}:${input.accountEmail}`);
  const parameters = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * Recovery codes, returned ONCE at enrolment and stored only as hashes.
 *
 * Without these, a lost phone is a permanently lost account — and the support
 * process that grows in their absence (a human deciding somebody sounds
 * genuine) is a far weaker second factor than the one it replaces.
 */
export function createRecoveryCodes(count = 10): {
  codes: readonly string[];
  hashes: readonly string[];
} {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const halves = [randomInt(0, 100000), randomInt(0, 100000)].map((part) =>
      String(part).padStart(5, '0'),
    );
    codes.push(halves.join('-'));
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', 'c7-recovery').update(code.trim(), 'utf8').digest('hex');
}

export function consumeRecoveryCode(
  enrolment: MfaEnrolment,
  presented: string,
): { ok: true; next: MfaEnrolment } | { ok: false } {
  const hash = hashRecoveryCode(presented);
  const index = enrolment.recoveryCodeHashes.indexOf(hash);
  if (index === -1) return { ok: false };
  // Single use: the hash is removed, not merely counted, so the same code can
  // never be presented twice.
  const remaining = enrolment.recoveryCodeHashes.filter((_unused, position) => position !== index);
  return {
    ok: true,
    next: {
      ...enrolment,
      recoveryCodeHashes: remaining,
      recoveryCodesUsed: enrolment.recoveryCodesUsed + 1,
    },
  };
}

/**
 * Operations that require a FRESH authentication, not merely a valid session.
 *
 * A session can be weeks old and belong to an unattended laptop. These are the
 * actions where being signed in once, long ago, is not evidence enough.
 */
export type StepUpOperation =
  | 'organization.transferOwnership'
  | 'organization.delete'
  | 'organization.manageSecurity'
  | 'organization.managePlan'
  | 'account.changeEmail'
  | 'account.changePhone'
  | 'account.disableMfa'
  | 'account.issueCredentials';

/** How recently authentication must have happened for a step-up to count. */
export const STEP_UP_FRESHNESS_MS = 5 * 60 * 1000;

export interface StepUpEvidence {
  /** When the second factor was last satisfied. */
  readonly verifiedAtMs: number | null;
  readonly method: MfaMethod | 'password' | 'recovery-code' | null;
}

export type StepUpDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'mfa-required' | 'step-up-required' | 'stale' };

/**
 * Does this evidence satisfy a step-up?
 *
 * Requires MFA to be ACTIVE. Accepting a password re-entry where a second
 * factor exists would make the whole enrolment optional at exactly the moments
 * it matters most.
 */
export function satisfiesStepUp(input: {
  operation: StepUpOperation;
  mfaState: MfaState;
  evidence: StepUpEvidence;
  nowMs: number;
}): StepUpDecision {
  if (input.mfaState !== 'active') return { ok: false, reason: 'mfa-required' };
  if (input.evidence.verifiedAtMs === null) return { ok: false, reason: 'step-up-required' };
  if (input.nowMs - input.evidence.verifiedAtMs > STEP_UP_FRESHNESS_MS) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true };
}

export const INITIAL_MFA: Omit<MfaEnrolment, 'secret'> & { secret: '' } = {
  method: 'totp',
  state: 'none',
  secret: '',
  createdAtMs: 0,
  confirmedAtMs: null,
  recoveryCodeHashes: [],
  recoveryCodesUsed: 0,
};
