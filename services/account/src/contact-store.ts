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
import {
  acceptContact,
  blockContact,
  contactPair,
  mayReach,
  otherParty,
  requestContact,
  unblockContact,
  type ContactEdge,
  type ContactOutcome,
  type ContactRefusal,
} from '@videofy-live/account-trust';

export interface ContactRecordPort {
  /** Every edge, once, at boot. */
  load(): Promise<readonly ContactEdge[]>;
  upsert(edge: ContactEdge): Promise<void>;
  remove(lowAccountId: string, highAccountId: string): Promise<void>;
}

export function createEphemeralContactRecords(): ContactRecordPort {
  return {
    async load() {
      return [];
    },
    async upsert() {},
    async remove() {},
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

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly records: ContactRecordPort = createEphemeralContactRecords(),
  ) {}

  async hydrate(): Promise<number> {
    const loaded = await this.records.load();
    for (const edge of loaded) {
      this.edges.set(edgeKey(edge.lowAccountId, edge.highAccountId), edge);
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

  /** The other party in an edge, for a caller that has one side. */
  other(edge: ContactEdge, accountId: string): string {
    return otherParty(edge, accountId);
  }
}
