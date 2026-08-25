/**
 * The migrations, as modules rather than .sql files on disk.
 *
 * WHY NOT A DIRECTORY OF .sql FILES, which is the nicer thing to read. `tsc`
 * copies TypeScript output and nothing else, so a migrations directory would
 * exist under src, be absent from dist, and the service would run perfectly in
 * development and fail at boot in production with "no migrations found" -- or,
 * worse, decide there was nothing to apply and start against an empty schema.
 * A build step to copy them is one more thing to remember on the day somebody
 * adds a second service. Modules ship wherever the code ships, by construction.
 *
 * ORDER IS THE ARRAY ORDER, not a filename sort, so it is explicit and cannot
 * be changed by renaming. Append; never reorder, never edit one that has run.
 * A migration that has already been applied somewhere is history, and editing
 * history means two databases that agree about which migrations ran and
 * disagree about what they did.
 */

export interface Migration {
  /** Recorded in schema_migrations. Never reused, never renamed. */
  readonly name: string;
  readonly sql: string;
}

/**
 * 001 -- accounts.
 *
 * WHAT IS A COLUMN AND WHAT IS JSONB, deliberately split:
 *
 * Columns for anything the DATABASE must enforce or search on. `email` is
 * UNIQUE here, and that constraint -- not the application's check -- is what
 * actually makes one-account-per-address true. An application check races with
 * itself across processes; a unique index cannot.
 *
 * JSONB for the nested, evolving state: trust components, outstanding
 * challenges, the identity case. These change shape as the product grows, they
 * are always read as a whole record, and nothing queries inside them. Modelling
 * each as its own table would buy joins nobody makes and a migration for every
 * product decision.
 *
 * That split is a judgement about today. If something inside `trust` ever needs
 * to be queried across accounts -- "every account whose identity check expired"
 * -- it becomes a column then, with a migration, on evidence.
 */
const ACCOUNTS: Migration = {
  name: '001_accounts',
  sql: `
    CREATE TABLE IF NOT EXISTS accounts (
      account_id            text        PRIMARY KEY,
      -- Stored normalised (lowercased, trimmed) by the application, exactly as
      -- the in-memory index keys it. The UNIQUE constraint is the real
      -- enforcement of one account per address.
      email                 text        NOT NULL UNIQUE,
      password_hash         text        NOT NULL,
      -- Bumped to invalidate every token issued so far. Not null and defaulted,
      -- because an absent version would compare unequal to every token and lock
      -- the account holder out of their own sessions.
      token_version         integer     NOT NULL DEFAULT 1,
      -- Only ever one of two values, and only when explicitly chosen. The check
      -- keeps a typo from becoming a stored value nothing downstream expects.
      voice_gender          text        CHECK (voice_gender IN ('male', 'female')),
      created_at            timestamptz NOT NULL,
      updated_at            timestamptz NOT NULL,
      -- Nullable: records written before a field existed must still load, which
      -- is the same rule the in-memory record follows.
      trust                 jsonb,
      email_challenge       jsonb,
      phone_challenge       jsonb,
      phone_number          text,
      identity_case         jsonb,
      -- Defaulted rather than nullable: this one is always a list, and "no
      -- events yet" is an empty list rather than an absence.
      seen_callback_events  jsonb       NOT NULL DEFAULT '[]'::jsonb
    );

    -- Retention and closure work will sweep by age, and a sequential scan over
    -- every account to find the old ones is the query that gets slow first.
    CREATE INDEX IF NOT EXISTS accounts_created_at_idx ON accounts (created_at);
  `,
};

/** Applied in this order. Append only. */
export const MIGRATIONS: readonly Migration[] = [ACCOUNTS];
