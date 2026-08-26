/**
 * The contact graph, stored.
 *
 * The rules are tested in account-trust. What is tested here is the part that
 * needs storage: that one relationship is one row whichever side asks, and that
 * two decisions about the same relationship cannot interleave.
 */
import { describe, expect, it } from 'vitest';
import { ContactStore } from '../contact-store.js';

const ALICE = 'acct_aaaa000000000001';
const BOB = 'acct_bbbb000000000002';
const CAROL = 'acct_cccc000000000003';

describe('one relationship, one row', () => {
  it('finds the relationship whichever way round it is asked for', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);

    expect(store.edgeBetween(ALICE, BOB)).not.toBeNull();
    expect(store.edgeBetween(BOB, ALICE)).not.toBeNull();
    expect(store.edgeBetween(ALICE, BOB)).toEqual(store.edgeBetween(BOB, ALICE));
  });

  /*
   * THE RACE THE LOCK EXISTS FOR. Both sides sending at the same instant read
   * "no relationship", and without serialisation both write one -- leaving two
   * views of one fact, whose disagreement resolves in favour of whoever asked
   * first. On a block, that is the wrong side.
   */
  it('lets only one of two simultaneous requests create the relationship', async () => {
    const store = new ContactStore();

    const [first, second] = await Promise.all([
      store.request(ALICE, BOB),
      store.request(BOB, ALICE),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(store.contactsOf(ALICE)).toHaveLength(0);
  });

  it('does not let an accept and a block interleave', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);

    await Promise.all([store.accept(BOB, ALICE), store.block(BOB, ALICE)]);

    // Whichever landed second decided, and the row says one thing rather than
    // two. What must never happen is a state that is both.
    const edge = store.edgeBetween(ALICE, BOB);
    expect(['accepted', 'blocked']).toContain(edge?.state);
  });
});

describe('what each side can see', () => {
  it('shows a request to the recipient and not to the sender', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);

    expect(store.pendingFor(BOB)).toHaveLength(1);
    // Listing your own request as answerable would invite a client to offer
    // accepting it.
    expect(store.pendingFor(ALICE)).toHaveLength(0);
    expect(store.sentBy(ALICE)).toHaveLength(1);
  });

  it('lists an accepted contact for both', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);
    await store.accept(BOB, ALICE);

    expect(store.contactsOf(ALICE)).toHaveLength(1);
    expect(store.contactsOf(BOB)).toHaveLength(1);
  });

  it('does not leak an unrelated relationship into somebody elses list', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);
    await store.accept(BOB, ALICE);

    expect(store.contactsOf(CAROL)).toHaveLength(0);
  });
});

describe('reaching each other', () => {
  it('is false until accepted and true after', async () => {
    const store = new ContactStore();
    expect(store.mayReach(ALICE, BOB)).toBe(false);

    await store.request(ALICE, BOB);
    expect(store.mayReach(ALICE, BOB)).toBe(false);

    await store.accept(BOB, ALICE);
    expect(store.mayReach(ALICE, BOB)).toBe(true);
  });

  /* A block that leaves calls working is not a block. */
  it('stops immediately on a block', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);
    await store.accept(BOB, ALICE);
    await store.block(BOB, ALICE);

    expect(store.mayReach(ALICE, BOB)).toBe(false);
    expect(store.mayReach(BOB, ALICE)).toBe(false);
  });
});

describe('removing and unblocking', () => {
  it('removes a contact for both sides', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);
    await store.accept(BOB, ALICE);
    await store.remove(ALICE, BOB);

    expect(store.contactsOf(ALICE)).toHaveLength(0);
    expect(store.contactsOf(BOB)).toHaveLength(0);
  });

  it('refuses the blocked party lifting the block', async () => {
    const store = new ContactStore();
    await store.block(BOB, ALICE);

    const result = await store.remove(ALICE, BOB);
    expect(result.ok).toBe(false);
    expect(store.mayReach(ALICE, BOB)).toBe(false);
  });

  /*
   * Lifting returns to NO relationship, not to the contact they used to be.
   * Restoring it silently would decide on the blocker's behalf that they meant
   * to resume, which is not what lifting a block says.
   */
  it('lets the blocker lift it, back to strangers rather than to contacts', async () => {
    const store = new ContactStore();
    await store.request(ALICE, BOB);
    await store.accept(BOB, ALICE);
    await store.block(BOB, ALICE);

    const result = await store.remove(BOB, ALICE);
    expect(result.ok).toBe(true);
    expect(store.edgeBetween(ALICE, BOB)).toBeNull();
    expect(store.mayReach(ALICE, BOB)).toBe(false);
  });

  it('treats removing a relationship that never existed as done', async () => {
    const store = new ContactStore();
    expect((await store.remove(ALICE, CAROL)).ok).toBe(true);
  });
});
