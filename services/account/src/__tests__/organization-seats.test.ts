/**
 * A1b — organizations, seats, invitations and the final-seat race.
 *
 * The race is the headline. Everything else here exists because seat accounting
 * is the kind of arithmetic that looks obviously right and is quietly wrong at
 * exactly one boundary.
 */
import { describe, expect, it } from 'vitest';
import { OrganizationStore } from '../organization-store.js';
import { accountSeats, maySeatOneMore, presentationFor } from '@videofy-live/workspace-authority';

function store(seats = 3) {
  const organizations = new OrganizationStore();
  const organization = organizations.create({
    legalName: 'Tech Advance Concept Ltd',
    displayName: 'Tech Advance Concept',
    packageId: 'corporate',
    contractedSeats: seats,
    createdByAccountId: 'account_owner',
  });
  organizations.setState(organization.organizationId, 'verified');
  return { organizations, organizationId: organization.organizationId };
}

describe('seat accounting', () => {
  it('counts the creator as a seat immediately', () => {
    const { organizations, organizationId } = store(3);
    expect(organizations.seats(organizationId)).toMatchObject({
      contracted: 3,
      activeMembers: 1,
      reservedByInvitations: 0,
      allocated: 1,
      available: 2,
    });
  });

  it('PIN: a pending invitation RESERVES a seat', async () => {
    const { organizations, organizationId } = store(3);
    await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    // Without reservation, an administrator could issue a hundred invitations
    // against three seats and the overage would only appear as people accepted.
    expect(organizations.seats(organizationId)).toMatchObject({
      activeMembers: 1,
      reservedByInvitations: 1,
      allocated: 2,
      available: 1,
    });
  });

  it('releases the seat when an invitation is cancelled or declined', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;

    await organizations.cancelInvitation(organizationId, invited.invitation.invitationId);
    expect(organizations.seats(organizationId)?.available).toBe(2);
  });

  it('an expired invitation stops reserving without anybody touching it', () => {
    let clock = 1_000_000;
    const organizations = new OrganizationStore(() => clock);
    const organization = organizations.create({
      legalName: 'L',
      displayName: 'D',
      packageId: 'corporate',
      contractedSeats: 2,
      createdByAccountId: 'account_owner',
    });
    return organizations
      .invite({
        organizationId: organization.organizationId,
        email: 'a@example.com',
        role: 'member',
        invitedByAccountId: 'account_owner',
      })
      .then(() => {
        expect(organizations.seats(organization.organizationId)?.available).toBe(0);
        clock += 15 * 24 * 60 * 60 * 1000;
        expect(organizations.seats(organization.organizationId)?.available).toBe(1);
      });
  });

  it('accepting converts a reservation into a seat, never both', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;

    await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_a',
      accountEmail: 'a@example.com',
    });

    const seats = organizations.seats(organizationId);
    expect(seats).toMatchObject({ activeMembers: 2, reservedByInvitations: 0, allocated: 2 });
  });
});

describe('the final seat', () => {
  it('PIN: two simultaneous invitations cannot both take the last seat', async () => {
    const { organizations, organizationId } = store(2); // owner + exactly one
    expect(organizations.seats(organizationId)?.available).toBe(1);

    // Fired together, with no await between them: this is the interleaving that
    // defeats naive check-then-write, because the event loop runs the second
    // handler while the first is awaiting.
    const [first, second] = await Promise.all([
      organizations.invite({
        organizationId,
        email: 'one@example.com',
        role: 'member',
        invitedByAccountId: 'account_owner',
      }),
      organizations.invite({
        organizationId,
        email: 'two@example.com',
        role: 'member',
        invitedByAccountId: 'account_owner',
      }),
    ]);

    const succeeded = [first, second].filter((outcome) => outcome.ok);
    expect(succeeded).toHaveLength(1);

    const refused = [first, second].find((outcome) => !outcome.ok);
    expect(refused && !refused.ok && refused.reason).toBe('no-seats-available');

    expect(organizations.seats(organizationId)?.available).toBe(0);
  });

  it('PIN: ten concurrent invitations against three seats admit exactly three', async () => {
    const { organizations, organizationId } = store(4); // owner + three
    const attempts = Array.from({ length: 10 }, (_unused, index) =>
      organizations.invite({
        organizationId,
        email: `person${index}@example.com`,
        role: 'member',
        invitedByAccountId: 'account_owner',
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((outcome) => outcome.ok)).toHaveLength(3);
    expect(organizations.seats(organizationId)).toMatchObject({
      allocated: 4,
      available: 0,
      overCapacity: false,
    });
  });
});

describe('invitation recipient binding', () => {
  it('PIN: a forwarded invitation cannot be used by somebody else', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'alice@company.example',
      role: 'organization-admin',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;

    const stolen = await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_bob',
      accountEmail: 'bob@different.example',
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toBe('wrong-recipient');

    // And Alice can still use it.
    const rightful = await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_alice',
      accountEmail: 'Alice@Company.Example',
    });
    expect(rightful.ok).toBe(true);
  });

  it('PIN: the invitation token is never stored in plaintext', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;
    expect(JSON.stringify(invited.invitation)).not.toContain(invited.token);
  });

  it('refuses a wrong token, and refuses reuse', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;

    const wrong = await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: 'not-the-token',
      accountId: 'account_a',
      accountEmail: 'a@example.com',
    });
    expect(wrong.ok).toBe(false);

    await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_a',
      accountEmail: 'a@example.com',
    });
    const reuse = await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_c',
      accountEmail: 'a@example.com',
    });
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.reason).toBe('invitation-not-pending');
  });

  it('refuses a duplicate pending invitation for the same address', async () => {
    const { organizations, organizationId } = store(5);
    await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    const again = await organizations.invite({
      organizationId,
      email: 'A@Example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already-invited');
  });
});

describe('offboarding and ownership', () => {
  it('removing a member releases the seat and keeps the account', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'a@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;
    await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_a',
      accountEmail: 'a@example.com',
    });
    expect(organizations.seats(organizationId)?.available).toBe(1);

    const removed = await organizations.removeMember(organizationId, 'account_a');
    expect(removed.ok).toBe(true);
    expect(organizations.seats(organizationId)?.available).toBe(2);
    // The membership is inactive, not erased: authority is gone, history is not.
    expect(organizations.membershipOf(organizationId, 'account_a')?.active).toBe(false);
  });

  it('PIN: the last Owner cannot be removed', async () => {
    const { organizations, organizationId } = store(3);
    // An organization nobody can administer cannot be recovered from inside.
    const attempt = await organizations.removeMember(organizationId, 'account_owner');
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toBe('last-owner');
  });

  it('PIN: ownership transfer leaves exactly one Owner', async () => {
    const { organizations, organizationId } = store(3);
    const invited = await organizations.invite({
      organizationId,
      email: 'next@example.com',
      role: 'organization-admin',
      invitedByAccountId: 'account_owner',
    });
    if (!invited.ok) return;
    await organizations.accept({
      organizationId,
      invitationId: invited.invitation.invitationId,
      token: invited.token,
      accountId: 'account_next',
      accountEmail: 'next@example.com',
    });

    const transferred = await organizations.transferOwnership(
      organizationId,
      'account_owner',
      'account_next',
    );
    expect(transferred.ok).toBe(true);

    const owners = organizations
      .membersOf(organizationId)
      .filter((member) => member.active && member.role === 'organization-owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]?.accountId).toBe('account_next');
    expect(organizations.membershipOf(organizationId, 'account_owner')?.role).toBe(
      'organization-admin',
    );
  });
});

describe('package downgrade', () => {
  it('PIN: a downgrade never removes people — it goes OVER CAPACITY', async () => {
    const { organizations, organizationId } = store(4);
    for (const name of ['a', 'b', 'c']) {
      const invited = await organizations.invite({
        organizationId,
        email: `${name}@example.com`,
        role: 'member',
        invitedByAccountId: 'account_owner',
      });
      if (!invited.ok) continue;
      await organizations.accept({
        organizationId,
        invitationId: invited.invitation.invitationId,
        token: invited.token,
        accountId: `account_${name}`,
        accountEmail: `${name}@example.com`,
      });
    }
    expect(organizations.seats(organizationId)?.allocated).toBe(4);

    organizations.setContractedSeats(organizationId, 2);
    const seats = organizations.seats(organizationId);
    // Choosing who to eject is a decision with consequences for real employees.
    // A billing change is not consent to make it.
    expect(seats?.overCapacity).toBe(true);
    expect(seats?.activeMembers).toBe(4);
    expect(seats?.available).toBe(0);

    // And no new seat may be allocated while over capacity.
    const blocked = await organizations.invite({
      organizationId,
      email: 'd@example.com',
      role: 'member',
      invitedByAccountId: 'account_owner',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('over-capacity');
  });
});

describe('organization impersonation', () => {
  it('PIN: typing a famous name does not make an organization verified', () => {
    const organizations = new OrganizationStore();
    const impostor = organizations.create({
      legalName: 'Microsoft Corporation',
      displayName: 'Microsoft',
      packageId: 'enterprise',
      contractedSeats: 10,
      createdByAccountId: 'account_impostor',
    });
    const presentation = presentationFor(impostor);
    expect(presentation.verified).toBe(false);
    // The legal name is corroboration; showing it before anything checked it is
    // exactly the wrong signal.
    expect(presentation.showLegalName).toBe(false);
    expect(impostor.verifiedDomains).toEqual([]);
    expect(impostor.state).not.toBe('verified');
  });
});

describe('seat arithmetic in isolation', () => {
  it('never reports negative availability', () => {
    const seats = accountSeats({
      contractedSeats: 2,
      activeMemberCount: 5,
      invitations: [],
      nowMs: 0,
    });
    expect(seats.available).toBe(0);
    expect(seats.overCapacity).toBe(true);
    expect(maySeatOneMore(seats)).toEqual({ ok: false, reason: 'over-capacity' });
  });
});
