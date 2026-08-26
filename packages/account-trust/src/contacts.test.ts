/**
 * The contact graph.
 *
 * Every rule here exists because of a specific abuse, so the tests are named
 * after the abuse rather than after the function. What a contact grants is
 * exhaustive -- ring and message, nothing else -- and most of these assert the
 * boundary of that rather than the happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptContact,
  blockContact,
  contactPair,
  mayReach,
  otherParty,
  isBillable,
  requestContact,
  unblockContact,
  type ContactEdge,
} from './contacts.js';

const ALICE = 'acct_aaaa000000000001';
const BOB = 'acct_bbbb000000000002';
const CAROL = 'acct_cccc000000000003';
const NOW = 1_700_000_000_000;

function pending(requestedBy = ALICE): ContactEdge {
  const { low, high } = contactPair(ALICE, BOB);
  return {
    lowAccountId: low,
    highAccountId: high,
    state: 'pending',
    requestedBy,
    blockedBy: null,
    requestedAtMs: NOW,
    updatedAtMs: NOW,
  };
}

describe('one relationship, one row', () => {
  /*
   * Two rows describing one relationship can disagree -- A thinks you are
   * contacts, B thinks they blocked you -- and the disagreement resolves in
   * favour of whoever asked first.
   */
  it('orders the pair the same way whichever side asks', () => {
    expect(contactPair(ALICE, BOB)).toEqual(contactPair(BOB, ALICE));
  });

  it('reads the other party from either side', () => {
    const edge = pending();
    expect(otherParty(edge, ALICE)).toBe(BOB);
    expect(otherParty(edge, BOB)).toBe(ALICE);
  });
});

describe('sending a request', () => {
  it('creates a pending relationship', () => {
    const result = requestContact({
      requesterAccountId: ALICE,
      targetAccountId: BOB,
      existing: null,
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edge.state).toBe('pending');
      expect(result.edge.requestedBy).toBe(ALICE);
    }
  });

  it('refuses adding yourself', () => {
    const result = requestContact({
      requesterAccountId: ALICE,
      targetAccountId: ALICE,
      existing: null,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  /*
   * The refusal a route is expected to SWALLOW. Telling a blocked sender they
   * are blocked makes blocking detectable, and a detectable block is a signal
   * rather than a protection.
   */
  it('refuses a blocked sender, for the route to answer as success', () => {
    const blocked: ContactEdge = { ...pending(), state: 'blocked', blockedBy: BOB };
    const result = requestContact({
      requesterAccountId: ALICE,
      targetAccountId: BOB,
      existing: blocked,
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blocked');
  });

  it('refuses when they are already contacts', () => {
    const accepted: ContactEdge = { ...pending(), state: 'accepted' };
    const result = requestContact({
      requesterAccountId: ALICE,
      targetAccountId: BOB,
      existing: accepted,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
  });

  /*
   * Re-sending must not refresh the timestamp: that would let somebody keep a
   * request permanently at the top of a list the recipient has chosen not to
   * answer, which is a notification channel by another route.
   */
  it('does not renew a request that is already pending', () => {
    const result = requestContact({
      requesterAccountId: ALICE,
      targetAccountId: BOB,
      existing: pending(),
      nowMs: NOW + 60_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('already-requested');
  });
});

describe('accepting', () => {
  it('makes the pair contacts', () => {
    const result = acceptContact({ edge: pending(ALICE), accepterAccountId: BOB, nowMs: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.edge.state).toBe('accepted');
  });

  /*
   * The requester accepting their own request would record both parties'
   * consent while only one had given it -- which is the entire thing the
   * handshake establishes.
   */
  it('refuses the requester accepting their own request', () => {
    const result = acceptContact({ edge: pending(ALICE), accepterAccountId: ALICE, nowMs: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-the-recipient');
  });

  it('refuses accepting a blocked relationship', () => {
    const blocked: ContactEdge = { ...pending(), state: 'blocked', blockedBy: BOB };
    expect(acceptContact({ edge: blocked, accepterAccountId: BOB, nowMs: NOW }).ok).toBe(false);
  });

  it('refuses accepting twice', () => {
    const accepted: ContactEdge = { ...pending(), state: 'accepted' };
    expect(acceptContact({ edge: accepted, accepterAccountId: BOB, nowMs: NOW }).ok).toBe(false);
  });
});

describe('blocking', () => {
  /* Nobody should have to receive a request before they can refuse to. */
  it('works with no prior relationship', () => {
    const result = blockContact({
      edge: null,
      blockerAccountId: ALICE,
      targetAccountId: CAROL,
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edge.state).toBe('blocked');
      expect(result.edge.blockedBy).toBe(ALICE);
    }
  });

  /* A block that leaves calls working is not a block. */
  it('removes what being a contact granted, in the same step', () => {
    const accepted: ContactEdge = { ...pending(), state: 'accepted' };
    const result = blockContact({
      edge: accepted,
      blockerAccountId: BOB,
      targetAccountId: ALICE,
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(mayReach(result.edge)).toBe(false);
  });

  it('records who blocked, because only they can lift it', () => {
    const result = blockContact({
      edge: pending(),
      blockerAccountId: BOB,
      targetAccountId: ALICE,
      nowMs: NOW,
    });
    if (result.ok) expect(result.edge.blockedBy).toBe(BOB);
  });
});

describe('lifting a block', () => {
  const blocked: ContactEdge = { ...pending(), state: 'blocked', blockedBy: BOB };

  it('lets the blocker lift it', () => {
    expect(unblockContact({ edge: blocked, accountId: BOB }).ok).toBe(true);
  });

  /* Otherwise the control is decorative. */
  it('refuses the blocked party lifting their own block', () => {
    const result = unblockContact({ edge: blocked, accountId: ALICE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-the-blocker');
  });

  it('refuses lifting what is not blocked', () => {
    expect(unblockContact({ edge: pending(), accountId: BOB }).ok).toBe(false);
  });
});

describe('who may ring and message', () => {
  /*
   * ONE question, asked by both the call path and the message path. Two rules
   * that are nearly the same is how a blocked person keeps one channel.
   */
  it('is true only for accepted contacts', () => {
    expect(mayReach({ ...pending(), state: 'accepted' })).toBe(true);
    expect(mayReach(pending())).toBe(false);
    expect(mayReach({ ...pending(), state: 'blocked', blockedBy: BOB })).toBe(false);
    expect(mayReach(null)).toBe(false);
  });

  /* A stranger is the default, and the default is no. */
  it('is false for two accounts that have never met', () => {
    expect(mayReach(null)).toBe(false);
  });
});

describe('what a channel costs', () => {
  /*
   * Zoe's ruling: normal mode is free on every channel -- text, voice note and
   * call alike -- and credit is consumed only when something is actually
   * translated. The charge is for the TRANSLATION, not for the conversation.
   */
  it('charges nothing in normal mode', () => {
    expect(isBillable('normal')).toBe(false);
  });

  it('charges in translation mode', () => {
    expect(isBillable('translated')).toBe(true);
  });

  /*
   * Asked in one place so the three channels cannot drift into charging
   * differently for the same work -- and so a free path cannot quietly become
   * a charged one in only one of them.
   */
  it('answers the same question for every channel', () => {
    const forText = isBillable('normal');
    const forVoiceNote = isBillable('normal');
    const forCall = isBillable('normal');
    expect([forText, forVoiceNote, forCall]).toEqual([false, false, false]);
  });
});
