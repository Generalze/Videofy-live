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

/**
 * 020 -- channel profiles. Founder directive (LOCKED, 30 Aug 2026), OPERATOR
 * CHANNEL IDENTITY: "persistent channel profile {channelId, ownerAccountId,
 * handle, displayName, description, avatar, banner, category, visibility,
 * createdAt, updatedAt}"; "unique human-readable @handle"; "persist outside
 * gateway memory".
 *
 * The opaque channel id the gateway derives from the account stays the key;
 * the handle is an alias with its own unique index on the FOLDED form, so
 * `Zoe` and `zoe` are one claim. One channel per owner is a constraint, not
 * a convention. The category and visibility checks name the controlled lists
 * literally; the parity test holds them equal to the shared-types lists.
 * The image columns hold a version ref, never bytes: the bytes live where
 * account avatars do, on disk, keyed by channel id.
 */
const CHANNEL_PROFILES: Migration = {
  name: '020_channel_profiles',
  sql: `
    CREATE TABLE IF NOT EXISTS channel_profiles (
      channel_id       text   PRIMARY KEY,
      owner_account_id text   NOT NULL UNIQUE,
      handle           text   NOT NULL,
      display_name     text   NOT NULL,
      description      text   NOT NULL DEFAULT '',
      category         text
        CHECK (category IS NULL OR category IN ('news', 'faith', 'business', 'education', 'culture', 'music', 'sport', 'community', 'technology', 'health', 'government', 'entertainment')),
      visibility       text   NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'private', 'locked')),
      avatar_ref       text,
      banner_ref       text,
      created_at_ms    bigint NOT NULL,
      updated_at_ms    bigint NOT NULL
    );

    -- The handle is unique as people read it, not as it is cased.
    CREATE UNIQUE INDEX IF NOT EXISTS channel_profiles_handle_idx
      ON channel_profiles (lower(handle));
  `,
};

/**
 * 023 -- the Language Specialist programme.
 *
 * TEN TABLES, AND THE SHAPE IS THE POLICY. Four of them are append-only with a
 * trigger to prove it, one carries a CHECK constraint that a future product
 * decision has to lift on purpose, and none of them holds a global "is a
 * specialist" flag. Each of those is a rule this programme cannot be run
 * honestly without, and each is enforced here rather than in a route handler,
 * because a rule that lives in one of eleven endpoints is a rule that holds
 * until somebody adds the twelfth.
 *
 * WHY QUALIFICATION IS A ROW PER LANGUAGE. The first contributor this was
 * designed around writes Yoruba and English, has never been assessed in French,
 * and applied for Hausa last week. A boolean on the account answers "may this
 * person review?" with one word for four different situations, and the first
 * consumer to consult it hands them a French packet. The primary key is
 * (account_id, language) and there is nowhere else to record standing.
 *
 * WHY THE CORPUS IS ITS OWN TABLE AND NOT A FLAG ON THE DRAFT. The whole value
 * of native source is that it was written without knowledge of how the engines
 * behave, and that property is destroyed silently by one well-meaning edit
 * after the first results arrive. A draft is meant to be edited; a corpus must
 * not be. Making them one table with a `frozen` column means the same UPDATE
 * path serves both, and the day it is called on a frozen row nothing at all
 * appears to have gone wrong. Two tables, a UNIQUE key on
 * (account_id, language, revision) and a trigger refusing UPDATE and DELETE
 * mean a correction can only ever be a NEW revision.
 *
 * WHY provider AND model LIVE ON THE CANDIDATE ROW. The reviewer must not learn
 * which engine produced which line -- automatic checks have already been wrong
 * three times on Yoruba-adjacent judgements, and a reviewer who knows what a
 * machine thought is no longer an independent instrument. The identity has to
 * exist somewhere, so it exists HERE, server-side, behind an opaque candidate
 * id, and the application builds the reviewer's payload by naming the fields it
 * copies rather than by deleting the ones it must not.
 *
 * WHY voice_rights_granted IS A COLUMN WITH A CHECK THAT PINS IT FALSE. The
 * permission a contributor gives on the elicitation form is a licence over TEXT
 * they wrote. It grants no voice right of any kind. Storing the field absent
 * would leave the boundary depending on whoever adds it later having read the
 * legal note; storing it pinned means opening a voice programme is a migration
 * somebody authors deliberately, with the constraint's name in the diff.
 *
 * WHAT IS NOT COLLECTED, and it is a design decision rather than an omission:
 * no home address, no government identifier, no demographics. None of them
 * helps decide whether a person can tell a good Yoruba translation from a bad
 * one, and each is a thing that must then be protected, disclosed and deleted.
 */
const LANGUAGE_SPECIALISTS: Migration = {
  name: '023_language_specialists',
  sql: `
    CREATE TABLE IF NOT EXISTS specialist_profiles (
      account_id        text        PRIMARY KEY,
      applied_at_ms     bigint      NOT NULL,
      application_state text        NOT NULL DEFAULT 'UNDER_REVIEW'
        CHECK (application_state IN ('UNDER_REVIEW', 'ACCEPTED', 'DECLINED')),
      -- The applicant's own words on why they want to do this. Free text, and
      -- it never appears in a log line.
      motivation        text        NOT NULL DEFAULT '',
      -- Optional and unverified. Present so an assignment is not scheduled for
      -- somebody's three in the morning, and for no other purpose.
      country           text,
      time_zone         text,
      updated_at_ms     bigint      NOT NULL
    );

    -- Standing, per language. See the note above on why there is no flag.
    CREATE TABLE IF NOT EXISTS specialist_languages (
      account_id    text   NOT NULL,
      language      text   NOT NULL,
      state         text   NOT NULL
        CHECK (state IN ('APPLIED', 'ASSESSMENT_PENDING', 'ASSESSMENT_IN_PROGRESS',
                         'SUBMITTED', 'UNDER_REVIEW', 'QUALIFIED', 'NOT_QUALIFIED',
                         'REASSESSMENT_ALLOWED', 'SUSPENDED')),
      applied_at_ms bigint NOT NULL,
      decided_at_ms bigint,
      decided_by    text,
      decision_note text,
      -- Bumped when an operator allows a reassessment. The corpus revision
      -- follows it, which is what makes a correction a new attempt rather than
      -- an edit of the first one.
      attempt       integer NOT NULL DEFAULT 1,
      PRIMARY KEY (account_id, language)
    );

    -- The operator console's first screen is "everyone waiting on a decision".
    CREATE INDEX IF NOT EXISTS specialist_languages_state_idx
      ON specialist_languages (state, applied_at_ms DESC);

    -- What a person agreed to, and the bytes they agreed to it in.
    CREATE TABLE IF NOT EXISTS specialist_consents (
      consent_id           text   PRIMARY KEY,
      account_id           text   NOT NULL,
      language             text   NOT NULL,
      consent_version      text   NOT NULL,
      -- One value today. It exists so that a future voice agreement cannot be
      -- written into these rows and become indistinguishable from this one.
      scope                text   NOT NULL DEFAULT 'language-text'
        CHECK (scope IN ('language-text')),
      -- The version says WHICH document; this says which BYTES. A deployment
      -- that ships a version number without bumping the text is the mistake
      -- this guards, and it is not a hypothetical one.
      consent_text_sha256  text   NOT NULL,
      accepted_at_ms       bigint NOT NULL
    );

    CREATE INDEX IF NOT EXISTS specialist_consents_who_idx
      ON specialist_consents (account_id, language, accepted_at_ms DESC);

    -- The form as it is being typed. MUTABLE, on purpose: refusing a
    -- half-finished save costs a contributor twenty minutes to a closed tab.
    CREATE TABLE IF NOT EXISTS specialist_elicitation_drafts (
      attempt_id    text   PRIMARY KEY,
      account_id    text   NOT NULL,
      language      text   NOT NULL,
      items         jsonb  NOT NULL DEFAULT '[]'::jsonb,
      updated_at_ms bigint NOT NULL,
      UNIQUE (account_id, language)
    );

    -- The corpus. IMMUTABLE, on purpose. See the note above.
    CREATE TABLE IF NOT EXISTS specialist_source_corpora (
      attempt_id      text   PRIMARY KEY,
      account_id      text   NOT NULL,
      language        text   NOT NULL,
      revision        integer NOT NULL,
      items           jsonb  NOT NULL,
      -- Rows carrying a message. The optional code-switch row may be absent,
      -- which is a legitimate skip and not a short corpus.
      source_count    integer NOT NULL,
      sha256          text   NOT NULL,
      frozen_at_ms    bigint NOT NULL,
      -- NOT NULL, and it is the whole consent gate expressed as a constraint:
      -- there is no way to write a corpus that no permission was given for.
      consent_id      text   NOT NULL REFERENCES specialist_consents (consent_id),
      consent_version text   NOT NULL,
      UNIQUE (account_id, language, revision)
    );

    CREATE TABLE IF NOT EXISTS specialist_assignments (
      assignment_id text   PRIMARY KEY,
      account_id    text   NOT NULL,
      language      text   NOT NULL,
      kind          text   NOT NULL
        CHECK (kind IN ('BLIND_TRANSLATION_REVIEW', 'SOURCE_ELICITATION')),
      state         text   NOT NULL DEFAULT 'NEW'
        CHECK (state IN ('NEW', 'IN_PROGRESS', 'SUBMITTED')),
      created_at_ms bigint NOT NULL,
      due_at_ms     bigint
    );

    CREATE INDEX IF NOT EXISTS specialist_assignments_who_idx
      ON specialist_assignments (account_id, created_at_ms DESC);

    -- The engine identity lives here and is never selected into a reviewer
    -- payload. See the note above.
    CREATE TABLE IF NOT EXISTS specialist_review_candidates (
      candidate_id   text    PRIMARY KEY,
      assignment_id  text    NOT NULL REFERENCES specialist_assignments (assignment_id),
      ordinal        integer NOT NULL,
      direction      text    NOT NULL,
      category       text    NOT NULL DEFAULT '',
      source_text    text    NOT NULL,
      candidate_text text    NOT NULL,
      provider       text    NOT NULL,
      model          text    NOT NULL,
      machine_score  double precision,
      benchmark_rank integer,
      expected_winner boolean,
      UNIQUE (assignment_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS specialist_review_verdicts (
      verdict_id              text    PRIMARY KEY,
      assignment_id           text    NOT NULL REFERENCES specialist_assignments (assignment_id),
      candidate_id            text    NOT NULL REFERENCES specialist_review_candidates (candidate_id),
      account_id              text    NOT NULL,
      -- Stored as the words rather than as booleans. A column of t/f loses
      -- which question it answered the moment the criteria are reordered, and
      -- these are read years later as evidence.
      meaning_preserved       text    NOT NULL CHECK (meaning_preserved IN ('yes', 'no')),
      meaning_reversed        text    NOT NULL CHECK (meaning_reversed IN ('yes', 'no')),
      information_omitted     text    NOT NULL CHECK (information_omitted IN ('yes', 'no')),
      information_invented    text    NOT NULL CHECK (information_invented IN ('yes', 'no')),
      names_numbers_corrupted text    NOT NULL CHECK (names_numbers_corrupted IN ('yes', 'no')),
      naturalness             integer NOT NULL CHECK (naturalness BETWEEN 1 AND 5),
      grammar                 integer NOT NULL CHECK (grammar BETWEEN 1 AND 5),
      trust_in_real_chat      text    NOT NULL CHECK (trust_in_real_chat IN ('yes', 'no')),
      corrected_translation   text,
      note                    text,
      submitted_at_ms         bigint  NOT NULL,
      -- One judgement per candidate. A second is a client retry, and accepting
      -- it would put two verdicts of the same line into the same evidence.
      UNIQUE (assignment_id, candidate_id)
    );

    -- Granted one at a time by a named operator. Nothing derives a row here
    -- from a qualification state; see the package note on why.
    CREATE TABLE IF NOT EXISTS specialist_capabilities (
      account_id    text   NOT NULL,
      language      text   NOT NULL,
      capability    text   NOT NULL
        CHECK (capability IN ('TRANSLATION_REVIEWER', 'TRANSLATION_ADJUDICATOR',
                              'VOCABULARY_SPECIALIST', 'PRONUNCIATION_SPECIALIST',
                              'CULTURAL_REVIEWER', 'VOICE_QUALITY_REVIEWER')),
      granted_by    text   NOT NULL,
      granted_at_ms bigint NOT NULL,
      PRIMARY KEY (account_id, language, capability)
    );

    -- Who decided, when, from what, to what, and why.
    CREATE TABLE IF NOT EXISTS specialist_decisions (
      decision_id text   PRIMARY KEY,
      account_id  text   NOT NULL,
      language    text   NOT NULL,
      from_state  text,
      to_state    text   NOT NULL,
      decided_by  text   NOT NULL,
      reason      text   NOT NULL DEFAULT '',
      at_ms       bigint NOT NULL
    );

    CREATE INDEX IF NOT EXISTS specialist_decisions_who_idx
      ON specialist_decisions (account_id, language, at_ms DESC);

    -- Modelled, and closed. See the note above on the CHECK.
    CREATE TABLE IF NOT EXISTS specialist_voice_participation (
      account_id              text    PRIMARY KEY,
      state                   text    NOT NULL DEFAULT 'NOT_INVITED'
        CHECK (state IN ('NOT_INVITED', 'INVITED', 'AUDITION_PENDING', 'VOICE_APPROVED',
                         'VOICE_AGREEMENT_REQUIRED', 'ACTIVE', 'WITHDRAWN')),
      -- Pinned false. Opening a voice programme means writing a migration that
      -- drops this constraint by name, which is a decision with an author.
      voice_rights_granted    boolean NOT NULL DEFAULT false
        CONSTRAINT specialist_voice_rights_not_granted CHECK (voice_rights_granted = false),
      -- There is no such document today, and a version string here would imply
      -- there was.
      voice_agreement_version text    CHECK (voice_agreement_version IS NULL),
      updated_at_ms           bigint  NOT NULL
    );

    -- The append-only rule, in the database rather than in a convention.
    -- Application-level append-only survives until somebody writes a
    -- well-meaning UPDATE in a console session.
    CREATE OR REPLACE FUNCTION specialist_records_are_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        '% is append-only: write a new record instead of %', TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS specialist_consents_no_rewrite ON specialist_consents;
    CREATE TRIGGER specialist_consents_no_rewrite
      BEFORE UPDATE OR DELETE ON specialist_consents
      FOR EACH ROW EXECUTE FUNCTION specialist_records_are_append_only();

    DROP TRIGGER IF EXISTS specialist_source_corpora_no_rewrite ON specialist_source_corpora;
    CREATE TRIGGER specialist_source_corpora_no_rewrite
      BEFORE UPDATE OR DELETE ON specialist_source_corpora
      FOR EACH ROW EXECUTE FUNCTION specialist_records_are_append_only();

    DROP TRIGGER IF EXISTS specialist_review_verdicts_no_rewrite ON specialist_review_verdicts;
    CREATE TRIGGER specialist_review_verdicts_no_rewrite
      BEFORE UPDATE OR DELETE ON specialist_review_verdicts
      FOR EACH ROW EXECUTE FUNCTION specialist_records_are_append_only();

    DROP TRIGGER IF EXISTS specialist_decisions_no_rewrite ON specialist_decisions;
    CREATE TRIGGER specialist_decisions_no_rewrite
      BEFORE UPDATE OR DELETE ON specialist_decisions
      FOR EACH ROW EXECUTE FUNCTION specialist_records_are_append_only();
  `,
};

/**
 * 024 -- specialist integrity: attempts, composite keys, source validation.
 *
 * A FOLLOW-UP, NOT AN EDIT OF 023. Migration 023 has already run against a
 * local specialist database. Editing it would mean two databases that agree
 * about which migrations ran and disagree about what they did -- the exact
 * failure the header of this file forbids. No production deployment has applied
 * either, and that is a reason to be scrupulous rather than a licence to
 * rewrite history.
 *
 * NUMBERING IS NOW SETTLED. These three began life as 021-023 on the specialist
 * branch while main was still moving. At the one authorised rebase onto the P8
 * Checkpoint-C head, main had taken 021 (programme vocabulary) and 022
 * (programme sponsored creative), so the specialist set moved to 023-025. None
 * had run anywhere but a local specialist database, which is exactly what made
 * renaming them honest at that moment and would not have made it honest after
 * a deployment.
 *
 * WHAT THIS ADDS, AND WHY EACH IS IN THE DATABASE RATHER THAN THE APPLICATION:
 *
 * 1. ATTEMPT IDENTITY. Evidence belongs to an attempt, not to a person and a
 *    language. Without this, a reassessment inherits the previous attempt's
 *    frozen corpus and opens for review on evidence a decision already
 *    superseded. The draft's uniqueness moves to (account, language, attempt)
 *    and assignments carry the attempt they were built for.
 *
 * 2. CONSENT BINDING. A corpus referenced SOME consent id. It must reference a
 *    consent belonging to the same account, the same language and the same
 *    version -- otherwise Alice's Yoruba corpus can cite Bob's consent, or her
 *    own Hausa one, and the licence record for that material is a lie that
 *    reads perfectly well. A composite foreign key makes it unrepresentable.
 *
 * 3. VERDICT INTEGRITY. A verdict must be about a candidate that belongs to the
 *    assignment it names, and must come from the account the assignment belongs
 *    to. Both were application-level lookups; both are now composite foreign
 *    keys, so a verdict crossing assignments cannot be inserted at all.
 *
 * 4. SOURCE VALIDATION. The Checkpoint-B ruling: for languages where C7 can
 *    obtain source but cannot judge it, a fluent speaker validates or corrects
 *    the source BEFORE anything is translated, and the corrected source is
 *    frozen and hashed like an elicitation corpus.
 *
 * 5. OBSERVED LANGUAGE. A structured answer to "what language is this output
 *    actually in", for the failure class already seen: an engine answering
 *    Portuguese in Italian. It is not a note, because a note cannot be counted.
 *
 * 6. THE DEAD APPROVAL COLUMN GOES. `application_state` had three values and no
 *    transition path: nothing set it, nothing read it, and every specialist sat
 *    at UNDER_REVIEW while their language tracks said QUALIFIED. A column that
 *    contradicts the record beside it is worse than an absent one.
 */
const SPECIALIST_INTEGRITY: Migration = {
  name: '024_specialist_integrity',
  sql: `
    /* --- 1. attempt identity ------------------------------------------- */

    -- The draft/source identity for the CURRENT attempt. Defaulted for the rows
    -- 023 already created locally, which are all attempt 1 by construction.
    ALTER TABLE specialist_languages
      ADD COLUMN IF NOT EXISTS attempt_id text NOT NULL DEFAULT 'att_legacy_1';

    ALTER TABLE specialist_elicitation_drafts
      ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

    -- One draft per person per language per ATTEMPT. The old key allowed one
    -- per language for all time, so attempt 2 would have overwritten attempt
    -- 1's rows -- or, worse, been read as attempt 2's own progress.
    ALTER TABLE specialist_elicitation_drafts
      DROP CONSTRAINT IF EXISTS specialist_elicitation_drafts_account_id_language_key;
    ALTER TABLE specialist_elicitation_drafts
      DROP CONSTRAINT IF EXISTS specialist_elicitation_drafts_attempt_key;
    ALTER TABLE specialist_elicitation_drafts
      ADD CONSTRAINT specialist_elicitation_drafts_attempt_key
      UNIQUE (account_id, language, attempt);

    -- Which attempt a packet was built for, and from which frozen source.
    -- A packet from attempt 1 must never become attempt 2's packet merely
    -- because the same account and language are review-unlocked again.
    ALTER TABLE specialist_assignments
      ADD COLUMN IF NOT EXISTS qualification_attempt integer NOT NULL DEFAULT 1;
    ALTER TABLE specialist_assignments
      ADD COLUMN IF NOT EXISTS source_revision integer;
    -- The fingerprint, not merely the revision: a source frozen, corrected and
    -- re-frozen shares the revision and not the hash.
    ALTER TABLE specialist_assignments
      ADD COLUMN IF NOT EXISTS source_sha256 text;
    ALTER TABLE specialist_assignments
      ADD COLUMN IF NOT EXISTS source_set_id text;

    -- The attempt a decision was about, so the audit trail reads unambiguously
    -- once a person has been assessed twice.
    ALTER TABLE specialist_decisions
      ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

    /* --- 2. consent binding -------------------------------------------- */

    -- The target a composite foreign key needs. Redundant with the primary key
    -- on its own; load-bearing as the thing the corpus points at.
    ALTER TABLE specialist_consents
      DROP CONSTRAINT IF EXISTS specialist_consents_identity_key;
    ALTER TABLE specialist_consents
      ADD CONSTRAINT specialist_consents_identity_key
      UNIQUE (consent_id, account_id, language, consent_version);

    -- A corpus may only cite a consent belonging to the SAME account, the SAME
    -- language and the SAME version. The single-column reference this replaces
    -- was satisfied by any consent row in the table.
    ALTER TABLE specialist_source_corpora
      DROP CONSTRAINT IF EXISTS specialist_source_corpora_consent_id_fkey;
    ALTER TABLE specialist_source_corpora
      DROP CONSTRAINT IF EXISTS specialist_source_corpora_consent_binding_fkey;
    ALTER TABLE specialist_source_corpora
      ADD CONSTRAINT specialist_source_corpora_consent_binding_fkey
      FOREIGN KEY (consent_id, account_id, language, consent_version)
      REFERENCES specialist_consents (consent_id, account_id, language, consent_version);

    /* --- 3. verdict relational integrity -------------------------------- */

    -- Targets for the two composite keys below.
    ALTER TABLE specialist_assignments
      DROP CONSTRAINT IF EXISTS specialist_assignments_owner_key;
    ALTER TABLE specialist_assignments
      ADD CONSTRAINT specialist_assignments_owner_key UNIQUE (assignment_id, account_id);

    ALTER TABLE specialist_review_candidates
      DROP CONSTRAINT IF EXISTS specialist_review_candidates_owner_key;
    ALTER TABLE specialist_review_candidates
      ADD CONSTRAINT specialist_review_candidates_owner_key
      UNIQUE (candidate_id, assignment_id);

    -- A verdict about a candidate from ANOTHER assignment is now impossible to
    -- insert, rather than merely refused by a lookup in the store.
    ALTER TABLE specialist_review_verdicts
      DROP CONSTRAINT IF EXISTS specialist_review_verdicts_candidate_id_fkey;
    ALTER TABLE specialist_review_verdicts
      DROP CONSTRAINT IF EXISTS specialist_review_verdicts_candidate_binding_fkey;
    ALTER TABLE specialist_review_verdicts
      ADD CONSTRAINT specialist_review_verdicts_candidate_binding_fkey
      FOREIGN KEY (candidate_id, assignment_id)
      REFERENCES specialist_review_candidates (candidate_id, assignment_id);

    -- A verdict from an account the assignment does not belong to is likewise
    -- unrepresentable. One reviewer per packet is the whole point of a blind.
    ALTER TABLE specialist_review_verdicts
      DROP CONSTRAINT IF EXISTS specialist_review_verdicts_assignment_id_fkey;
    ALTER TABLE specialist_review_verdicts
      DROP CONSTRAINT IF EXISTS specialist_review_verdicts_reviewer_binding_fkey;
    ALTER TABLE specialist_review_verdicts
      ADD CONSTRAINT specialist_review_verdicts_reviewer_binding_fkey
      FOREIGN KEY (assignment_id, account_id)
      REFERENCES specialist_assignments (assignment_id, account_id);

    /* --- 4. source validation ------------------------------------------- */

    -- What C7 supplied for a fluent speaker to check, plus their working
    -- judgements. MUTABLE until frozen, like the elicitation draft: a
    -- half-finished check must survive a closed tab.
    CREATE TABLE IF NOT EXISTS specialist_source_sets (
      set_id        text    PRIMARY KEY,
      account_id    text    NOT NULL,
      language      text    NOT NULL,
      attempt       integer NOT NULL,
      items         jsonb   NOT NULL,
      judgements    jsonb   NOT NULL DEFAULT '[]'::jsonb,
      supplied_by   text    NOT NULL,
      created_at_ms bigint  NOT NULL,
      updated_at_ms bigint  NOT NULL,
      UNIQUE (account_id, language, attempt)
    );

    -- The validated source, frozen. IMMUTABLE, exactly like the elicitation
    -- corpus, and for the same reason: a source edited after engines ran
    -- against it turns a benchmark into two measurements of different things.
    CREATE TABLE IF NOT EXISTS specialist_validated_sources (
      set_id               text    PRIMARY KEY
        REFERENCES specialist_source_sets (set_id),
      account_id           text    NOT NULL,
      language             text    NOT NULL,
      revision             integer NOT NULL,
      items                jsonb   NOT NULL,
      source_count         integer NOT NULL,
      sha256               text    NOT NULL,
      frozen_at_ms         bigint  NOT NULL,
      validator_account_id text    NOT NULL,
      -- Whether any sentence was CHANGED. It decides something: if it was, both
      -- engines must be rerun against the corrected text.
      corrected            boolean NOT NULL DEFAULT false,
      UNIQUE (account_id, language, revision)
    );

    CREATE INDEX IF NOT EXISTS specialist_validated_sources_who_idx
      ON specialist_validated_sources (account_id, language, revision);

    DROP TRIGGER IF EXISTS specialist_validated_sources_no_rewrite ON specialist_validated_sources;
    CREATE TRIGGER specialist_validated_sources_no_rewrite
      BEFORE UPDATE OR DELETE ON specialist_validated_sources
      FOR EACH ROW EXECUTE FUNCTION specialist_records_are_append_only();

    -- SOURCE_VALIDATION joins the kinds a packet can be.
    ALTER TABLE specialist_assignments
      DROP CONSTRAINT IF EXISTS specialist_assignments_kind_check;
    ALTER TABLE specialist_assignments
      ADD CONSTRAINT specialist_assignments_kind_check
      CHECK (kind IN ('BLIND_TRANSLATION_REVIEW', 'SOURCE_ELICITATION', 'SOURCE_VALIDATION'));

    /* --- 5. observed language ------------------------------------------- */

    -- "What language is this output actually written in?" Stored as the label
    -- the reviewer chose. Deliberately NOT constrained to a list here: the
    -- options differ per target language and live in the domain package, and a
    -- CHECK naming one language's neighbours would have to be migrated every
    -- time another language opted in.
    ALTER TABLE specialist_review_verdicts
      ADD COLUMN IF NOT EXISTS observed_language text;

    /* --- 6. the dead approval column ------------------------------------ */

    -- Nothing wrote it, nothing read it, and it contradicted the language
    -- tracks beside it. Progress is derived from those tracks instead.
    ALTER TABLE specialist_profiles
      DROP COLUMN IF EXISTS application_state;
  `,
};

/**
 * 025 -- source provenance, in the database.
 *
 * A THIRD FILE RATHER THAN AN EDIT OF THE OTHER TWO, for the reason 024 already
 * gives: both have run against a local specialist database. The numbering is
 * settled -- see 024's header for how 021-023 became 023-025 at the one
 * authorised rebase.
 *
 * WHAT 024 LEFT REPRESENTABLE. It bound a corpus to its own consent and a
 * verdict to its own assignment and reviewer, but the SOURCE VALIDATION side
 * carried single-column references only:
 *
 *   `specialist_validated_sources.set_id` pointed at a set. ANY set. Alice's
 *   frozen French source could name the set C7 supplied to Bob, or Alice's own
 *   Spanish one, or the set from her previous attempt -- and the row would read
 *   perfectly well while attesting that a fluent speaker had checked sentences
 *   they were never shown.
 *
 *   `specialist_assignments.source_set_id` pointed at a set with no relation to
 *   the assignment's own account, language or attempt, so a SOURCE_VALIDATION
 *   packet could be issued against somebody else's material.
 *
 * Both are now composite foreign keys, so bad provenance is unrepresentable
 * rather than merely refused by a lookup in the store. The application checks
 * are kept: a database that refuses is a good last line, and an error a person
 * can read is a better first one.
 *
 * NULL source_set_id STAYS LEGAL. A blind-review packet has no set, and a
 * composite key with a NULL component is not enforced (MATCH SIMPLE, the
 * default). That is the behaviour wanted here and it is worth saying out loud,
 * because MATCH FULL would refuse every blind-review row.
 */
const SPECIALIST_SOURCE_PROVENANCE: Migration = {
  name: '025_specialist_source_provenance',
  sql: `
    -- The target the two keys below need. Redundant with the primary key on its
    -- own; load-bearing as the thing they point at.
    ALTER TABLE specialist_source_sets
      DROP CONSTRAINT IF EXISTS specialist_source_sets_identity_key;
    ALTER TABLE specialist_source_sets
      ADD CONSTRAINT specialist_source_sets_identity_key
      UNIQUE (set_id, account_id, language, attempt);

    -- A validated source may only freeze the set belonging to the SAME account,
    -- the SAME language and the SAME attempt. "revision" is the attempt number
    -- by construction, which is why it is the column matched against "attempt".
    ALTER TABLE specialist_validated_sources
      DROP CONSTRAINT IF EXISTS specialist_validated_sources_set_id_fkey;
    ALTER TABLE specialist_validated_sources
      DROP CONSTRAINT IF EXISTS specialist_validated_sources_provenance_fkey;
    ALTER TABLE specialist_validated_sources
      ADD CONSTRAINT specialist_validated_sources_provenance_fkey
      FOREIGN KEY (set_id, account_id, language, revision)
      REFERENCES specialist_source_sets (set_id, account_id, language, attempt);

    -- A SOURCE_VALIDATION packet may only name the set belonging to its own
    -- account, language and attempt. NULL is legal and unenforced: a
    -- blind-review packet has no set.
    ALTER TABLE specialist_assignments
      DROP CONSTRAINT IF EXISTS specialist_assignments_source_set_fkey;
    ALTER TABLE specialist_assignments
      ADD CONSTRAINT specialist_assignments_source_set_fkey
      FOREIGN KEY (source_set_id, account_id, language, qualification_attempt)
      REFERENCES specialist_source_sets (set_id, account_id, language, attempt);

    -- A frozen corpus belongs to a track, at a revision that is that track's
    -- attempt. Without this a corpus could name a language the person never
    -- applied in, which is the elicitation half of the same defect.
    ALTER TABLE specialist_source_corpora
      DROP CONSTRAINT IF EXISTS specialist_source_corpora_track_fkey;
    ALTER TABLE specialist_source_corpora
      ADD CONSTRAINT specialist_source_corpora_track_fkey
      FOREIGN KEY (account_id, language)
      REFERENCES specialist_languages (account_id, language);

    ALTER TABLE specialist_source_sets
      DROP CONSTRAINT IF EXISTS specialist_source_sets_track_fkey;
    ALTER TABLE specialist_source_sets
      ADD CONSTRAINT specialist_source_sets_track_fkey
      FOREIGN KEY (account_id, language)
      REFERENCES specialist_languages (account_id, language);
  `,
};

/** Applied in this order. Append only. */
/**
 * Programme vocabulary, and the revision that makes it one coherent state.
 *
 * TWO TABLES, ON PURPOSE. The entries hold the terms; a separate one-row-per-
 * programme state table holds the revision. That row is the SERIALIZATION POINT
 * for mutations: a writer takes `FOR UPDATE` on it, so two operators editing the
 * same programme at once cannot both read revision 17 and both write 18 --
 * which would leave both their changes in the rows while the revision advanced
 * only once, and a snapshot labelled 18 would be missing one of them.
 *
 * The lock is PROGRAMME-LOCAL. Programme A's writer must never block
 * programme B's, which is why the revision lives in a row keyed by programme
 * rather than in a single global counter.
 *
 * Every index leads with programme_id, because every legitimate query is
 * programme-scoped and no query that is not should be cheap.
 */
const PROGRAMME_VOCABULARY: Migration = {
  name: '021_programme_vocabulary',
  sql: `
    CREATE TABLE IF NOT EXISTS programme_vocabulary_state (
      programme_id text PRIMARY KEY,
      -- Advanced by exactly one per semantic change, inside the same
      -- transaction as the change itself.
      revision     bigint NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS programme_vocabulary_entries (
      programme_id        text NOT NULL,
      entry_id            text NOT NULL,
      term                text NOT NULL,
      canonical_rendering text NOT NULL DEFAULT '',
      language            text NOT NULL DEFAULT '*',
      pronunciation_hint  text NOT NULL DEFAULT '',
      do_not_translate    boolean NOT NULL DEFAULT false,
      stt_keyterm         boolean NOT NULL DEFAULT false,
      kind                text NOT NULL DEFAULT 'programme-term',
      notes               text NOT NULL DEFAULT '',
      enabled             boolean NOT NULL DEFAULT true,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      -- Composite key: an entry id is unique WITHIN a programme, not globally.
      -- Two programmes may legitimately use the same id, and a delete keyed on
      -- id alone would take both.
      PRIMARY KEY (programme_id, entry_id)
    );

    CREATE INDEX IF NOT EXISTS programme_vocabulary_entries_programme_idx
      ON programme_vocabulary_entries (programme_id);
  `,
};

/**
 * The programme's sponsored creative: ONE row, which is both the data and the
 * revision that labels it.
 *
 * ONE TABLE, unlike programme vocabulary. Vocabulary needed a separate state
 * row because its data is many rows and a revision spanning them has to live
 * somewhere; a sponsored creative is exactly one row per programme, so that row
 * is already the serialization point. A second table here would be ceremony
 * with an extra way to disagree.
 *
 * THE WINDOW IS A CHECK CONSTRAINT, not only application validation. The
 * service refuses `starts_at >= ends_at` before it ever reaches here, and the
 * constraint refuses it again -- because a window that can never be open would
 * make a creative that is saved, looks configured, and never once appears, with
 * nothing anywhere reporting a fault.
 *
 * NO SCHEDULER READS THIS TABLE. There is no job, no timer and no cron: the
 * bounds are compared against the clock when a viewer asks. A scheduler would
 * be a second source of truth that can be late, down, or running twice.
 */
const PROGRAMME_SPONSORED_CREATIVE: Migration = {
  name: '022_programme_sponsored_creative',
  sql: `
    CREATE TABLE IF NOT EXISTS programme_sponsored_creative (
      programme_id text        PRIMARY KEY,
      -- Advances once per SEMANTIC change; 0 means no row has ever been saved.
      revision     bigint      NOT NULL DEFAULT 0,
      headline     text        NOT NULL,
      body         text        NOT NULL,
      cta          text        NOT NULL,
      -- Null is a real value: a creative with no destination is legitimate.
      href         text,
      -- "Use the programme's own creative", NOT "advertising is on": the slot
      -- is reserved either way and falls back to the house creative.
      enabled      boolean     NOT NULL DEFAULT false,
      starts_at    timestamptz,
      ends_at      timestamptz,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT programme_sponsored_creative_window
        CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
    );
  `,
};

/**
 * C7 ADVERTISING. Who advertises, in which programmes, and what actually ran.
 *
 * THE OPERATOR IS NOT IN THIS SCHEMA. There is no column by which a broadcaster
 * selects an advertiser, a campaign, a creative or a commercial priority --
 * that is the founder's ruling made structural rather than enforced by a check
 * somebody can later relax. A broadcaster who could choose their advertiser, or
 * read what a campaign pays, would make the platform unsellable to advertisers.
 *
 * IMPRESSIONS ARE IDEMPOTENT BY KEY. A reconnect gives a broadcast a new
 * transport and the same run; without the uniqueness below, replaying a
 * decision after a network hiccup would bill an advertiser for an impression
 * they did not buy. The key is what the decision IS -- this run, this campaign,
 * this moment in the programme -- so a retry of the same decision collapses
 * onto the same row and a genuinely second airing does not.
 *
 * NO SCHEDULER READS THIS. Windows are compared against the clock when a break
 * is offered, exactly as the sponsored creative does it. A scheduler would be a
 * second source of truth that can be late, down, or running twice.
 */
const C7_ADVERTISING: Migration = {
  name: '026_c7_advertising',
  sql: `
    CREATE TABLE IF NOT EXISTS c7_ad_campaigns (
      campaign_id    text        PRIMARY KEY,
      -- Who is buying. Commercial, and never leaves C7.
      advertiser     text        NOT NULL,
      status         text        NOT NULL DEFAULT 'draft',
      -- Higher wins among the eligible. Commercially sensitive.
      priority       integer     NOT NULL DEFAULT 0,
      starts_at      timestamptz NOT NULL,
      ends_at        timestamptz NOT NULL,
      -- Empty means every programme, language or region.
      programme_ids  text[]      NOT NULL DEFAULT '{}',
      languages      text[]      NOT NULL DEFAULT '{}',
      regions        text[]      NOT NULL DEFAULT '{}',
      -- How many times ONE broadcast may carry this campaign, and how close
      -- together. Two airings each get their own allowance.
      max_per_run    integer     NOT NULL DEFAULT 1,
      min_spacing_ms bigint      NOT NULL DEFAULT 300000,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT c7_ad_campaigns_window CHECK (starts_at < ends_at),
      CONSTRAINT c7_ad_campaigns_status
        CHECK (status IN ('draft', 'active', 'paused', 'ended')),
      CONSTRAINT c7_ad_campaigns_cap CHECK (max_per_run >= 0),
      CONSTRAINT c7_ad_campaigns_spacing CHECK (min_spacing_ms >= 0)
    );

    CREATE TABLE IF NOT EXISTS c7_ad_creatives (
      creative_id text        PRIMARY KEY,
      campaign_id text        NOT NULL
        REFERENCES c7_ad_campaigns(campaign_id) ON DELETE CASCADE,
      -- What the audience is shown, and for exactly how long. A creative
      -- longer than a break is refused rather than trimmed: trimming cuts a
      -- creative mid-sentence and still bills for it.
      duration_ms integer     NOT NULL,
      media_url   text        NOT NULL,
      status      text        NOT NULL DEFAULT 'active',
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT c7_ad_creatives_duration CHECK (duration_ms > 0),
      CONSTRAINT c7_ad_creatives_status CHECK (status IN ('active', 'withdrawn'))
    );

    CREATE INDEX IF NOT EXISTS c7_ad_creatives_by_campaign
      ON c7_ad_creatives (campaign_id);

    CREATE TABLE IF NOT EXISTS c7_ad_impressions (
      decision_id       text        PRIMARY KEY,
      run_id            text        NOT NULL,
      campaign_id       text        NOT NULL,
      creative_id       text        NOT NULL,
      programme_time_ms bigint      NOT NULL,
      duration_ms       integer     NOT NULL,
      policy_version    text        NOT NULL,
      origin            text        NOT NULL,
      decided_at        timestamptz NOT NULL,
      recorded_at       timestamptz NOT NULL DEFAULT now(),
      -- What the decision IS. A retry after a reconnect collapses onto this
      -- row; a genuinely second airing has a different run and does not.
      CONSTRAINT c7_ad_impressions_once
        UNIQUE (run_id, campaign_id, programme_time_ms)
    );

    CREATE INDEX IF NOT EXISTS c7_ad_impressions_by_run
      ON c7_ad_impressions (run_id);
  `,
};

/**
 * 027 -- programme airings.
 *
 * WHAT THIS TABLE IS FOR, and what it deliberately is not. A broadcast that
 * went out is a historical fact about a channel; its recording is optional
 * media that may never have existed and may already have been released. Those
 * are two different lifetimes, and keeping them in one row would mean deleting
 * a month-old replay deletes the evidence that the programme ever aired.
 *
 *     MEDIA MAY EXPIRE. HISTORY DOES NOT DISAPPEAR WITH IT.
 *
 * So the row is the AIRING. `replay_disposition` says whether a recording was
 * ever kept, and the replay columns describe it when one was.
 *
 * NOT A MAP OF THE ARCHIVE. There is deliberately no storage reference, no
 * archive root, no object key and no segment list anywhere below. This database
 * describes broadcasts; finding their bytes is the media archive's job, and a
 * product table that also held paths would be an archive-path leak with a
 * schema. `replay_bytes` and the counts are a size, which is what a history
 * page shows, not a way to reach anything.
 *
 * NOT AN AUTHORITY EITHER. A row saying `available` records what the archive
 * last reported. Playback asks the archive; if the two disagree, the archive
 * wins, because it is the thing that holds the media.
 *
 * COLUMNS RATHER THAN A JSONB BLOB, because these are exactly the fields a
 * history query filters and orders on -- channel, programme, when, and what
 * became of the recording -- and because the CHECK constraints below are how
 * "an airing that kept nothing carries no replay state" stops being a comment
 * and starts being true.
 */
const PROGRAMME_AIRINGS: Migration = {
  name: '027_programme_airings',
  sql: `
    CREATE TABLE IF NOT EXISTS programme_airings (
      -- One airing, one row. A reconnect or a retried report collapses onto
      -- this key; a genuinely second broadcast of the same programme has a
      -- different run and does not.
      run_id                 text        PRIMARY KEY,
      -- Whose broadcast it was. Immutable after the first write: the
      -- application refuses to move a run between channels, because a
      -- programme does not change who aired it.
      channel_id             text        NOT NULL,
      programme_id           text        NOT NULL,
      started_at_ms          bigint      NOT NULL,
      -- Null while it is still on air.
      ended_at_ms            bigint,

      -- 'none'   the operator chose to keep no recording.
      -- 'replay' a recording exists, or existed. The columns below describe it.
      replay_disposition     text        NOT NULL,
      replay_status          text,
      replay_policy          text,
      replay_visibility      text,
      replay_expires_at_ms   bigint,
      replay_finalised_at_ms bigint,
      replay_failure_reason  text,
      -- A SENTENCE THE APPLICATION CHOSE, never the archive's own detail. The
      -- text a replay failure carries is written where the failure happened
      -- and can name a spool file; a product database is queried by other
      -- things, backed up elsewhere, and read by people who should never learn
      -- the shape of a volume. The reason is mapped to fixed wording before it
      -- reaches here.
      replay_failure_summary text,
      replay_bytes           bigint,
      replay_segment_count   integer,
      replay_init_count      integer,

      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT programme_airings_disposition
        CHECK (replay_disposition IN ('none', 'replay')),

      /*
       * AN AIRING THAT KEPT NOTHING CARRIES NO REPLAY STATE.
       *
       * Without this, a bug could write status 'deleted' against a programme
       * that never had a recording, and the history page would say a replay was
       * removed when none was ever made. The two are different facts and the
       * database refuses to blur them.
       */
      CONSTRAINT programme_airings_none_is_empty
        CHECK (
          replay_disposition <> 'none'
          OR (
            replay_status IS NULL
            AND replay_policy IS NULL
            AND replay_visibility IS NULL
            AND replay_expires_at_ms IS NULL
            AND replay_finalised_at_ms IS NULL
            AND replay_failure_reason IS NULL
            AND replay_failure_summary IS NULL
            AND replay_bytes IS NULL
            AND replay_segment_count IS NULL
            AND replay_init_count IS NULL
          )
        ),

      -- And a recorded airing carries the state that describes it.
      CONSTRAINT programme_airings_replay_is_described
        CHECK (
          replay_disposition <> 'replay'
          OR (
            replay_status IS NOT NULL
            AND replay_policy IS NOT NULL
            AND replay_visibility IS NOT NULL
            AND replay_bytes IS NOT NULL
            AND replay_segment_count IS NOT NULL
            AND replay_init_count IS NOT NULL
          )
        ),

      CONSTRAINT programme_airings_status
        CHECK (
          replay_status IS NULL
          OR replay_status IN (
            'recording', 'processing', 'available', 'failed', 'expired', 'deleted'
          )
        ),
      CONSTRAINT programme_airings_policy
        CHECK (replay_policy IS NULL OR replay_policy IN ('keep', 'expire', 'none')),
      -- The REPLAY tiers, which are not the channel tiers. A replay is a stored
      -- object rather than a door, so its middle tier is 'unlisted'.
      CONSTRAINT programme_airings_visibility
        CHECK (
          replay_visibility IS NULL
          OR replay_visibility IN ('public', 'unlisted', 'private')
        ),
      -- An expiry belongs to exactly one policy.
      CONSTRAINT programme_airings_expiry_needs_policy
        CHECK (replay_expires_at_ms IS NULL OR replay_policy = 'expire'),
      CONSTRAINT programme_airings_counts_are_sane
        CHECK (
          (replay_bytes IS NULL OR replay_bytes >= 0)
          AND (replay_segment_count IS NULL OR replay_segment_count >= 0)
          AND (replay_init_count IS NULL OR replay_init_count >= 0)
        )
    );

    /*
     * The two history questions, and the ordering they are answered in.
     *
     * DESC on the time and the run together, because that pair is the keyset a
     * page resumes from: ordering by time alone leaves two airings that began
     * in the same millisecond in an order the database is free to change
     * between queries, which is how a viewer paging through history sees one
     * broadcast twice and never sees another.
     */
    CREATE INDEX IF NOT EXISTS programme_airings_by_channel
      ON programme_airings (channel_id, started_at_ms DESC, run_id DESC);

    CREATE INDEX IF NOT EXISTS programme_airings_by_programme
      ON programme_airings (programme_id, started_at_ms DESC, run_id DESC);
  `,
};

/**
 * 028 -- channel replay settings.
 *
 * WHERE THE DEFAULTS LIVE, and why they are not in the Replay domain. That
 * package refuses to invent a policy: it has no default retention and no
 * default visibility, because "the operator chose not to keep this" and
 * "nobody has decided yet" are different facts and only one is safe to act on.
 * Somebody still has to decide, and this table is where a channel's standing
 * answer is kept.
 *
 * NO ROW MEANS UNCONFIGURED, and that is the useful answer rather than a
 * missing one. A channel with no row does not resolve to "keep nothing" or to
 * "keep everything"; it resolves to a refusal, so a configuration that failed
 * to load can never quietly become a decision about somebody's broadcast.
 *
 * `allow_overrides` IS POLICY, not a convenience flag. A channel publishing
 * under a retention promise needs a per-programme override to be REFUSED rather
 * than quietly honoured, and that refusal has to survive a restart.
 *
 * DAYS HERE, AN INSTANT LATER. What is stored is what an operator set -- "keep
 * these for thirty days" -- and the conversion into an expiry happens against
 * the broadcast's own start, so two programmes configured identically and aired
 * an hour apart expire an hour apart.
 *
 * ALSO TIGHTENS 027. A `replay` airing could syntactically carry
 * `replay_policy = 'none'`, which the typed projection cannot produce but the
 * table permitted. Added here as an additive constraint rather than by editing
 * a migration that has already run.
 */
const CHANNEL_REPLAY_SETTINGS: Migration = {
  name: '028_channel_replay_settings',
  sql: `
    CREATE TABLE IF NOT EXISTS channel_replay_settings (
      -- One channel, one standing answer.
      channel_id            text        PRIMARY KEY,
      default_policy        text        NOT NULL,
      -- Days, as the operator set them. Required by expire, meaningless
      -- otherwise -- and refused rather than ignored on the other policies,
      -- because somebody who set one believed the recording would be released.
      default_duration_days integer,
      default_visibility    text        NOT NULL,
      -- False means a programme asking to differ is refused, not overruled.
      allow_overrides       boolean     NOT NULL DEFAULT true,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT channel_replay_settings_policy
        CHECK (default_policy IN ('keep', 'expire', 'none')),
      -- The REPLAY tiers, which are not the channel access tiers: a replay is a
      -- stored object rather than a door, so its middle tier is 'unlisted'.
      CONSTRAINT channel_replay_settings_visibility
        CHECK (default_visibility IN ('public', 'unlisted', 'private')),
      CONSTRAINT channel_replay_settings_duration_belongs_to_expire
        CHECK (
          (default_policy = 'expire' AND default_duration_days IS NOT NULL)
          OR (default_policy <> 'expire' AND default_duration_days IS NULL)
        ),
      CONSTRAINT channel_replay_settings_duration_is_usable
        CHECK (
          default_duration_days IS NULL
          OR (default_duration_days >= 1 AND default_duration_days <= 3650)
        )
    );

    /*
     * A recorded airing carries a policy that keeps something.
     *
     * 027 allowed 'none' here syntactically. The typed projection cannot
     * produce it -- a 'none' disposition has no summary at all -- but a table
     * that permits a shape the application forbids is a table that will hold
     * one eventually, by some other route.
     */
    ALTER TABLE programme_airings
      DROP CONSTRAINT IF EXISTS programme_airings_replay_policy_keeps_something;
    ALTER TABLE programme_airings
      ADD CONSTRAINT programme_airings_replay_policy_keeps_something
      CHECK (replay_disposition <> 'replay' OR replay_policy IN ('keep', 'expire'));
  `,
};

/**
 * 029 -- one programme's departure from its channel's standing answer.
 *
 * WHY A TABLE AND NOT THREE COLUMNS ON A PROGRAMME ROW. There is no programme
 * row. A programme is an identity the platform already carries -- vocabulary
 * and sponsored creative are keyed the same way -- and inventing a programmes
 * table to hang three nullable columns off would be a schema decision made for
 * the convenience of one feature.
 *
 * ABSENT IS NOT THE SAME AS CLEARED, and this is the only subtle thing here.
 * The override's duration has THREE states, not two: not stated at all (inherit
 * whatever the channel says), stated as nothing (there is deliberately no
 * duration), and stated as a number. A single nullable integer can hold two of
 * those, so `duration_days_stated` carries the third. Collapsing them would
 * make "use the channel's thirty days" and "expire with no duration, which is
 * incoherent and must be refused" the same stored row, and one of those is a
 * recording that quietly lives forever.
 *
 * NO ROW MEANS THIS PROGRAMME ASKED FOR NOTHING, which resolves to the
 * channel's defaults. That is deliberately unlike an unconfigured CHANNEL,
 * which resolves to a refusal: a channel must decide, a programme need not.
 *
 * THE VALUES ARE CHECKED, THE COMBINATION IS NOT. Whether `keep` may carry a
 * duration, or whether this channel permits overrides at all, is decided by
 * `resolveReplayPolicy` against settings this table cannot see. A CHECK
 * constraint asserting half of that rule would be a second, partial copy of a
 * decision that has one home.
 */
const PROGRAMME_REPLAY_OVERRIDES: Migration = {
  name: '029_programme_replay_overrides',
  sql: `
    CREATE TABLE IF NOT EXISTS programme_replay_overrides (
      -- One programme, one departure. Re-saving replaces it.
      programme_id          text        PRIMARY KEY,
      -- Whose programme it is. Carried rather than joined for, because the
      -- join that answers "may this caller change it" is the one that gets
      -- skipped on the day somebody is in a hurry.
      channel_id            text        NOT NULL,
      -- Null in all three means: not overridden, inherit the channel's.
      policy                text,
      visibility            text,
      -- See above: stated-as-nothing and not-stated are different answers.
      duration_days         integer,
      duration_days_stated  boolean     NOT NULL DEFAULT false,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT programme_replay_overrides_policy
        CHECK (policy IS NULL OR policy IN ('keep', 'expire', 'none')),
      -- REPLAY tiers, which are not the channel access tiers: there is no
      -- 'locked' here, because a stored object is not a door.
      CONSTRAINT programme_replay_overrides_visibility
        CHECK (visibility IS NULL OR visibility IN ('public', 'unlisted', 'private')),
      CONSTRAINT programme_replay_overrides_duration_is_usable
        CHECK (
          duration_days IS NULL
          OR (duration_days >= 1 AND duration_days <= 3650)
        ),
      -- A duration that was never stated cannot have a value; otherwise the
      -- discriminator and the column would be free to disagree.
      CONSTRAINT programme_replay_overrides_duration_needs_stating
        CHECK (duration_days_stated OR duration_days IS NULL)
    );

    -- Every read is by programme; this is for the channel-wide sweep an
    -- operator console makes when it lists what departs from the default.
    CREATE INDEX IF NOT EXISTS programme_replay_overrides_by_channel
      ON programme_replay_overrides (channel_id);
  `,
};

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
  CHANNEL_PROFILES,
  PROGRAMME_VOCABULARY,
  PROGRAMME_SPONSORED_CREATIVE,
  C7_ADVERTISING,
  LANGUAGE_SPECIALISTS,
  SPECIALIST_INTEGRITY,
  SPECIALIST_SOURCE_PROVENANCE,
  PROGRAMME_AIRINGS,
  CHANNEL_REPLAY_SETTINGS,
  PROGRAMME_REPLAY_OVERRIDES,
];
