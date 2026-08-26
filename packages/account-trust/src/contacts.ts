/**
 * The contact graph: who may ring you and who may message you.
 *
 * WHAT BEING A CONTACT GRANTS, exhaustively: they may ring you, and they may
 * message you. Not your organizations, not your presence, not your other
 * contacts. A permission that quietly widens is how a contact list becomes a
 * profile somebody can mine.
 *
 * ONE ROW PER RELATIONSHIP, not one per direction. Two rows describing one
 * relationship can disagree -- A thinks you are contacts, B thinks they blocked
 * you -- and the disagreement always resolves in favour of whoever asked first.
 * The pair is stored in a fixed order so there is exactly one place to look.
 *
 * NO FREE TEXT ANYWHERE IN A REQUEST. Not one word, and the type has nowhere to
 * put it. A message attached to a contact request is a channel that reaches a
 * stranger's screen without their consent, which is the precise thing the
 * contact gate exists to prevent -- fraud and spam migrate into it within a
 * week, and then the gate is a formality with a comment box.
 *
 * DECLINING IS SILENT. The sender is told nothing, ever, because an answer that
 * differs between "ignored" and "no such person" makes the graph probeable.
 */

export type ContactState = 'pending' | 'accepted' | 'blocked';

/**
 * A relationship between two accounts.
 *
 * `lowAccountId` and `highAccountId` are the two ids in lexicographic order.
 * Ordering them is what makes one relationship one row: without it, (A,B) and
 * (B,A) are two rows for one fact.
 */
export interface ContactEdge {
  readonly lowAccountId: string;
  readonly highAccountId: string;
  readonly state: ContactState;
  /** Who asked. Retained through acceptance, for audit and for the UI. */
  readonly requestedBy: string;
  /** Who blocked, when blocked. Only they can lift it. */
  readonly blockedBy: string | null;
  readonly requestedAtMs: number;
  readonly updatedAtMs: number;
}

export type ContactRefusal =
  | 'self'
  | 'blocked'
  | 'already-contacts'
  | 'already-requested'
  | 'not-pending'
  | 'not-the-recipient'
  | 'not-blocked'
  | 'not-the-blocker';

export type ContactOutcome =
  | { readonly ok: true; readonly edge: ContactEdge }
  | { readonly ok: false; readonly reason: ContactRefusal };

/** The two ids in the fixed order the edge is stored under. */
export function contactPair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/** The other party, from one side's point of view. */
export function otherParty(edge: ContactEdge, accountId: string): string {
  return edge.lowAccountId === accountId ? edge.highAccountId : edge.lowAccountId;
}

/**
 * Send a contact request.
 *
 * @param existing - The current relationship, if any. Passed in rather than
 * looked up, because this module holds no storage.
 *
 * A BLOCK IS ANSWERED EXACTLY LIKE A SUCCESS by the caller, and the type says
 * so by returning a refusal the route is expected to swallow. If a blocked
 * sender were told, blocking would become detectable and the block itself
 * becomes information -- which turns a protection into a signal.
 */
export function requestContact(input: {
  requesterAccountId: string;
  targetAccountId: string;
  existing: ContactEdge | null;
  nowMs: number;
}): ContactOutcome {
  if (input.requesterAccountId === input.targetAccountId) {
    return { ok: false, reason: 'self' };
  }

  const { low, high } = contactPair(input.requesterAccountId, input.targetAccountId);

  if (input.existing) {
    if (input.existing.state === 'blocked') return { ok: false, reason: 'blocked' };
    if (input.existing.state === 'accepted') return { ok: false, reason: 'already-contacts' };
    /*
     * A second request while one is pending changes nothing and is not an
     * error worth distinguishing. Re-sending must not refresh the timestamp
     * either: that would let somebody keep a request permanently at the top of
     * a list somebody else has chosen not to answer.
     */
    return { ok: false, reason: 'already-requested' };
  }

  return {
    ok: true,
    edge: {
      lowAccountId: low,
      highAccountId: high,
      state: 'pending',
      requestedBy: input.requesterAccountId,
      blockedBy: null,
      requestedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    },
  };
}

/**
 * Accept a request.
 *
 * ONLY THE RECIPIENT MAY. The requester accepting their own request would be a
 * one-sided contact with both parties' consent recorded, which is the whole
 * thing the handshake exists to establish.
 */
export function acceptContact(input: {
  edge: ContactEdge;
  accepterAccountId: string;
  nowMs: number;
}): ContactOutcome {
  if (input.edge.state === 'blocked') return { ok: false, reason: 'blocked' };
  if (input.edge.state !== 'pending') return { ok: false, reason: 'not-pending' };
  if (input.edge.requestedBy === input.accepterAccountId) {
    return { ok: false, reason: 'not-the-recipient' };
  }

  return {
    ok: true,
    edge: { ...input.edge, state: 'accepted', updatedAtMs: input.nowMs },
  };
}

/**
 * Block somebody.
 *
 * Available from ANY state, including from no relationship at all: somebody
 * should not have to receive a request before they can refuse to receive one.
 * Blocking an existing contact removes what being a contact granted, in the
 * same step, because a block that leaves calls working is not a block.
 */
export function blockContact(input: {
  edge: ContactEdge | null;
  blockerAccountId: string;
  targetAccountId: string;
  nowMs: number;
}): ContactOutcome {
  if (input.blockerAccountId === input.targetAccountId) return { ok: false, reason: 'self' };

  const { low, high } = contactPair(input.blockerAccountId, input.targetAccountId);
  const base: ContactEdge = input.edge ?? {
    lowAccountId: low,
    highAccountId: high,
    state: 'pending',
    requestedBy: input.blockerAccountId,
    blockedBy: null,
    requestedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };

  return {
    ok: true,
    edge: { ...base, state: 'blocked', blockedBy: input.blockerAccountId, updatedAtMs: input.nowMs },
  };
}

/**
 * Lift a block.
 *
 * ONLY THE BLOCKER, which is what "permanent until reversed by the blocker"
 * means. The blocked party lifting their own block would make the control
 * decorative.
 *
 * Lifting returns to NO RELATIONSHIP, not to the contact they used to be.
 * Somebody who blocked a contact and later relents has not thereby agreed to
 * resume; if they want them back, that is a fresh handshake.
 */
export function unblockContact(input: {
  edge: ContactEdge;
  accountId: string;
}): { ok: true } | { ok: false; reason: ContactRefusal } {
  if (input.edge.state !== 'blocked') return { ok: false, reason: 'not-blocked' };
  if (input.edge.blockedBy !== input.accountId) return { ok: false, reason: 'not-the-blocker' };
  return { ok: true };
}

/**
 * Whether these two may ring and message each other.
 *
 * THE ONE QUESTION THE CALL AND MESSAGE PATHS ASK. Written once so those two
 * cannot drift apart: a personal call permitted by one rule and a message
 * permitted by a slightly different one is how a blocked person keeps a channel.
 */
export function mayReach(edge: ContactEdge | null): boolean {
  return edge?.state === 'accepted';
}

/**
 * What a recipient is shown about a pending request.
 *
 * DELIBERATELY NOT MUTUAL CONTACTS, and this is a departure from
 * COMMUNICATION_ARCHITECTURE.md section 2.2, which lists them. Section 2.5 of
 * the same document says contacts are never transitive and that there is "no
 * path by which being in someone's contacts exposes you to anybody in theirs" --
 * and a mutual-contact count is exactly such a path. It also hands a fraudster
 * who has got into one person's contacts a way to map the graph around them, by
 * sending requests and reading the counts. The two rules cannot both hold, so
 * this takes the narrower one until it is ruled on.
 */
export interface ContactRequestView {
  readonly fromAccountId: string;
  readonly displayName: string | null;
  /** When their account was first verified. Absent when it never was. */
  readonly verifiedSinceMs: number | null;
  readonly requestedAtMs: number;
}
