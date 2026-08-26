/**
 * Where the contact graph lives.
 *
 * The rules are in `@videofy-live/account-trust/contacts` and hold no storage.
 * This is the half that persists them, and it does exactly two things the pure
 * module cannot: it finds the one row describing a relationship, and it
 * serialises the read-decide-write so two requests cannot both decide.
 *
 * ONE ROW PER RELATIONSHIP, keyed on the pair in a fixed order. Two rows for
 * one relationship can disagree, and the disagreement always resolves in favour
 * of whoever asked first -- which on a block is the wrong side.
 *
 * EPHEMERAL BY DEFAULT, like the organization store beside it. That default is
 * what every test wants and what production must never run: a contact list that
 * empties on deploy would silently reopen every personal call the graph was
 * gating. The composition root chooses the durable port explicitly.
 */
import { randomUUID } from 'node:crypto';
import {
  acceptContact,
  blockContact,
  contactInviteUsable,
  contactPair,
  issueContactInvite,
  redeemContactInvite,
  revokeContactInvite,
  mayReach,
  otherParty,
  requestContact,
  unblockContact,
  type ContactEdge,
  type ContactInvite,
  type ContactInviteRefusal,
  type ContactOutcome,
  type ContactRefusal,
} from '@videofy-live/account-trust';

export interface ContactRecordPort {
  /** Every edge, once, at boot. */
  load(): Promise<readonly ContactEdge[]>;
  upsert(edge: ContactEdge): Promise<void>;
  remove(lowAccountId: string, highAccountId: string): Promise<void>;
  /**
   * Invites, which persist for the same reason challenges do: a restart must
   * not silently invalidate every link somebody has already sent out.
   */
  loadInvites(): Promise<readonly ContactInvite[]>;
  upsertInvite(invite: ContactInvite): Promise<void>;
}

export function createEphemeralContactRecords(): ContactRecordPort {
  return {
    async load() {
      return [];
    },
    async upsert() {},
    async remove() {},
    async loadInvites() {
      return [];
    },
    async upsertInvite() {},
  };
}

/**
 * The key one relationship is stored under.
 *
 * NUL as the separator, written as an escape: an account id cannot contain
 * one, so two ids can never be joined into a key that collides with another
 * pair. A literal NUL in source fails the hygiene gate and makes the file
 * undiffable, which is how this arrived here in the first place.
 */
const edgeKey = (low: string, high: string) => `${low}\u0000${high}`;

export class ContactStore {
  private readonly edges = new Map<string, ContactEdge>();
  /**
   * One promise chain per RELATIONSHIP, not per account.
   *
   * Keyed on the pair so two unrelated conversations never wait on each other,
   * and so both sides of one relationship do wait -- which is the case that
   * matters: A accepting while B blocks must not interleave.
   */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Invites by id. The plaintext token is never here -- only its hash, on the challenge. */
  private readonly invites = new Map<string, ContactInvite>();
  /** One chain per invite, so two people redeeming the same link cannot both win. */
  private readonly inviteLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly records: ContactRecordPort = createEphemeralContactRecords(),
  ) {}

  async hydrate(): Promise<number> {
    const loaded = await this.records.load();
    for (const edge of loaded) {
      this.edges.set(edgeKey(edge.lowAccountId, edge.highAccountId), edge);
    }
    for (const invite of await this.records.loadInvites()) {
      this.invites.set(invite.inviteId, invite);
    }
    return this.edges.size;
  }

  /** The relationship between two accounts, whichever way round they are given. */
  edgeBetween(a: string, b: string): ContactEdge | null {
    const { low, high } = contactPair(a, b);
    return this.edges.get(edgeKey(low, high)) ?? null;
  }

  /**
   * Whether these two may ring and message each other.
   *
   * THE question both the call path and the message path ask, answered in one
   * place so they cannot drift apart.
   */
  mayReach(a: string, b: string): boolean {
    return mayReach(this.edgeBetween(a, b));
  }

  /** Every accepted contact of an account. */
  contactsOf(accountId: string): readonly ContactEdge[] {
    return [...this.edges.values()].filter(
      (edge) =>
        edge.state === 'accepted' &&
        (edge.lowAccountId === accountId || edge.highAccountId === accountId),
    );
  }

  /**
   * Requests waiting for this account to answer.
   *
   * Only the ones somebody else sent. A request you sent is not something you
   * can act on, and listing it here would invite a client to offer accepting
   * your own.
   */
  pendingFor(accountId: string): readonly ContactEdge[] {
    return [...this.edges.values()].filter(
      (edge) =>
        edge.state === 'pending' &&
        edge.requestedBy !== accountId &&
        (edge.lowAccountId === accountId || edge.highAccountId === accountId),
    );
  }

  /** Requests this account sent and nobody has answered. */
  sentBy(accountId: string): readonly ContactEdge[] {
    return [...this.edges.values()].filter(
      (edge) => edge.state === 'pending' && edge.requestedBy === accountId,
    );
  }

  /**
   * Run a decision under the relationship's lock.
   *
   * Every mutation goes through here. The pure rule reads the CURRENT edge
   * inside the critical section rather than one the caller read earlier --
   * otherwise two requests both read "no relationship" and both write one.
   */
  private async withEdgeLock<T>(
    a: string,
    b: string,
    decide: (current: ContactEdge | null) => Promise<{ edge: ContactEdge | null; result: T }>,
  ): Promise<T> {
    const { low, high } = contactPair(a, b);
    const key = edgeKey(low, high);
    const previous = this.locks.get(key) ?? Promise.resolve();

    const next = previous.then(async () => {
      const current = this.edges.get(key) ?? null;
      const { edge, result } = await decide(current);
      if (edge) {
        this.edges.set(key, edge);
        await this.records.upsert(edge);
      }
      return result;
    });

    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  async request(requesterAccountId: string, targetAccountId: string): Promise<ContactOutcome> {
    return this.withEdgeLock<ContactOutcome>(
      requesterAccountId,
      targetAccountId,
      async (current) => {
        const outcome = requestContact({
          requesterAccountId,
          targetAccountId,
          existing: current,
          nowMs: this.now(),
        });
        return { edge: outcome.ok ? outcome.edge : null, result: outcome };
      },
    );
  }

  async accept(accepterAccountId: string, otherAccountId: string): Promise<ContactOutcome> {
    return this.withEdgeLock<ContactOutcome>(accepterAccountId, otherAccountId, async (current) => {
      if (!current) return { edge: null, result: { ok: false as const, reason: 'not-pending' as const } };
      const outcome = acceptContact({ edge: current, accepterAccountId, nowMs: this.now() });
      return { edge: outcome.ok ? outcome.edge : null, result: outcome };
    });
  }

  async block(blockerAccountId: string, targetAccountId: string): Promise<ContactOutcome> {
    return this.withEdgeLock<ContactOutcome>(blockerAccountId, targetAccountId, async (current) => {
      const outcome = blockContact({
        edge: current,
        blockerAccountId,
        targetAccountId,
        nowMs: this.now(),
      });
      return { edge: outcome.ok ? outcome.edge : null, result: outcome };
    });
  }

  /**
   * Lift a block, or remove a contact.
   *
   * BOTH ERASE THE ROW, and deliberately: lifting a block returns to no
   * relationship rather than to the contact they used to be. Somebody who
   * blocked a contact and later relents has not thereby agreed to resume, and
   * restoring them silently would be a decision made on their behalf.
   */
  async remove(
    accountId: string,
    otherAccountId: string,
  ): Promise<{ ok: true } | { ok: false; reason: ContactRefusal }> {
    const { low, high } = contactPair(accountId, otherAccountId);
    type Removal = { ok: true } | { ok: false; reason: ContactRefusal };
    return this.withEdgeLock<Removal>(accountId, otherAccountId, async (current) => {
      if (!current) return { edge: null, result: { ok: true as const } };

      if (current.state === 'blocked') {
        const lifted = unblockContact({ edge: current, accountId });
        if (!lifted.ok) return { edge: null, result: lifted };
      }

      this.edges.delete(edgeKey(low, high));
      await this.records.remove(low, high);
      return { edge: null, result: { ok: true as const } };
    });
  }

  /**
   * Mint an invite link.
   *
   * THE ONLY ROUTE TO A PRIVATE ACCOUNT, which is the default. Somebody who has
   * not opted into being findable cannot be requested by username, so a link
   * they issue themselves is how they choose to be reachable -- consent given in
   * advance rather than asked for after the fact.
   *
   * The plaintext token is returned ONCE and never stored: what is kept is its
   * hash, on the challenge. A link that could be re-read from storage would be a
   * standing key to somebody's contact list.
   */
  async issueInvite(issuerAccountId: string): Promise<{ invite: ContactInvite; token: string }> {
    const issued = issueContactInvite({
      inviteId: `inv_${randomUUID()}`,
      issuerAccountId,
      nowMs: this.now(),
    });
    this.invites.set(issued.invite.inviteId, issued.invite);
    await this.records.upsertInvite(issued.invite);
    return issued;
  }

  /** Withdraw an unused invite. Contacts already made through it are untouched. */
  async revokeInvite(
    inviteId: string,
    issuerAccountId: string,
  ): Promise<{ ok: boolean }> {
    const invite = this.invites.get(inviteId);
    /*
     * A missing invite and somebody else's invite answer identically. Otherwise
     * this endpoint reports whether an invite id exists, which is a thing an
     * attacker holding a guessed id would like to know.
     */
    if (!invite || invite.issuerAccountId !== issuerAccountId) return { ok: false };

    const revoked = revokeContactInvite(invite, this.now());
    this.invites.set(inviteId, revoked);
    await this.records.upsertInvite(revoked);
    return { ok: true };
  }

  /** An issuer's own invites, for showing which links are still live. */
  invitesOf(issuerAccountId: string): readonly ContactInvite[] {
    return [...this.invites.values()].filter(
      (invite) => invite.issuerAccountId === issuerAccountId,
    );
  }

  usable(invite: ContactInvite): boolean {
    return contactInviteUsable(invite, this.now());
  }

  /**
   * Redeem an invite, becoming contacts directly.
   *
   * NO PENDING REQUEST FOLLOWS. The issuer consented by minting the link and the
   * redeemer consented by using it, so there is nothing left for either to
   * approve -- an invite that still needed accepting would be a worse version of
   * an ordinary contact request.
   *
   * UNDER THE INVITE'S OWN LOCK, because single use is the whole design: two
   * people opening the same link at once must not both get in. The consumed
   * marker is written before the edge, so a crash between them leaves a spent
   * invite rather than a reusable one.
   */
  async redeemInvite(
    inviteId: string,
    token: string,
    redeemerAccountId: string,
  ): Promise<{ ok: true; issuerAccountId: string } | { ok: false; reason: ContactInviteRefusal }> {
    const previous = this.inviteLocks.get(inviteId) ?? Promise.resolve();

    const next = previous.then(async () => {
      const invite = this.invites.get(inviteId);
      // A missing invite is answered as a wrong one: an id that does not exist
      // and a token that does not match are the same non-answer.
      if (!invite) return { ok: false as const, reason: 'wrong-invite' as const };

      const outcome = redeemContactInvite({
        invite,
        token,
        redeemerAccountId,
        nowMs: this.now(),
      });

      // Written on EVERY path, because a failed attempt must still be counted --
      // that counter is what bounds guessing at a link.
      this.invites.set(inviteId, outcome.invite);
      await this.records.upsertInvite(outcome.invite);

      if (!outcome.ok) return { ok: false as const, reason: outcome.reason };

      const { low, high } = contactPair(outcome.issuerAccountId, outcome.redeemerAccountId);
      const nowMs = this.now();
      const edge: ContactEdge = {
        lowAccountId: low,
        highAccountId: high,
        state: 'accepted',
        requestedBy: outcome.issuerAccountId,
        blockedBy: null,
        requestedAtMs: nowMs,
        updatedAtMs: nowMs,
      };

      /*
       * A BLOCK SURVIVES AN INVITE. Somebody who blocked a person and later
       * hands out a general-purpose link has not thereby unblocked them, and a
       * link that quietly overrides a block is a way around one.
       */
      const existing = this.edges.get(edgeKey(low, high)) ?? null;
      if (existing?.state === 'blocked') {
        return { ok: false as const, reason: 'mismatch' as const };
      }

      this.edges.set(edgeKey(low, high), edge);
      await this.records.upsert(edge);
      return { ok: true as const, issuerAccountId: outcome.issuerAccountId };
    });

    const settled = next.catch(() => undefined);
    this.inviteLocks.set(inviteId, settled);
    void settled.then(() => {
      if (this.inviteLocks.get(inviteId) === settled) this.inviteLocks.delete(inviteId);
    });
    return next;
  }

  /** The other party in an edge, for a caller that has one side. */
  other(edge: ContactEdge, accountId: string): string {
    return otherParty(edge, accountId);
  }
}
