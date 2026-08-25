/**
 * Conference link controls -- expiry, revocation, and a lobby.
 *
 * WHY THIS EXISTS. Personal calls are gated behind a mutual contact list so a
 * stranger cannot ring you (docs/COMMUNICATION_ARCHITECTURE.md section 1, "Why
 * this split is the anti-fraud control"). A conference link has no such gate --
 * section 3.2 is explicit that it stays open BY DESIGN, because that is what a
 * conference is. Left at that, conference becomes the open door beside the
 * locked gate: a fraudster who cannot ring a stranger directly just always
 * uses a conference link instead, and the whole contact gate achieves
 * nothing. This module is what closes that door without removing it --
 * section 3.2's three controls (short-lived links, revocation, a lobby)
 * implemented as functions over values, so the store (a later step, by
 * somebody else) decides when to call them but never has to decide how they
 * work.
 *
 * PURE DOMAIN LOGIC. No storage, no HTTP, no sockets. Time is passed in as
 * `nowMs` rather than read from the clock, so a test can put a link one
 * millisecond either side of expiry without waiting for it. Same shape as
 * `packages/account-trust/src/verification-token.ts`.
 */

/**
 * The state of one conference room's join link.
 *
 * One record per link, not per room: revoking a link and minting a fresh one
 * for the same `roomId` is how a host recovers from a leaked link without
 * losing the room itself (see `revokeRoomAccess`).
 */
export interface RoomAccess {
  readonly roomId: string;
  readonly hostAccountId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** Set once revoked. Revocation never un-sets this -- see `revokeRoomAccess`. */
  readonly revokedAtMs: number | null;
  readonly lobbyRequired: boolean;
  /**
   * The total number of joins this link will ever admit.
   *
   * `null` means unlimited. This is deliberately not `0` and not "field
   * absent from a plain object" -- a stored `RoomAccess` always carries one of
   * exactly two states, decided once at creation by `createRoomAccess`, so
   * nothing downstream can mistake "no limit was set" for "the limit is
   * zero." See the comment on `createRoomAccess`'s `maxJoins` input for where
   * that distinction has to be made.
   */
  readonly maxJoins: number | null;
  /**
   * How many joins this link has admitted, ever. Monotonic: a participant
   * leaving does not free a slot. `maxJoins` caps total uses of the link, the
   * same way a contact invite is single-use -- it is not a concurrent-seat
   * limit, so there is no separate "room capacity" concept here.
   */
  readonly joinsCount: number;
}

/**
 * Four hours.
 *
 * SHORT, AND DELIBERATELY SHORTER THAN `CONTACT_INVITE_POLICY` (72 hours in
 * `packages/account-trust/src/contact-invite.ts`). That invite reaches one
 * named person who consented to being invited; a conference link reaches
 * anyone who has it, forwarded or not, which is exactly the property a
 * fraudster needs. A link that outlives the meeting it was made for turns
 * into a standing entry point -- indistinguishable, from the fraud this
 * module exists to stop, from never having a contact gate at all.
 *
 * Four hours is long enough to cover a link shared same-day ahead of a
 * meeting plus a real overrun, short enough that a link forwarded outside its
 * intended audience is stale before it can be reused as one. A host running a
 * recurring room re-mints a link each time rather than relying on one that
 * never goes stale -- the daily friction is the point, not a defect.
 */
export const DEFAULT_ROOM_ACCESS_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Open a room's join link.
 *
 * `maxJoins` ABSENT (the property left out of the input) means unlimited;
 * `maxJoins: 0` means the link admits nobody at all. Do not collapse this
 * with `input.maxJoins || someDefault` guarded by truthiness -- `0 ||
 * unlimited` reads zero as falsy and silently grants the unlimited default,
 * which is precisely backwards for a control whose entire job is refusing
 * joins. `??` is safe here because it only substitutes on `null`/`undefined`,
 * never on `0`, so an explicit zero survives untouched.
 */
export function createRoomAccess(input: {
  roomId: string;
  hostAccountId: string;
  nowMs: number;
  /** Overrides `DEFAULT_ROOM_ACCESS_TTL_MS`. Rarely needed; prefer the default. */
  ttlMs?: number;
  /** Explicit host choice. Wins over `sharedOutsideContacts` either direction. */
  lobbyRequired?: boolean;
  /**
   * Whether this link is being handed to people outside the host's contacts.
   * This module has no contact list of its own to check that against -- the
   * caller (who does) passes the answer in. When true, and `lobbyRequired` is
   * not explicitly given, the lobby defaults ON, per section 3.2: "Default on
   * for rooms opened to people outside your contacts."
   */
  sharedOutsideContacts?: boolean;
  /** Absent = unlimited. See the module-level comment above for why this must not be `||`-defaulted. */
  maxJoins?: number;
}): RoomAccess {
  return {
    roomId: input.roomId,
    hostAccountId: input.hostAccountId,
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + (input.ttlMs ?? DEFAULT_ROOM_ACCESS_TTL_MS),
    revokedAtMs: null,
    lobbyRequired: input.lobbyRequired ?? input.sharedOutsideContacts ?? false,
    maxJoins: input.maxJoins ?? null,
    joinsCount: 0,
  };
}

/**
 * Withdraw a link without ending the room.
 *
 * WHY REVOCATION DOES NOT TOUCH THE ROOM. A room mid-meeting can have its
 * link leak -- forwarded into the wrong group chat, posted somewhere public --
 * without any fault of the people already on the call. Tearing down the room
 * to kill the link would punish everyone already inside for a leak that is
 * not their doing, and would hand a griefer a one-click way to end a meeting
 * they were never part of just by leaking its link themselves. So revocation
 * is scoped to the LINK: it stops admitting new joins (`evaluateJoin` below)
 * without evicting anyone already admitted. Ending the room, if that is ever
 * wanted, is a different, host-only action this module does not model.
 *
 * Idempotent, matching `revokeContactInvite`: a second revoke does not move
 * the timestamp, so `revokedAtMs` stays the moment revocation first happened
 * rather than the moment somebody last clicked the button.
 */
export function revokeRoomAccess(access: RoomAccess, nowMs: number): RoomAccess {
  if (access.revokedAtMs !== null) return access;
  return { ...access, revokedAtMs: nowMs };
}

export type JoinRefusalReason = 'expired' | 'revoked' | 'full' | 'room-unknown';

export type JoinEvaluation =
  | { readonly status: 'admitted'; readonly access: RoomAccess }
  | { readonly status: 'admit-pending' }
  | { readonly status: 'refused'; readonly reason: JoinRefusalReason };

/**
 * Decide what happens when somebody tries to use a room's link.
 *
 * `access` is `null` for "no such room" -- the caller looked up a `roomId`
 * and found nothing. That state is evaluated here rather than left for the
 * caller to special-case, so `room-unknown` goes through the exact same
 * refusal shape as `revoked` and reaches `publicJoinRefusal` the same way;
 * see that function for why the two must be indistinguishable outside this
 * module.
 *
 * Order matters and is deliberate: link-lifecycle checks (revoked, expired,
 * full) run before the host is ever singled out, so a host whose own link
 * expired or filled up is refused exactly like anyone else -- requirement 7
 * exempts the host from the LOBBY only, nothing else. The lobby check is last
 * and is the only place `joinerAccountId` matters.
 */
export function evaluateJoin(input: {
  access: RoomAccess | null;
  nowMs: number;
  /** `null` for an anonymous joiner, who can therefore never be the host. */
  joinerAccountId: string | null;
}): JoinEvaluation {
  const { access, nowMs, joinerAccountId } = input;

  if (access === null) {
    return { status: 'refused', reason: 'room-unknown' };
  }
  if (access.revokedAtMs !== null) {
    return { status: 'refused', reason: 'revoked' };
  }
  if (nowMs > access.expiresAtMs) {
    return { status: 'refused', reason: 'expired' };
  }
  if (access.maxJoins !== null && access.joinsCount >= access.maxJoins) {
    return { status: 'refused', reason: 'full' };
  }

  // The host bypasses their own lobby -- requirement 7. Nothing else is
  // bypassed: a host is still refused above by an expired, revoked or full
  // link, because none of those are the lobby.
  const isHost = joinerAccountId !== null && joinerAccountId === access.hostAccountId;
  if (access.lobbyRequired && !isHost) {
    return { status: 'admit-pending' };
  }

  return { status: 'admitted', access: { ...access, joinsCount: access.joinsCount + 1 } };
}

export type LobbyDecision = 'admit' | 'deny';

export type LobbyDecisionResult =
  | { readonly status: 'admitted'; readonly access: RoomAccess }
  | { readonly status: 'denied' }
  | { readonly status: 'refused'; readonly reason: 'expired' | 'revoked' | 'full' };

/**
 * The host's decision on someone waiting in the lobby.
 *
 * Link state is RE-CHECKED here, not just at the original `evaluateJoin`
 * call, because time passes while somebody waits: the link can expire, be
 * revoked, or fill up (from other admissions) between a person entering the
 * lobby and the host acting on them. Trusting the state captured at admission
 * time would let a host admit someone through a link that is no longer good,
 * or push the join count past `maxJoins`. A denial skips all of that --
 * turning someone away never needs the link to still be valid.
 */
export function decideLobbyAdmission(input: {
  access: RoomAccess;
  decision: LobbyDecision;
  nowMs: number;
}): LobbyDecisionResult {
  if (input.decision === 'deny') {
    return { status: 'denied' };
  }

  const { access, nowMs } = input;
  if (access.revokedAtMs !== null) {
    return { status: 'refused', reason: 'revoked' };
  }
  if (nowMs > access.expiresAtMs) {
    return { status: 'refused', reason: 'expired' };
  }
  if (access.maxJoins !== null && access.joinsCount >= access.maxJoins) {
    return { status: 'refused', reason: 'full' };
  }

  return { status: 'admitted', access: { ...access, joinsCount: access.joinsCount + 1 } };
}

export type PublicJoinRefusal = 'unavailable' | 'expired' | 'full';

/**
 * Flatten a refusal reason to what an untrusted joiner may be told.
 *
 * `room-unknown` and `revoked` collapse to the same `unavailable` answer.
 * Telling a caller "revoked" rather than "no such room" would confirm that a
 * room with this id was ever created -- an existence leak with the same shape
 * as `ContactSearchResult` in `packages/account-trust/src/contact-invite.ts`,
 * which answers "found but private" and "never existed" identically for the
 * same reason. Here the stakes are the directory-harvesting risk section 3.3
 * warns about: someone probing guessed or previously-seen room ids must not
 * be able to map which ones were ever real. `expired` and `full` stay
 * distinguishable -- both require the caller to already be holding a
 * currently-referenced link, so answering precisely does not tell them
 * anything about the room's existence they could not already infer from
 * holding a link to it, and a genuine joiner benefits from knowing which one
 * it is.
 */
export function publicJoinRefusal(reason: JoinRefusalReason): PublicJoinRefusal {
  switch (reason) {
    case 'room-unknown':
    case 'revoked':
      return 'unavailable';
    case 'expired':
      return 'expired';
    case 'full':
      return 'full';
  }
}
