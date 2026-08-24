/**
 * Account recovery.
 *
 * The interesting tests are not "does the token verify" — verification-token.ts
 * owns that and is tested there. They are the two properties a RESET adds:
 * that the endpoint says the same thing whether or not the account exists, and
 * that completing a reset invalidates the sessions an attacker may already hold.
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_RESET_POLICY,
  beginPasswordReset,
  completePasswordReset,
  hashToken,
  issueChallenge,
  revokeSessions,
  type ChallengeRecord,
} from './index.js';

const NOW = 1_700_000_000_000;
const EMAIL = 'someone@example.com';

function begin(overrides: Partial<Parameters<typeof beginPasswordReset>[0]> = {}) {
  return beginPasswordReset({
    accountId: 'acc_1',
    target: EMAIL,
    previous: null,
    nowMs: NOW,
    ...overrides,
  });
}

describe('beginning a reset', () => {
  it('issues a challenge for a real account', () => {
    const { acknowledgement, effect } = begin();
    expect(acknowledgement).toBe('accepted');
    expect(effect?.accountId).toBe('acc_1');
    expect(effect?.token).toBeTruthy();
  });

  /*
   * The enumeration defence. An unknown address, a real address and a
   * throttled address must be indistinguishable to the caller — only the
   * server-side effect differs.
   */
  it('acknowledges an unknown address identically, with no effect', () => {
    const unknown = begin({ accountId: null });
    expect(unknown.acknowledgement).toBe('accepted');
    expect(unknown.effect).toBeNull();
    expect(unknown.acknowledgement).toBe(begin().acknowledgement);
  });

  it('acknowledges a throttled request identically rather than reporting a cooldown', () => {
    const first = begin();
    const second = begin({ previous: first.effect?.challenge ?? null, nowMs: NOW + 1000 });

    expect(second.acknowledgement).toBe('accepted');
    expect(second.effect).toBeNull();
  });

  it('allows a fresh request once the cooldown has passed', () => {
    const first = begin();
    const later = begin({
      previous: first.effect?.challenge ?? null,
      nowMs: NOW + PASSWORD_RESET_POLICY.resendCooldownMs + 1,
    });
    expect(later.effect).not.toBeNull();
  });

  it('stores only the hash, never the token', () => {
    const { effect } = begin();
    expect(effect?.challenge.tokenHash).toBe(hashToken(effect!.token));
    expect(effect?.challenge.tokenHash).not.toBe(effect?.token);
  });

  /* A reset key should not outlive the reset. */
  it('expires sooner than a routine email verification', () => {
    expect(PASSWORD_RESET_POLICY.ttlMs).toBeLessThan(30 * 60 * 1000);
  });
});

describe('completing a reset', () => {
  function issued(): { record: ChallengeRecord; token: string } {
    const { effect } = begin();
    return { record: effect!.challenge, token: effect!.token };
  }

  it('accepts the token and demands session revocation', () => {
    const { record, token } = issued();
    const result = completePasswordReset({ record, token, target: EMAIL, nowMs: NOW + 1000 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revokeSessions).toBe(true);
      expect(result.challenge.consumedAtMs).not.toBeNull();
    }
  });

  it('refuses a replayed token', () => {
    const { record, token } = issued();
    const first = completePasswordReset({ record, token, target: EMAIL, nowMs: NOW + 1000 });
    const replay = completePasswordReset({
      record: first.challenge,
      token,
      target: EMAIL,
      nowMs: NOW + 2000,
    });

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('consumed');
  });

  it('refuses a token presented for a different address', () => {
    const { record, token } = issued();
    const result = completePasswordReset({
      record,
      token,
      target: 'someone-else@example.com',
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-target');
  });

  it('refuses an expired token', () => {
    const { record, token } = issued();
    const result = completePasswordReset({
      record,
      token,
      target: EMAIL,
      nowMs: NOW + PASSWORD_RESET_POLICY.ttlMs + 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  /*
   * A verifier that only persists on success gives an attacker unlimited free
   * guesses, so the count must come back on the failure path too.
   */
  it('counts a wrong token against the attempt cap', () => {
    const { record } = issued();
    const result = completePasswordReset({
      record,
      token: 'not-the-token',
      target: EMAIL,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.challenge.attempts).toBe(1);
  });

  it('stops accepting attempts at the cap', () => {
    let record = issued().record;
    for (let attempt = 0; attempt < PASSWORD_RESET_POLICY.maxAttempts; attempt += 1) {
      record = completePasswordReset({
        record,
        token: 'wrong',
        target: EMAIL,
        nowMs: NOW + 1000,
      }).challenge;
    }
    const result = completePasswordReset({ record, token: 'wrong', target: EMAIL, nowMs: NOW + 1000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-many-attempts');
  });

  it('refuses a token issued for another challenge entirely', () => {
    const other = issueChallenge({
      channel: 'email',
      token: 'a-different-token',
      target: EMAIL,
      nowMs: NOW,
      policy: PASSWORD_RESET_POLICY,
    });
    const { token } = issued();
    const result = completePasswordReset({ record: other, token, target: EMAIL, nowMs: NOW + 1000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });
});

describe('session revocation', () => {
  it('advances the token version so older tokens are refused', () => {
    const revocation = revokeSessions({
      accountId: 'acc_1',
      currentTokenVersion: 4,
      reason: 'password-reset',
      nowMs: NOW,
    });

    expect(revocation.tokenVersion).toBe(5);
    expect(revocation.reason).toBe('password-reset');
  });
});
