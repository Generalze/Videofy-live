/** @author masterzee001 */
/**
 * Accounts: who exists, and whether this is really them.
 *
 * The rules that matter here are the ones about what the store REFUSES to tell
 * a caller. Sign-in cannot distinguish "no such account" from "wrong password",
 * because a system that does is a system anybody can use to find out who has an
 * account — and for a product where an account authorises speaking in someone's
 * voice, membership is not public information.
 *
 * Storage is an injected port, as with voice profiles: the rules live here and
 * the filesystem does not get to decide any of them.
 *
 * DEVELOPMENT PROTOTYPE. Real password storage, real constant-time comparison,
 * real lockout — and no email verification, no password reset, no second
 * factor, no breach-list check. Those absences are listed rather than implied,
 * because the dangerous version of this file is the one that looks finished.
 */
import { createAccountId, type AccountId } from '@videofy-live/participant-contracts';
import {
  describePasswordRejection,
  hashPassword,
  needsRehash,
  rejectPassword,
  verifyPassword,
} from './password.js';

export interface AccountRecord {
  readonly accountId: AccountId;
  /** Normalised: lowercased and trimmed. The stored form IS the lookup key. */
  readonly email: string;
  readonly passwordHash: string;
  /**
   * Bumped to invalidate every token issued so far. This is what makes "sign
   * out everywhere" mean something for a stateless token.
   */
  readonly tokenVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountRecordPort {
  load(): Promise<readonly AccountRecord[]>;
  save(records: readonly AccountRecord[]): Promise<void>;
}

export function createEphemeralAccountRecords(): AccountRecordPort {
  return { load: async () => [], save: async () => {} };
}

export type RegistrationResult =
  | { readonly ok: true; readonly account: AccountRecord }
  | { readonly ok: false; readonly reason: 'invalid-email' | 'weak-password' | 'already-exists'; readonly message: string };

export type AuthenticationResult =
  | { readonly ok: true; readonly account: AccountRecord }
  /**
   * Deliberately one reason for both an unknown email and a wrong password.
   * Splitting them would turn sign-in into a membership oracle.
   */
  | { readonly ok: false; readonly reason: 'rejected' | 'locked' };

/**
 * Good enough to reject nonsense, deliberately not RFC 5322.
 *
 * An address is proved to exist by sending mail to it, which this prototype
 * does not do. Elaborate pattern matching would only create false confidence
 * about a string nobody has confirmed.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** After this many consecutive failures an account stops answering for a while. */
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * A hash for an account that does not exist, so signing in as a stranger costs
 * the same as signing in with the wrong password.
 *
 * Its FORMAT has to be exactly right or it does nothing. A first version of
 * this had a leading `$`, which failed `verifyPassword`'s format check and
 * returned in microseconds — reintroducing, through the back door, precisely
 * the timing oracle the identical error message exists to close. 16-byte salt,
 * 64-byte key, matching what `hashPassword` produces.
 */
const DUMMY_HASH = `scrypt$${32_768}$8$1$${'A'.repeat(22)}==$${'A'.repeat(86)}==`;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface FailureState {
  count: number;
  until: number;
}

export class AccountStore {
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byEmail = new Map<string, string>();
  /**
   * Failed attempts, in memory only and deliberately so. Lockout is a
   * brute-force speed bump, not a record about a person, and it is not worth
   * persisting somebody's failure history to disk to keep it across restarts.
   */
  private readonly failures = new Map<string, FailureState>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly records: AccountRecordPort = createEphemeralAccountRecords(),
    private readonly now: () => number = () => Date.now(),
    private readonly newAccountSuffix: () => string = () =>
      // 16 hex characters. Long enough that account ids are not guessable, which
      // matters because an account id is an owner id.
      [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
  ) {}

  async hydrate(): Promise<number> {
    for (const record of await this.records.load()) {
      this.byId.set(record.accountId, record);
      this.byEmail.set(record.email, record.accountId);
    }
    return this.byId.size;
  }

  get(accountId: string): AccountRecord | null {
    return this.byId.get(accountId) ?? null;
  }

  async register(input: { email: string; password: string }): Promise<RegistrationResult> {
    const email = normaliseEmail(input.email);
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return { ok: false, reason: 'invalid-email', message: 'Enter a valid email address.' };
    }
    const rejection = rejectPassword(input.password, email);
    if (rejection) {
      return { ok: false, reason: 'weak-password', message: describePasswordRejection(rejection) };
    }
    if (this.byEmail.has(email)) {
      // Registration necessarily reveals that an address is taken — there is no
      // way to create a unique account without saying so. Sign-in, which is the
      // endpoint an attacker would actually enumerate with, does not.
      return {
        ok: false,
        reason: 'already-exists',
        message: 'An account already exists for that email address.',
      };
    }

    const timestamp = new Date(this.now()).toISOString();
    const account: AccountRecord = {
      accountId: createAccountId(this.newAccountSuffix),
      email,
      passwordHash: await hashPassword(input.password),
      tokenVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.byId.set(account.accountId, account);
    this.byEmail.set(email, account.accountId);
    await this.persist();
    return { ok: true, account };
  }

  /**
   * Whether this is really them.
   *
   * An unknown email still costs a password hash. Returning early would make
   * "no such account" measurably faster than "wrong password", which is the
   * same disclosure the identical error message exists to prevent — a timing
   * oracle is still an oracle.
   */
  async authenticate(input: { email: string; password: string }): Promise<AuthenticationResult> {
    const email = normaliseEmail(input.email);
    const failure = this.failures.get(email);
    if (failure && failure.until > this.now()) return { ok: false, reason: 'locked' };

    const accountId = this.byEmail.get(email);
    const account = accountId ? this.byId.get(accountId) : undefined;
    const hash = account?.passwordHash ?? DUMMY_HASH;
    const matched = await verifyPassword(input.password, hash);

    if (!account || !matched) {
      this.recordFailure(email);
      return { ok: false, reason: 'rejected' };
    }

    this.failures.delete(email);
    // Raising the cost later must not lock anybody out, so an old hash is
    // upgraded on the next successful sign-in — the one moment the plaintext
    // is legitimately in hand.
    if (needsRehash(account.passwordHash)) {
      const upgraded: AccountRecord = {
        ...account,
        passwordHash: await hashPassword(input.password),
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.byId.set(account.accountId, upgraded);
      await this.persist();
      return { ok: true, account: upgraded };
    }
    return { ok: true, account };
  }

  /**
   * Invalidate every token this account has been issued.
   *
   * The only mechanism a stateless token has for revocation, so it is worth
   * more than the convenience of signing out one browser.
   */
  async signOutEverywhere(accountId: string): Promise<AccountRecord | null> {
    const account = this.byId.get(accountId);
    if (!account) return null;
    const updated: AccountRecord = {
      ...account,
      tokenVersion: account.tokenVersion + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

  private recordFailure(email: string): void {
    const current = this.failures.get(email) ?? { count: 0, until: 0 };
    const count = current.count + 1;
    this.failures.set(email, {
      count,
      until: count >= MAX_FAILED_ATTEMPTS ? this.now() + LOCKOUT_MS : 0,
    });
  }

  private async persist(): Promise<void> {
    const write = this.writing.then(() => this.records.save([...this.byId.values()]));
    this.writing = write.catch(() => {});
    await write;
  }
}
