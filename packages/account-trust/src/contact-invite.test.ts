/**
 * Contact invites and discovery.
 *
 * The load-bearing properties are that an invite dies on first use — a link
 * that works twice is a public handle, which defeats private mode by ordinary
 * sharing rather than by attack — and that a private account is indistinguish-
 * able from an address that was never registered.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_INVITE_POLICY,
  contactInviteUsable,
  issueContactInvite,
  redeemContactInvite,
  revokeContactInvite,
  searchContact,
  type ContactInvite,
} from './index.js';

const NOW = 1_700_000_000_000;
const ISSUER = 'acc_issuer';
const REDEEMER = 'acc_redeemer';
const TOKEN = 'a-high-entropy-invite-token';

function invite(nowMs = NOW): ContactInvite {
  return issueContactInvite({
    inviteId: 'inv_1',
    issuerAccountId: ISSUER,
    nowMs,
    token: TOKEN,
  }).invite;
}

describe('issuing', () => {
  it('stores only the hash, never the token', () => {
    const { invite: issued, token } = issueContactInvite({
      inviteId: 'inv_1',
      issuerAccountId: ISSUER,
      nowMs: NOW,
    });
    expect(token.length).toBeGreaterThan(16);
    expect(issued.challenge.tokenHash).not.toBe(token);
    expect(JSON.stringify(issued)).not.toContain(token);
  });

  it('binds the invite to its issuer', () => {
    expect(invite().challenge.target).toBe(ISSUER);
  });

  it('starts usable and unrevoked', () => {
    expect(contactInviteUsable(invite(), NOW)).toBe(true);
  });
});

describe('redeeming', () => {
  it('connects the two accounts', () => {
    const result = redeemContactInvite({
      invite: invite(),
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issuerAccountId).toBe(ISSUER);
      expect(result.redeemerAccountId).toBe(REDEEMER);
    }
  });

  /*
   * The whole design. A link that works twice works a thousand times once
   * somebody forwards it, and private mode is defeated by sharing rather than
   * by any attack.
   */
  it('dies on first use', () => {
    const first = redeemContactInvite({
      invite: invite(),
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });
    expect(first.ok).toBe(true);

    const second = redeemContactInvite({
      invite: first.invite,
      token: TOKEN,
      redeemerAccountId: 'acc_someone_else',
      nowMs: NOW + 2000,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('consumed');
    expect(contactInviteUsable(first.invite, NOW + 2000)).toBe(false);
  });

  it('refuses a wrong token and counts the attempt', () => {
    const result = redeemContactInvite({
      invite: invite(),
      token: 'not-the-token',
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
    expect(result.invite.challenge.attempts).toBe(1);
  });

  it('stops accepting attempts at the cap', () => {
    let current = invite();
    for (let attempt = 0; attempt < CONTACT_INVITE_POLICY.maxAttempts; attempt += 1) {
      current = redeemContactInvite({
        invite: current,
        token: 'wrong',
        redeemerAccountId: REDEEMER,
        nowMs: NOW + 1000,
      }).invite;
    }
    const result = redeemContactInvite({
      invite: current,
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-many-attempts');
  });

  it('refuses an expired invite', () => {
    const result = redeemContactInvite({
      invite: invite(),
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + CONTACT_INVITE_POLICY.ttlMs + 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('survives a weekend, so a contact in another timezone can still use it', () => {
    const result = redeemContactInvite({
      invite: invite(),
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 48 * 60 * 60 * 1000,
    });
    expect(result.ok).toBe(true);
  });
});

describe('revocation', () => {
  it('refuses a revoked invite', () => {
    const revoked = revokeContactInvite(invite(), NOW + 500);
    const result = redeemContactInvite({
      invite: revoked,
      token: TOKEN,
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  /*
   * A withdrawn invite is not a guess at a live one. Counting attempts against
   * it would let anybody holding a revoked link exhaust the record.
   */
  it('does not spend attempts on a revoked invite', () => {
    const revoked = revokeContactInvite(invite(), NOW + 500);
    const result = redeemContactInvite({
      invite: revoked,
      token: 'wrong',
      redeemerAccountId: REDEEMER,
      nowMs: NOW + 1000,
    });
    expect(result.invite.challenge.attempts).toBe(0);
  });

  it('is idempotent', () => {
    const once = revokeContactInvite(invite(), NOW + 500);
    expect(revokeContactInvite(once, NOW + 900).revokedAtMs).toBe(NOW + 500);
  });
});

describe('self-redemption', () => {
  /*
   * A mistake, not an attack. Opening your own link while signed in must not
   * consume it and force you to mint another.
   */
  it('refuses without consuming the invite', () => {
    const original = invite();
    const result = redeemContactInvite({
      invite: original,
      token: TOKEN,
      redeemerAccountId: ISSUER,
      nowMs: NOW + 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('self');
    expect(result.invite.challenge.consumedAtMs).toBeNull();
    expect(contactInviteUsable(result.invite, NOW + 1000)).toBe(true);
  });
});

describe('discovery', () => {
  it('finds a discoverable account by exact address', () => {
    expect(
      searchContact({
        query: 'someone@example.com',
        matchedAccountId: 'acc_1',
        matchedMode: 'discoverable',
      }),
    ).toEqual({ found: true, accountId: 'acc_1' });
  });

  /*
   * The property private mode exists for. "This person is private" confirms
   * they exist, which is the fact being concealed.
   */
  it('answers for a private account exactly as for one that does not exist', () => {
    const privateAccount = searchContact({
      query: 'someone@example.com',
      matchedAccountId: 'acc_1',
      matchedMode: 'private',
    });
    const unknown = searchContact({
      query: 'nobody@example.com',
      matchedAccountId: null,
      matchedMode: 'discoverable',
    });

    expect(privateAccount).toEqual(unknown);
    expect(JSON.stringify(privateAccount)).toBe(JSON.stringify(unknown));
  });

  it('never returns anything but a single account or nothing', () => {
    const result = searchContact({
      query: 'someone@example.com',
      matchedAccountId: 'acc_1',
      matchedMode: 'discoverable',
    });
    // No count, no list, no partial matches: a directory is the harvesting
    // surface the whole model exists to avoid.
    expect(Object.keys(result).sort()).toEqual(['accountId', 'found']);
  });
});
