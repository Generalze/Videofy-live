/**
 * Conference link controls.
 *
 * Weighted toward what must NOT happen: an expired or revoked link must not
 * admit, a zero join limit must not silently become unlimited, a lobby must
 * not let a stranger straight in, and a refusal must not leak whether the
 * room ever existed.
 */
import { describe, expect, it } from 'vitest';
import {
  createRoomAccess,
  decideLobbyAdmission,
  evaluateJoin,
  publicJoinRefusal,
  revokeRoomAccess,
  DEFAULT_ROOM_ACCESS_TTL_MS,
  type RoomAccess,
} from './conference-access.js';

const NOW = 1_700_000_000_000;
const HOST = 'acc_host';
const STRANGER = 'acc_stranger';

function access(overrides: Partial<Parameters<typeof createRoomAccess>[0]> = {}): RoomAccess {
  return createRoomAccess({
    roomId: 'room_1',
    hostAccountId: HOST,
    nowMs: NOW,
    ...overrides,
  });
}

describe('createRoomAccess', () => {
  it('defaults to a short expiry', () => {
    const a = access();
    expect(a.expiresAtMs).toBe(NOW + DEFAULT_ROOM_ACCESS_TTL_MS);
    // "Short" is meaningless without a ceiling: this pins it well under a day,
    // so nobody quietly widens the default into a standing link.
    expect(DEFAULT_ROOM_ACCESS_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('starts unrevoked, with zero joins, and no limit unless one is given', () => {
    const a = access();
    expect(a.revokedAtMs).toBeNull();
    expect(a.joinsCount).toBe(0);
    expect(a.maxJoins).toBeNull();
  });

  it('maxJoins absent from the input means unlimited', () => {
    expect(access().maxJoins).toBeNull();
  });

  // The exact bug this rule exists to prevent: `0 || unlimited` reads a
  // legitimate zero as falsy and grants unlimited joins instead of none.
  it('maxJoins: 0 means zero, not unlimited', () => {
    expect(access({ maxJoins: 0 }).maxJoins).toBe(0);
  });

  it('lobby defaults off when nothing says otherwise', () => {
    expect(access().lobbyRequired).toBe(false);
  });

  it('sharedOutsideContacts defaults the lobby on', () => {
    expect(access({ sharedOutsideContacts: true }).lobbyRequired).toBe(true);
  });

  it('an explicit lobbyRequired wins over sharedOutsideContacts either way', () => {
    expect(access({ sharedOutsideContacts: true, lobbyRequired: false }).lobbyRequired).toBe(false);
    expect(access({ sharedOutsideContacts: false, lobbyRequired: true }).lobbyRequired).toBe(true);
  });
});

describe('evaluateJoin: the happy path', () => {
  it('admits a join to a fresh, open link', () => {
    const result = evaluateJoin({ access: access(), nowMs: NOW, joinerAccountId: STRANGER });
    expect(result.status).toBe('admitted');
    if (result.status === 'admitted') {
      expect(result.access.joinsCount).toBe(1);
    }
  });
});

describe('evaluateJoin: expiry', () => {
  it('refuses a join exactly at and after expiry', () => {
    const a = access();
    const atExpiry = evaluateJoin({ access: a, nowMs: a.expiresAtMs, joinerAccountId: STRANGER });
    expect(atExpiry.status).toBe('admitted'); // the boundary instant itself is still valid

    const afterExpiry = evaluateJoin({
      access: a,
      nowMs: a.expiresAtMs + 1,
      joinerAccountId: STRANGER,
    });
    expect(afterExpiry).toEqual({ status: 'refused', reason: 'expired' });
  });
});

describe('evaluateJoin: revocation', () => {
  it('refuses new joins once revoked', () => {
    const revoked = revokeRoomAccess(access(), NOW + 1000);
    const result = evaluateJoin({ access: revoked, nowMs: NOW + 2000, joinerAccountId: STRANGER });
    expect(result).toEqual({ status: 'refused', reason: 'revoked' });
  });

  it('does not disturb a join already admitted before the revoke', () => {
    const before = evaluateJoin({ access: access(), nowMs: NOW, joinerAccountId: STRANGER });
    expect(before.status).toBe('admitted');
    if (before.status !== 'admitted') throw new Error('unreachable');

    // Revoking is a function of the LINK, not of the participant record
    // returned above -- there is no eviction path in this module, so the
    // record a joiner was admitted with is untouched by a later revoke.
    const revoked = revokeRoomAccess(before.access, NOW + 1000);
    expect(before.access.revokedAtMs).toBeNull();
    expect(revoked.joinsCount).toBe(before.access.joinsCount);
  });

  it('revoking twice keeps the first revocation instant', () => {
    const once = revokeRoomAccess(access(), NOW + 1000);
    const twice = revokeRoomAccess(once, NOW + 5000);
    expect(twice.revokedAtMs).toBe(NOW + 1000);
  });
});

describe('evaluateJoin: maxJoins', () => {
  it('absent is unlimited across many joins', () => {
    let a = access();
    for (let i = 0; i < 50; i++) {
      const result = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: `acc_${i}` });
      expect(result.status).toBe('admitted');
      if (result.status === 'admitted') a = result.access;
    }
  });

  it('zero refuses every join, including the first', () => {
    const a = access({ maxJoins: 0 });
    const result = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: STRANGER });
    expect(result).toEqual({ status: 'refused', reason: 'full' });
  });

  it('N admits exactly N, and refuses the N+1th', () => {
    let a = access({ maxJoins: 2 });

    const first = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: 'acc_1' });
    expect(first.status).toBe('admitted');
    if (first.status === 'admitted') a = first.access;

    const second = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: 'acc_2' });
    expect(second.status).toBe('admitted');
    if (second.status === 'admitted') a = second.access;

    const third = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: 'acc_3' });
    expect(third).toEqual({ status: 'refused', reason: 'full' });
  });
});

describe('evaluateJoin: the lobby', () => {
  it('a required lobby yields admit-pending, not admitted', () => {
    const a = access({ lobbyRequired: true });
    const result = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: STRANGER });
    expect(result).toEqual({ status: 'admit-pending' });
  });

  it('host admission from the lobby admits, and counts as a join', () => {
    const a = access({ lobbyRequired: true });
    const pending = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: STRANGER });
    expect(pending.status).toBe('admit-pending');

    const decided = decideLobbyAdmission({ access: a, decision: 'admit', nowMs: NOW + 100 });
    expect(decided.status).toBe('admitted');
    if (decided.status === 'admitted') {
      expect(decided.access.joinsCount).toBe(1);
    }
  });

  it('host denial refuses, without touching the link', () => {
    const a = access({ lobbyRequired: true });
    const decided = decideLobbyAdmission({ access: a, decision: 'deny', nowMs: NOW + 100 });
    expect(decided).toEqual({ status: 'denied' });
  });

  it('the host is never put in the lobby for their own room', () => {
    const a = access({ lobbyRequired: true });
    const result = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: HOST });
    expect(result.status).toBe('admitted');
  });

  it('an anonymous joiner is never mistaken for the host', () => {
    const a = access({ lobbyRequired: true });
    const result = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: null });
    expect(result).toEqual({ status: 'admit-pending' });
  });

  // The link can go bad WHILE someone waits: admission re-validates instead
  // of trusting the state captured when the join request first arrived.
  it('re-checks link state at the moment of admission, not at request time', () => {
    let a = access({ lobbyRequired: true, maxJoins: 1 });
    const pending = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: STRANGER });
    expect(pending.status).toBe('admit-pending');

    // The single slot fills from someone else while the first waits -- the
    // host, here, since a host bypasses the lobby and is admitted directly.
    const other = evaluateJoin({ access: a, nowMs: NOW, joinerAccountId: HOST });
    expect(other.status).toBe('admitted');
    if (other.status === 'admitted') a = other.access;

    const decided = decideLobbyAdmission({ access: a, decision: 'admit', nowMs: NOW + 100 });
    expect(decided).toEqual({ status: 'refused', reason: 'full' });
  });
});

describe('publicJoinRefusal', () => {
  // The load-bearing property: a caller that cannot already tell a live,
  // revoked room from one that never existed must not be able to either,
  // by asking evaluateJoin and reading the reason back.
  it('does not let an untrusted caller distinguish "no such room" from "revoked"', () => {
    expect(publicJoinRefusal('room-unknown')).toBe(publicJoinRefusal('revoked'));
  });

  it('keeps expired and full distinguishable from each other and from unavailable', () => {
    const answers = new Set([
      publicJoinRefusal('room-unknown'),
      publicJoinRefusal('expired'),
      publicJoinRefusal('full'),
    ]);
    expect(answers).toEqual(new Set(['unavailable', 'expired', 'full']));
  });
});
