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

/**
 * The C7 username, the name shown in calls, and the graveyard between them.
 *
 * THREE COLUMNS AND A TABLE, and the shapes carry the rules:
 *
 * `username` is what a person typed; `username_key` is its skeleton, with
 * separators removed and confusables folded, and the UNIQUE INDEX is on the
 * KEY. That is what makes `zoemeak` and `z0emeak` one claim rather than two
 * accounts nobody can tell apart. Nullable, and Postgres allows many NULLs in a
 * unique index -- so an account that has not chosen one does not collide with
 * every other account that has not either.
 *
 * `display_name` carries no constraint at all beyond its type, because it is a
 * label rather than an identity. Nobody is ever found by it.
 *
 * `released_usernames` is the never-reuse rule. A freed handle is a ready-made
 * impersonation of whoever held it, so releasing one records it forever. The
 * account id is kept so the ORIGINAL holder can take their own name back -- that
 * carries no impersonation risk, and refusing it would punish the one person
 * the rule is not aimed at.
 */
const USERNAME_AND_PROFILE: Migration = {
  name: '006_username_and_profile',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS username text,
      ADD COLUMN IF NOT EXISTS username_key text,
      ADD COLUMN IF NOT EXISTS display_name text,
      -- Private unless it says otherwise. Read through readDiscoveryMode,
      -- which treats anything that is not exactly 'discoverable' as private,
      -- so a null, a typo and a future value all fail the safe way.
      ADD COLUMN IF NOT EXISTS discovery_mode text;

    CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_key_unique
      ON accounts (username_key);

    CREATE TABLE IF NOT EXISTS released_usernames (
      username_key text PRIMARY KEY,
      account_id   text NOT NULL,
      released_at  timestamptz NOT NULL DEFAULT now()
    );
  `,
};

/**
 * The contact graph, and the links that are the only way into a private account.
 *
 * WHY DURABILITY IS A SECURITY PROPERTY HERE. This graph is what gates personal
 * calls and messages -- a stranger cannot ring you because you are not contacts.
 * Held only in memory it empties on every deploy, and an empty graph does not
 * fail closed: it loses every connection people made and quietly discards the
 * consent each one represented.
 *
 * THE PAIR IS THE PRIMARY KEY, in the fixed order the store sorts ids into. The
 * database then enforces what the store intends: two rows describing one
 * relationship cannot exist to disagree about who blocked whom.
 *
 * An invite stores its CHALLENGE, which holds a token hash. The plaintext token
 * is in exactly one place -- the link the issuer copied -- and never in a
 * column, so somebody reading this table has no link they can use.
 */
const CONTACTS: Migration = {
  name: '007_contacts',
  sql: `
    CREATE TABLE IF NOT EXISTS contacts (
      low_account_id  text   NOT NULL,
      high_account_id text   NOT NULL,
      state           text   NOT NULL,
      requested_by    text   NOT NULL,
      blocked_by      text,
      requested_at_ms bigint NOT NULL,
      updated_at_ms   bigint NOT NULL,
      PRIMARY KEY (low_account_id, high_account_id)
    );

    -- Either side may be the one asking, so both columns are searched.
    CREATE INDEX IF NOT EXISTS contacts_low_idx  ON contacts (low_account_id);
    CREATE INDEX IF NOT EXISTS contacts_high_idx ON contacts (high_account_id);

    CREATE TABLE IF NOT EXISTS contact_invites (
      invite_id         text  PRIMARY KEY,
      issuer_account_id text  NOT NULL,
      challenge         jsonb NOT NULL,
      revoked_at_ms     bigint
    );

    CREATE INDEX IF NOT EXISTS contact_invites_issuer_idx
      ON contact_invites (issuer_account_id);
  `,
};

/**
 * 008 -- the platform tariff.
 *
 * APPEND-ONLY, AND THE DATABASE ENFORCES IT. Every other table here is state
 * that changes; this one is history that must not. A charge raised last week is
 * only explicable if the tariff it was raised under still says what it said
 * then, so "changing the price" inserts a new version and the old rows stay
 * exactly as published.
 *
 * The trigger is the point. Application-level append-only is a convention that
 * survives until someone writes a well-meaning UPDATE in a migration or a
 * console session; a rule in the database is the thing that still holds at
 * three in the morning. Deliberately no ON CONFLICT DO UPDATE anywhere: a
 * repeated version is a bug worth hearing about, not a silent overwrite of a
 * price somebody was charged under.
 *
 * `grades` is jsonb for the same reason trust components are: it is read as a
 * whole, nothing queries inside it, and the set of grades is a product decision
 * that should not need a migration to revisit.
 */
const BILLING_TARIFF: Migration = {
  name: '008_billing_tariff',
  sql: `
    CREATE TABLE IF NOT EXISTS billing_tariffs (
      version           integer PRIMARY KEY,
      effective_from_ms bigint  NOT NULL,
      currency          text    NOT NULL,
      grades            jsonb   NOT NULL,
      published_by      text    NOT NULL,
      published_at_ms   bigint  NOT NULL,
      note              text
    );

    -- "Which tariff was in force at time T" is the only query that matters for
    -- explaining a past charge, and it is the one an audit runs most.
    CREATE INDEX IF NOT EXISTS billing_tariffs_effective_idx
      ON billing_tariffs (effective_from_ms DESC);

    CREATE OR REPLACE FUNCTION billing_tariffs_are_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'billing_tariffs is append-only: publish a new version instead of %',
        TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS billing_tariffs_no_rewrite ON billing_tariffs;
    CREATE TRIGGER billing_tariffs_no_rewrite
      BEFORE UPDATE OR DELETE ON billing_tariffs
      FOR EACH ROW EXECUTE FUNCTION billing_tariffs_are_append_only();
  `,
};

/**
 * 009 -- devices a person can be reached on.
 *
 * A UNIQUE INDEX ON THE TOKEN, and it is the point of this table. A push token
 * belongs to an INSTALL, not to a person: a shared or resold phone hands the
 * same token to whoever signs in next. Two rows holding one token would leave
 * the PROVIDER deciding which account a notification reaches, which is to say
 * nobody decided -- and the visible symptom is somebody's calls and message
 * previews arriving on a stranger's lock screen. The application reassigns on
 * registration; this constraint is what makes that true rather than intended.
 *
 * The token is a credential and is stored like one: never logged, never in a
 * list response, and only read by the code that sends a push.
 */
const DEVICES: Migration = {
  name: '009_devices',
  sql: `
    CREATE TABLE IF NOT EXISTS devices (
      device_id        text   PRIMARY KEY,
      account_id       text   NOT NULL,
      platform         text   NOT NULL,
      push_token       text   NOT NULL,
      label            text   NOT NULL,
      registered_at_ms bigint NOT NULL,
      last_seen_at_ms  bigint NOT NULL
    );

    -- "every device for this account" is the only read on the hot path.
    CREATE INDEX IF NOT EXISTS devices_account_idx ON devices (account_id);

    -- One token, one device row. See the note above.
    CREATE UNIQUE INDEX IF NOT EXISTS devices_push_token_key ON devices (push_token);
  `,
};

/**
 * 010 -- messages between contacts.
 *
 * The pair columns mirror the contacts table exactly, because a conversation
 * IS the relationship: messages are keyed by the same sorted (low, high) pair
 * as the contact edge that authorises them. There is no conversations table --
 * a conversation with no messages is nothing, and one with messages is fully
 * described by them.
 *
 * `media_path` is a server-side file path, never a URL: voice audio is served
 * only through an authenticated route that checks the caller is a participant.
 * The two indexes serve the only two hot reads -- a conversation page, and the
 * unread count per pair.
 */
const MESSAGES: Migration = {
  name: '010_messages',
  sql: `
    CREATE TABLE IF NOT EXISTS messages (
      message_id        text    PRIMARY KEY,
      low_account_id    text    NOT NULL,
      high_account_id   text    NOT NULL,
      sender_id         text    NOT NULL,
      kind              text    NOT NULL,
      body              text,
      media_path        text,
      media_duration_ms integer,
      created_at_ms     bigint  NOT NULL,
      read_at_ms        bigint
    );

    CREATE INDEX IF NOT EXISTS messages_pair_time_idx
      ON messages (low_account_id, high_account_id, created_at_ms DESC);

    -- Unread lookups filter on the pair plus null read_at_ms; partial index
    -- keeps it small since read messages are the overwhelming majority.
    CREATE INDEX IF NOT EXISTS messages_unread_idx
      ON messages (low_account_id, high_account_id)
      WHERE read_at_ms IS NULL;
  `,
};

/**
 * The language this person's calls enter with. Nullable: "not stated" keeps
 * the call form's own default rather than this guessing -- same rule as
 * voice_gender directly above it in the accounts table.
 */
const DEFAULT_LANGUAGE: Migration = {
  name: '011_default_language',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS default_language text
        CHECK (default_language IN ('en', 'es', 'fr'));
  `,
};

/**
 * Translated conversations (founder's ruling 2026-08-27). The mode is one
 * row per pair -- absence means normal, the free default -- and a translated
 * message stores its rendering BESIDE the original, which is never
 * discarded. Billing intentionally not wired; see message-store.ts header.
 */
const CONVERSATION_MODES: Migration = {
  name: '012_conversation_modes',
  sql: `
    CREATE TABLE IF NOT EXISTS conversation_modes (
      low_account_id    text   NOT NULL,
      high_account_id   text   NOT NULL,
      mode              text   NOT NULL CHECK (mode IN ('normal', 'translated')),
      set_by_account_id text   NOT NULL,
      updated_at_ms     bigint NOT NULL,
      PRIMARY KEY (low_account_id, high_account_id)
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS translated_body     text,
      ADD COLUMN IF NOT EXISTS translated_language text;
  `,
};

/**
 * Language becomes three facts (external review, adopted 2026-08-28): what
 * you speak and what you prefer to hear are different questions. The
 * existing default_language stays as the PRIMARY that seeds both.
 */
const LANGUAGE_FACTS: Migration = {
  name: '013_language_facts',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS spoken_language text
        CHECK (spoken_language IN ('en', 'es', 'fr')),
      ADD COLUMN IF NOT EXISTS listening_language text
        CHECK (listening_language IN ('en', 'es', 'fr'));

    UPDATE accounts
       SET spoken_language    = COALESCE(spoken_language, default_language),
           listening_language = COALESCE(listening_language, default_language)
     WHERE default_language IS NOT NULL;
  `,
};

/**
 * Call history (founder ruling 2026-08-29): a finished direct call is a
 * domain record on the account pair, rendered in the chat timeline. Metadata
 * only -- there is deliberately no column for content of any kind.
 */
const CALL_RECORDS: Migration = {
  name: '014_call_records',
  sql: `
    CREATE TABLE IF NOT EXISTS call_records (
      call_id             text    PRIMARY KEY,
      low_account_id      text    NOT NULL,
      high_account_id     text    NOT NULL,
      caller_account_id   text    NOT NULL,
      peer_account_id     text    NOT NULL,
      mode                text    NOT NULL CHECK (mode IN ('normal', 'translated')),
      created_at_ms       bigint  NOT NULL,
      answered_at_ms      bigint,
      connected_at_ms     bigint,
      ended_at_ms         bigint  NOT NULL,
      outcome             text    NOT NULL,
      ended_by_account_id text,
      duration_seconds    integer NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS call_records_pair_time_idx
      ON call_records (low_account_id, high_account_id, ended_at_ms DESC);
  `,
};

/**
 * Translated voice notes (P7 messaging). A voice note in a translated
 * conversation gets a second, derived audio file spoken in the recipient's
 * language, stored BESIDE the original -- which stays the authoritative,
 * playable recording. The translated text reuses translated_body/_language
 * from 012; only the derived file and its length are new. Paths, never URLs.
 */
const VOICE_NOTE_TRANSLATION: Migration = {
  name: '015_voice_note_translation',
  sql: `
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS translated_media_path   text,
      ADD COLUMN IF NOT EXISTS translated_duration_ms  integer;
  `,
};

/**
 * What a person may do to a message (founder rulings 2026-08-29).
 *
 * Edit and retract change the message for both readers and so are columns on
 * the row: `edited_at_ms` and the `retracted_at_ms` tombstone whose content
 * columns are nulled at the moment it is set. Reply and forward are
 * provenance, also on the row, because they are facts about the message.
 *
 * Hide, react, pin and mute/archive are ONE ACCOUNT's facts and so are side
 * tables keyed by (message_id, account_id) -- the schema makes "user-scoped"
 * true rather than every query having to remember it. Nothing references
 * `messages` by foreign key on purpose: a tombstoned message keeps its row,
 * so the side rows never dangle, and the ports already refuse to act on a
 * message that does not exist.
 */
const MESSAGE_ACTIONS: Migration = {
  name: '016_message_actions',
  sql: `
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_message_id       text,
      ADD COLUMN IF NOT EXISTS forwarded_from_message_id text,
      ADD COLUMN IF NOT EXISTS forwarded_from_sender_id  text,
      ADD COLUMN IF NOT EXISTS edited_at_ms              bigint,
      ADD COLUMN IF NOT EXISTS retracted_at_ms           bigint;

    -- Delete-for-me. The message stays; this reader stops seeing it.
    CREATE TABLE IF NOT EXISTS message_hides (
      message_id   text   NOT NULL,
      account_id   text   NOT NULL,
      hidden_at_ms bigint NOT NULL,
      PRIMARY KEY (message_id, account_id)
    );

    -- One reaction per account per message; changing it replaces the row.
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id    text   NOT NULL,
      account_id    text   NOT NULL,
      emoji         text   NOT NULL,
      reacted_at_ms bigint NOT NULL,
      PRIMARY KEY (message_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS message_pins (
      message_id   text   NOT NULL,
      account_id   text   NOT NULL,
      pinned_at_ms bigint NOT NULL,
      PRIMARY KEY (message_id, account_id)
    );

    -- "My pins" is the lookup; the pair is resolved through the message.
    CREATE INDEX IF NOT EXISTS message_pins_account_idx
      ON message_pins (account_id, pinned_at_ms DESC);

    -- Per account, per partner: NOT per pair. A mutes B without B knowing.
    CREATE TABLE IF NOT EXISTS conversation_settings (
      account_id    text    NOT NULL,
      partner_id    text    NOT NULL,
      muted         boolean NOT NULL DEFAULT false,
      archived      boolean NOT NULL DEFAULT false,
      updated_at_ms bigint  NOT NULL,
      PRIMARY KEY (account_id, partner_id)
    );
  `,
};

/**
 * 017 -- what a person says about themselves, and how they want to be reached
 * (founder directive 2026-08-29). Three columns on the account rather than a
 * side table: each is one fact per person, read with the record on every
 * profile view, and never queried across accounts. Presence itself is NOT
 * here -- it is a heartbeat that a restart honestly forgets -- only the
 * standing override a person sets over it.
 */
const PROFILE_EXTRAS: Migration = {
  name: '017_profile_extras',
  sql: `
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS availability          text    NOT NULL DEFAULT 'auto'
        CHECK (availability IN ('auto', 'busy', 'away')),
      ADD COLUMN IF NOT EXISTS bio                   text
        CHECK (bio IS NULL OR char_length(bio) <= 160),
      ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;
  `,
};

/**
 * 018 -- channel follows. A follow is one account's interest in one channel,
 * with a per-follow reminder flag so "I want to know when they go live" is
 * a choice and not a consequence of following. The channel itself lives in
 * the programme service; this table only ever names it, so nothing here can
 * dangle when a channel is deleted -- the follow simply stops matching.
 */
const CHANNEL_FOLLOWS: Migration = {
  name: '018_channel_follows',
  sql: `
    CREATE TABLE IF NOT EXISTS channel_follows (
      account_id     text    NOT NULL,
      channel_id     text    NOT NULL,
      followed_at_ms bigint  NOT NULL,
      remind         boolean NOT NULL DEFAULT false,
      PRIMARY KEY (account_id, channel_id)
    );

    -- "Every follower of this channel" is the live-push fan-out; "how many"
    -- is the public interest count. Both walk this index.
    CREATE INDEX IF NOT EXISTS channel_follows_channel_idx ON channel_follows (channel_id);
  `,
};

/**
 * 019 -- reports. Write-only from the product's point of view: a person
 * files one and nothing public ever reads it back, so there is no row
 * shape to keep stable for a client. The note is capped so the table cannot
 * become a place to store arbitrary text; the reason is a closed list so it
 * can be counted.
 */
const REPORTS: Migration = {
  name: '019_reports',
  sql: `
    CREATE TABLE IF NOT EXISTS reports (
      report_id           text   PRIMARY KEY,
      reporter_account_id text   NOT NULL,
      target_account_id   text   NOT NULL,
      message_id          text,
      reason              text   NOT NULL
        CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'abuse', 'impersonation', 'other')),
      note                text   NOT NULL DEFAULT ''
        CHECK (char_length(note) <= 500),
      created_at_ms       bigint NOT NULL
    );

    -- The rate limit is "reports by this person in the last hour".
    CREATE INDEX IF NOT EXISTS reports_reporter_time_idx
      ON reports (reporter_account_id, created_at_ms DESC);
  `,
};

/** Applied in this order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  ACCOUNTS,
  ORGANIZATIONS,
  RESET_AND_CONSENT,
  MFA_AND_STEP_UP,
  PENDING_IDENTITY_CHANGE,
  USERNAME_AND_PROFILE,
  CONTACTS,
  BILLING_TARIFF,
  DEVICES,
  MESSAGES,
  DEFAULT_LANGUAGE,
  CONVERSATION_MODES,
  LANGUAGE_FACTS,
  CALL_RECORDS,
  VOICE_NOTE_TRANSLATION,
  MESSAGE_ACTIONS,
  PROFILE_EXTRAS,
  CHANNEL_FOLLOWS,
  REPORTS,
];
