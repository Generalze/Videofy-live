/** @author masterzee001 */
/**
 * Who a federated sign-in belongs to, and whether it may claim an account
 * that already exists.
 *
 * WHY THIS IS ONE PURE FUNCTION WITH ITS OWN FILE. Everything else about
 * KingsChat and Google is plumbing -- an authorization code, a token
 * exchange, a JSON profile. THIS is the security decision, and it is the one
 * that loses somebody their account if it is wrong. Keeping it out of the
 * route handlers means it can be reasoned about and falsified without a
 * network, a vendor, or a running service.
 *
 * THE RULE, decided by the founder on 2026-10-03:
 *
 *   An existing account is claimed by a provider ONLY when that provider has
 *   told us the email address is verified. An unverified address is refused,
 *   and the person is asked to sign in the way they already can and link the
 *   provider from their settings.
 *
 * WHY NOT "LINK ON MATCHING EMAIL", which is friendlier and common. An email
 * address in a provider's profile is a claim by that provider, not proof.
 * A provider that lets somebody set an address without proving it -- or one
 * that is itself compromised -- hands over every C7 account whose address
 * was guessed. The cost of the safe rule is one extra step for a person who
 * has genuinely forgotten which button they used last time; the cost of the
 * friendly rule is somebody else's account.
 *
 * WHY THE SAME RULE FOR BOTH PROVIDERS. Google states `email_verified` and
 * is usually true; KingsChat's profile has not been confirmed to carry an
 * equivalent. Writing the rule per provider would mean the weaker one sets
 * the standard the moment somebody adds a third. The caller reports what the
 * provider actually said, and absent means NO.
 */
import type { AccountId } from '@videofy-live/participant-contracts';

/** Providers C7 accepts. A caller may not invent one. */
export type IdentityProvider = 'google' | 'kingschat';

/**
 * What a provider told us about the person, after the token was verified.
 *
 * `subject` is the provider's own permanent id for them -- Google's `sub`,
 * KingsChat's user id. It is the join key, NEVER the email: an address can
 * be changed, released and re-registered to somebody else, and an account
 * that follows the address follows the stranger.
 */
export interface ProviderIdentity {
  readonly provider: IdentityProvider;
  readonly subject: string;
  /** Normalised the same way the account store normalises: lower, trimmed. */
  readonly email: string | null;
  /**
   * Whether the PROVIDER says it verified that address.
   *
   * Absent or false both mean no. This is the whole hinge of the rule above,
   * so it is required rather than optional: a caller that does not know must
   * say `false` on purpose rather than omit a field and get a default.
   */
  readonly emailVerified: boolean;
  /** For seeding a display name. Never used to identify anybody. */
  readonly displayName: string | null;
}

/** What the account layer already knows about this address and subject. */
export interface ExistingAccounts {
  /** An account already linked to this exact provider subject, if any. */
  readonly linkedToSubject: AccountId | null;
  /** An account holding this email address, if any. */
  readonly holdingEmail: AccountId | null;
}

export type FederatedOutcome =
  /** Sign them in. The subject is already linked to this account. */
  | { readonly kind: 'sign-in'; readonly accountId: AccountId }
  /** Attach this subject to the existing account, then sign them in. */
  | { readonly kind: 'link-and-sign-in'; readonly accountId: AccountId }
  /** Nobody holds this identity or address: a new account may be created. */
  | { readonly kind: 'create' }
  /**
   * Refused. `message` is for the person; it never says whether the address
   * is registered, because that would make this endpoint an oracle for which
   * addresses have C7 accounts.
   */
  | { readonly kind: 'refuse'; readonly reason: RefusalReason; readonly message: string };

export type RefusalReason =
  /** The provider gave us no address, so nothing can be matched or created. */
  | 'no-email'
  /** The address is spoken for and the provider did not verify it. */
  | 'unverified-email-conflict';

/**
 * A single sentence for every refusal that involves an existing account.
 *
 * DELIBERATELY THE SAME WORDS whatever the cause. "That address already has
 * an account" tells an unauthenticated caller which addresses are
 * registered, one guess at a time, which is the thing a sign-in surface must
 * never be. It names the way forward instead.
 */
const CONFLICT_MESSAGE =
  'We could not sign you in that way. Sign in with your email and password, ' +
  'then connect this account from your settings.';

export function resolveFederatedSignIn(
  identity: ProviderIdentity,
  existing: ExistingAccounts,
): FederatedOutcome {
  /*
   * THE SUBJECT WINS, ALWAYS, AND IS CHECKED FIRST.
   *
   * Somebody who linked this provider last year and has since changed their
   * email at the provider must still land in their own account. Matching on
   * the address first would create a second one, or worse, hand them
   * somebody else's.
   */
  if (existing.linkedToSubject !== null) {
    return { kind: 'sign-in', accountId: existing.linkedToSubject };
  }

  /*
   * NO ADDRESS, NO ACCOUNT. Every account in this system is keyed by a unique
   * email, so an identity without one cannot be created or matched. Refused
   * plainly rather than invented: a synthesised address like
   * `kingschat-12345@c7.invalid` would be an address nobody can receive mail
   * at, attached to an account that can never recover a password.
   */
  if (identity.email === null || identity.email.trim() === '') {
    return {
      kind: 'refuse',
      reason: 'no-email',
      message:
        'That account did not share an email address with us, so we cannot create ' +
        'your C7 account from it. Sign up with your email address instead.',
    };
  }

  if (existing.holdingEmail === null) return { kind: 'create' };

  /*
   * THE DECISION. Somebody else's account -- or their own -- already holds
   * this address, and the only thing that may attach a provider to it is the
   * provider having verified the address.
   */
  if (!identity.emailVerified) {
    return { kind: 'refuse', reason: 'unverified-email-conflict', message: CONFLICT_MESSAGE };
  }
  return { kind: 'link-and-sign-in', accountId: existing.holdingEmail };
}
