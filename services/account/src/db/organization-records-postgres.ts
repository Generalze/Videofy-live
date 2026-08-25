/**
 * Organizations, memberships and invitations in PostgreSQL.
 *
 * These previously had NO persistence at all -- three in-memory Maps -- so a
 * restart or a deploy destroyed every organization, every membership and every
 * pending invitation. This is the fix for the highest-severity item in the
 * repository.
 *
 * SAME LIMIT AS THE ACCOUNT ADAPTER, stated again because it is easy to assume
 * otherwise once the word "Postgres" appears: the store keeps an in-memory
 * index as its read authority and writes through to here. That is durability,
 * not multi-instance correctness -- two instances would each hold their own
 * view. `reserveSeatTransactionally` below is the exception, and the reason it
 * is the exception is explained on it.
 */
import type { Pool, PoolClient } from 'pg';
import {
  reservesSeat,
  type Invitation,
  type Organization,
  type OrganizationMembership,
} from '@videofy-live/workspace-authority';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * What the store needs to survive a restart.
 *
 * Deliberately not one `save(everything)`: rewriting every organization to
 * change one membership is the shape the account store just moved away from.
 */
export interface OrganizationRecordPort {
  load(): Promise<{
    readonly organizations: readonly Organization[];
    readonly memberships: readonly OrganizationMembership[];
    readonly invitations: readonly Invitation[];
  }>;
  upsertOrganization(organization: Organization): Promise<void>;
  upsertMembership(membership: OrganizationMembership): Promise<void>;
  upsertInvitation(invitation: Invitation): Promise<void>;
  /**
   * Take a seat and write the invitation, atomically.
   *
   * SEPARATE FROM upsertInvitation because it is the one operation whose
   * decision depends on a COUNT that another process can change between the
   * counting and the deciding. Everything else here is write-through; this is
   * the only place the database has to be the authority rather than a copy.
   *
   * The in-memory check in the store still runs first and still refuses fast.
   * This does not replace it -- it backs it, and if the two ever disagree the
   * database wins and the disagreement is itself the finding.
   */
  reserveSeatForInvitation(invitation: Invitation, nowMs: number): Promise<SeatReservation>;
}

/** Nothing is persisted. For tests and for the pre-database configuration. */
export function createEphemeralOrganizationRecords(): OrganizationRecordPort {
  return {
    load: async () => ({ organizations: [], memberships: [], invitations: [] }),
    upsertOrganization: async () => {},
    upsertMembership: async () => {},
    upsertInvitation: async () => {},
    /*
     * Nothing is stored, so there is nothing to count. Returning ok defers
     * entirely to the store's in-memory accounting, which is the whole of the
     * enforcement when no database is configured -- correct for one process,
     * and the reason the ephemeral port must never be what production runs.
     */
    reserveSeatForInvitation: async () => ({ ok: true, allocated: 0, contracted: 0 }),
  };
}

interface OrganizationRow {
  organization_id: string;
  legal_name: string;
  display_name: string;
  state: string;
  package_id: string;
  contracted_seats: number;
  created_by_account_id: string;
  created_at: Date;
  updated_at: Date;
  verified_domains: unknown;
}

interface MembershipRow {
  organization_id: string;
  account_id: string;
  role: string;
  active: boolean;
  joined_at: Date;
}

interface InvitationRow {
  invitation_id: string;
  organization_id: string;
  email: string;
  role: string;
  invited_by_account_id: string;
  status: string;
  token_hash: string;
  /**
   * bigint, which node-postgres returns as a STRING.
   *
   * By default the driver refuses to parse int8 into a JS number, because
   * bigint's range exceeds what a double can hold exactly. Epoch milliseconds
   * are far inside the safe range, so converting is correct here -- but it must
   * be done deliberately. Left as-is, `expiresAtMs > nowMs` compares a string
   * to a number, which JavaScript resolves by coercion often enough to look
   * like it works and fails on the boundaries nobody tests.
   */
  created_at_ms: string;
  expires_at_ms: string;
  accepted_by_account_id: string | null;
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    organizationId: row.organization_id,
    legalName: row.legal_name,
    displayName: row.display_name,
    state: row.state as Organization['state'],
    packageId: row.package_id as Organization['packageId'],
    contractedSeats: row.contracted_seats,
    createdByAccountId: row.created_by_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    verifiedDomains: Array.isArray(row.verified_domains) ? (row.verified_domains as string[]) : [],
  };
}

function toMembership(row: MembershipRow): OrganizationMembership {
  return {
    organizationId: row.organization_id,
    accountId: row.account_id,
    role: row.role as OrganizationMembership['role'],
    active: row.active,
    joinedAt: row.joined_at.toISOString(),
  };
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role as Invitation['role'],
    invitedByAccountId: row.invited_by_account_id,
    status: row.status as Invitation['status'],
    tokenHash: row.token_hash,
    // See the note on the row type: these arrive as strings.
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    acceptedByAccountId: row.accepted_by_account_id,
  };
}

async function upsertOrganizationOn(q: Queryable, organization: Organization): Promise<void> {
  await q.query(
    `INSERT INTO organizations (
       organization_id, legal_name, display_name, state, package_id,
       contracted_seats, created_by_account_id, created_at, updated_at, verified_domains
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (organization_id) DO UPDATE SET
       legal_name       = EXCLUDED.legal_name,
       display_name     = EXCLUDED.display_name,
       state            = EXCLUDED.state,
       package_id       = EXCLUDED.package_id,
       contracted_seats = EXCLUDED.contracted_seats,
       updated_at       = EXCLUDED.updated_at,
       verified_domains = EXCLUDED.verified_domains`,
    [
      organization.organizationId,
      organization.legalName,
      organization.displayName,
      organization.state,
      organization.packageId,
      organization.contractedSeats,
      organization.createdByAccountId,
      organization.createdAt,
      organization.updatedAt,
      JSON.stringify(organization.verifiedDomains ?? []),
    ],
  );
}

async function upsertMembershipOn(q: Queryable, membership: OrganizationMembership): Promise<void> {
  await q.query(
    `INSERT INTO organization_memberships (organization_id, account_id, role, active, joined_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, account_id) DO UPDATE SET
       role   = EXCLUDED.role,
       active = EXCLUDED.active`,
    [
      membership.organizationId,
      membership.accountId,
      membership.role,
      membership.active,
      membership.joinedAt,
    ],
  );
}

async function upsertInvitationOn(q: Queryable, invitation: Invitation): Promise<void> {
  await q.query(
    `INSERT INTO organization_invitations (
       invitation_id, organization_id, email, role, invited_by_account_id,
       status, token_hash, created_at_ms, expires_at_ms, accepted_by_account_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (invitation_id) DO UPDATE SET
       status                 = EXCLUDED.status,
       accepted_by_account_id = EXCLUDED.accepted_by_account_id`,
    [
      invitation.invitationId,
      invitation.organizationId,
      invitation.email,
      invitation.role,
      invitation.invitedByAccountId,
      invitation.status,
      invitation.tokenHash,
      invitation.createdAtMs,
      invitation.expiresAtMs,
      invitation.acceptedByAccountId,
    ],
  );
}

export function createPostgresOrganizationRecords(pool: Pool): OrganizationRecordPort {
  return {
    async load() {
      const [organizations, memberships, invitations] = await Promise.all([
        pool.query<OrganizationRow>(
          `SELECT * FROM organizations ORDER BY created_at, organization_id`,
        ),
        pool.query<MembershipRow>(
          `SELECT * FROM organization_memberships ORDER BY organization_id, account_id`,
        ),
        pool.query<InvitationRow>(
          `SELECT * FROM organization_invitations ORDER BY created_at_ms, invitation_id`,
        ),
      ]);
      return {
        organizations: organizations.rows.map(toOrganization),
        memberships: memberships.rows.map(toMembership),
        invitations: invitations.rows.map(toInvitation),
      };
    },
    upsertOrganization: (organization) => upsertOrganizationOn(pool, organization),
    upsertMembership: (membership) => upsertMembershipOn(pool, membership),
    upsertInvitation: (invitation) => upsertInvitationOn(pool, invitation),
    reserveSeatForInvitation: (invitation, nowMs) =>
      reserveSeatTransactionally(pool, {
        organizationId: invitation.organizationId,
        nowMs,
        apply: (client) => upsertInvitationOn(client, invitation),
      }),
  };
}

export type SeatReservation =
  | { readonly ok: true; readonly allocated: number; readonly contracted: number }
  | {
      readonly ok: false;
      readonly reason: 'unknown-organization' | 'no-seats-available' | 'over-capacity';
      readonly allocated: number;
      readonly contracted: number;
    };

/**
 * Count seats and take one, atomically, in the database.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE WRITE-THROUGH PATH. Everything else in
 * this adapter is durability: the in-memory index answers reads and the
 * database keeps a copy. Seat allocation cannot work that way, because it is
 * the one place where a decision depends on a COUNT that another process can
 * change between the counting and the deciding.
 *
 * The in-process lock the store already has serialises this correctly within
 * one instance and does nothing at all across two. `SELECT ... FOR UPDATE` on
 * the organization row is what makes it correct regardless: the second
 * transaction blocks on the row until the first commits, and then counts a
 * world that includes the first one's write.
 *
 * LOCKING THE ORGANIZATION ROW, not the membership or invitation rows, is
 * deliberate. The rows being counted are the ones being ADDED to, so there is
 * nothing yet to lock -- two transactions would each lock nothing, count the
 * same total, and both proceed. The organization row is the thing they have in
 * common, which makes it the thing to serialise on.
 */
export async function reserveSeatTransactionally(
  pool: Pool,
  input: { organizationId: string; nowMs: number; apply: (client: PoolClient) => Promise<void> },
): Promise<SeatReservation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const organization = await client.query<{ contracted_seats: number }>(
      `SELECT contracted_seats FROM organizations
        WHERE organization_id = $1
        FOR UPDATE`,
      [input.organizationId],
    );
    if (organization.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-organization', allocated: 0, contracted: 0 };
    }
    const contracted = organization.rows[0]?.contracted_seats ?? 0;

    const members = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM organization_memberships
        WHERE organization_id = $1 AND active = true`,
      [input.organizationId],
    );
    /*
     * Pending AND unexpired, which is `reservesSeat`'s definition expressed in
     * SQL. Two definitions of "does this hold a seat" is how an organization
     * ends up over capacity while both places believe they agree -- so if that
     * rule ever changes, it changes in both.
     */
    const pending = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM organization_invitations
        WHERE organization_id = $1 AND status = 'pending' AND expires_at_ms > $2`,
      [input.organizationId, input.nowMs],
    );

    const allocated = Number(members.rows[0]?.n ?? 0) + Number(pending.rows[0]?.n ?? 0);

    // Over capacity is distinguished from merely full: a downgrade puts an
    // organization above its contracted count without anybody having done
    // anything wrong, and the remediation is different.
    if (allocated > contracted) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'over-capacity', allocated, contracted };
    }
    if (allocated >= contracted) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no-seats-available', allocated, contracted };
    }

    await input.apply(client);
    await client.query('COMMIT');
    return { ok: true, allocated: allocated + 1, contracted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Exported so the seat rule has exactly one definition to test against. */
export { reservesSeat };
