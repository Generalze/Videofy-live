/**
 * The contact graph, stored.
 *
 * The rules are tested in account-trust. What is tested here is the part that
 * needs storage: that one relationship is one row whichever side asks, and that
 * two decisions about the same relationship cannot interleave.
 */
import { describe, expect, it } from 'vitest';
import { ContactStore, type ContactRecordPort } from '../contact-store.js';
import type { ContactEdge, ContactInvite } from '@videofy-live/account-trust';

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

/*
 * SURVIVING A RESTART, which for this store is a security property rather than
 * a convenience. The contact graph is what gates personal calls and messages;
 * an empty one does not fail closed, it loses every connection people made and
 * discards the consent each represented.
 *
 * Tested against a recording port rather than a real database, so the thing
 * being proven is that the STORE writes what it would need to read back -- the
 * Postgres adapter's own SQL is exercised on the box.
 */
describe('surviving a restart', () => {
  function recordingPort() {
    const edges = new Map<string, ContactEdge>();
    const invites = new Map<string, ContactInvite>();
    const port: ContactRecordPort = {
      async load() {
        return [...edges.values()];
      },
      async upsert(edge) {
        edges.set(`${edge.lowAccountId}|${edge.highAccountId}`, edge);
      },
      async remove(low, high) {
        edges.delete(`${low}|${high}`);
      },
      async loadInvites() {
        return [...invites.values()];
      },
      async upsertInvite(invite) {
        invites.set(invite.inviteId, invite);
      },
    };
    return { port, edges, invites };
  }

  it('restores an accepted contact, so a call it gated stays gated', async () => {
    const { port } = recordingPort();
    const before = new ContactStore(() => Date.now(), port);
    await before.request(ALICE, BOB);
    await before.accept(BOB, ALICE);

    const after = new ContactStore(() => Date.now(), port);
    await after.hydrate();

    expect(after.mayReach(ALICE, BOB)).toBe(true);
    expect(after.contactsOf(ALICE)).toHaveLength(1);
  });

  /* A block that did not survive a deploy would silently un-block somebody. */
  it('restores a block', async () => {
    const { port } = recordingPort();
    const before = new ContactStore(() => Date.now(), port);
    await before.block(BOB, ALICE);

    const after = new ContactStore(() => Date.now(), port);
    await after.hydrate();

    expect(after.mayReach(ALICE, BOB)).toBe(false);
    expect(after.edgeBetween(ALICE, BOB)?.blockedBy).toBe(BOB);
  });

  it('does not resurrect a removed contact', async () => {
    const { port } = recordingPort();
    const before = new ContactStore(() => Date.now(), port);
    await before.request(ALICE, BOB);
    await before.accept(BOB, ALICE);
    await before.remove(ALICE, BOB);

    const after = new ContactStore(() => Date.now(), port);
    await after.hydrate();

    expect(after.edgeBetween(ALICE, BOB)).toBeNull();
  });

  /*
   * A SPENT INVITE MUST STAY SPENT. If invites did not survive, a restart would
   * turn every link ever issued back into a working one -- which is the exact
   * opposite of single use, and worse than never having persisted them.
   */
  it('keeps a spent invite spent across a restart', async () => {
    const { port } = recordingPort();
    const before = new ContactStore(() => Date.now(), port);
    const issued = await before.issueInvite(ALICE);
    const first = await before.redeemInvite(issued.invite.inviteId, issued.token, BOB);
    expect(first.ok).toBe(true);

    const after = new ContactStore(() => Date.now(), port);
    await after.hydrate();

    const replay = await after.redeemInvite(issued.invite.inviteId, issued.token, CAROL);
    expect(replay.ok).toBe(false);
    expect(after.mayReach(ALICE, CAROL)).toBe(false);
  });

  it('keeps a revoked invite revoked across a restart', async () => {
    const { port } = recordingPort();
    const before = new ContactStore(() => Date.now(), port);
    const issued = await before.issueInvite(ALICE);
    await before.revokeInvite(issued.invite.inviteId, ALICE);

    const after = new ContactStore(() => Date.now(), port);
    await after.hydrate();

    const redeemed = await after.redeemInvite(issued.invite.inviteId, issued.token, BOB);
    expect(redeemed.ok).toBe(false);
  });

  /* The plaintext token exists only in the link somebody copied. */
  it('never writes the token to the port', async () => {
    const { port, invites } = recordingPort();
    const store = new ContactStore(() => Date.now(), port);
    const issued = await store.issueInvite(ALICE);

    expect(JSON.stringify([...invites.values()])).not.toContain(issued.token);
  });
});
