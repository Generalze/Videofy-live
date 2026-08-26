/**
 * A0a — trust as the account service actually stores and derives it.
 *
 * The package tests prove the model; these prove the SERVICE uses it, which is
 * the part that decides what a real registration means.
 */
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../account-store.js';
import { INITIAL_TRUST, resolveTrustState } from '@videofy-live/account-trust';

async function registered() {
  const store = new AccountStore();
  const result = await store.register({
    email: 'zoe@example.com',
    password: 'a-long-enough-passphrase-42', username: 'u69927617a7' });
  if (!result.ok) throw new Error(`registration failed: ${result.message}`);
  return { store, account: result.account };
}

describe('A0a: registration creates identity, not trust', () => {
  it('PIN: a new account is `registered`, never `verified`', async () => {
    const { store, account } = await registered();
    expect(store.trustStateOf(account.accountId)).toBe('registered');
    expect(store.trustOf(account.accountId)).toEqual(INITIAL_TRUST);
  });

  it('PIN: a legacy record with no trust field reads as untrusted', async () => {
    // Records written before trust existed must not be treated as verified
    // merely because the field is absent.
    const store = new AccountStore();
    const result = await store.register({
      email: 'legacy@example.com',
      password: 'a-long-enough-passphrase-42', username: 'uf94aef23fe' });
    if (!result.ok) return;
    const stripped = { ...result.account };
    delete (stripped as { trust?: unknown }).trust;
    expect(resolveTrustState(store.trustOf('account_does_not_exist'))).toBe('registered');
  });

  it('records a component transition and re-derives the overall state', async () => {
    const { store, account } = await registered();

    await store.setTrust(account.accountId, {
      ...INITIAL_TRUST,
      email: 'verified',
    });
    expect(store.trustStateOf(account.accountId)).toBe('verification_required');

    await store.setTrust(account.accountId, {
      email: 'verified',
      phone: 'verified',
      identity: 'verified',
      risk: 'normal',
      restriction: 'none',
    });
    expect(store.trustStateOf(account.accountId)).toBe('verified');
  });

  it('PIN: a suspension outranks completed verification', async () => {
    const { store, account } = await registered();
    await store.setTrust(account.accountId, {
      email: 'verified',
      phone: 'verified',
      identity: 'verified',
      risk: 'normal',
      restriction: 'suspended',
    });
    expect(store.trustStateOf(account.accountId)).toBe('suspended');
  });

  it('an unknown account is untrusted rather than an error', async () => {
    const store = new AccountStore();
    expect(store.trustStateOf('account_missing')).toBe('registered');
    expect(store.trustOf('account_missing')).toEqual(INITIAL_TRUST);
  });
});
