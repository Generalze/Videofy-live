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

/**
 * 002 -- organizations, memberships, invitations.
 *
 * These had NO persistence whatsoever: three in-memory Maps, so every
 * organization, every membership and every pending invitation was destroyed by
 * a restart or a deploy. It was the highest-severity item in the repository.
 *
 * FOREIGN KEYS ARE REAL HERE, unlike in the account table which has nothing to
 * point at. A membership row for an organization that does not exist is not a
 * state the application can produce, and the database saying so is cheaper than
 * a test that hopes it never happens.
 *
 * MILLISECONDS STAY MILLISECONDS. Invitation carries createdAtMs and
 * expiresAtMs as epoch numbers, and `reservesSeat` compares them against
 * nowMs. Storing them as timestamptz would mean converting in both directions
 * on every read and write, and every conversion is a chance to be an hour out
 * in a way that shows up as invitations expiring early in one timezone. bigint
 * keeps the value the application already reasons about.
 */
const ORGANIZATIONS: Migration = {
  name: '002_organizations',
  sql: `
    CREATE TABLE IF NOT EXISTS organizations (
      organization_id       text        PRIMARY KEY,
      -- As registered, and never shown as verified merely because it was typed.
      legal_name            text        NOT NULL,
      display_name          text        NOT NULL,
      -- The lifecycle state. Deliberately NOT a database enum: the transition
      -- table in workspace-authority is the authority, and an enum here would
      -- mean a migration every time a state is added, plus two places that can
      -- disagree about which states exist.
      state                 text        NOT NULL,
      package_id            text        NOT NULL,
      -- A number for both packages. "Enterprise means unlimited" is a
      -- commercial promise nobody has made, and encoding it as infinity makes
      -- every capacity check meaningless.
      contracted_seats      integer     NOT NULL,
      created_by_account_id text        NOT NULL,
      created_at            timestamptz NOT NULL,
      updated_at            timestamptz NOT NULL,
      -- Proven domains only. A claim is not a proof, so nothing reaches this
      -- column without DNS or a provider outcome behind it.
      verified_domains      jsonb       NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS organization_memberships (
      organization_id text        NOT NULL
        REFERENCES organizations (organization_id) ON DELETE CASCADE,
      account_id      text        NOT NULL,
      role            text        NOT NULL,
      -- Membership is deactivated, never deleted: offboarding is an event with
      -- an audit trail, and a removed row cannot be distinguished from somebody
      -- who was never there.
      active          boolean     NOT NULL,
      joined_at       timestamptz NOT NULL,
      PRIMARY KEY (organization_id, account_id)
    );

    -- Every seat count and member list scans by organization.
    CREATE INDEX IF NOT EXISTS memberships_org_idx
      ON organization_memberships (organization_id);

    CREATE TABLE IF NOT EXISTS organization_invitations (
      invitation_id         text   PRIMARY KEY,
      organization_id       text   NOT NULL
        REFERENCES organizations (organization_id) ON DELETE CASCADE,
      -- Normalised lowercase. The binding that stops a forwarded invitation
      -- being accepted by somebody else.
      email                 text   NOT NULL,
      role                  text   NOT NULL,
      invited_by_account_id text   NOT NULL,
      status                text   NOT NULL,
      -- The token itself is never stored, so a stolen database yields no
      -- working invitations.
      token_hash            text   NOT NULL,
      created_at_ms         bigint NOT NULL,
      expires_at_ms         bigint NOT NULL,
      accepted_by_account_id text
    );

    -- Seat accounting counts pending, unexpired invitations for one
    -- organization, and does it on the hot path of every invite.
    CREATE INDEX IF NOT EXISTS invitations_org_status_idx
      ON organization_invitations (organization_id, status);
  `,
};

/**
 * 003 -- password reset, and versioned policy consent.
 *
 * Both are columns on `accounts` rather than tables of their own. The reset
 * challenge is at most ONE per account and dies within fifteen minutes; a table
 * would buy a join and a cleanup job for a value that is nearly always null.
 *
 * Consent is a LIST and is kept as jsonb for now, with a caveat worth writing
 * down: the moment somebody has to answer "who has accepted v2.1 of the privacy
 * policy" across all accounts, this becomes a table. That is a real question a
 * regulator asks, so this is a decision with an expiry date rather than a
 * permanent one.
 */
const RESET_AND_CONSENT: Migration = {
  name: '003_reset_and_consent',
  sql: `
    ALTER TABLE accounts
      -- Hashed, expiring, single-use. Null for the overwhelming majority of
      -- accounts at any moment, which is why it is not a table.
      ADD COLUMN IF NOT EXISTS password_reset_challenge jsonb,
      -- NOT NULL with a default: "has accepted nothing" is an empty list, not
      -- an absence. The distinction matters because outstanding consent is
      -- DERIVED by comparing held against required, and a null would have to be
      -- special-cased at every comparison.
      ADD COLUMN IF NOT EXISTS consents jsonb NOT NULL DEFAULT '[]'::jsonb;
  `,
};

/**
 * 004 -- MFA enrolment and the step-up grant.
 *
 * The enrolment's `secret` field holds a SEALED ENVELOPE, not a secret: the
 * TOTP secret is encrypted with AES-256-GCM before it reaches this column, so a
 * stolen database yields no working second factors. The column is jsonb like
 * the rest of the nested state, and its contents are opaque without the
 * deployment keyring.
 *
 * THE STEP-UP GRANT IS A TIMESTAMP, NOT A TOKEN, and it lives server-side
 * rather than in the session token. A claim inside a signed token cannot be
 * revoked before it expires, so a step-up obtained a minute before an account
 * was suspended would keep working; a row can be cleared the instant anything
 * changes. It also avoids editing the token payload, which every other service
 * verifies and would have to be redeployed to understand.
 */
const MFA_AND_STEP_UP: Migration = {
  name: '004_mfa_and_step_up',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS mfa jsonb,
      -- When a second factor was last satisfied, and by what. Null means never,
      -- which is distinct from "long ago" -- one is an account that has never
      -- stepped up, the other is a stale grant, and the refusals differ.
      ADD COLUMN IF NOT EXISTS step_up_at_ms bigint,
      ADD COLUMN IF NOT EXISTS step_up_method text;
  `,
};

/**
 * A change of verified email or phone that has been authorised but NOT applied.
 *
 * ITS OWN COLUMN, never the live address field. The moment a pending change is
 * written into `email`, something downstream reads it as authoritative -- and
 * the whole security property of this flow is that the old address stays
 * authoritative until the instant it is superseded. Replacing first would lock
 * somebody out of their own account the moment they mistyped, and would hand an
 * attacker the change even when the confirmation was never opened.
 *
 * Holds a challenge whose token is a HASH, so the row is useless to anyone who
 * reads it, exactly like the other challenge columns.
 */
const PENDING_IDENTITY_CHANGE: Migration = {
  name: '005_pending_identity_change',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS pending_identity_change jsonb;
  `,
};

/** Applied in this order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  ACCOUNTS,
  ORGANIZATIONS,
  RESET_AND_CONSENT,
  MFA_AND_STEP_UP,
  PENDING_IDENTITY_CHANGE,
];
