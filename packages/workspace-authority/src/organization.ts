/**
 * Organizations, packages and SEATS.
 *
 * The seat model is where a subtle unfairness usually creeps in. Naive
 * accounting counts only active members, so an administrator can issue a
 * hundred invitations against ten seats and the overage only appears when
 * people start accepting — at which point somebody is turned away by a system
 * that already told their colleague they were welcome.
 *
 * So a PENDING INVITATION RESERVES A SEAT, and every way an invitation can die
 * releases it. That is the whole model, and the rest of this file is making it
 * impossible to get wrong.
 */
import type { OrganizationRole, OrganizationState } from './workspace.js';

export type PackageId = 'corporate' | 'enterprise';

export interface Organization {
  readonly organizationId: string;
  /** As registered. Never shown as verified merely because it was typed. */
  readonly legalName: string;
  /** What people see. Also not evidence of anything. */
  readonly displayName: string;
  readonly state: OrganizationState;
  readonly packageId: PackageId;
  /**
   * Seats the organization has contracted.
   *
   * Deliberately a NUMBER for both packages. "Enterprise means unlimited" is a
   * commercial promise nobody here has made, and encoding it as `Infinity`
   * makes every capacity check meaningless the moment somebody picks that plan.
   */
  readonly contractedSeats: number;
  readonly createdByAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Domains proven to belong to this organization.
   *
   * A CLAIM is not a proof. Anybody can type "microsoft.com"; only DNS or a
   * provider outcome can put it here, which is what keeps a display name from
   * becoming an impersonation.
   */
  readonly verifiedDomains: readonly string[];
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

export interface Invitation {
  readonly invitationId: string;
  readonly organizationId: string;
  /** Normalised lowercase. The address the invitation is FOR. */
  readonly email: string;
  readonly role: OrganizationRole;
  readonly invitedByAccountId: string;
  readonly status: InvitationStatus;
  /** SHA-256 of the invitation token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly acceptedByAccountId: string | null;
}

/**
 * Whether an invitation is currently holding a seat.
 *
 * ONE definition, used by the counter and the enforcement check alike. Two
 * definitions of "does this reserve a seat" is how an organization ends up
 * over capacity while both places believe they agree.
 */
export function reservesSeat(invitation: Invitation, nowMs: number): boolean {
  return invitation.status === 'pending' && invitation.expiresAtMs > nowMs;
}

export interface SeatAccounting {
  readonly contracted: number;
  readonly activeMembers: number;
  readonly reservedByInvitations: number;
  readonly allocated: number;
  readonly available: number;
  /** True when a package downgrade left more people than seats. */
  readonly overCapacity: boolean;
}

export function accountSeats(input: {
  contractedSeats: number;
  activeMemberCount: number;
  invitations: readonly Invitation[];
  nowMs: number;
}): SeatAccounting {
  const reserved = input.invitations.filter((invitation) =>
    reservesSeat(invitation, input.nowMs),
  ).length;
  const allocated = input.activeMemberCount + reserved;
  return {
    contracted: input.contractedSeats,
    activeMembers: input.activeMemberCount,
    reservedByInvitations: reserved,
    allocated,
    // Never negative: an over-capacity organization has zero available, not a
    // negative number that some later arithmetic quietly treats as room.
    available: Math.max(0, input.contractedSeats - allocated),
    overCapacity: allocated > input.contractedSeats,
  };
}

export type SeatRefusal = 'no-seats-available' | 'over-capacity';

/**
 * May one more seat be allocated?
 *
 * The single authority. Every caller asks this rather than comparing numbers
 * itself, because the comparison is where the off-by-one lives.
 */
export function maySeatOneMore(seats: SeatAccounting): { ok: true } | { ok: false; reason: SeatRefusal } {
  if (seats.overCapacity) return { ok: false, reason: 'over-capacity' };
  if (seats.available < 1) return { ok: false, reason: 'no-seats-available' };
  return { ok: true };
}

/**
 * A package downgrade never removes people.
 *
 * Choosing who to eject is a decision with consequences for real employees, and
 * a billing change is not consent to make it. The organization enters
 * OVER CAPACITY: everyone keeps working, no new seat can be allocated, and the
 * dashboard says what to do about it.
 */
export function applyContractedSeatChange(
  organization: Organization,
  nextContractedSeats: number,
): Organization {
  return { ...organization, contractedSeats: Math.max(0, Math.floor(nextContractedSeats)) };
}

/**
 * Is this domain proven to belong to the organization?
 *
 * Used for presentation decisions. A verified domain is the only thing that
 * may ever make an organization LOOK official.
 */
export function hasVerifiedDomain(organization: Organization, domain: string): boolean {
  const normalised = domain.trim().toLowerCase();
  return organization.verifiedDomains.some((entry) => entry.toLowerCase() === normalised);
}

/**
 * How an organization may be presented publicly.
 *
 * The impersonation defence: somebody registering "Microsoft" gets their typed
 * name shown as UNVERIFIED, and nothing about the presentation implies
 * otherwise until KYB or domain proof says so.
 */
export function presentationFor(organization: Organization): {
  readonly name: string;
  readonly verified: boolean;
  readonly showLegalName: boolean;
} {
  const verified = organization.state === 'verified';
  return {
    name: organization.displayName,
    verified,
    // The legal name is only worth showing once something checked it. Shown
    // beforehand it reads as corroboration, which is exactly what it is not.
    showLegalName: verified,
  };
}

/**
 * Which organization state may follow which.
 *
 * WHY A TABLE AND NOT SCATTERED CHECKS. `setState` previously accepted any
 * state from any state, so a closed organization could be moved back to
 * verified by one mistaken call and nothing would notice -- every audit
 * statement about that organization would silently become conditional.
 * `IdentityCaseStatus` already had exactly this table; organizations did not,
 * and there was no reason for the asymmetry beyond nobody having written it.
 *
 * Two entries here carry real requirements rather than mere hygiene:
 *
 *  - `verified -> under_review` is what makes verification REVOCABLE. An
 *    expiring check, a provider revocation or a material change in the business
 *    must be able to return a verified organization to review WITHOUT
 *    destroying its identity or history. A model where `verified` is terminal
 *    would force deleting and recreating the organization to express it.
 *  - `rejected -> under_review` is the appeal path. A rejection that cannot be
 *    reconsidered makes every provider false positive permanent, and external
 *    providers produce false positives as a matter of routine.
 */
const ALLOWED_ORGANIZATION_NEXT: Readonly<Record<OrganizationState, readonly OrganizationState[]>> =
  {
    // A terminal outcome straight from `draft` is normal, for the same reason
    // IdentityCaseStatus allows it from `created`: plenty of KYB providers emit
    // only the final decision and never the intermediate steps, and requiring
    // `pending` first would silently reject every one of their callbacks.
    draft: [
      'verification_required',
      'pending',
      'under_review',
      'verified',
      'rejected',
      'restricted',
      'closure_pending',
      'archived',
    ],
    verification_required: [
      'pending',
      'under_review',
      'verified',
      'rejected',
      'restricted',
      'closure_pending',
      'archived',
    ],
    pending: ['under_review', 'verified', 'rejected', 'restricted', 'closure_pending', 'archived'],
    under_review: [
      'verified',
      'rejected',
      'restricted',
      'suspended',
      'closure_pending',
      'archived',
    ],
    // Revocable: see above.
    verified: ['under_review', 'restricted', 'suspended', 'closure_pending', 'archived'],
    restricted: ['verified', 'under_review', 'suspended', 'closure_pending', 'archived'],
    // Appealable: see above.
    rejected: ['under_review', 'closure_pending', 'archived'],
    suspended: ['restricted', 'verified', 'under_review', 'closure_pending', 'archived', 'closed'],
    // Reversible on purpose. Closure requested is not closure performed, and
    // the window in which somebody can say "no, wait" is the point of the state.
    closure_pending: ['closed', 'archived', 'verified', 'restricted', 'under_review'],
    // Inert but restorable. Restoration lands in review rather than verified:
    // whatever was true when it was archived may no longer be.
    archived: ['under_review', 'restricted', 'closure_pending', 'closed'],
    // Terminal, deliberately and permanently.
    closed: [],
  };

export function isLegalOrganizationTransition(
  from: OrganizationState,
  to: OrganizationState,
): boolean {
  // A no-op transition is always legal; refusing it would make every idempotent
  // write a caller has to special-case.
  if (from === to) return true;
  return (ALLOWED_ORGANIZATION_NEXT[from] ?? []).includes(to);
}

/**
 * States in which an organization is finished, for good or for now.
 *
 * Used to decide capability, so that closure actually stops work rather than
 * merely relabelling the dashboard.
 */
export const INACTIVE_ORGANIZATION_STATES: ReadonlySet<OrganizationState> =
  new Set<OrganizationState>(['suspended', 'rejected', 'closure_pending', 'archived', 'closed']);

/** A closed or archived organization cannot be looked at, let alone used. */
export const TERMINAL_ORGANIZATION_STATES: ReadonlySet<OrganizationState> =
  new Set<OrganizationState>(['closed']);
