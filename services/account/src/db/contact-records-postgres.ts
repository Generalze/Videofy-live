/**
 * Contacts and invite links, in Postgres.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The contact graph is what gates personal
 * calls and messages: a stranger cannot ring you because you are not contacts.
 * Held only in memory, that list empties on every deploy -- and an empty graph
 * does not fail closed, it silently un-gates nothing and loses every connection
 * people made. Losing an organization was the highest-severity item in this
 * repository for the same reason.
 *
 * ONE ROW PER RELATIONSHIP, with the pair as the primary key in the fixed order
 * the store sorts them into. The database enforces what the store intends: two
 * rows for one relationship cannot exist to disagree with each other.
 *
 * AN INVITE STORES ITS CHALLENGE, WHICH HOLDS A HASH. The plaintext token
 * appears nowhere -- not in a column, not in a log -- so a reader of this table
 * has no link they can use.
 */
import type { Pool } from 'pg';
import type { ContactEdge, ContactInvite } from '@videofy-live/account-trust';
import type { ContactRecordPort } from '../contact-store.js';

interface ContactRow {
  low_account_id: string;
  high_account_id: string;
  state: string;
  requested_by: string;
  blocked_by: string | null;
  /**
   * bigint, which node-postgres returns as a STRING.
   *
   * The driver refuses to parse int8 into a JS number by default, because
   * bigint's range exceeds what a double holds exactly. Epoch milliseconds are
   * far inside the safe range, so converting is correct -- but it has to be
   * done deliberately. Left alone, a timestamp comparison puts a string beside
   * a number, which JavaScript coerces often enough to look like it works and
   * fails on the boundaries nobody tests.
   */
  requested_at_ms: string;
  updated_at_ms: string;
}

interface InviteRow {
  invite_id: string;
  issuer_account_id: string;
  challenge: unknown;
  revoked_at_ms: string | null;
}

function toEdge(row: ContactRow): ContactEdge {
  return {
    lowAccountId: row.low_account_id,
    highAccountId: row.high_account_id,
    state: row.state as ContactEdge['state'],
    requestedBy: row.requested_by,
    blockedBy: row.blocked_by,
    requestedAtMs: Number(row.requested_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function toInvite(row: InviteRow): ContactInvite {
  return {
    inviteId: row.invite_id,
    issuerAccountId: row.issuer_account_id,
    challenge: row.challenge as ContactInvite['challenge'],
    revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
  };
}

export function createPostgresContactRecords(pool: Pool): ContactRecordPort {
  return {
    async load() {
      /*
       * Ordered so hydration is deterministic: the same rows build the same
       * index in the same sequence, which matters the day somebody is comparing
       * two boxes to work out why they disagree.
       */
      const { rows } = await pool.query<ContactRow>(
        `SELECT low_account_id, high_account_id, state, requested_by, blocked_by,
                requested_at_ms, updated_at_ms
           FROM contacts
          ORDER BY low_account_id, high_account_id`,
      );
      return rows.map(toEdge);
    },

    async upsert(edge) {
      await pool.query(
        `INSERT INTO contacts (
           low_account_id, high_account_id, state, requested_by, blocked_by,
           requested_at_ms, updated_at_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (low_account_id, high_account_id) DO UPDATE SET
           state           = EXCLUDED.state,
           requested_by    = EXCLUDED.requested_by,
           blocked_by      = EXCLUDED.blocked_by,
           requested_at_ms = EXCLUDED.requested_at_ms,
           updated_at_ms   = EXCLUDED.updated_at_ms`,
        [
          edge.lowAccountId,
          edge.highAccountId,
          edge.state,
          edge.requestedBy,
          // Undefined must become SQL NULL explicitly: passed as undefined the
          // driver treats the parameter as missing rather than as null.
          edge.blockedBy ?? null,
          edge.requestedAtMs,
          edge.updatedAtMs,
        ],
      );
    },

    async remove(lowAccountId, highAccountId) {
      await pool.query(
        `DELETE FROM contacts WHERE low_account_id = $1 AND high_account_id = $2`,
        [lowAccountId, highAccountId],
      );
    },

    async loadInvites() {
      const { rows } = await pool.query<InviteRow>(
        `SELECT invite_id, issuer_account_id, challenge, revoked_at_ms
           FROM contact_invites
          ORDER BY invite_id`,
      );
      return rows.map(toInvite);
    },

    async upsertInvite(invite) {
      await pool.query(
        `INSERT INTO contact_invites (invite_id, issuer_account_id, challenge, revoked_at_ms)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (invite_id) DO UPDATE SET
           challenge     = EXCLUDED.challenge,
           revoked_at_ms = EXCLUDED.revoked_at_ms`,
        [invite.inviteId, invite.issuerAccountId, invite.challenge, invite.revokedAtMs ?? null],
      );
    },
  };
}
