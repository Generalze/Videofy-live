/**
 * C7 account trust.
 *
 * The defect this suite exists for is a single `verified: true` boolean —
 * something a client can send, a corrupted record can contain, and one lifted
 * suspension can accidentally restore.
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_POLICY,
  INITIAL_TRUST,
  PHONE_POLICY,
  SyntheticProviderInProductionError,
  applyTransition,
  assertProviderAllowed,
  createLinkToken,
  createOtpCode,
  createSyntheticProvider,
  hashToken,
  issueChallenge,
  mayResend,
  readEnvironment,
  readTrust,
  requireReverification,
  resolveTrustState,
  trustCapabilities,
  verifyChallenge,
  type AccountTrust,
} from './index.js';

const VERIFIED: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

describe('trust state resolution', () => {
  it('a fresh signup is registered, not verified', () => {
    expect(resolveTrustState(INITIAL_TRUST)).toBe('registered');
  });

  it('needs all three channels before it says verified', () => {
    expect(resolveTrustState({ ...VERIFIED, identity: 'unverified' })).toBe(
      'verification_required',
    );
    expect(resolveTrustState({ ...VERIFIED, phone: 'pending' })).toBe('verification_pending');
    expect(resolveTrustState(VERIFIED)).toBe('verified');
  });

  it('PIN: a negative outcome beats any amount of completed verification', () => {
    // Order is the policy. Written the other way round, the first happy match
    // wins and a suspension becomes cosmetic.
    expect(resolveTrustState({ ...VERIFIED, restriction: 'suspended' })).toBe('suspended');
    expect(resolveTrustState({ ...VERIFIED, restriction: 'rejected' })).toBe('rejected');
    expect(resolveTrustState({ ...VERIFIED, restriction: 'restricted' })).toBe('restricted');
    expect(resolveTrustState({ ...VERIFIED, restriction: 'under_review' })).toBe('under_review');
  });

  it('distinguishes a failed channel from an untouched one', () => {
    expect(resolveTrustState({ ...INITIAL_TRUST, email: 'expired' })).toBe(
      'verification_required',
    );
    expect(resolveTrustState({ ...INITIAL_TRUST, email: 'failed' })).toBe('verification_required');
  });
});

describe('trust capabilities', () => {
  it('PIN: registration alone grants nothing but the shell', () => {
    const capabilities = trustCapabilities(INITIAL_TRUST);
    expect(capabilities.canAccessApp).toBe(true);
    expect(capabilities.canHostSessions).toBe(false);
    expect(capabilities.canCreateOrganization).toBe(false);
    expect(capabilities.canHoldPrivilegedRole).toBe(false);
    expect(capabilities.canActivateProducts).toBe(false);
  });

  it('grants the real capabilities only when fully verified and unflagged', () => {
    const capabilities = trustCapabilities(VERIFIED);
    expect(capabilities.canHostSessions).toBe(true);
    expect(capabilities.canCreateOrganization).toBe(true);
    expect(capabilities.canHoldPrivilegedRole).toBe(true);
    expect(capabilities.canActivateProducts).toBe(true);
  });

  it('PIN: a verified account under step-up cannot create durable authority', () => {
    // The account is real; this session or recent behaviour is not trusted.
    const flagged = trustCapabilities({ ...VERIFIED, risk: 'step_up_required' });
    expect(flagged.canAccessApp).toBe(true);
    expect(flagged.canHostSessions).toBe(false);
    expect(flagged.canCreateOrganization).toBe(false);
    expect(flagged.canHoldPrivilegedRole).toBe(false);
  });

  it('PIN: suspension removes product authority but never the way back in', () => {
    const suspended = trustCapabilities({ ...VERIFIED, restriction: 'suspended' });
    expect(suspended.canHostSessions).toBe(false);
    expect(suspended.canActivateProducts).toBe(false);
    // Still reachable, so the person can see status, security and support. A
    // lockout with no visible reason is a complaint, not a control.
    expect(suspended.canAccessApp).toBe(true);
  });
});

describe('trust transitions', () => {
  it('PIN: a verified channel cannot quietly become unverified', () => {
    const result = applyTransition(VERIFIED, { channel: 'identity', to: 'pending' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('requireReverification');
  });

  it('un-verifying is possible, but only deliberately', () => {
    const next = requireReverification(VERIFIED, 'identity');
    expect(next.identity).toBe('unverified');
    expect(resolveTrustState(next)).toBe('verification_required');
  });

  it('moves a channel forward normally', () => {
    const pending = applyTransition(INITIAL_TRUST, { channel: 'email', to: 'pending' });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(resolveTrustState(pending.trust)).toBe('verification_pending');
  });
});

describe('reading stored trust', () => {
  it('PIN: unrecognised stored values fall to the SAFE value, never the trusting one', () => {
    // A hand-edited or corrupted record must not be able to promote an account
    // by containing an unexpected string.
    const trust = readTrust({
      email: 'definitely-verified',
      phone: true,
      identity: 'VERIFIED',
      risk: 'none-at-all',
      restriction: 'fine',
    });
    expect(trust).toEqual(INITIAL_TRUST);
    expect(resolveTrustState(trust)).toBe('registered');
  });

  it('reads a well-formed record faithfully', () => {
    expect(readTrust(VERIFIED)).toEqual(VERIFIED);
  });

  it('treats a missing record as a fresh signup', () => {
    expect(readTrust(undefined)).toEqual(INITIAL_TRUST);
    expect(readTrust(null)).toEqual(INITIAL_TRUST);
  });
});

describe('verification challenges', () => {
  const target = 'zoe@example.com';

  function fresh(nowMs = 1_000_000) {
    const token = createLinkToken();
    const record = issueChallenge({
      channel: 'email',
      target,
      token,
      nowMs,
      policy: EMAIL_POLICY,
    });
    return { token, record, nowMs };
  }

  it('PIN: the plaintext token is never stored', () => {
    const { token, record } = fresh();
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record.tokenHash).toBe(hashToken(token));
  });

  it('accepts the right token once, and refuses the replay', () => {
    const { token, record, nowMs } = fresh();
    const first = verifyChallenge({ record, token, target, nowMs, policy: EMAIL_POLICY });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = verifyChallenge({
      record: first.record,
      token,
      target,
      nowMs,
      policy: EMAIL_POLICY,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('consumed');
  });

  it('refuses an expired token', () => {
    const { token, record, nowMs } = fresh();
    const late = verifyChallenge({
      record,
      token,
      target,
      nowMs: nowMs + EMAIL_POLICY.ttlMs + 1,
      policy: EMAIL_POLICY,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe('expired');
  });

  it('PIN: a failed attempt is COUNTED, so guessing is bounded', () => {
    // A verifier that only persists on success gives an attacker unlimited
    // free guesses at a six-digit code.
    let record = issueChallenge({
      channel: 'phone',
      target: '+2348000000000',
      token: createOtpCode(),
      nowMs: 0,
      policy: PHONE_POLICY,
    });

    for (let attempt = 0; attempt < PHONE_POLICY.maxAttempts; attempt += 1) {
      const verdict = verifyChallenge({
        record,
        token: '000000',
        target: '+2348000000000',
        nowMs: 1000,
        policy: PHONE_POLICY,
      });
      expect(verdict.ok).toBe(false);
      record = verdict.record;
    }
    expect(record.attempts).toBe(PHONE_POLICY.maxAttempts);

    const blocked = verifyChallenge({
      record,
      token: '000000',
      target: '+2348000000000',
      nowMs: 1000,
      policy: PHONE_POLICY,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('too-many-attempts');
  });

  it('PIN: a token issued for one target cannot verify another', () => {
    const { token, record, nowMs } = fresh();
    const verdict = verifyChallenge({
      record,
      token,
      target: 'someone-else@example.com',
      nowMs,
      policy: EMAIL_POLICY,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('wrong-target');
  });

  it('throttles resend', () => {
    const { record, nowMs } = fresh();
    const tooSoon = mayResend({ previous: record, nowMs: nowMs + 1000, policy: EMAIL_POLICY });
    expect(tooSoon.ok).toBe(false);

    const later = mayResend({
      previous: record,
      nowMs: nowMs + EMAIL_POLICY.resendCooldownMs,
      policy: EMAIL_POLICY,
    });
    expect(later.ok).toBe(true);
  });

  it('generates codes of the right shape', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(createOtpCode()).toMatch(/^\d{6}$/);
    }
    expect(new Set(Array.from({ length: 20 }, () => createLinkToken())).size).toBe(20);
  });
});

describe('delivery providers', () => {
  it('PIN: a synthetic provider cannot start in production', () => {
    const provider = createSyntheticProvider('email');
    expect(() => assertProviderAllowed(provider, 'production', 'email')).toThrow(
      SyntheticProviderInProductionError,
    );
    // And it is fine where it belongs.
    expect(() => assertProviderAllowed(provider, 'staging', 'email')).not.toThrow();
  });

  it('PIN: an unrecognised environment is treated as production', () => {
    // A typo in a deployment variable must not be what enables synthetic
    // verification.
    expect(readEnvironment('prod')).toBe('production');
    expect(readEnvironment('Staging')).toBe('production');
    expect(readEnvironment(undefined)).toBe('production');
    expect(readEnvironment('staging')).toBe('staging');
    expect(readEnvironment('development')).toBe('development');
  });

  it('a synthetic provider reports that nothing was delivered', async () => {
    const seen: string[] = [];
    const provider = createSyntheticProvider('email', (message) => seen.push(message.target));
    const result = await provider.send({
      channel: 'email',
      target: 'zoe@example.com',
      token: 'abc',
      expiresAtMs: 1, purpose: 'verify-email' });
    expect(result.synthetic).toBe(true);
    expect(seen).toEqual(['zoe@example.com']);
  });
});

/**
 * The graduated gate.
 *
 * These pin a PRODUCT POLICY, not an implementation detail: a verified email
 * is enough to use the product, and only commercial activation waits for full
 * identity. The previous single gate required email AND phone AND identity
 * together, which -- with identity synthetic and phone deferred -- was
 * unreachable, so nobody could host a call at all.
 */
describe('graduated trust capabilities', () => {
  const EMAIL_ONLY = { ...INITIAL_TRUST, email: 'verified' } as const;

  it('lets a verified email host a call', () => {
    expect(trustCapabilities(EMAIL_ONLY).canHostSessions).toBe(true);
  });

  it('lets a verified email create an organization and hold a role in one', () => {
    const capabilities = trustCapabilities(EMAIL_ONLY);
    expect(capabilities.canCreateOrganization).toBe(true);
    // Without this an invited member could do nothing inside an organization
    // but look at it, which makes organizations unusable rather than careful.
    expect(capabilities.canHoldPrivilegedRole).toBe(true);
  });

  /*
   * The one capability tied to money rather than to use. Deliberately
   * unreachable until real identity verification lands -- not overlooked.
   */
  it('still withholds commercial activation until every channel is verified', () => {
    expect(trustCapabilities(EMAIL_ONLY).canActivateProducts).toBe(false);
    expect(
      trustCapabilities({ ...INITIAL_TRUST, email: 'verified', phone: 'verified' })
        .canActivateProducts,
    ).toBe(false);
    expect(trustCapabilities(VERIFIED).canActivateProducts).toBe(true);
  });

  /*
   * EMAIL specifically, not "any channel". A phone-verified account with an
   * unverified email has not proven the address every recovery path depends on.
   */
  it('does not accept a verified phone in place of a verified email', () => {
    const phoneOnly = trustCapabilities({ ...INITIAL_TRUST, phone: 'verified' });
    expect(phoneOnly.canHostSessions).toBe(false);
    expect(phoneOnly.canCreateOrganization).toBe(false);
  });

  it('grants nothing beyond the shell while the email is merely pending', () => {
    const pending = trustCapabilities({ ...INITIAL_TRUST, email: 'pending' });
    expect(pending.canAccessApp).toBe(true);
    expect(pending.canHostSessions).toBe(false);
  });

  /*
   * Order is the policy. A verified email must never buy back a capability a
   * suspension or a risk signal took away.
   */
  it('PIN: a suspension outranks a verified email', () => {
    const suspended = trustCapabilities({ ...EMAIL_ONLY, restriction: 'suspended' });
    expect(suspended.canAccessApp).toBe(true);
    expect(suspended.canHostSessions).toBe(false);
    expect(suspended.canCreateOrganization).toBe(false);
    expect(suspended.canHoldPrivilegedRole).toBe(false);
  });

  it('PIN: a risk signal outranks a verified email', () => {
    for (const risk of ['step_up_required', 'elevated'] as const) {
      const flagged = trustCapabilities({ ...EMAIL_ONLY, risk });
      expect(flagged.canAccessApp).toBe(true);
      expect(flagged.canHostSessions).toBe(false);
      expect(flagged.canHoldPrivilegedRole).toBe(false);
    }
  });

  it('PIN: review and restriction outrank a verified email', () => {
    for (const restriction of ['under_review', 'restricted', 'rejected'] as const) {
      const held = trustCapabilities({ ...EMAIL_ONLY, restriction });
      expect(held.canAccessApp).toBe(true);
      expect(held.canHostSessions).toBe(false);
    }
  });

  /* The label a person is shown is unchanged; only what they may DO graduated. */
  it('leaves the derived state meaning exactly what it meant before', () => {
    expect(resolveTrustState(EMAIL_ONLY)).toBe('verification_required');
    expect(resolveTrustState(VERIFIED)).toBe('verified');
  });
});
