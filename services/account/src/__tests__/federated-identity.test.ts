/** @author masterzee001 */
/**
 * The account-takeover rule, exercised from every side.
 *
 * FOUNDER DECISION, 3 Oct 2026: a provider may claim an existing account
 * only when it has told us the email address is verified. These exist
 * because the friendly alternative -- link whenever the addresses match --
 * is the one most products ship, and it hands over a C7 account to anybody
 * who can make a provider assert an address they do not own.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveFederatedSignIn,
  type ExistingAccounts,
  type ProviderIdentity,
} from '../federated-identity.js';
import type { AccountId } from '@videofy-live/participant-contracts';

const ALICE = 'acct_alice' as AccountId;
const STRANGER = 'acct_stranger' as AccountId;

function identity(over: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google',
    subject: 'google-subject-1',
    email: 'alice@example.com',
    emailVerified: true,
    displayName: 'Alice',
    ...over,
  };
}

function existing(over: Partial<ExistingAccounts> = {}): ExistingAccounts {
  return { linkedToSubject: null, holdingEmail: null, ...over };
}

describe('somebody who has signed in this way before', () => {
  it('lands in their own account', () => {
    const out = resolveFederatedSignIn(identity(), existing({ linkedToSubject: ALICE }));
    expect(out).toEqual({ kind: 'sign-in', accountId: ALICE });
  });

  /*
   * THE SUBJECT OUTRANKS THE ADDRESS, and this is why. Somebody linked
   * Google a year ago and has since changed their Google email. Matching on
   * the address would either make them a second account or, as here, drop
   * them into whoever now holds the old address.
   */
  it('is NOT redirected by an address that now belongs to somebody else', () => {
    const out = resolveFederatedSignIn(
      identity({ email: 'reassigned@example.com' }),
      existing({ linkedToSubject: ALICE, holdingEmail: STRANGER }),
    );
    expect(out).toEqual({ kind: 'sign-in', accountId: ALICE });
  });

  it('is signed in even when the provider stopped verifying the address', () => {
    // The link already exists; verification governs CLAIMING an account, not
    // keeping one you are already attached to.
    const out = resolveFederatedSignIn(
      identity({ emailVerified: false }),
      existing({ linkedToSubject: ALICE }),
    );
    expect(out).toEqual({ kind: 'sign-in', accountId: ALICE });
  });
});

describe('a new person', () => {
  it('may create an account when nobody holds the address', () => {
    expect(resolveFederatedSignIn(identity(), existing())).toEqual({ kind: 'create' });
  });

  it('may create one even with an unverified address nobody else holds', () => {
    // Nothing is being taken from anybody, so verification is not the
    // question here -- there is no account to protect.
    const out = resolveFederatedSignIn(identity({ emailVerified: false }), existing());
    expect(out).toEqual({ kind: 'create' });
  });
});

describe('the takeover rule', () => {
  it('LINKS when the provider verified the address', () => {
    const out = resolveFederatedSignIn(identity(), existing({ holdingEmail: ALICE }));
    expect(out).toEqual({ kind: 'link-and-sign-in', accountId: ALICE });
  });

  /*
   * THE DEFECT THIS FILE EXISTS FOR. An unverified address plus an existing
   * account is exactly the shape of a takeover, and the only thing standing
   * between the two is this branch.
   */
  it('REFUSES when the provider did not verify the address', () => {
    const out = resolveFederatedSignIn(
      identity({ emailVerified: false }),
      existing({ holdingEmail: ALICE }),
    );
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') expect(out.reason).toBe('unverified-email-conflict');
  });

  it('holds the same line for KingsChat as for Google', () => {
    // Writing the rule per provider would let the weakest one set the
    // standard the moment somebody adds a third.
    const out = resolveFederatedSignIn(
      identity({ provider: 'kingschat', subject: 'kc-1', emailVerified: false }),
      existing({ holdingEmail: ALICE }),
    );
    expect(out.kind).toBe('refuse');
  });

  it('never reveals that the address is registered', () => {
    /*
     * A sign-in surface that says "that address already has an account" is
     * an oracle for which addresses are registered, one guess at a time.
     */
    const out = resolveFederatedSignIn(
      identity({ emailVerified: false }),
      existing({ holdingEmail: ALICE }),
    );
    if (out.kind !== 'refuse') throw new Error('unreachable');
    for (const leak of ['already', 'exists', 'registered', 'taken', 'alice@example.com']) {
      expect(out.message.toLowerCase()).not.toContain(leak);
    }
    // And it names the way forward rather than leaving them stuck.
    expect(out.message).toContain('settings');
  });
});

describe('a provider that shares no address', () => {
  it('is refused rather than given an invented one', () => {
    /*
     * Every account is keyed by a unique email. A synthesised address would
     * be one nobody can receive mail at, on an account that can never
     * recover a password.
     */
    for (const email of [null, '', '   ']) {
      const out = resolveFederatedSignIn(identity({ email }), existing());
      expect(out.kind, JSON.stringify(email)).toBe('refuse');
      if (out.kind === 'refuse') expect(out.reason).toBe('no-email');
    }
  });

  it('still signs in somebody already linked, address or not', () => {
    const out = resolveFederatedSignIn(
      identity({ email: null }),
      existing({ linkedToSubject: ALICE }),
    );
    expect(out).toEqual({ kind: 'sign-in', accountId: ALICE });
  });
});
