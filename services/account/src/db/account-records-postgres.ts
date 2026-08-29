/**
 * Accounts in PostgreSQL.
 *
 * The adapter behind `AccountRecordPort`. It replaces the JSON-file store,
 * whose own header called itself a development prototype and which had a
 * failure mode where one unreadable read destroyed every account on the next
 * write.
 *
 * WHAT IS AND IS NOT SOLVED HERE. Durability: an account survives a restart, a
 * deploy, and a crash mid-write. NOT solved: two service instances would each
 * hydrate their own in-memory index and drift, because the store still reads
 * from memory and writes through to here. That is a separate and larger change,
 * and this file existing must not be taken to mean it has happened.
 */
import type { Pool, PoolClient } from 'pg';
import type { AccountRecord, AccountRecordPort } from '../account-store.js';

/**
 * Anything that can run a statement: the pool, or one client inside a
 * transaction.
 *
 * This exists because of a bug written and caught in this file: the importer
 * opened a transaction on a client and then called an adapter that queried the
 * POOL, which hands out a different connection. Every insert would have landed
 * outside the transaction it was supposed to be atomic within, and the rollback
 * on failure would have rolled back nothing. Taking the queryable explicitly
 * makes that mistake impossible to write.
 */
type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * The row as Postgres returns it.
 *
 * Written out rather than inferred so that a schema change which does not
 * match the code fails at the type level here, in one place, rather than as
 * `undefined` arriving somewhere three calls away.
 */
interface AccountRow {
  account_id: string;
  email: string;
  password_hash: string;
  token_version: number;
  voice_gender: string | null;
  default_language: string | null;
  spoken_language: string | null;
  listening_language: string | null;
  created_at: Date;
  updated_at: Date;
  trust: unknown;
  email_challenge: unknown;
  phone_challenge: unknown;
  phone_number: string | null;
  identity_case: unknown;
  seen_callback_events: unknown;
  password_reset_challenge: unknown;
  consents: unknown;
  mfa: unknown;
  /** bigint -> string, like the invitation timestamps. See that note. */
  step_up_at_ms: string | null;
  step_up_method: string | null;
  pending_identity_change: unknown;
  username: string | null;
  username_key: string | null;
  display_name: string | null;
  discovery_mode: string | null;
  availability: string | null;
  bio: string | null;
  notifications_enabled: boolean | null;
}

/**
 * NULL becomes ABSENT, not null.
 *
 * The record type uses optional properties, and several of them are also
 * explicitly nullable -- `emailChallenge?: ChallengeRecord | null` means the
 * same thing whether it is missing or null. SQL has only NULL, so a round trip
 * has to pick one, and picking "absent" reproduces the shape a freshly
 * registered record actually has. Reading a null back as an explicit `null`
 * would quietly change the shape of every record that passed through the
 * database, which is the kind of difference that only shows up in an equality
 * check somebody wrote months later.
 */
function optional<T>(value: T | null | undefined): { present: false } | { present: true; value: T } {
  return value === null || value === undefined ? { present: false } : { present: true, value };
}

/*
 * NonNullable on every cast below is not decoration. The record is declared
 * with exactOptionalPropertyTypes, so `trust?: AccountTrust` means the key is
 * either absent or an AccountTrust -- never present-and-undefined. Casting to
 * the raw property type would readmit undefined and let a NULL column become a
 * key that exists with nothing behind it, which is the exact distinction the
 * `optional` helper above is drawing.
 */
function toRecord(row: AccountRow): AccountRecord {
  const voiceGender = optional(row.voice_gender);
  const defaultLanguage = optional(row.default_language);
  const spokenLanguage = optional(row.spoken_language);
  const listeningLanguage = optional(row.listening_language);
  const trust = optional(row.trust);
  const emailChallenge = optional(row.email_challenge);
  const phoneChallenge = optional(row.phone_challenge);
  const phoneNumber = optional(row.phone_number);
  const identityCase = optional(row.identity_case);
  const passwordResetChallenge = optional(row.password_reset_challenge);
  const pendingIdentityChange = optional(row.pending_identity_change);
  const mfa = optional(row.mfa);
  const stepUpAtMs = optional(row.step_up_at_ms);
  const stepUpMethod = optional(row.step_up_method);

  return {
    accountId: row.account_id,
    email: row.email,
    passwordHash: row.password_hash,
    tokenVersion: row.token_version,
    // Back to the ISO strings the record has always carried. Stored as
    // timestamptz rather than text so that retention and closure sweeps can
    // compare dates in SQL instead of pulling every row to filter in memory.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(voiceGender.present ? { voiceGender: voiceGender.value as 'male' | 'female' } : {}),
    ...(defaultLanguage.present
      ? { defaultLanguage: defaultLanguage.value as 'en' | 'es' | 'fr' }
      : {}),
    ...(spokenLanguage.present
      ? { spokenLanguage: spokenLanguage.value as 'en' | 'es' | 'fr' }
      : {}),
    ...(listeningLanguage.present
      ? { listeningLanguage: listeningLanguage.value as 'en' | 'es' | 'fr' }
      : {}),
    ...(trust.present ? { trust: trust.value as NonNullable<AccountRecord['trust']> } : {}),
    ...(emailChallenge.present
      ? { emailChallenge: emailChallenge.value as NonNullable<AccountRecord['emailChallenge']> }
      : {}),
    ...(phoneChallenge.present
      ? { phoneChallenge: phoneChallenge.value as NonNullable<AccountRecord['phoneChallenge']> }
      : {}),
    ...(phoneNumber.present ? { phoneNumber: phoneNumber.value } : {}),
    ...(identityCase.present
      ? { identityCase: identityCase.value as NonNullable<AccountRecord['identityCase']> }
      : {}),
    ...(row.username === null ? {} : { username: row.username }),
    ...(row.username_key === null ? {} : { usernameKey: row.username_key }),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.discovery_mode === null ? {} : { discoveryMode: row.discovery_mode }),
    // Only the three known values come back; the CHECK constraint guarantees
    // it, and the cast records that the guarantee lives in the schema.
    ...(row.availability === null
      ? {}
      : { availability: row.availability as NonNullable<AccountRecord['availability']> }),
    ...(row.bio === null ? {} : { bio: row.bio }),
    ...(row.notifications_enabled === null
      ? {}
      : { notificationsEnabled: row.notifications_enabled }),
    ...(pendingIdentityChange.present
      ? {
          pendingIdentityChange: pendingIdentityChange.value as NonNullable<
            AccountRecord['pendingIdentityChange']
          >,
        }
      : {}),
    ...(passwordResetChallenge.present
      ? {
          passwordResetChallenge: passwordResetChallenge.value as NonNullable<
            AccountRecord['passwordResetChallenge']
          >,
        }
      : {}),
    // Always a list, like seenCallbackEvents: "has accepted nothing" is an
    // empty list rather than an absence, and outstanding consent is derived by
    // comparing held against required.
    consents: Array.isArray(row.consents)
      ? (row.consents as NonNullable<AccountRecord['consents']>)
      : [],
    ...(mfa.present ? { mfa: mfa.value as NonNullable<AccountRecord['mfa']> } : {}),
    // Converted deliberately: node-postgres returns bigint as a string, and
    // comparing a string against nowMs is the coercion bug that only shows up
    // on the boundaries nobody tests.
    ...(stepUpAtMs.present ? { stepUpAtMs: Number(stepUpAtMs.value) } : {}),
    ...(stepUpMethod.present ? { stepUpMethod: stepUpMethod.value } : {}),
    // Always a list. "No events yet" is an empty list, not an absence, which is
    // why the column is NOT NULL with a default rather than nullable.
    seenCallbackEvents: Array.isArray(row.seen_callback_events)
      ? (row.seen_callback_events as string[])
      : [],
  };
}

/** The single definition of how a record becomes a row. */
async function upsertOn(queryable: Queryable, record: AccountRecord): Promise<void> {
  /*
       * ON CONFLICT on the primary key, so this is insert-or-replace in one
       * statement and one round trip. A read-then-branch would be two, with a
       * race between them that the per-account lock does not cover across
       * processes.
       *
       * Every column is listed on the UPDATE. Omitting one would leave a stale
       * value behind on a record the caller believed it had replaced whole,
       * and that is exactly the class of bug the authenticate() rehash race
       * turned out to be.
       */
      await queryable.query(
        `INSERT INTO accounts (
           account_id, email, password_hash, token_version, voice_gender, default_language, spoken_language, listening_language,
           created_at, updated_at, trust, email_challenge, phone_challenge,
           phone_number, identity_case, seen_callback_events,
           password_reset_challenge, consents, mfa, step_up_at_ms, step_up_method,
           pending_identity_change, username, username_key, display_name,
           discovery_mode, availability, bio, notifications_enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         ON CONFLICT (account_id) DO UPDATE SET
           email                = EXCLUDED.email,
           password_hash        = EXCLUDED.password_hash,
           token_version        = EXCLUDED.token_version,
           voice_gender         = EXCLUDED.voice_gender,
           default_language     = EXCLUDED.default_language,
           spoken_language      = EXCLUDED.spoken_language,
           listening_language   = EXCLUDED.listening_language,
           updated_at           = EXCLUDED.updated_at,
           trust                = EXCLUDED.trust,
           email_challenge      = EXCLUDED.email_challenge,
           phone_challenge      = EXCLUDED.phone_challenge,
           phone_number         = EXCLUDED.phone_number,
           identity_case        = EXCLUDED.identity_case,
           seen_callback_events = EXCLUDED.seen_callback_events,
           password_reset_challenge = EXCLUDED.password_reset_challenge,
           consents                 = EXCLUDED.consents,
           mfa                      = EXCLUDED.mfa,
           step_up_at_ms            = EXCLUDED.step_up_at_ms,
           step_up_method           = EXCLUDED.step_up_method,
           pending_identity_change  = EXCLUDED.pending_identity_change,
           username                 = EXCLUDED.username,
           username_key             = EXCLUDED.username_key,
           display_name             = EXCLUDED.display_name,
           discovery_mode           = EXCLUDED.discovery_mode,
           availability             = EXCLUDED.availability,
           bio                      = EXCLUDED.bio,
           notifications_enabled    = EXCLUDED.notifications_enabled`,
        [
          record.accountId,
          record.email,
          record.passwordHash,
          record.tokenVersion,
          record.voiceGender ?? null,
          record.defaultLanguage ?? null,
          record.spokenLanguage ?? null,
          record.listeningLanguage ?? null,
          record.createdAt,
          record.updatedAt,
          // Undefined must become SQL NULL explicitly. Passed as undefined, the
          // driver would treat the parameter as missing rather than null.
          record.trust ?? null,
          record.emailChallenge ?? null,
          record.phoneChallenge ?? null,
          record.phoneNumber ?? null,
          record.identityCase ?? null,
          JSON.stringify(record.seenCallbackEvents ?? []),
          record.passwordResetChallenge ?? null,
          JSON.stringify(record.consents ?? []),
          record.mfa ?? null,
          record.stepUpAtMs ?? null,
          record.stepUpMethod ?? null,
          record.pendingIdentityChange ?? null,
          record.username ?? null,
          record.usernameKey ?? null,
          record.displayName ?? null,
          record.discoveryMode ?? null,
          // NOT NULL with defaults in the schema, so an absent value is
          // written as the default rather than as NULL -- an old record
          // saved through here must read back exactly as it behaved.
          record.availability ?? 'auto',
          record.bio ?? null,
          record.notificationsEnabled ?? true,
        ],
      );
}

export function createPostgresAccountRecords(pool: Pool): AccountRecordPort {
  return {
    async load() {
      /*
       * Ordered so hydration is deterministic. Two instances, or the same one
       * twice, build their index in the same sequence -- which matters the day
       * somebody is comparing two boxes to work out why they disagree.
       */
      const { rows } = await pool.query<AccountRow>(
        /*
         * EVERY COLUMN THE UPSERT WRITES. A column added to the insert and not
         * to this list is written on every save and silently dropped on every
         * restart -- which is how `username`, `display_name`, `discovery_mode`
         * and `pending_identity_change` came to persist perfectly and vanish
         * the moment the service came back. `contact-records-postgres.ts` has
         * the same shape; a test now compares the two lists so this cannot
         * happen again quietly.
         */
        `SELECT account_id, email, password_hash, token_version, voice_gender, default_language, spoken_language, listening_language,
                created_at, updated_at, trust, email_challenge, phone_challenge,
                phone_number, identity_case, seen_callback_events,
                password_reset_challenge, consents, mfa, step_up_at_ms, step_up_method,
                pending_identity_change, username, username_key, display_name,
                discovery_mode, availability, bio, notifications_enabled
           FROM accounts
          ORDER BY created_at, account_id`,
      );
      return rows.map(toRecord);
    },
    upsert: (record) => upsertOn(pool, record),
  };
}

/**
 * Import accounts from the JSON file store, once.
 *
 * REFUSES rather than merging if the table already holds anything. A partial or
 * repeated import is worse than no import: it would silently resurrect accounts
 * that were closed after the file was written, or overwrite live records with
 * a stale snapshot, and neither announces itself. Emptiness is the only state
 * in which this is unambiguous.
 *
 * Runs inside ONE transaction, so an import that fails halfway leaves an empty
 * table rather than an arbitrary prefix of the file that somebody then has to
 * work out the boundary of.
 */
export async function importAccountsOnce(
  pool: Pool,
  records: readonly AccountRecord[],
): Promise<{ imported: number } | { refused: 'table-not-empty'; existing: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM accounts');
    const existing = Number(rows[0]?.count ?? 0);
    if (existing > 0) {
      await client.query('ROLLBACK');
      return { refused: 'table-not-empty', existing };
    }

    for (const record of records) {
      // Reuses the same mapping as every other write, so an imported record and
      // a registered one are byte-identical in the table. A separate INSERT
      // here would be a second place for the column list to drift.
      await client.query('SAVEPOINT record');
      try {
        await upsertOn(client, record);
        await client.query('RELEASE SAVEPOINT record');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `importing account ${record.accountId} failed; nothing was imported: ` +
            `${(error as Error)?.message ?? 'unknown error'}`,
        );
      }
    }
    await client.query('COMMIT');
    return { imported: records.length };
  } finally {
    client.release();
  }
}
