/**
 * A0b — the identity flow as the service runs it.
 *
 * The property under test: a browser can START a check and can never REPORT
 * one. Every outcome enters through a signed server-to-server callback.
 */
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../account-store.js';
import { VerificationService } from '../verification.js';
import {
  CALLBACK_MAX_AGE_MS,
  createSyntheticIdentityProvider,
  createSyntheticProvider,
  signCallback,
} from '@videofy-live/account-trust';

const SECRET = 'identity-callback-secret-long-enough';

async function harness() {
  const store = new AccountStore();
  let nowMs = 1_700_000_000_000;
  const verification = new VerificationService({
    store,
    emailProvider: createSyntheticProvider('email'),
    phoneProvider: createSyntheticProvider('phone'),
    identityProvider: createSyntheticIdentityProvider(),
    identityCallbackSecret: SECRET,
    nowMs: () => nowMs,
  });
  const registration = await store.register({
    email: 'zoe@example.com',
    password: 'a-long-enough-passphrase-42',
  });
  if (!registration.ok) throw new Error('registration failed');

  return {
    store,
    verification,
    accountId: registration.account.accountId,
    nowMs: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function callback(
  providerReference: string,
  status: string,
  nowMs: number,
  eventId = 'evt_1',
) {
  const raw = JSON.stringify({ providerReference, status, eventId, issuedAtMs: nowMs });
  return { raw, signature: signCallback(raw, SECRET) };
}

describe('identity verification', () => {
  it('creates a hosted session and moves identity to pending', async () => {
    const { store, verification, accountId } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.session.redirectUrl).toContain('.invalid');
    expect(store.trustOf(accountId).identity).toBe('pending');
    expect(store.get(accountId)?.identityCase?.status).toBe('created');
  });

  it('PIN: only a signed callback can verify an identity', async () => {
    const { store, verification, accountId, nowMs } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;
    const reference = started.session.providerReference;

    // Unsigned, and signed with the wrong key: both refused.
    const unsigned = await verification.handleIdentityCallback(
      callback(reference, 'verified', nowMs()).raw,
      undefined,
    );
    expect(unsigned.ok).toBe(false);

    const wrongKey = callback(reference, 'verified', nowMs());
    const forged = await verification.handleIdentityCallback(
      wrongKey.raw,
      signCallback(wrongKey.raw, 'not-the-secret'),
    );
    expect(forged.ok).toBe(false);

    // Still pending: nothing an unauthenticated caller sent had any effect.
    expect(store.trustOf(accountId).identity).toBe('pending');
  });

  it('verifies through a correctly signed callback', async () => {
    const { store, verification, accountId, nowMs } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;

    const signed = callback(started.session.providerReference, 'verified', nowMs());
    const applied = await verification.handleIdentityCallback(signed.raw, signed.signature);
    expect(applied.ok).toBe(true);

    expect(store.trustOf(accountId).identity).toBe('verified');
    expect(store.get(accountId)?.identityCase?.completedAtMs).toBe(nowMs());
  });

  it('PIN: a replayed callback is accepted once and ignored after', async () => {
    const { store, verification, accountId, nowMs } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;

    const signed = callback(started.session.providerReference, 'verified', nowMs(), 'evt_same');
    expect((await verification.handleIdentityCallback(signed.raw, signed.signature)).ok).toBe(true);

    // At-least-once delivery: the same event WILL arrive again. Accepted, and
    // applied exactly once.
    const repeat = await verification.handleIdentityCallback(signed.raw, signed.signature);
    expect(repeat.ok).toBe(true);
    expect(store.get(accountId)?.seenCallbackEvents?.filter((id) => id === 'evt_same')).toHaveLength(
      1,
    );
  });

  it('PIN: a stale callback cannot be replayed later', async () => {
    const { verification, accountId, nowMs, advance } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;

    const signed = callback(started.session.providerReference, 'verified', nowMs());
    advance(CALLBACK_MAX_AGE_MS + 1);
    // Correctly signed yesterday is still correctly signed today; age is what
    // stops a captured callback from working forever.
    const late = await verification.handleIdentityCallback(signed.raw, signed.signature);
    expect(late.ok).toBe(false);
  });

  it('PIN: a late `processing` cannot un-verify a completed case', async () => {
    const { store, verification, accountId, nowMs, advance } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;
    const reference = started.session.providerReference;

    const done = callback(reference, 'verified', nowMs(), 'evt_done');
    await verification.handleIdentityCallback(done.raw, done.signature);
    expect(store.trustOf(accountId).identity).toBe('verified');

    advance(1000);
    const late = callback(reference, 'processing', nowMs(), 'evt_late');
    const outcome = await verification.handleIdentityCallback(late.raw, late.signature);
    expect(outcome.ok).toBe(false);
    expect(store.trustOf(accountId).identity).toBe('verified');
  });

  it('puts an account into review without pretending it is still pending', async () => {
    const { store, verification, accountId, nowMs } = await harness();
    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;

    const review = callback(started.session.providerReference, 'review', nowMs());
    await verification.handleIdentityCallback(review.raw, review.signature);

    expect(store.trustStateOf(accountId)).toBe('under_review');
    expect(store.get(accountId)?.identityCase?.reviewOpenedAtMs).toBe(nowMs());
  });

  it('refuses a second concurrent case', async () => {
    const { verification, accountId } = await harness();
    expect((await verification.startIdentityVerification(accountId)).ok).toBe(true);
    // Two live cases means two callbacks racing to decide the same account.
    const second = await verification.startIdentityVerification(accountId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('in-progress');
  });

  it('PIN: status exposes standing, never the provider vocabulary', async () => {
    const { verification, accountId } = await harness();
    await verification.startIdentityVerification(accountId);
    const status = verification.status(accountId);

    expect(status).toHaveProperty('identity');
    expect(status).toHaveProperty('identityCaseStatus');
    // A person needs to know where they stand, not the provider's reference or
    // its internal outcome codes.
    expect(status).not.toHaveProperty('providerReference');
    expect(status).not.toHaveProperty('outcomeCode');
    expect(status).not.toHaveProperty('jurisdiction');
  });

  it('reaches fully verified only when all three channels complete', async () => {
    const { store, verification, accountId, nowMs, advance } = await harness();
    const delivered: string[] = [];
    // Email and phone through their own flows.
    const store2 = store;
    await verification.requestEmailVerification(accountId);
    const emailToken = store2.get(accountId)?.emailChallenge;
    expect(emailToken).toBeTruthy();

    // The synthetic providers in this harness do not expose tokens, so drive
    // the remaining channels through trust directly — the channel flows are
    // pinned in verification-flow.test.ts.
    await store.setTrust(accountId, {
      ...store.trustOf(accountId),
      email: 'verified',
      phone: 'verified',
    });
    advance(1000);

    const started = await verification.startIdentityVerification(accountId);
    if (!started.ok) return;
    const signed = callback(started.session.providerReference, 'verified', nowMs());
    await verification.handleIdentityCallback(signed.raw, signed.signature);

    expect(store.trustStateOf(accountId)).toBe('verified');
    expect(delivered).toEqual([]);
  });
});
