/**
 * Changing a verified email or phone.
 *
 * The tests are about ORDER, because the order is the security property: step
 * up before anything is sent, prove the new address before the old one stops
 * being authoritative, and warn the old address afterwards. Each of those is a
 * separate way to lose an account.
 */
import { describe, expect, it } from 'vitest';
import {
  STEP_UP_FRESHNESS_MS,
  beginIdentityChange,
  completeIdentityChange,
  type PendingIdentityChange,
  type StepUpEvidence,
} from './index.js';

const NOW = 1_700_000_000_000;
const OLD_EMAIL = 'old@example.com';
const NEW_EMAIL = 'new@example.com';
const TOKEN = 'a-token-delivered-to-the-new-address';

const FRESH: StepUpEvidence = { verifiedAtMs: NOW - 1000, method: 'totp' };

function begin(overrides: Partial<Parameters<typeof beginIdentityChange>[0]> = {}) {
  return beginIdentityChange({
    channel: 'email',
    currentTarget: OLD_EMAIL,
    nextTarget: NEW_EMAIL,
    mfaState: 'active',
    evidence: FRESH,
    token: TOKEN,
    nowMs: NOW,
    ...overrides,
  });
}

describe('beginning a change', () => {
  it('issues a challenge against the NEW address', () => {
    const started = begin();
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.pending.target).toBe(NEW_EMAIL);
      expect(started.pending.challenge.target).toBe(NEW_EMAIL);
    }
  });

  /*
   * Demanded before anything is sent, so a stolen session cannot even cause a
   * message to be delivered to an attacker-chosen address.
   */
  it('refuses without an active second factor', () => {
    const started = begin({ mfaState: 'none' });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toBe('mfa-required');
  });

  it('refuses on a session that has not stepped up', () => {
    const started = begin({ evidence: { verifiedAtMs: null, method: null } });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toBe('step-up-required');
  });

  /* A session can be weeks old and belong to an unattended laptop. */
  it('refuses on a stale step-up', () => {
    const started = begin({
      evidence: { verifiedAtMs: NOW - STEP_UP_FRESHNESS_MS - 1, method: 'totp' },
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toBe('stale');
  });

  /*
   * A no-op change still costs a message and still warns the old address,
   * which trains people to ignore exactly the warning that matters.
   */
  it('refuses a change to the address already held', () => {
    const started = begin({ nextTarget: '  OLD@Example.com ' });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toBe('unchanged');
  });

  it('accepts a first-time address where none was verified before', () => {
    const started = begin({ currentTarget: null });
    expect(started.ok).toBe(true);
  });
});

describe('completing a change', () => {
  function pending(overrides: Partial<PendingIdentityChange> = {}): PendingIdentityChange {
    const started = begin();
    if (!started.ok) throw new Error('expected the change to start');
    return { ...started.pending, ...overrides };
  }

  it('applies only once the new address is proven', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: TOKEN,
      currentTarget: OLD_EMAIL,
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.nextTarget).toBe(NEW_EMAIL);
  });

  it('refuses a wrong token, leaving the old address authoritative', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: 'not-the-token',
      currentTarget: OLD_EMAIL,
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  /* The only step that reaches somebody who has NOT been compromised. */
  it('requires the old address to be warned', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: TOKEN,
      currentTarget: OLD_EMAIL,
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.notifyOldTarget).toBe(OLD_EMAIL);
  });

  it('has nothing to warn when no address was verified before', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: TOKEN,
      currentTarget: null,
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.notifyOldTarget).toBeNull();
  });

  /*
   * An email change moves the recovery path, so it is the moment to end an
   * attacker's access rather than leave it running.
   */
  it('revokes sessions on an email change', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: TOKEN,
      currentTarget: OLD_EMAIL,
      identityVerified: false,
      nowMs: NOW + 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.revokeSessions).toBe(true);
  });

  it('does not revoke sessions for a phone change alone', () => {
    const started = beginIdentityChange({
      channel: 'phone',
      currentTarget: '+2348000000000',
      nextTarget: '+2348111111111',
      mfaState: 'active',
      evidence: FRESH,
      token: TOKEN,
      nowMs: NOW,
    });
    if (!started.ok) throw new Error('expected the change to start');

    const result = completeIdentityChange({
      pending: started.pending,
      token: TOKEN,
      currentTarget: '+2348000000000',
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.revokeSessions).toBe(false);
  });

  /*
   * A verification that survives a material change unexamined is a
   * verification of facts that no longer hold.
   */
  it('sends a verified identity back for review', () => {
    const result = completeIdentityChange({
      pending: pending(),
      token: TOKEN,
      currentTarget: OLD_EMAIL,
      identityVerified: true,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects.requiresIdentityReview).toBe(true);
  });

  /*
   * The guard that stops a change-of-address challenge being redirected onto
   * the address it was meant to replace.
   */
  it('refuses a token redirected at the old address', () => {
    const redirected = pending({ target: OLD_EMAIL });
    const result = completeIdentityChange({
      pending: redirected,
      token: TOKEN,
      currentTarget: OLD_EMAIL,
      identityVerified: false,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-target');
  });
});
