/**
 * A0b — identity verification.
 *
 * The two attacks this suite is about: a browser reporting its own KYC result,
 * and a captured callback being replayed. Both are cheap, both are total, and
 * both are stopped by things that are easy to leave out.
 */
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_MAX_AGE_MS,
  SyntheticIdentityProviderInProductionError,
  applyCallback,
  assertIdentityProviderAllowed,
  createSyntheticIdentityProvider,
  isLegalTransition,
  signCallback,
  validateCallback,
  type IdentityCase,
} from './index.js';

const SECRET = 'a-provider-shared-secret-that-is-long-enough';
const NOW = 1_700_000_000_000;

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    providerReference: 'syn_case_1',
    status: 'verified',
    eventId: 'evt_1',
    issuedAtMs: NOW,
    jurisdiction: 'NG',
    outcomeCode: 'approved',
    ...over,
  });
}

function validate(raw: string, over: Partial<Parameters<typeof validateCallback>[0]> = {}) {
  return validateCallback({
    rawBody: raw,
    signature: signCallback(raw, SECRET),
    secret: SECRET,
    nowMs: NOW,
    seenEventIds: new Set(),
    ...over,
  });
}

function caseAt(status: IdentityCase['status']): IdentityCase {
  return {
    caseId: 'case_1',
    provider: 'synthetic-identity',
    providerReference: 'syn_case_1',
    status,
    jurisdiction: null,
    outcomeCode: null,
    createdAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    completedAtMs: null,
    reviewOpenedAtMs: null,
  };
}

describe('callback authentication', () => {
  it('accepts a correctly signed, fresh, unseen callback', () => {
    const verdict = validate(body());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.callback.status).toBe('verified');
  });

  it('PIN: an unsigned or wrongly signed callback is refused', () => {
    const raw = body();
    expect(validate(raw, { signature: undefined }).ok).toBe(false);
    expect(validate(raw, { signature: '' }).ok).toBe(false);
    expect(validate(raw, { signature: 'deadbeef' }).ok).toBe(false);
    // A signature over DIFFERENT bytes must not validate these bytes.
    expect(validate(raw, { signature: signCallback(body({ status: 'rejected' }), SECRET) }).ok).toBe(
      false,
    );
  });

  it('PIN: a tampered body fails even with the original signature', () => {
    const original = body({ status: 'rejected' });
    const signature = signCallback(original, SECRET);
    const tampered = body({ status: 'verified' });
    const verdict = validateCallback({
      rawBody: tampered,
      signature,
      secret: SECRET,
      nowMs: NOW,
      seenEventIds: new Set(),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad-signature');
  });

  it('PIN: a replayed callback is refused twice over — by age and by event id', () => {
    // Correctly signed yesterday is still correctly signed today. Age is what
    // stops a captured callback from working forever.
    const stale = validate(body({ issuedAtMs: NOW - CALLBACK_MAX_AGE_MS - 1 }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('stale');

    const duplicate = validate(body(), { seenEventIds: new Set(['evt_1']) });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toBe('duplicate');
  });

  it('refuses a malformed or unknown-status payload', () => {
    expect(validate('not json').ok).toBe(false);
    expect(validate(JSON.stringify({ nothing: true })).ok).toBe(false);
    expect(validate(body({ status: 'definitely-verified' })).ok).toBe(false);
    expect(validate(body({ eventId: 42 })).ok).toBe(false);
    expect(validate(body({ issuedAtMs: 'now' })).ok).toBe(false);
  });
});

describe('case transitions', () => {
  it('PIN: a late callback cannot un-verify a completed case', () => {
    // At-least-once delivery makes this normal, not exotic: a `processing`
    // retry arriving after `verified` would otherwise reopen a finished check.
    expect(isLegalTransition('verified', 'processing')).toBe(false);
    expect(isLegalTransition('verified', 'rejected')).toBe(false);
    expect(isLegalTransition('rejected', 'verified')).toBe(false);

    const applied = applyCallback(
      caseAt('verified'),
      { providerReference: 'syn_case_1', status: 'processing', eventId: 'e', issuedAtMs: NOW },
      NOW,
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.reason).toBe('illegal-transition');
  });

  it('allows the normal path forward', () => {
    expect(isLegalTransition('created', 'submitted')).toBe(true);
    expect(isLegalTransition('submitted', 'processing')).toBe(true);
    expect(isLegalTransition('processing', 'verified')).toBe(true);
    expect(isLegalTransition('processing', 'review')).toBe(true);
    expect(isLegalTransition('review', 'verified')).toBe(true);
  });

  it('stamps completion and review, and keeps the outcome code', () => {
    const verified = applyCallback(
      caseAt('processing'),
      {
        providerReference: 'syn_case_1',
        status: 'verified',
        jurisdiction: 'NG',
        outcomeCode: 'approved',
        eventId: 'e',
        issuedAtMs: NOW,
      },
      NOW,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.next.completedAtMs).toBe(NOW);
    expect(verified.next.jurisdiction).toBe('NG');
    expect(verified.next.outcomeCode).toBe('approved');

    const review = applyCallback(
      caseAt('processing'),
      { providerReference: 'syn_case_1', status: 'review', eventId: 'e', issuedAtMs: NOW },
      NOW,
    );
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.next.reviewOpenedAtMs).toBe(NOW);
  });

  it('an idempotent repeat of the same status is harmless', () => {
    expect(isLegalTransition('verified', 'verified')).toBe(true);
  });
});

describe('data minimisation', () => {
  it('PIN: the case record holds a reference and an outcome, never a document', () => {
    const keys = Object.keys(caseAt('verified'));
    // A stored identity document cannot be rotated, identifies a real person
    // for life, and is a permanent liability that grows with every signup.
    for (const forbidden of [
      'document',
      'documentImage',
      'passport',
      'idNumber',
      'nationalId',
      'selfie',
      'liveness',
      'dateOfBirth',
      'address',
      'documentNumber',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(keys).toContain('providerReference');
    expect(keys).toContain('outcomeCode');
  });
});

describe('synthetic identity provider', () => {
  it('PIN: cannot start in production', () => {
    const provider = createSyntheticIdentityProvider();
    expect(() => assertIdentityProviderAllowed(provider, 'production')).toThrow(
      SyntheticIdentityProviderInProductionError,
    );
    expect(() => assertIdentityProviderAllowed(provider, 'staging')).not.toThrow();
  });

  it('PIN: its destination is obviously not a real vendor', async () => {
    const provider = createSyntheticIdentityProvider();
    const session = await provider.createVerificationSession({
      accountId: 'account_1',
      reference: 'case_1',
      nowMs: NOW,
    });
    // `.invalid` can never resolve, and "mode=test" survives a screenshot into
    // a document claiming C7 verifies identity.
    expect(session.redirectUrl).toContain('.invalid');
    expect(session.redirectUrl).toContain('mode=test');
    expect(provider.synthetic).toBe(true);
  });

  it('offers no way to submit a document', () => {
    const provider = createSyntheticIdentityProvider();
    // There is no upload surface at all: the synthetic adapter must never be a
    // path down which somebody sends real identity documents.
    expect(Object.keys(provider)).toEqual([
      'name',
      'synthetic',
      'createVerificationSession',
      'getVerificationStatus',
    ]);
  });
});
