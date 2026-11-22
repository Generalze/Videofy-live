/** @author masterzee001 */
/**
 * The join: a verified provider identity in, a C7 account out.
 *
 * WHY THIS FILE EXISTS AT ALL. The decision lives in `federated-identity.ts`,
 * the rows live in `account-identities.ts`, the accounts live in
 * `account-store.ts`, and every one of those three was testable on its own
 * long before anybody could sign in with Google. That is the shape of the
 * defect this repository keeps producing: both halves built, both green, and
 * the seam between them owned by nobody. So the seam is a file, with a name,
 * with its own tests.
 *
 * WHY THE LOCK. The hazard is real -- two taps on the same button do this:
 *
 *   A: no identity for (google, sub123)   B: no identity for (google, sub123)
 *   A: no account holds the address       B: no account holds the address
 *   A: create account #1                  B: create account #2
 *
 * and one person has two accounts, reaching whichever the database indexed
 * first. It was measured, by removing the guards and watching the test produce
 * `acct_...01` and `acct_...02` for one person.
 *
 * BUT THE LOCK IS NOT WHAT PREVENTS IT TODAY, and saying otherwise would be
 * the kind of comment that gets believed. `registerFederated` checks the email
 * index and writes it with no await in between, so on a single-threaded
 * runtime that check and that write are already one step; removing this lock
 * alone changes nothing, and removing that atomic section alone changes
 * nothing either. Each guard covers the hazard by itself. The measurement
 * above needed BOTH removed before a second account appeared.
 *
 * So what is this lock for? The atomic section only holds while the account
 * lookup it guards is synchronous -- `findByEmail` reads an in-memory index,
 * and `AccountRecordPort` already names that index as the thing to revisit
 * when scale demands it. On the day that lookup becomes a query, the atomic
 * section stops being atomic and this lock is the only guard left standing.
 * It is cheap, it is keyed per (provider, subject) so strangers never queue
 * behind one another, and it is here so that change is not also an outage.
 *
 * It is in-process, which is honest about this service being single-instance.
 * The UNIQUE constraint in the table is the backstop if that stops being true,
 * and `orphanedAccountId` below is what that backstop costs.
 */
import type { AccountIdentityPort, AccountIdentityRecord } from './account-identities.js';
import type { AccountRecord, AccountStore } from './account-store.js';
import {
  resolveFederatedSignIn,
  type FederatedOutcome,
  type IdentityProvider,
  type ProviderIdentity,
} from './federated-identity.js';

export type FederatedSignInOutcome =
  | {
      readonly kind: 'signed-in';
      readonly account: AccountRecord;
      /** True when this call created the account rather than finding it. */
      readonly created: boolean;
      /** True when this call attached the provider to an account that existed. */
      readonly linked: boolean;
      /**
       * Set only when a cross-process race left an account behind that nothing
       * can reach. Never set in normal operation. Present so the condition is
       * reportable rather than invisible: an operator can delete the row, and
       * a monitor can notice it is happening at all.
       */
      readonly orphanedAccountId?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'no-email'
        | 'unverified-email-conflict'
        | 'account-already-linked'
        | 'account-not-created';
      /** Safe to show the person. Never says whether an address is registered. */
      readonly message: string;
    };

export interface FederatedSignInDeps {
  readonly accounts: AccountStore;
  readonly identities: AccountIdentityPort;
  readonly now?: () => number;
  /**
   * Where a condition that should not happen gets said out loud.
   *
   * Defaulting to a no-op would reproduce the failure this codebase has had
   * four times: a guard that fires correctly, logs below the deployed level,
   * and leaves an empty log that gets read as proof it never ran.
   */
  readonly warn?: (message: string) => void;
}

export class FederatedSignIn {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: FederatedSignInDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /**
   * Sign somebody in, creating or linking as the rule allows.
   *
   * `identity` must ALREADY be verified -- the token checked against the
   * provider's keys, the audience checked against ours. This method trusts
   * every field it is handed and has no way to tell a real assertion from one
   * a caller invented, which is why the verifiers are separate files that
   * cannot be skipped on the way here.
   */
  async signIn(identity: ProviderIdentity): Promise<FederatedSignInOutcome> {
    return this.withSubjectLock(identity.provider, identity.subject, async () => {
      const linkedToSubject = await this.deps.identities.findBySubject(
        identity.provider,
        identity.subject,
      );

      // Fast path, and by far the common one: they have signed in before.
      if (linkedToSubject) {
        const account = this.deps.accounts.get(linkedToSubject.accountId);
        if (account) {
          return { kind: 'signed-in', account, created: false, linked: false } as const;
        }
        /*
         * An identity row pointing at an account that is not there. The
         * foreign key is ON DELETE CASCADE, so this means the account index in
         * memory disagrees with the table -- a failed hydrate, or a delete
         * that did not reach this process. Creating a fresh account here would
         * hand somebody a blank one and lose everything the old one had.
         */
        this.warn(
          `federated sign-in: ${identity.provider} identity is linked to unknown account ${linkedToSubject.accountId}`,
        );
        return {
          kind: 'refused',
          reason: 'account-not-created',
          message: 'We could not open your account. Please try again shortly.',
        } as const;
      }

      const holdingEmail =
        identity.email === null
          ? null
          : (this.deps.accounts.findByEmail(identity.email)?.accountId ?? null);

      const decision: FederatedOutcome = resolveFederatedSignIn(identity, {
        linkedToSubject: null,
        holdingEmail,
      });

      switch (decision.kind) {
        case 'refuse':
          return {
            kind: 'refused',
            reason: decision.reason,
            message: decision.message,
          } as const;

        case 'sign-in':
        case 'link-and-sign-in':
          return this.attachTo(decision.accountId, identity, false);

        case 'create': {
          const created = await this.deps.accounts.registerFederated({
            email: identity.email ?? '',
            emailVerified: identity.emailVerified,
            ...(identity.displayName !== null ? { displayName: identity.displayName } : {}),
          });
          if (!created.ok) {
            /*
             * The policy said nobody held this address, and the store says
             * somebody does. Under the lock the only way that happens is
             * another process, so the honest answer is "try again" rather than
             * a guess about whose account it is.
             */
            this.warn(
              `federated sign-in: ${identity.provider} account creation refused as ${created.reason}`,
            );
            return {
              kind: 'refused',
              reason: 'account-not-created',
              message: 'We could not create your account. Please try again shortly.',
            } as const;
          }
          return this.attachTo(created.account.accountId, identity, true);
        }
      }
    });
  }

  /** Write the link and report what the person actually got. */
  private async attachTo(
    accountId: string,
    identity: ProviderIdentity,
    justCreated: boolean,
  ): Promise<FederatedSignInOutcome> {
    const record: AccountIdentityRecord = {
      accountId,
      provider: identity.provider,
      subject: identity.subject,
      emailAtLink: identity.email,
      emailVerifiedAtLink: identity.emailVerified,
      createdAt: new Date(this.now()).toISOString(),
    };
    const outcome = await this.deps.identities.link(record);

    switch (outcome.kind) {
      case 'linked': {
        const account = this.deps.accounts.get(accountId);
        if (!account) {
          this.warn(
            `federated sign-in: linked ${identity.provider} to unknown account ${accountId}`,
          );
          return {
            kind: 'refused',
            reason: 'account-not-created',
            message: 'We could not open your account. Please try again shortly.',
          };
        }
        return { kind: 'signed-in', account, created: justCreated, linked: !justCreated };
      }

      case 'subject-taken': {
        /*
         * Only reachable from another process, because the lock above covers
         * this subject here. The person is signed in to the account that holds
         * the identity -- that is theirs, and inventing a second one is the
         * thing this whole file exists to prevent. If we created an account a
         * moment ago it is now unreachable, and it is named in the result so
         * somebody can remove it instead of discovering it months later.
         */
        const account = this.deps.accounts.get(outcome.holder.accountId);
        if (!account) {
          return {
            kind: 'refused',
            reason: 'account-not-created',
            message: 'We could not open your account. Please try again shortly.',
          };
        }
        if (justCreated) {
          this.warn(
            `federated sign-in: lost the race for ${identity.provider} subject; account ${accountId} is orphaned`,
          );
        }
        return {
          kind: 'signed-in',
          account,
          created: false,
          linked: false,
          ...(justCreated ? { orphanedAccountId: accountId } : {}),
        };
      }

      case 'account-already-linked':
        /*
         * This account already has a different identity for this provider --
         * a second Google account being attached to one C7 account. Refused,
         * and the message names the provider without naming the other address,
         * which is not this person's to be told.
         */
        return {
          kind: 'refused',
          reason: 'account-already-linked',
          message: `This account is already connected to a different ${labelFor(identity.provider)} account.`,
        };
    }
  }

  /** One promise chain per (provider, subject). Modelled on AccountStore's. */
  private withSubjectLock<T>(
    provider: IdentityProvider,
    subject: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${provider}:${subject}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    // Both arms run `work`: a rejection must not wedge every later attempt.
    const next = previous.then(work, work);
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    // Compare before deleting, or a chain queued behind this one is discarded
    // and the next caller gets a fresh lock -- which is no lock at all.
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }
}

function labelFor(provider: IdentityProvider): string {
  return provider === 'google' ? 'Google' : 'KingsChat';
}
