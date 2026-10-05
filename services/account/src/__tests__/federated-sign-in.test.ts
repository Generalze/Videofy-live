/**
 * The seam between a verified provider identity and a C7 account.
 *
 * `federated-identity.ts` decides, `account-identities.ts` stores, and
 * `account-store.ts` holds the accounts; all three had tests before anybody
 * could sign in with Google. This file tests the thing that joins them, which
 * is where this repository's defects actually live.
 *
 * Every assertion here is about an OUTCOME -- which account the person reached,
 * how many exist afterwards, whether a row was written. None of them assert the
 * shape of the implementation, because a test written against the shape agrees
 * with the bug when the shape is the bug.
 */
import { describe, expect, it } from 'vitest';
import {
  createEphemeralAccountIdentities,
  type AccountIdentityPort,
} from '../account-identities.js';
import { AccountStore } from '../account-store.js';
import { FederatedSignIn } from '../federated-sign-in.js';
import type { ProviderIdentity } from '../federated-identity.js';

function identity(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google',
    subject: 'sub-123',
    email: 'zoe@example.com',
    emailVerified: true,
    displayName: 'Zoe',
    ...overrides,
  };
}

function harness(identities: AccountIdentityPort = createEphemeralAccountIdentities()) {
  let serial = 0;
  const warnings: string[] = [];
  const accounts = new AccountStore(
    undefined,
    () => 1_760_000_000_000,
    () => `000000000000000${++serial}`.slice(-16),
  );
  const signIn = new FederatedSignIn({
    accounts,
    identities,
    now: () => 1_760_000_000_000,
    warn: (message) => warnings.push(message),
  });
  return { accounts, identities, signIn, warnings };
}

describe('federated sign-in', () => {
  it('creates an account the first time, and finds the same one the second time', async () => {
    const { signIn } = harness();

    const first = await signIn.signIn(identity());
    expect(first.kind).toBe('signed-in');
    if (first.kind !== 'signed-in') return;
    expect(first.created).toBe(true);
    expect(first.account.email).toBe('zoe@example.com');

    const second = await signIn.signIn(identity());
    expect(second.kind).toBe('signed-in');
    if (second.kind !== 'signed-in') return;
    expect(second.created).toBe(false);
    expect(second.linked).toBe(false);
    // The point of the whole exercise: one person, one account.
    expect(second.account.accountId).toBe(first.account.accountId);
  });

  it('carries the provider email verification onto the new account', async () => {
    const { accounts, signIn } = harness();

    const verified = await signIn.signIn(identity());
    expect(verified.kind).toBe('signed-in');
    if (verified.kind !== 'signed-in') return;
    // Asked through `trustOf`, which is how the rest of the service asks: it
    // normalises a record with no trust field, so this cannot pass by reading
    // a shape that production never reads.
    expect(accounts.trustOf(verified.account.accountId).email).toBe('verified');

    const unverified = await signIn.signIn(
      identity({ subject: 'sub-other', email: 'other@example.com', emailVerified: false }),
    );
    expect(unverified.kind).toBe('signed-in');
    if (unverified.kind !== 'signed-in') return;
    // Absent is never a kind of verified: an unproven address stays unproven
    // even though the provider was happy to hand it over.
    expect(accounts.trustOf(unverified.account.accountId).email).toBe('unverified');
  });

  it('never gives a federated account a password to guess', async () => {
    const { accounts, signIn } = harness();
    await signIn.signIn(identity());

    // There is no password, so no password can open it -- including the empty
    // string, which is what a careless null check would let through.
    const attempt = await accounts.authenticate({ email: 'zoe@example.com', password: '' });
    expect(attempt.ok).toBe(false);
  });

  it('links to an existing account when the provider verified the address', async () => {
    const { accounts, signIn } = harness();
    const registered = await accounts.register({
      email: 'zoe@example.com',
      password: 'correct horse battery staple',
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const outcome = await signIn.signIn(identity());
    expect(outcome.kind).toBe('signed-in');
    if (outcome.kind !== 'signed-in') return;
    expect(outcome.linked).toBe(true);
    expect(outcome.created).toBe(false);
    expect(outcome.account.accountId).toBe(registered.account.accountId);
  });

  it('refuses to claim an existing account on an unverified address, and writes nothing', async () => {
    const { accounts, identities, signIn } = harness();
    const registered = await accounts.register({
      email: 'zoe@example.com',
      password: 'correct horse battery staple',
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const outcome = await signIn.signIn(identity({ emailVerified: false }));
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toBe('unverified-email-conflict');

    // The refusal has to be total. A link written anyway would hand the
    // account over on the NEXT attempt, when the fast path finds the subject
    // and never consults the rule again.
    expect(await identities.findBySubject('google', 'sub-123')).toBeNull();
    expect(await identities.listForAccount(registered.account.accountId)).toHaveLength(0);
  });

  it('refuses an identity that arrives with no address at all', async () => {
    const { signIn } = harness();
    const outcome = await signIn.signIn(identity({ email: null }));
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toBe('no-email');
  });

  it('refuses a second Google account on one C7 account', async () => {
    const { signIn } = harness();
    const first = await signIn.signIn(identity());
    expect(first.kind).toBe('signed-in');
    if (first.kind !== 'signed-in') return;

    // A different Google subject whose address is the one that account holds.
    const second = await signIn.signIn(identity({ subject: 'sub-999' }));
    expect(second.kind).toBe('refused');
    expect(second.kind === 'refused' && second.reason).toBe('account-already-linked');
  });

  it('refuses, loudly, when an identity points at an account that is not there', async () => {
    const identities = createEphemeralAccountIdentities();
    await identities.link({
      accountId: 'acct_gone',
      provider: 'google',
      subject: 'sub-123',
      emailAtLink: 'zoe@example.com',
      emailVerifiedAtLink: true,
      createdAt: new Date(1_760_000_000_000).toISOString(),
    });
    const { signIn, warnings } = harness(identities);

    const outcome = await signIn.signIn(identity());
    // Creating a fresh account here would silently strand everything the real
    // one holds, so the honest answer is a refusal.
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toBe('account-not-created');
    // And it must be audible. A guard that fires into an empty log is the
    // failure mode this codebase has already had four times.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('acct_gone');
  });

  /**
   * Two taps on one button, concurrently.
   *
   * WHAT THIS DOES AND DOES NOT ESTABLISH. It asserts the outcome that matters
   * -- one person, one account -- and it is sensitive to the real hazard: with
   * the subject lock removed AND the no-await section in `registerFederated`
   * broken, it fails, producing `acct_...01` and `acct_...02` for one person.
   *
   * It does NOT prove the lock, and an earlier version of this comment claimed
   * it did. Either guard alone is sufficient today, so removing just one keeps
   * this test green. That is worth knowing rather than papering over: it means
   * this test cannot be relied on to notice the lock going missing, and the
   * reason to keep the lock is written at the top of `federated-sign-in.ts`.
   */
  it('creates exactly one account when the same person signs in twice at once', async () => {
    const { accounts, signIn } = harness();

    const [a, b] = await Promise.all([signIn.signIn(identity()), signIn.signIn(identity())]);

    expect(a.kind).toBe('signed-in');
    expect(b.kind).toBe('signed-in');
    if (a.kind !== 'signed-in' || b.kind !== 'signed-in') return;
    expect(a.account.accountId).toBe(b.account.accountId);
    // Exactly one of the two calls did the creating.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(accounts.findByEmail('zoe@example.com')?.accountId).toBe(a.account.accountId);
  });

  it('keeps two different people apart when they sign in at the same moment', async () => {
    const { signIn } = harness();

    const [a, b] = await Promise.all([
      signIn.signIn(identity()),
      signIn.signIn(identity({ subject: 'sub-456', email: 'ada@example.com' })),
    ]);

    expect(a.kind).toBe('signed-in');
    expect(b.kind).toBe('signed-in');
    if (a.kind !== 'signed-in' || b.kind !== 'signed-in') return;
    // The lock is per subject, not global: two strangers must not be merged,
    // and must not have to queue behind one another either.
    expect(a.account.accountId).not.toBe(b.account.accountId);
  });

  it('treats the two providers as separate identities on one account', async () => {
    const { signIn } = harness();
    const google = await signIn.signIn(identity());
    expect(google.kind).toBe('signed-in');
    if (google.kind !== 'signed-in') return;

    const kingschat = await signIn.signIn(
      identity({ provider: 'kingschat', subject: 'kc-1' }),
    );
    expect(kingschat.kind).toBe('signed-in');
    if (kingschat.kind !== 'signed-in') return;
    // Same person, same verified address, one account, two ways in.
    expect(kingschat.account.accountId).toBe(google.account.accountId);
    expect(kingschat.linked).toBe(true);
  });
});
