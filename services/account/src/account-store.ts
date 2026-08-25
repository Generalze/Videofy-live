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
  INITIAL_TRUST,
  readTrust,
  resolveTrustState,
  type AccountTrust,
  type AccountTrustState,
  type ChallengeRecord,
  type IdentityCase,
} from '@videofy-live/account-trust';
import {
  describePasswordRejection,
  hashPassword,
  needsRehash,
  rejectPassword,
  verifyPassword,
} from './password.js';

/**
 * Which standard voice speaks this person's translated words.
 *
 * Asked once at sign-up rather than per call, because it is a fact about the
 * person rather than a per-conversation preference. Absent is allowed and means
 * "not stated": the call form keeps its own default rather than this guessing.
 */
export type AccountVoiceGender = 'male' | 'female';

export interface AccountRecord {
  readonly accountId: AccountId;
  readonly voiceGender?: AccountVoiceGender;
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
  /**
   * C7 trust, as COMPONENTS.
   *
   * Deliberately not a `verified` boolean. One flag cannot tell a confirmed
   * email apart from a matched identity document, cannot express a person whose
   * phone is done while their identity check is in review, and cannot be
   * revoked for one reason without discarding the others. It is also the field
   * that eventually gets set from a request body.
   *
   * Optional so records written before this existed still load; `readTrust`
   * turns anything missing or unrecognised into the SAFE value.
   */
  readonly trust?: AccountTrust;
  /**
   * The outstanding verification challenge per channel.
   *
   * Stored WITH the account rather than in memory, so restarting the service
   * does not silently invalidate every link and code already sent. It holds a
   * hash, never a token, so the record is useless to anyone who reads it.
   */
  readonly emailChallenge?: ChallengeRecord | null;
  readonly phoneChallenge?: ChallengeRecord | null;
  /** Set only once a phone number has been verified for this account. */
  readonly phoneNumber?: string;
  /**
   * The identity check, as a REFERENCE and an outcome.
   *
   * Never a document. What is kept here would be useless to anyone who stole
   * it: a case id, a provider handle, a status, a jurisdiction, timestamps.
   */
  readonly identityCase?: IdentityCase | null;
  /**
   * Provider callback event ids already applied.
   *
   * At-least-once delivery is normal, so the same event WILL arrive twice.
   * Bounded, because this list would otherwise grow forever on an account that
   * re-verifies; the age check refuses anything old enough to have fallen off.
   */
  readonly seenCallbackEvents?: readonly string[];
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

  /**
   * One promise chain per account.
   *
   * Serialises multi-step account mutations (e.g. MFA enrolment, verified email
   * change) so a check and its write cannot be interleaved with another
   * operation's. Keyed per account so two different accounts never wait on
   * each other.
   *
   * IT DOES FIX AN EXISTING BUG, contrary to what this comment first claimed.
   * The claim was that every mutation here is a synchronous read-modify-write
   * with no await in between. Most are. `authenticate` is not: it reads the
   * record, awaits two scrypt calls to verify and re-hash the password, and
   * then wrote back an object spread from the record it had read beforehand.
   * A `signOutEverywhere` landing in that window had its tokenVersion bump
   * silently reverted, so an attacker's tokens became valid again while the
   * account holder was told they were locked out. That path now goes through
   * this lock and re-reads inside it.
   *
   * It is also what the coming multi-step flows need -- MFA enrolment and
   * verified email change both span an await between read and write.
   */
  private readonly accountLocks = new Map<string, Promise<unknown>>();

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

  private withAccountLock<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.accountLocks.get(accountId) ?? Promise.resolve();
    // The chain must not break on a rejection, or one failed operation would
    // wedge every later one for that account.
    const next = previous.then(work, work);
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.accountLocks.set(accountId, settled);
    /*
     * Drop the entry once nothing is queued behind it, or this map grows by one
     * permanently-resolved promise for every account that ever signs in and is
     * never reclaimed for the life of the process.
     *
     * The compare before the delete is what makes it safe: if another operation
     * chained on in the meantime, the map holds ITS promise, not this one, and
     * removing that would hand the next caller a fresh chain and break the
     * serialisation this exists to provide.
     */
    void settled.then(() => {
      if (this.accountLocks.get(accountId) === settled) this.accountLocks.delete(accountId);
    });
    return next;
  }

  /**
   * Run a mutation under the account's critical section.
   *
   * This serialises multi-step flows so a read and its write cannot be
   * interleaved with another operation. Only same-account work serialises;
   * different accounts run concurrently.
   *
   * Internal: called only by multi-step flows that span an await between
   * reading a record and writing it back.
   */
  async withMutationLock<T>(
    accountId: string,
    mutation: (record: AccountRecord | null) => Promise<{ record: AccountRecord | null; result: T }>,
  ): Promise<T | null> {
    return this.withAccountLock(accountId, async () => {
      const record = this.byId.get(accountId) ?? null;
      const { record: updated, result } = await mutation(record);
      if (updated) {
        this.byId.set(accountId, updated);
        await this.persist();
      }
      return result;
    });
  }

  /**
   * The account's trust, normalised.
   *
   * Everything asks HERE rather than reading `record.trust` directly, so a
   * legacy record with no trust field and a corrupted one with a nonsense value
   * are both answered the same safe way.
   */
  trustOf(accountId: string): AccountTrust {
    const record = this.byId.get(accountId);
    return readTrust(record?.trust);
  }

  /**
   * Persist a challenge, or clear it by passing null.
   *
   * Internal: the verification flow owns this, and no route reaches it.
   */
  async setChallenge(
    accountId: string,
    channel: 'email' | 'phone',
    challenge: ChallengeRecord | null,
  ): Promise<AccountRecord | null> {
    const existing = this.byId.get(accountId);
    if (!existing) return null;
    const updated: AccountRecord = {
      ...existing,
      ...(channel === 'email' ? { emailChallenge: challenge } : { phoneChallenge: challenge }),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

  /** Persist the identity case, or clear it. Internal to the verification flow. */
  async setIdentityCase(
    accountId: string,
    identityCase: IdentityCase | null,
  ): Promise<AccountRecord | null> {
    const existing = this.byId.get(accountId);
    if (!existing) return null;
    const updated: AccountRecord = {
      ...existing,
      identityCase,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

  /** Find the account a provider callback belongs to. */
  findByProviderReference(providerReference: string): AccountRecord | null {
    for (const record of this.byId.values()) {
      if (record.identityCase?.providerReference === providerReference) return record;
    }
    return null;
  }

  /** Remember an applied callback event id, keeping the list bounded. */
  async rememberCallbackEvent(accountId: string, eventId: string): Promise<void> {
    const existing = this.byId.get(accountId);
    if (!existing) return;
    const seen = [...(existing.seenCallbackEvents ?? []), eventId].slice(-64);
    this.byId.set(accountId, { ...existing, seenCallbackEvents: seen });
    await this.persist();
  }

  /** Record a verified phone number once its challenge has been satisfied. */
  async setPhoneNumber(accountId: string, phoneNumber: string): Promise<AccountRecord | null> {
    const existing = this.byId.get(accountId);
    if (!existing) return null;
    const updated: AccountRecord = {
      ...existing,
      phoneNumber,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

  /** The derived overall state. There is no setter, because there is no field. */
  trustStateOf(accountId: string): AccountTrustState {
    return resolveTrustState(this.trustOf(accountId));
  }

  /**
   * Replace an account's trust components.
   *
   * Internal to the service: reached only from verification flows that have
   * already checked a token or a provider signature. No route hands a caller a
   * way into this.
   */
  async setTrust(accountId: string, trust: AccountTrust): Promise<AccountRecord | null> {
    const existing = this.byId.get(accountId);
    if (!existing) return null;
    const updated: AccountRecord = {
      ...existing,
      trust,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

  get(accountId: string): AccountRecord | null {
    return this.byId.get(accountId) ?? null;
  }

  async register(input: {
    email: string;
    password: string;
    voiceGender?: AccountVoiceGender;
  }): Promise<RegistrationResult> {
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
      // Only ever one of the two values, and only when explicitly chosen.
      ...(input.voiceGender === 'male' || input.voiceGender === 'female'
        ? { voiceGender: input.voiceGender }
        : {}),
      passwordHash: await hashPassword(input.password),
      tokenVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      // Registration creates an IDENTITY and nothing else. Every channel starts
      // unverified, so the derived state is `registered` -- not `verified`, and
      // not entitled to any product.
      trust: INITIAL_TRUST,
    };
    /*
     * RE-CHECKED after the await, immediately before the write.
     *
     * The check above happens before `hashPassword`, which takes tens of
     * milliseconds. Two registrations for the same address can both pass it,
     * both hash, and both write -- leaving two records in `byId` for one email
     * while `byEmail` points at only one of them. The orphan is unreachable by
     * sign-in and invisible to its owner, and the invariant the first check
     * exists to enforce is broken silently.
     *
     * The per-account lock cannot help here: there is no account id to key on
     * until after the race has already happened. What closes it is that this
     * re-check and the two writes below contain no await between them, so they
     * are one atomic section on a single-threaded runtime.
     */
    if (this.byEmail.has(email)) {
      return {
        ok: false,
        reason: 'already-exists',
        message: 'An account already exists for that email address.',
      };
    }
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
      /*
       * THE EXPENSIVE PART HAPPENS OUTSIDE THE LOCK, and the write happens
       * inside it against a FRESH read.
       *
       * This branch used to spread `...account` -- the record as it was before
       * two scrypt calls, tens of milliseconds each -- straight back into the
       * map. Anything that changed the account in that window was silently
       * reverted, and the case that matters is not a lost field: a person
       * reacting to a compromise presses sign out everywhere, tokenVersion is
       * bumped, and the stale write puts the OLD version back. Every token the
       * attacker holds starts working again while the screen says they are
       * locked out.
       *
       * Hashing does not depend on current record state, so it stays outside
       * the critical section and sign-ins do not serialise on it. Only the
       * read-modify-write is held, and it applies the new hash onto whatever
       * the record is NOW rather than onto a remembered copy.
       */
      const rehashed = await hashPassword(input.password);
      const upgraded = await this.withMutationLock<AccountRecord | null>(
        account.accountId,
        async (current) => {
          if (!current) return { record: null, result: null };
          const next: AccountRecord = {
            ...current,
            passwordHash: rehashed,
            updatedAt: new Date(this.now()).toISOString(),
          };
          return { record: next, result: next };
        },
      );
      // A null here means the account vanished mid-sign-in (closed, or removed
      // by an administrator). The credential was still correct, so the caller
      // is told what it verified rather than being handed a fabricated record.
      return { ok: true, account: upgraded ?? account };
    }
    return { ok: true, account };
  }

  /**
   * Invalidate every token this account has been issued.
   *
   * The only mechanism a stateless token has for revocation, so it is worth
   * more than the convenience of signing out one browser.
   */
  /** Change which standard voice speaks this person's translated words. */
  async setVoiceGender(
    accountId: string,
    voiceGender: AccountVoiceGender,
  ): Promise<AccountRecord | null> {
    const account = this.byId.get(accountId);
    if (!account) return null;
    const updated: AccountRecord = {
      ...account,
      voiceGender,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.byId.set(accountId, updated);
    await this.persist();
    return updated;
  }

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
