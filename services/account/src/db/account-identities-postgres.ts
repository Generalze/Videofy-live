/** @author masterzee001 */
/** Postgres port for federated provider identities. See account-identities.ts. */
import type { Pool } from 'pg';
import type {
  AccountIdentityPort,
  AccountIdentityRecord,
  LinkOutcome,
} from '../account-identities.js';
import type { IdentityProvider } from '../federated-identity.js';

interface Row {
  account_id: string;
  provider: string;
  subject: string;
  email_at_link: string | null;
  email_verified_at_link: boolean;
  created_at: Date | string;
}

const COLUMNS = `account_id, provider, subject, email_at_link, email_verified_at_link, created_at`;

function toRecord(row: Row): AccountIdentityRecord {
  return {
    accountId: row.account_id,
    // The column has a CHECK constraint naming exactly these two, so a value
    // that is neither cannot have come from this table.
    provider: row.provider as IdentityProvider,
    subject: row.subject,
    emailAtLink: row.email_at_link,
    emailVerifiedAtLink: row.email_verified_at_link,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export function createPostgresAccountIdentities(pool: Pool): AccountIdentityPort {
  async function findBySubject(
    provider: IdentityProvider,
    subject: string,
  ): Promise<AccountIdentityRecord | null> {
    const result = await pool.query(
      `SELECT ${COLUMNS} FROM account_identities WHERE provider = $1 AND subject = $2`,
      [provider, subject],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? toRecord(row) : null;
  }

  return {
    findBySubject,

    async listForAccount(accountId) {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM account_identities WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      return (result.rows as Row[]).map(toRecord);
    },

    async link(record): Promise<LinkOutcome> {
      /*
       * DO NOTHING, never DO UPDATE.
       *
       * An upsert would move an existing identity to whichever account asked
       * last, which is account takeover written by us. Losing the insert is
       * the correct outcome; the two SELECTs below work out WHICH constraint
       * refused it, because the two mean opposite things to the person.
       *
       * No ON CONFLICT target is named, so both the UNIQUE (provider, subject)
       * and the PRIMARY KEY (account_id, provider) are caught here rather than
       * one of them escaping as an exception.
       */
      const inserted = await pool.query(
        `INSERT INTO account_identities
           (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          record.accountId,
          record.provider,
          record.subject,
          record.emailAtLink,
          record.emailVerifiedAtLink,
          record.createdAt,
        ],
      );
      const row = inserted.rows[0] as Row | undefined;
      if (row) return { kind: 'linked', record: toRecord(row) };

      // Somebody holds this identity. If it is this same account, the write was
      // simply already done -- a retry, not a conflict.
      const holder = await findBySubject(record.provider, record.subject);
      if (holder) {
        return holder.accountId === record.accountId
          ? { kind: 'linked', record: holder }
          : { kind: 'subject-taken', holder };
      }

      // Nobody holds the subject, so the primary key refused: this account
      // already has a different identity for this provider.
      const existing = await pool.query(
        `SELECT ${COLUMNS} FROM account_identities WHERE account_id = $1 AND provider = $2`,
        [record.accountId, record.provider],
      );
      const existingRow = existing.rows[0] as Row | undefined;
      if (existingRow) return { kind: 'account-already-linked', existing: toRecord(existingRow) };

      /*
       * Neither constraint explains the refusal, which means the row vanished
       * between the insert and these reads. Reporting `linked` would tell the
       * caller a link exists when none does, and the person would be signed in
       * to an account nothing connects them to on the next attempt.
       */
      throw new Error(
        `account_identities: insert for ${record.provider} was refused but no conflicting row exists`,
      );
    },
  };
}
