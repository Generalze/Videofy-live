/**
 * C7 account trust — the four things that must never collapse into one.
 *
 *   SIGNUP CREATES IDENTITY.
 *   VERIFICATION ESTABLISHES TRUST.
 *   ENTITLEMENTS GRANT PRODUCTS.
 *   ROLES GRANT AUTHORITY.
 *
 * The failure this file exists to prevent is a single boolean called `verified`.
 * One flag cannot distinguish "we emailed them and they clicked" from "a
 * qualified provider matched a document to a face", cannot express a person
 * whose email is confirmed while their identity check is still in review, and
 * cannot be revoked for one reason without discarding the others. It is also
 * the field somebody eventually sets from a request body.
 *
 * So trust is COMPONENTS, and the overall state is DERIVED from them. There is
 * no setter for the overall state anywhere, because there is no field to set.
 */

/** How far one verification channel has got. */
export type VerificationState =
  | 'unverified'
  | 'pending'
  | 'verified'
  | 'failed'
  | 'expired';

/**
 * Risk is about BEHAVIOUR; restriction is about a DECISION somebody made.
 *
 * Kept apart because they are cleared by different things: risk decays or is
 * satisfied by a step-up challenge, while a restriction is lifted by review.
 * Merged into one field, lifting a suspension would silently clear a risk
 * signal that had nothing to do with it.
 */
export type RiskState = 'normal' | 'step_up_required' | 'elevated';

export type RestrictionState =
  | 'none'
  | 'under_review'
  | 'restricted'
  | 'rejected'
  | 'suspended';

export interface AccountTrust {
  readonly email: VerificationState;
  readonly phone: VerificationState;
  readonly identity: VerificationState;
  readonly risk: RiskState;
  readonly restriction: RestrictionState;
}

export const INITIAL_TRUST: AccountTrust = {
  email: 'unverified',
  phone: 'unverified',
  identity: 'unverified',
  risk: 'normal',
  restriction: 'none',
};

/** The overall state, always derived, never stored as the source of truth. */
export type AccountTrustState =
  | 'registered'
  | 'verification_required'
  | 'verification_pending'
  | 'under_review'
  | 'verified'
  | 'restricted'
  | 'rejected'
  | 'suspended';

/**
 * Resolve the overall state.
 *
 * ORDER IS THE POLICY. A suspended account whose email happens to be verified
 * is suspended, not verified — so the negative outcomes are tested first and
 * `verified` is reachable only when nothing else applies. Written the other way
 * round, the first matching happy case wins and a suspension becomes cosmetic.
 */
export function resolveTrustState(trust: AccountTrust): AccountTrustState {
  if (trust.restriction === 'suspended') return 'suspended';
  if (trust.restriction === 'rejected') return 'rejected';
  if (trust.restriction === 'restricted') return 'restricted';
  if (trust.restriction === 'under_review') return 'under_review';

  const components = [trust.email, trust.phone, trust.identity] as const;

  if (components.every((state) => state === 'verified')) return 'verified';
  if (components.some((state) => state === 'pending')) return 'verification_pending';
  // Untouched since signup. Distinguished from `verification_required` because
  // the two deserve different words to a person: one is "start", the other is
  // "try again".
  if (components.every((state) => state === 'unverified')) return 'registered';
  return 'verification_required';
}

/**
 * What a person may do, derived from trust alone.
 *
 * This is NOT authorization on its own — a product still needs an entitlement,
 * and an operation still needs a capability. It is the floor beneath both.
 */
export interface TrustCapabilities {
  /** Reach the registered shell at all. */
  readonly canAccessApp: boolean;
  /** Create or host something durable: a call, a conference, a programme. */
  readonly canHostSessions: boolean;
  /** Create or own an organization. */
  readonly canCreateOrganization: boolean;
  /** Hold a durable privileged role inside a session. */
  readonly canHoldPrivilegedRole: boolean;
  /** Activate a commercial product. */
  readonly canActivateProducts: boolean;
}

const NOTHING: TrustCapabilities = {
  canAccessApp: false,
  canHostSessions: false,
  canCreateOrganization: false,
  canHoldPrivilegedRole: false,
  canActivateProducts: false,
};

/**
 * Deny by default, then GRADUATE by which channel actually proved something.
 *
 * WHY THIS IS NOT ONE GATE. It used to grant everything from the derived
 * `verified` state, which requires email AND phone AND identity together. That
 * read as strict and was in practice a total lockout: identity verification is
 * synthetic and refused in production, and phone delivery waits on sender-id
 * registration, so `verified` was unreachable and therefore NOBODY could host
 * a call. A gate nobody can pass does not protect the product, it replaces it.
 *
 * The components exist precisely so they can be spent separately, so they are:
 *
 *   email verified   -> use the product. Join and host calls, create an
 *                       organization, hold a role inside one.
 *   fully verified   -> activate a commercial product.
 *
 * WHY EMAIL IS ENOUGH FOR AN ORGANIZATION ROLE. It looks generous and is not,
 * because it is not the only gate in front of anything that matters. A newly
 * created organization sits in `draft` until KYB moves it, and an organization
 * that is not `verified` grants its members nothing beyond viewing and working
 * toward verification. The role table then bounds what each member may do. So
 * email unlocks participation, while the organization's own state still decides
 * whether that participation can affect anybody.
 *
 * WHY COMMERCIAL ACTIVATION KEEPS THE HIGH BAR. It is the one capability tied
 * to money rather than to use, nothing reaches it today, and leaving it at the
 * full bar costs nothing now while keeping the right shape for when real
 * identity verification lands. Deliberately unreachable, not overlooked.
 *
 * A suspended account keeps `canAccessApp` so it can still reach verification
 * status, security and support — a person locked out with no way to see why or
 * appeal is a support ticket that becomes a complaint.
 */
export function trustCapabilities(trust: AccountTrust): TrustCapabilities {
  const state = resolveTrustState(trust);

  /*
   * ORDER IS THE POLICY, exactly as in resolveTrustState. Every negative
   * outcome is answered before any component is consulted, so a verified email
   * on a suspended account can never buy back a capability the suspension took
   * away.
   */
  if (
    state === 'suspended' ||
    state === 'rejected' ||
    state === 'restricted' ||
    state === 'under_review'
  ) {
    return { ...NOTHING, canAccessApp: true };
  }

  /*
   * Risk is about behaviour, and it outranks every component. The account may
   * be entirely real and something about this session is not; reading stays
   * available and anything that creates durable authority waits for the
   * step-up challenge.
   */
  if (trust.risk !== 'normal') {
    return { ...NOTHING, canAccessApp: true };
  }

  const emailVerified = trust.email === 'verified';
  // Every channel, not merely a truthy summary: `state` is the honest label
  // shown to a person and is left meaning exactly what it always meant.
  const fullyVerified = state === 'verified';

  return {
    canAccessApp: true,
    canHostSessions: emailVerified,
    canCreateOrganization: emailVerified,
    canHoldPrivilegedRole: emailVerified,
    canActivateProducts: fullyVerified,
  };
}

export interface TrustTransition {
  readonly channel: 'email' | 'phone' | 'identity';
  readonly to: VerificationState;
}

/**
 * Apply one verification transition, refusing the ones that make no sense.
 *
 * A `verified` channel cannot silently fall back to `pending` or `unverified`:
 * un-verifying is a deliberate act (re-verification, provider revocation,
 * a material change) and must go through `requireReverification`, which says
 * so and can be audited as its own event.
 */
export function applyTransition(
  trust: AccountTrust,
  transition: TrustTransition,
): { ok: true; trust: AccountTrust } | { ok: false; reason: string } {
  const current = trust[transition.channel];

  if (current === 'verified' && transition.to !== 'verified') {
    return {
      ok: false,
      reason: `${transition.channel} is already verified; use requireReverification to undo it deliberately`,
    };
  }
  if (current === transition.to) return { ok: true, trust };

  return { ok: true, trust: { ...trust, [transition.channel]: transition.to } };
}

/** Deliberately return a verified channel to unverified, with a reason. */
export function requireReverification(
  trust: AccountTrust,
  channel: TrustTransition['channel'],
): AccountTrust {
  return { ...trust, [channel]: 'unverified' };
}

/**
 * Read trust from stored data.
 *
 * Anything unrecognised becomes the SAFE value rather than being trusted as
 * written. A corrupted or hand-edited record must not be able to promote an
 * account by containing an unexpected string.
 */
export function readTrust(value: unknown): AccountTrust {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const verification = (input: unknown): VerificationState =>
    input === 'pending' || input === 'verified' || input === 'failed' || input === 'expired'
      ? input
      : 'unverified';

  const risk: RiskState =
    source['risk'] === 'step_up_required' || source['risk'] === 'elevated'
      ? source['risk']
      : 'normal';

  const restriction: RestrictionState =
    source['restriction'] === 'under_review' ||
    source['restriction'] === 'restricted' ||
    source['restriction'] === 'rejected' ||
    source['restriction'] === 'suspended'
      ? source['restriction']
      : 'none';

  return {
    email: verification(source['email']),
    phone: verification(source['phone']),
    identity: verification(source['identity']),
    risk,
    restriction,
  };
}
