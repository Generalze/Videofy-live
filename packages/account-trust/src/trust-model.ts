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
 * Deny by default, and grant only from `verified`.
 *
 * A suspended account keeps `canAccessApp` so it can still reach verification
 * status, security and support — a person locked out with no way to see why or
 * appeal is a support ticket that becomes a complaint.
 */
export function trustCapabilities(trust: AccountTrust): TrustCapabilities {
  const state = resolveTrustState(trust);

  if (state === 'verified' && trust.risk === 'normal') {
    return {
      canAccessApp: true,
      canHostSessions: true,
      canCreateOrganization: true,
      canHoldPrivilegedRole: true,
      canActivateProducts: true,
    };
  }

  // Verified but flagged: the account is real, and something about the current
  // session or recent behaviour is not. Reading stays available; anything that
  // creates durable authority waits for the challenge.
  if (state === 'verified') {
    return { ...NOTHING, canAccessApp: true };
  }

  if (state === 'rejected' || state === 'suspended') {
    return { ...NOTHING, canAccessApp: true };
  }

  return { ...NOTHING, canAccessApp: true };
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
