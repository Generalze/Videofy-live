/** @author masterzee001 */
/**
 * Organizations, memberships, invitations and seats.
 *
 * THE RACE THIS FILE EXISTS FOR. One seat left, two administrators invite
 * somebody at the same moment. Both handlers read "1 available", both decide
 * yes, and the organization is now over its contracted capacity — with two
 * people who have each been told they are welcome.
 *
 * Node being single-threaded does NOT prevent this. The gap is the `await`:
 * between reading the seat count and persisting the invitation, the event loop
 * runs the other request. So every seat-allocating operation runs inside a
 * per-organization critical section, serialised through a promise chain. It is
 * a mutex, it is small, and it is the only reason the count can be trusted.
 *
 * This does not require PostgreSQL. It requires the check and the write to be
 * indivisible, which a promise chain achieves in this process. A multi-process
 * deployment would need the database to hold that guarantee instead, and that
 * is recorded as the migration seam rather than pretended away.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  accountSeats,
  applyContractedSeatChange,
  isLegalOrganizationTransition,
  maySeatOneMore,
  reservesSeat,
  type Invitation,
  type Organization,
  type OrganizationMembership,
  type OrganizationRole,
  type PackageId,
  type SeatAccounting,
} from '@videofy-live/workspace-authority';

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type OrganizationFailure =
  | 'unknown-organization'
  | 'no-seats-available'
  | 'over-capacity'
  | 'already-a-member'
  | 'already-invited'
  | 'unknown-invitation'
  | 'invitation-not-pending'
  | 'invitation-expired'
  | 'wrong-recipient'
  | 'last-owner'
  | 'unknown-member';

import {
  createEphemeralOrganizationRecords,
  type OrganizationRecordPort,
} from './db/organization-records-postgres.js';

export class OrganizationStore {
  private readonly organizations = new Map<string, Organization>();
  private readonly memberships = new Map<string, Map<string, OrganizationMembership>>();
  private readonly invitations = new Map<string, Invitation[]>();

  /**
   * One promise chain per organization.
   *
   * Serialises seat-allocating work so a check and its write cannot be
   * interleaved with another request's. Keyed per organization so two different
   * companies never wait on each other.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Where this survives a restart.
   *
   * Defaults to ephemeral so every existing test constructs a store exactly as
   * before. That default is also what production must never run: an
   * organization that vanishes on deploy was the highest-severity item in this
   * repository, and the composition root chooses the real port explicitly.
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly records: OrganizationRecordPort = createEphemeralOrganizationRecords(),
  ) {}

  /**
   * Fill the in-memory index from the store, once, at boot.
   *
   * Memberships and invitations are grouped back under their organization as
   * they load. The database holds them flat -- one row per membership -- and
   * this is the only place that shape difference exists, which is where it
   * belongs.
   */
  async hydrate(): Promise<{ organizations: number; memberships: number; invitations: number }> {
    const loaded = await this.records.load();
    for (const organization of loaded.organizations) {
      this.organizations.set(organization.organizationId, organization);
      if (!this.memberships.has(organization.organizationId)) {
        this.memberships.set(organization.organizationId, new Map());
      }
      if (!this.invitations.has(organization.organizationId)) {
        this.invitations.set(organization.organizationId, []);
      }
    }
    for (const membership of loaded.memberships) {
      const members = this.memberships.get(membership.organizationId) ?? new Map();
      members.set(membership.accountId, membership);
      this.memberships.set(membership.organizationId, members);
    }
    for (const invitation of loaded.invitations) {
      this.invitations.set(invitation.organizationId, [
        ...(this.invitations.get(invitation.organizationId) ?? []),
        invitation,
      ]);
    }
    return {
      organizations: loaded.organizations.length,
      memberships: loaded.memberships.length,
      invitations: loaded.invitations.length,
    };
  }

  /*
   * The three write-through helpers.
   *
   * Every mutation goes through one of these rather than touching the Map and
   * the port separately at fifteen call sites. One place to get wrong is worth
   * more than fifteen places to remember.
   */
  private async putOrganization(organization: Organization): Promise<Organization> {
    this.organizations.set(organization.organizationId, organization);
    await this.records.upsertOrganization(organization);
    return organization;
  }

  private async putMembership(membership: OrganizationMembership): Promise<void> {
    const members = this.memberships.get(membership.organizationId) ?? new Map();
    members.set(membership.accountId, membership);
    this.memberships.set(membership.organizationId, members);
    await this.records.upsertMembership(membership);
  }

  private async putInvitation(invitation: Invitation): Promise<void> {
    const existing = this.invitationsOf(invitation.organizationId);
    const known = existing.some((entry) => entry.invitationId === invitation.invitationId);
    this.invitations.set(
      invitation.organizationId,
      known
        ? existing.map((entry) =>
            entry.invitationId === invitation.invitationId ? invitation : entry,
          )
        : [...existing, invitation],
    );
    await this.records.upsertInvitation(invitation);
  }

  private withLock<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(organizationId) ?? Promise.resolve();
    // The chain must not break on a rejection, or one failed operation would
    // wedge every later one for that organization.
    const next = previous.then(work, work);
    this.locks.set(
      organizationId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async create(input: {
    legalName: string;
    displayName: string;
    packageId: PackageId;
    contractedSeats: number;
    createdByAccountId: string;
  }): Promise<Organization> {
    const timestamp = new Date(this.now()).toISOString();
    const organizationId = `org_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const organization: Organization = {
      organizationId,
      legalName: input.legalName.trim(),
      displayName: input.displayName.trim(),
      // Created as DRAFT. A customer-typed name is not a verified company, and
      // KYB is what moves this forward.
      state: 'verification_required',
      packageId: input.packageId,
      contractedSeats: Math.max(1, Math.floor(input.contractedSeats)),
      createdByAccountId: input.createdByAccountId,
      createdAt: timestamp,
      updatedAt: timestamp,
      verifiedDomains: [],
    };
    this.memberships.set(organizationId, new Map());
    this.invitations.set(organizationId, []);
    // The organization row must exist before the membership row that references
    // it, or the foreign key refuses the write.
    await this.putOrganization(organization);

    // The creator is the first Owner, seated immediately.
    await this.putMembership({
      organizationId,
      accountId: input.createdByAccountId,
      role: 'organization-owner',
      active: true,
      joinedAt: timestamp,
    });
    return organization;
  }

  get(organizationId: string): Organization | null {
    return this.organizations.get(organizationId) ?? null;
  }

  /**
   * The membership the SERVER holds for this account.
   *
   * `null` means not a member, whatever an id in a URL claimed.
   */
  membershipOf(organizationId: string, accountId: string): OrganizationMembership | null {
    return this.memberships.get(organizationId)?.get(accountId) ?? null;
  }

  membersOf(organizationId: string): readonly OrganizationMembership[] {
    return [...(this.memberships.get(organizationId)?.values() ?? [])];
  }

  invitationsOf(organizationId: string): readonly Invitation[] {
    return [...(this.invitations.get(organizationId) ?? [])];
  }

  /**
   * The organizations this account actually belongs to.
   *
   * Built by walking MEMBERSHIPS, never by trusting a list of ids the caller
   * supplied. This is the only way a workspace switcher learns what it may
   * offer, which is what keeps switching from being a way to gain access.
   */
  organizationsFor(accountId: string): readonly {
    organizationId: string;
    displayName: string;
    role: OrganizationRole;
    state: Organization['state'];
  }[] {
    const found: {
      organizationId: string;
      displayName: string;
      role: OrganizationRole;
      state: Organization['state'];
    }[] = [];
    for (const [organizationId, members] of this.memberships) {
      const membership = members.get(accountId);
      if (!membership?.active) continue;
      const organization = this.organizations.get(organizationId);
      if (!organization) continue;
      found.push({
        organizationId,
        displayName: organization.displayName,
        role: membership.role,
        state: organization.state,
      });
    }
    return found;
  }

  seats(organizationId: string): SeatAccounting | null {
    const organization = this.organizations.get(organizationId);
    if (!organization) return null;
    const active = this.membersOf(organizationId).filter((member) => member.active).length;
    return accountSeats({
      contractedSeats: organization.contractedSeats,
      activeMemberCount: active,
      invitations: this.invitationsOf(organizationId),
      nowMs: this.now(),
    });
  }

  /**
   * Issue an invitation, reserving a seat.
   *
   * The whole body runs inside the organization's critical section: the seat
   * check and the write that consumes the seat are indivisible.
   */
  invite(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    invitedByAccountId: string;
  }): Promise<
    | { ok: true; invitation: Invitation; token: string }
    | { ok: false; reason: OrganizationFailure }
  > {
    return this.withLock(input.organizationId, async () => {
      const organization = this.organizations.get(input.organizationId);
      if (!organization) return { ok: false as const, reason: 'unknown-organization' as const };

      const email = normaliseEmail(input.email);
      const nowMs = this.now();

      const alreadyInvited = this.invitationsOf(input.organizationId).some(
        (invitation) => invitation.email === email && reservesSeat(invitation, nowMs),
      );
      if (alreadyInvited) return { ok: false as const, reason: 'already-invited' as const };

      const seats = this.seats(input.organizationId);
      if (!seats) return { ok: false as const, reason: 'unknown-organization' as const };
      const allowed = maySeatOneMore(seats);
      if (!allowed.ok) return { ok: false as const, reason: allowed.reason };

      const token = randomBytes(32).toString('base64url');
      const invitation: Invitation = {
        invitationId: `inv_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        organizationId: input.organizationId,
        email,
        role: input.role,
        invitedByAccountId: input.invitedByAccountId,
        status: 'pending',
        tokenHash: hashToken(token),
        createdAtMs: nowMs,
        expiresAtMs: nowMs + INVITATION_TTL_MS,
        acceptedByAccountId: null,
      };
      /*
       * The DATABASE takes the seat, not this process.
       *
       * The in-memory check above has already refused the obvious cases and is
       * correct while one instance is running. It cannot be correct across two:
       * both would count the same world, both would see a seat free, and both
       * would allocate it. The reservation below locks the organization row, so
       * the second transaction counts a world that includes the first one's
       * write.
       *
       * The invitation is written INSIDE that transaction, which is what makes
       * the count and the write one decision rather than two.
       */
      const reserved = await this.records.reserveSeatForInvitation(invitation, nowMs);
      if (!reserved.ok) {
        // The database disagreed with the in-memory count. That is either two
        // instances running, or drift -- and either way the durable answer wins.
        return {
          ok: false as const,
          reason:
            reserved.reason === 'over-capacity'
              ? ('over-capacity' as const)
              : ('no-seats-available' as const),
        };
      }
      // Only now does the in-memory index learn about it, so a refused
      // reservation cannot leave a phantom invitation holding a seat locally.
      this.invitations.set(input.organizationId, [
        ...this.invitationsOf(input.organizationId),
        invitation,
      ]);
      return { ok: true as const, invitation, token };
    });
  }

  private replaceInvitation(_organizationId: string, next: Invitation): Promise<void> {
    return this.putInvitation(next);
  }

  /**
   * Accept an invitation.
   *
   * RECIPIENT BINDING: the accepting account's verified email must match the
   * address the invitation was issued to. Forwarding an invite must not hand
   * somebody else a seat in a company that never chose them.
   */
  accept(input: {
    organizationId: string;
    invitationId: string;
    token: string;
    accountId: string;
    accountEmail: string;
  }): Promise<{ ok: true; membership: OrganizationMembership } | { ok: false; reason: OrganizationFailure }> {
    return this.withLock(input.organizationId, async () => {
      const invitation = this.invitationsOf(input.organizationId).find(
        (candidate) => candidate.invitationId === input.invitationId,
      );
      if (!invitation) return { ok: false as const, reason: 'unknown-invitation' as const };
      if (invitation.status !== 'pending') {
        return { ok: false as const, reason: 'invitation-not-pending' as const };
      }
      const nowMs = this.now();
      if (invitation.expiresAtMs <= nowMs) {
        await this.replaceInvitation(input.organizationId, { ...invitation, status: 'expired' });
        return { ok: false as const, reason: 'invitation-expired' as const };
      }
      if (hashToken(input.token) !== invitation.tokenHash) {
        return { ok: false as const, reason: 'unknown-invitation' as const };
      }
      if (normaliseEmail(input.accountEmail) !== invitation.email) {
        return { ok: false as const, reason: 'wrong-recipient' as const };
      }

      const members = this.memberships.get(input.organizationId) ?? new Map();
      if (members.get(input.accountId)?.active === true) {
        return { ok: false as const, reason: 'already-a-member' as const };
      }

      const membership: OrganizationMembership = {
        organizationId: input.organizationId,
        accountId: input.accountId,
        role: invitation.role,
        active: true,
        joinedAt: new Date(nowMs).toISOString(),
      };
      await this.putMembership(membership);
      // Accepting converts a reservation into a seat; the invitation stops
      // reserving so the two are never counted at once.
      await this.replaceInvitation(input.organizationId, {
        ...invitation,
        status: 'accepted',
        acceptedByAccountId: input.accountId,
      });
      return { ok: true as const, membership };
    });
  }

  /** Cancel a pending invitation, releasing its seat. */
  cancelInvitation(organizationId: string, invitationId: string): Promise<boolean> {
    return this.withLock(organizationId, async () => {
      const invitation = this.invitationsOf(organizationId).find(
        (candidate) => candidate.invitationId === invitationId,
      );
      if (!invitation || invitation.status !== 'pending') return false;
      await this.replaceInvitation(organizationId, { ...invitation, status: 'cancelled' });
      return true;
    });
  }

  declineInvitation(organizationId: string, invitationId: string): Promise<boolean> {
    return this.withLock(organizationId, async () => {
      const invitation = this.invitationsOf(organizationId).find(
        (candidate) => candidate.invitationId === invitationId,
      );
      if (!invitation || invitation.status !== 'pending') return false;
      await this.replaceInvitation(organizationId, { ...invitation, status: 'declined' });
      return true;
    });
  }

  /**
   * Remove a member, releasing their seat.
   *
   * Refuses to remove the LAST owner: an organization with nobody able to
   * administer it cannot be recovered by anyone inside it.
   */
  removeMember(
    organizationId: string,
    accountId: string,
  ): Promise<{ ok: true } | { ok: false; reason: OrganizationFailure }> {
    return this.withLock(organizationId, async () => {
      const members = this.memberships.get(organizationId);
      const member = members?.get(accountId);
      if (!members || !member?.active) {
        return { ok: false as const, reason: 'unknown-member' as const };
      }
      if (member.role === 'organization-owner' && this.activeOwnerCount(organizationId) <= 1) {
        return { ok: false as const, reason: 'last-owner' as const };
      }
      await this.putMembership({ ...member, active: false });
      return { ok: true as const };
    });
  }

  private activeOwnerCount(organizationId: string): number {
    return this.membersOf(organizationId).filter(
      (member) => member.active && member.role === 'organization-owner',
    ).length;
  }

  /**
   * Transfer ownership atomically.
   *
   * Both writes happen inside one critical section, so there is never an
   * instant with two owners or none.
   */
  transferOwnership(
    organizationId: string,
    fromAccountId: string,
    toAccountId: string,
  ): Promise<{ ok: true } | { ok: false; reason: OrganizationFailure }> {
    return this.withLock(organizationId, async () => {
      const members = this.memberships.get(organizationId);
      const from = members?.get(fromAccountId);
      const to = members?.get(toAccountId);
      if (!members || !from?.active || from.role !== 'organization-owner') {
        return { ok: false as const, reason: 'unknown-member' as const };
      }
      if (!to?.active) return { ok: false as const, reason: 'unknown-member' as const };

      /*
       * Both writes, then both persisted, still inside the one critical
       * section -- so there is never an instant with two owners or none, in
       * memory or on disk.
       */
      await this.putMembership({ ...to, role: 'organization-owner' });
      await this.putMembership({ ...from, role: 'organization-admin' });
      return { ok: true as const };
    });
  }

  /** Change the contracted seat count. Never removes anybody. */
  async setContractedSeats(organizationId: string, seats: number): Promise<Organization | null> {
    const organization = this.organizations.get(organizationId);
    if (!organization) return null;
    const updated = applyContractedSeatChange(organization, seats);
    return this.putOrganization(updated);
  }

  /**
   * Move an organization through its lifecycle. Server-side only.
   *
   * GUARDED BY THE TRANSITION TABLE. This previously accepted any state from
   * any state, which meant one mistaken call could move a closed organization
   * back to verified and nothing would notice -- and every audit statement
   * about that organization would quietly become conditional. An illegal move
   * is now refused rather than silently applied.
   */
  async setState(
    organizationId: string,
    state: Organization['state'],
  ): Promise<
    | { ok: true; organization: Organization }
    | { ok: false; reason: 'unknown-organization' | 'illegal-transition' }
  > {
    const organization = this.organizations.get(organizationId);
    if (!organization) return { ok: false, reason: 'unknown-organization' };
    if (!isLegalOrganizationTransition(organization.state, state)) {
      return { ok: false, reason: 'illegal-transition' };
    }
    const updated: Organization = {
      ...organization,
      state,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.putOrganization(updated);
    return { ok: true, organization: updated };
  }
}
