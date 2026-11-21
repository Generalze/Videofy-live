/** @author masterzee001 */
/**
 * Where a provider identity is written down, and what happens when two of them
 * race for the same person.
 *
 * WHY THIS IS NOT PART OF `AccountStore`. Accounts are held entirely in memory
 * and rebuilt at boot; that port's own comment admits startup time grows with
 * the account count. Identities do not need that. Sign-in asks exactly one
 * question -- "who owns (provider, subject)?" -- and the UNIQUE constraint on
 * that pair already indexes it, so this port asks the database each time and
 * keeps nothing. It costs one indexed lookup per sign-in and saves holding a
 * second copy of every row for the life of the process.
 *
 * WHY `link` RETURNS A RESULT INSTEAD OF THROWING. Two constraints can refuse
 * the write, and they mean opposite things:
 *
 *   UNIQUE (provider, subject)  -- somebody ELSE already holds this identity.
 *   PRIMARY KEY (account_id, provider) -- THIS account already linked a
 *                               different subject for the same provider.
 *
 * The first is a race between two sign-ins and resolves by signing the person
 * in to the account that won. The second is a person trying to attach a second
 * Google account to one C7 account, which is a refusal with an explanation.
 * Collapsing both into one thrown error would make the first look like the
 * second, and tell somebody their account was taken when it was simply theirs
 * a moment earlier.
 */
import type { IdentityProvider } from './federated-identity.js';

/** One provider identity, as it is stored. */
export interface AccountIdentityRecord {
  readonly accountId: string;
  readonly provider: IdentityProvider;
  /** The provider's permanent id for the person. The join key. */
  readonly subject: string;
  /**
   * What the provider said the address was at the moment of linking.
   *
   * AUDIT ONLY. Nothing looks an account up by this, deliberately: an address
   * can be released and re-registered to a stranger, and a lookup that follows
   * the address follows the stranger.
   */
  readonly emailAtLink: string | null;
  /** Whether the provider claimed to have verified it, at the moment of linking. */
  readonly emailVerifiedAtLink: boolean;
  readonly createdAt: string;
}

/** What happened when a link was attempted. */
export type LinkOutcome =
  /** The row is ours. */
  | { readonly kind: 'linked'; readonly record: AccountIdentityRecord }
  /**
   * Another account already holds this (provider, subject). `holder` is that
   * row -- the caller signs the person in to it rather than inventing a second
   * account for one person.
   */
  | { readonly kind: 'subject-taken'; readonly holder: AccountIdentityRecord }
  /**
   * This account already has a DIFFERENT subject linked for this provider.
   * `existing` is the one it has.
   */
  | { readonly kind: 'account-already-linked'; readonly existing: AccountIdentityRecord };

export interface AccountIdentityPort {
  /** Who owns this provider identity, if anybody. */
  findBySubject(
    provider: IdentityProvider,
    subject: string,
  ): Promise<AccountIdentityRecord | null>;
  /** Every provider linked to one account, for a settings screen. */
  listForAccount(accountId: string): Promise<readonly AccountIdentityRecord[]>;
  /**
   * Write the link, losing gracefully to whoever got there first.
   *
   * MUST NOT overwrite an existing row. An upsert here would let a second
   * sign-in silently move an identity from one account to another, which is
   * account takeover performed by our own code.
   */
  link(record: AccountIdentityRecord): Promise<LinkOutcome>;
}

/**
 * An in-memory port, for tests and for a deployment with no database.
 *
 * It enforces the same two constraints the table does, because a test that
 * passes against a port which permits what Postgres refuses has certified
 * nothing.
 */
export function createEphemeralAccountIdentities(): AccountIdentityPort {
  const rows: AccountIdentityRecord[] = [];
  const bySubject = (provider: IdentityProvider, subject: string) =>
    rows.find((row) => row.provider === provider && row.subject === subject) ?? null;

  return {
    async findBySubject(provider, subject) {
      return bySubject(provider, subject);
    },
    async listForAccount(accountId) {
      return rows.filter((row) => row.accountId === accountId);
    },
    async link(record) {
      const holder = bySubject(record.provider, record.subject);
      if (holder) {
        return holder.accountId === record.accountId
          ? { kind: 'linked', record: holder }
          : { kind: 'subject-taken', holder };
      }
      const existing = rows.find(
        (row) => row.accountId === record.accountId && row.provider === record.provider,
      );
      if (existing) return { kind: 'account-already-linked', existing };
      rows.push(record);
      return { kind: 'linked', record };
    },
  };
}
