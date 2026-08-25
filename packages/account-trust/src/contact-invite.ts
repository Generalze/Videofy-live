/**
 * Private contact invite links — the only route to a private account.
 *
 * WHY SINGLE USE IS THE WHOLE DESIGN. A contact link that works twice works a
 * thousand times the moment somebody forwards it, and then it is not an invite
 * any more, it is a public handle. Private mode would be defeated not by an
 * attack but by ordinary sharing. So redemption consumes the token, and the
 * second attempt is refused exactly like a stolen one.
 *
 * BUILT ON THE VERIFICATION CHALLENGE, NOT BESIDE IT. The requirements are
 * identical to an email verification token — high entropy, hashed at rest,
 * expiring, attempt-capped, single-use, constant-time comparison — and every
 * one of those is easy to get subtly wrong. `verification-token.ts` already
 * gets them right, and a second implementation is a second thing to keep right.
 *
 * The challenge's `target` carries the ISSUER's account id. That turns the
 * existing wrong-target check into a binding: a token minted by one person can
 * never be redeemed against another person's invite, even if the records were
 * somehow confused by the storage layer.
 */
import {
  createLinkToken,
  issueChallenge,
  verifyChallenge,
  type ChallengePolicy,
  type ChallengeRecord,
} from './verification-token.js';

/**
 * Longer-lived than a verification code, shorter than a standing invitation.
 *
 * A person sends this to someone who may not look at it today — a colleague on
 * leave, a contact in another timezone — so minutes would make it useless.
 * Seventy-two hours covers a weekend without leaving a working key to your
 * private account lying in a chat log for a month.
 *
 * The attempt cap is low because, unlike an OTP, nobody types this by hand: a
 * link is clicked or pasted whole. Repeated failures against one invite mean
 * guessing, not fumbling.
 */
export const CONTACT_INVITE_POLICY: ChallengePolicy = {
  ttlMs: 72 * 60 * 60 * 1000,
  maxAttempts: 3,
  resendCooldownMs: 0,
};

export interface ContactInvite {
  readonly inviteId: string;
  /** Whose invite this is. Redeeming it adds THIS person and nobody else. */
  readonly issuerAccountId: string;
  readonly challenge: ChallengeRecord;
  /** Set when withdrawn before use. Revocation never affects contacts already made. */
  readonly revokedAtMs: number | null;
}

export type ContactInviteRefusal =
  | 'revoked'
  | 'self'
  | 'expired'
  | 'consumed'
  | 'too-many-attempts'
  | 'mismatch'
  | 'wrong-invite';

export type ContactInviteRedemption =
  | {
      readonly ok: true;
      /** Persist this: it carries the consumed marker that enforces single use. */
      readonly invite: ContactInvite;
      /** The pair to connect. Mutual — an invite is consent from both sides. */
      readonly issuerAccountId: string;
      readonly redeemerAccountId: string;
    }
  | {
      readonly ok: false;
      readonly reason: ContactInviteRefusal;
      /** Returned on every path, because a failed attempt must still be counted. */
      readonly invite: ContactInvite;
    };

/**
 * Mint an invite.
 *
 * The plaintext token is returned for the link and never stored; the record
 * keeps only its hash, so a stolen database yields no working invites.
 */
export function issueContactInvite(input: {
  inviteId: string;
  issuerAccountId: string;
  nowMs: number;
  /** Injectable for tests. Real callers should let this default. */
  token?: string;
}): { invite: ContactInvite; token: string } {
  const token = input.token ?? createLinkToken();
  return {
    token,
    invite: {
      inviteId: input.inviteId,
      issuerAccountId: input.issuerAccountId,
      revokedAtMs: null,
      challenge: issueChallenge({
        channel: 'email',
        token,
        // The binding described in the module comment.
        target: input.issuerAccountId,
        nowMs: input.nowMs,
        policy: CONTACT_INVITE_POLICY,
      }),
    },
  };
}

/** Withdraw an unused invite. Contacts already made are untouched. */
export function revokeContactInvite(invite: ContactInvite, nowMs: number): ContactInvite {
  if (invite.revokedAtMs !== null) return invite;
  return { ...invite, revokedAtMs: nowMs };
}

/**
 * Redeem an invite, creating a mutual contact.
 *
 * NO PENDING REQUEST FOLLOWS. The issuer consented by minting the link and the
 * redeemer consented by using it, so there is nothing left for either to
 * approve. An invite that still required acceptance would be a worse version of
 * an ordinary contact request.
 */
export function redeemContactInvite(input: {
  invite: ContactInvite;
  token: string;
  redeemerAccountId: string;
  nowMs: number;
}): ContactInviteRedemption {
  /*
   * Revocation is checked BEFORE the token, and deliberately does not count an
   * attempt. A withdrawn invite is not a guess at a live one, and burning its
   * attempts would let anybody holding a revoked link exhaust the record.
   */
  if (input.invite.revokedAtMs !== null) {
    return { ok: false, reason: 'revoked', invite: input.invite };
  }

  /*
   * Also before the token: adding yourself is a mistake, not an attack, and it
   * must not consume the invite. Somebody who opens their own link while
   * signed in would otherwise destroy it and have to mint another.
   */
  if (input.redeemerAccountId === input.invite.issuerAccountId) {
    return { ok: false, reason: 'self', invite: input.invite };
  }

  const verdict = verifyChallenge({
    record: input.invite.challenge,
    token: input.token,
    target: input.invite.issuerAccountId,
    nowMs: input.nowMs,
    policy: CONTACT_INVITE_POLICY,
  });

  if (!verdict.ok) {
    const reason: ContactInviteRefusal =
      verdict.reason === 'wrong-target' ? 'wrong-invite' : verdict.reason;
    return { ok: false, reason, invite: { ...input.invite, challenge: verdict.record } };
  }

  return {
    ok: true,
    invite: { ...input.invite, challenge: verdict.record },
    issuerAccountId: input.invite.issuerAccountId,
    redeemerAccountId: input.redeemerAccountId,
  };
}

/**
 * Whether an invite could still be redeemed, for display.
 *
 * Presentation only. Never let this decide a redemption: between rendering a
 * page and a request arriving, an invite can expire or be spent, and the
 * decision has to be made at the moment of use.
 */
export function contactInviteUsable(invite: ContactInvite, nowMs: number): boolean {
  return (
    invite.revokedAtMs === null &&
    invite.challenge.consumedAtMs === null &&
    nowMs <= invite.challenge.expiresAtMs &&
    invite.challenge.attempts < CONTACT_INVITE_POLICY.maxAttempts
  );
}

/**
 * How an account may be found.
 *
 * `private` is not a weaker `discoverable`: it removes the account from every
 * lookup, and a search for it must be answered exactly as a search for an
 * address that was never registered. Saying "this person is private" would
 * confirm the existence that private mode exists to conceal.
 */
export type DiscoveryMode = 'discoverable' | 'private';

/**
 * PRIVATE BY DEFAULT. An owner decision, and the safe one either way.
 *
 * Discoverable-by-default is the conventional choice and quietly opts people
 * into being findable by anybody who can guess their work address. Private by
 * default costs some onboarding convenience -- nobody can be found until they
 * share a link -- and that cost is paid deliberately.
 *
 * It is also the value that must win when nothing is stored. A record written
 * before this field existed, a corrupted value, or a typo in a migration all
 * resolve HERE, and the failure that matters is only in one direction:
 * defaulting to discoverable would silently expose every account whose field
 * failed to read.
 */
export const DEFAULT_DISCOVERY_MODE: DiscoveryMode = 'private';

/**
 * Read a stored discovery mode.
 *
 * Only the exact string `discoverable` opts an account in. Everything else --
 * absent, misspelt, the wrong type, hand-edited -- is private, for the reason
 * above. Same shape as `readTrust`: anything unrecognised becomes the safe
 * value rather than being trusted as written.
 */
export function readDiscoveryMode(value: unknown): DiscoveryMode {
  return value === 'discoverable' ? 'discoverable' : DEFAULT_DISCOVERY_MODE;
}

export interface ContactSearchInput {
  readonly query: string;
  readonly matchedAccountId: string | null;
  /**
   * Deliberately `unknown`, and normalised inside.
   *
   * Typed as DiscoveryMode, a caller reading straight from a record could pass
   * `undefined` for an account that predates the field, and TypeScript would
   * not stop it at a storage boundary. Normalising here means no call site can
   * make an account discoverable by omission.
   */
  readonly matchedMode?: unknown;
}

/**
 * The result of an exact-address lookup.
 *
 * A single-valued success type and one indistinguishable failure. There is no
 * "found but private" branch to render differently, no count, and no list --
 * anything that returns more than one result is a directory, and a directory is
 * the harvesting surface this whole model exists to avoid.
 */
export type ContactSearchResult =
  | { readonly found: true; readonly accountId: string }
  | { readonly found: false };

export function searchContact(input: ContactSearchInput): ContactSearchResult {
  if (input.matchedAccountId === null) return { found: false };
  // Not `=== 'private'`: that would treat an absent or unrecognised mode as
  // discoverable, which is the one direction this must never fail in.
  if (readDiscoveryMode(input.matchedMode) !== 'discoverable') return { found: false };
  return { found: true, accountId: input.matchedAccountId };
}
