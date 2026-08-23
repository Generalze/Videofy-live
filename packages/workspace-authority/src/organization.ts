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
