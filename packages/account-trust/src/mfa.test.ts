/**
 * MFA and step-up.
 *
 * TOTP is a standard, so the interesting tests are not "does it compute a
 * code" — they are the choices around it: drift, replay, single-use recovery,
 * and whether a long-lived session can stand in for a fresh second factor.
 */
import { describe, expect, it } from 'vitest';
import {
  STEP_UP_FRESHNESS_MS,
  TOTP_DRIFT_STEPS,
  TOTP_PERIOD_SECONDS,
  consumeRecoveryCode,
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  satisfiesStepUp,
  totpCodeAt,
  totpEnrolmentUri,
  verifyTotp,
  type MfaEnrolment,
} from './index.js';

const NOW = 1_700_000_000_000;

function enrolment(over: Partial<MfaEnrolment> = {}): MfaEnrolment {
  const { hashes } = createRecoveryCodes(3);
  return {
    method: 'totp',
    state: 'active',
    secret: createTotpSecret(),
    createdAtMs: NOW,
    confirmedAtMs: NOW,
    recoveryCodeHashes: hashes,
    recoveryCodesUsed: 0,
    ...over,
  };
}

describe('TOTP', () => {
  it('produces a six-digit code that verifies', () => {
    const secret = createTotpSecret();
    const code = totpCodeAt(secret, NOW);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, NOW)).toBe(true);
  });

  it('is stable within a period and changes across one', () => {
    const secret = createTotpSecret();
    const start = Math.floor(NOW / 30000) * 30000;
    expect(totpCodeAt(secret, start)).toBe(totpCodeAt(secret, start + 29_000));
    expect(totpCodeAt(secret, start)).not.toBe(totpCodeAt(secret, start + 60_000));
  });

  it('PIN: accepts exactly one step of drift, and no more', () => {
    const secret = createTotpSecret();
    const period = TOTP_PERIOD_SECONDS * 1000;
    const previous = totpCodeAt(secret, NOW - period);
    const next = totpCodeAt(secret, NOW + period);
    const tooOld = totpCodeAt(secret, NOW - period * (TOTP_DRIFT_STEPS + 2));

    expect(verifyTotp(secret, previous, NOW)).toBe(true);
    expect(verifyTotp(secret, next, NOW)).toBe(true);
    // Every extra step multiplies the codes valid at any instant.
    expect(verifyTotp(secret, tooOld, NOW)).toBe(false);
  });

  it('refuses anything that is not a six-digit code', () => {
    const secret = createTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '000000x']) {
      expect(verifyTotp(secret, bad, NOW), bad).toBe(false);
    }
  });

  it('two secrets do not verify each other', () => {
    const a = createTotpSecret();
    const b = createTotpSecret();
    expect(verifyTotp(b, totpCodeAt(a, NOW), NOW)).toBe(false);
  });

  it('the enrolment URI carries standard parameters an authenticator understands', () => {
    const secret = createTotpSecret();
    const uri = totpEnrolmentUri({ secret, accountEmail: 'zoe@example.com' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain(secret);
  });
});

describe('recovery codes', () => {
  it('PIN: only hashes are retained', () => {
    const { codes, hashes } = createRecoveryCodes(5);
    expect(codes).toHaveLength(5);
    for (const code of codes) {
      expect(hashes).toContain(hashRecoveryCode(code));
      // The code itself must not be recoverable from what is stored.
      expect(hashes.join(' ')).not.toContain(code);
    }
  });

  it('PIN: a recovery code is single use', () => {
    const { codes, hashes } = createRecoveryCodes(3);
    const active = enrolment({ recoveryCodeHashes: hashes });

    const first = consumeRecoveryCode(active, codes[0]!);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.next.recoveryCodeHashes).toHaveLength(2);
    expect(first.next.recoveryCodesUsed).toBe(1);

    // Removed, not merely counted, so it can never be presented again.
    const replay = consumeRecoveryCode(first.next, codes[0]!);
    expect(replay.ok).toBe(false);
  });

  it('refuses an unknown code', () => {
    expect(consumeRecoveryCode(enrolment(), '00000-00000').ok).toBe(false);
  });
});

describe('step-up authentication', () => {
  const fresh = { verifiedAtMs: NOW, method: 'totp' as const };

  it('accepts a fresh second factor', () => {
    expect(
      satisfiesStepUp({
        operation: 'organization.transferOwnership',
        mfaState: 'active',
        evidence: fresh,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('PIN: a long-lived session is not a step-up', () => {
    // A session can be weeks old and belong to an unattended laptop.
    expect(
      satisfiesStepUp({
        operation: 'organization.delete',
        mfaState: 'active',
        evidence: { verifiedAtMs: null, method: null },
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'step-up-required' });
  });

  it('PIN: evidence goes stale', () => {
    expect(
      satisfiesStepUp({
        operation: 'account.disableMfa',
        mfaState: 'active',
        evidence: { verifiedAtMs: NOW - STEP_UP_FRESHNESS_MS - 1, method: 'totp' },
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'stale' });
  });

  it('PIN: without active MFA, a sensitive operation demands enrolment', () => {
    // Accepting a password re-entry where a second factor exists would make
    // enrolment optional at exactly the moments it matters most.
    for (const state of ['none', 'enrolling', 'revoked'] as const) {
      expect(
        satisfiesStepUp({
          operation: 'organization.manageSecurity',
          mfaState: state,
          evidence: fresh,
          nowMs: NOW,
        }),
        state,
      ).toEqual({ ok: false, reason: 'mfa-required' });
    }
  });

  it('covers the operations that change who holds power or how money moves', () => {
    const operations = [
      'organization.transferOwnership',
      'organization.delete',
      'organization.manageSecurity',
      'organization.managePlan',
      'account.changeEmail',
      'account.changePhone',
      'account.disableMfa',
      'account.issueCredentials',
    ] as const;
    for (const operation of operations) {
      expect(
        satisfiesStepUp({ operation, mfaState: 'active', evidence: fresh, nowMs: NOW }).ok,
        operation,
      ).toBe(true);
    }
  });
});
