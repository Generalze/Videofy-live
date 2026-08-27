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
  recordConsent,
  resolveTrustState,
  type AccountTrust,
  type AccountTrustState,
  type ChallengeRecord,
  type ConsentRecord,
  type IdentityCase,
  type MfaEnrolment,
  type PolicyType,
  type StepUpEvidence,
  type PendingIdentityChange,
  type IdentityChangeEffects,
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

/**
 * The language this person's calls ENTER with -- speak and hear preload on
 * the join form, both changeable per call. Matches call-client-core's
 * CallLanguage union; kept as its own type because account and call are
 * separate bounded contexts that happen to agree today.
 */
export type AccountDefaultLanguage = 'en' | 'es' | 'fr';

export interface AccountRecord {
  readonly accountId: AccountId;
  readonly voiceGender?: AccountVoiceGender;
  readonly defaultLanguage?: AccountDefaultLanguage;
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
  /**
   * The outstanding password reset, if any.
   *
   * A SEPARATE FIELD from emailChallenge, deliberately. They are different
   * grants with different lifetimes: one proves you can read an address, the
   * other replaces the credential to an account. Sharing a field would let a
   * verification token complete a reset, and the wrong-target check in
   * verifyChallenge would not catch it because the target is the same address.
   */
  readonly passwordResetChallenge?: ChallengeRecord | null;
  /**
   * Policy acceptances, as versioned facts.
   *
   * Never a boolean. A stored `acceptedTerms: true` records that somebody once
   * agreed to something and loses which document and when -- the only two
   * details ever asked for afterwards.
   */
  readonly consents?: readonly ConsentRecord[];
  /**
   * The second factor, with its secret SEALED.
   *
   * `mfa.secret` is an encrypted envelope, never the TOTP secret itself. That
   * is what makes the comment in mfa.ts -- "the storage boundary encrypts it"
   * -- true rather than aspirational.
   */
  readonly mfa?: MfaEnrolment | null;
  /**
   * When a second factor was last satisfied, and by what.
   *
   * Server-side rather than a token claim, so it can be cleared the instant
   * anything changes. A claim inside a signed token survives until it expires,
   * which means a step-up obtained a minute before an account was suspended
   * would keep working.
   */
  readonly stepUpAtMs?: number | null;
  readonly stepUpMethod?: string | null;
  /**
   * A change of verified email or phone, authorised but not yet applied.
   *
   * SEPARATE from `email` and `phoneNumber` for its whole life. The old address
   * stays authoritative until the new one has been proven, so that a mistyped
   * address cannot lock somebody out and an unopened confirmation cannot hand
   * an attacker the account.
   */
  readonly pendingIdentityChange?: PendingIdentityChange | null;
  /**
   * The handle somebody is ADDED by. Unique on its key, never on its spelling.
   *
   * Separate from displayName because a display name is free text: if people
   * were added by it, a fraudster sets theirs to match somebody trusted and
   * gets added by mistake.
   */
  readonly username?: string;
  /** The folded form the uniqueness index is on. See packages/account-trust/username.ts. */
  readonly usernameKey?: string;
  /** The label shown in calls and rosters. Resolves to nobody. */
  readonly displayName?: string;
  /**
   * Whether this account can be found by username at all.
   *
   * PRIVATE BY DEFAULT, and read through readDiscoveryMode so anything that
   * is not exactly 'discoverable' -- a null, a typo, a value from a future
   * version -- resolves to private rather than to findable.
   */
  readonly discoveryMode?: string;
}

export interface AccountRecordPort {
  /**
   * Every record, once, at boot.
   *
   * The store keeps an in-memory index and this fills it. That is honest at
   * current scale and is the thing to revisit first when it stops being: it
   * means startup time grows with the account count, and it means two service
   * instances would each hold their own copy and drift apart. Durability is
   * what this port provides; multi-instance correctness is a different change.
   */
  load(): Promise<readonly AccountRecord[]>;
  /**
   * Insert or replace ONE record.
   *
   * Deliberately not `save(allRecords)`, which is what this was. Rewriting
   * every account to change one is an artefact of a JSON file being the only
   * store -- against a database it is a full table rewrite per sign-in, and it
   * scales by getting slower for everybody every time somebody registers.
   */
  upsert(record: AccountRecord): Promise<void>;
}

export function createEphemeralAccountRecords(): AccountRecordPort {
  return { load: async () => [], upsert: async () => {} };
}

export type RegistrationResult =
  | { readonly ok: true; readonly account: AccountRecord }
  | { readonly ok: false; readonly reason: 'invalid-email' | 'weak-password' | 'already-exists' | 'username-taken' | 'username-previously-used'; readonly message: string };

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

/** The outcome of claiming a username. */
export type UsernameClaim =
  | { readonly ok: true; readonly record: AccountRecord }
  | { readonly ok: false; readonly reason: 'unknown-account' | 'taken' | 'previously-used' };

/** The outcome of applying a proven identity change. */
export type IdentityChangeApplication =
  | { readonly ok: true; readonly record: AccountRecord }
  | { readonly ok: false; readonly reason: 'not-found' | 'taken' };

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
  /**
   * Every username ever released, and the account that held it.
   *
   * In memory alongside the account index, which is honest at current scale and
   * is the thing to revisit with it: this is durable in Postgres and rebuilt at
   * boot, exactly like the account index above.
   */
  private readonly releasedUsernames = new Map<string, string>();

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
        await this.persist(updated);
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
    await this.persist(updated);
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
    await this.persist(updated);
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
    const updated: AccountRecord = { ...existing, seenCallbackEvents: seen };
    this.byId.set(accountId, updated);
    await this.persist(updated);
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
    await this.persist(updated);
    return updated;
  }

  /** Find an account by its normalised address, or null. */
  findByEmail(email: string): AccountRecord | null {
    const accountId = this.byEmail.get(normaliseEmail(email));
    return accountId ? (this.byId.get(accountId) ?? null) : null;
  }

  /** Persist or clear the outstanding password reset. */
  async setPasswordResetChallenge(
    accountId: string,
    challenge: ChallengeRecord | null,
  ): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        passwordResetChallenge: challenge,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /**
   * Replace the password and end every existing session, in ONE step.
   *
   * The three writes belong together and are done under the account lock
   * against a fresh read. Somebody resetting a password is frequently somebody
   * who believes they are compromised: setting the new hash while leaving the
   * old sessions alive means the attacker keeps their access and can no longer
   * be locked out, which inverts the whole point. Clearing the challenge in the
   * same step is what makes the reset single-use even if the same link is
   * opened twice.
   */
  async completePasswordReset(
    accountId: string,
    password: string,
  ): Promise<AccountRecord | null> {
    // Hashing is expensive and does not depend on current record state, so it
    // happens outside the critical section -- the same shape as the rehash on
    // sign-in.
    const passwordHash = await hashPassword(password);
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        passwordHash,
        tokenVersion: current.tokenVersion + 1,
        passwordResetChallenge: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /**
   * Hold a change that has been authorised but not yet proven.
   *
   * Written to its own field, never to `email` or `phoneNumber`. See the note
   * on the record field: the old address stays authoritative until the new one
   * is confirmed, which is what stops a typo locking somebody out and stops an
   * unopened confirmation handing over the account.
   */
  async setPendingIdentityChange(
    accountId: string,
    pending: PendingIdentityChange | null,
  ): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        pendingIdentityChange: pending,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /**
   * Apply a proven identity change, in ONE step.
   *
   * Every one of these writes belongs to the same decision and none of them is
   * safe to land without the others:
   *
   *   - the address is replaced, and the pending change is cleared, so the
   *     same confirmation cannot be replayed;
   *   - sessions are revoked when the recovery path moved, because a change of
   *     email is exactly when to end an attacker's access rather than the
   *     moment to leave it running;
   *   - the step-up grant is consumed, so one re-authentication buys one
   *     sensitive operation and not a window of them;
   *   - an identity check is reopened for review, because a verification of
   *     contact details that have since changed is a verification of facts
   *     that no longer hold.
   *
   * EMAIL UNIQUENESS IS RE-CHECKED HERE, inside the lock and with no await
   * between the check and the write. Checked only at the start of the flow it
   * would be a time-of-check/time-of-use gap wide enough for two accounts to
   * claim one address -- the same shape as the one register() closes.
   */
  async applyIdentityChange(
    accountId: string,
    effects: IdentityChangeEffects,
  ): Promise<IdentityChangeApplication> {
    const outcome = await this.withMutationLock<IdentityChangeApplication>(accountId, async (current) => {
      if (!current) {
        return { record: null, result: { ok: false as const, reason: 'not-found' as const } };
      }

      if (effects.channel === 'email') {
        const holder = this.findByEmail(effects.nextTarget);
        if (holder && holder.accountId !== accountId) {
          return { record: null, result: { ok: false as const, reason: 'taken' as const } };
        }
      }

      const nowMs = this.now();
      const identityCase =
        effects.requiresIdentityReview && current.identityCase
          ? {
              ...current.identityCase,
              reviewOpenedAtMs: current.identityCase.reviewOpenedAtMs ?? nowMs,
              updatedAtMs: nowMs,
            }
          : current.identityCase;

      const updated: AccountRecord = {
        ...current,
        ...(effects.channel === 'email'
          ? { email: effects.nextTarget }
          : { phoneNumber: effects.nextTarget }),
        pendingIdentityChange: null,
        tokenVersion: effects.revokeSessions ? current.tokenVersion + 1 : current.tokenVersion,
        // Consumed either way. The grant paid for THIS change.
        stepUpAtMs: null,
        stepUpMethod: null,
        ...(identityCase === undefined ? {} : { identityCase }),
        updatedAt: new Date(nowMs).toISOString(),
      };
      return { record: updated, result: { ok: true as const, record: updated } };
    });
    /*
     * withMutationLock is typed `T | null` although its body always returns the
     * mutation's result. Treated as not-found rather than asserted away: if that
     * signature is ever narrowed this line simply becomes dead, whereas a `!`
     * would become a crash.
     */
    return outcome ?? { ok: false, reason: 'not-found' };
  }

  /**
   * The account holding a username, matched on its folded key.
   *
   * Looked up by KEY, never by spelling, so `zoemeak` and `z0emeak` find the
   * same person rather than one finding nobody.
   */
  findByUsernameKey(key: string): AccountRecord | null {
    for (const record of this.byId.values()) {
      if (record.usernameKey === key) return record;
    }
    return null;
  }

  /** Whether a key was ever released, and by whom. */
  releasedUsernameHolder(key: string): string | null {
    return this.releasedUsernames.get(key) ?? null;
  }

  /**
   * Claim a username.
   *
   * THE UNIQUENESS CHECK IS INSIDE THE LOCK AND HAS NO AWAIT BEFORE THE WRITE.
   * Checked outside it, two requests naming the same handle both pass and both
   * write, and the loser only discovers it when somebody adds the wrong person
   * -- the same time-of-check gap register() already closes.
   *
   * NEVER REUSED, with one exception. A released handle is a ready-made
   * impersonation of whoever held it, so it stays claimed forever -- except by
   * the account that held it, which carries no impersonation risk and would
   * otherwise punish the one person the rule is not aimed at.
   */
  async claimUsername(
    accountId: string,
    username: string,
    key: string,
  ): Promise<UsernameClaim> {
    const outcome = await this.withMutationLock<UsernameClaim>(accountId, async (current) => {
      if (!current) {
        return { record: null, result: { ok: false as const, reason: 'unknown-account' as const } };
      }
      if (current.usernameKey === key) {
        // Same claim, possibly a different spelling. Idempotent rather than a
        // refusal: a retried request must not report a conflict with itself.
        const updated: AccountRecord = {
          ...current,
          username,
          updatedAt: new Date(this.now()).toISOString(),
        };
        return { record: updated, result: { ok: true as const, record: updated } };
      }

      const holder = this.findByUsernameKey(key);
      if (holder && holder.accountId !== accountId) {
        return { record: null, result: { ok: false as const, reason: 'taken' as const } };
      }

      const previouslyHeldBy = this.releasedUsernames.get(key);
      if (previouslyHeldBy !== undefined && previouslyHeldBy !== accountId) {
        return {
          record: null,
          result: { ok: false as const, reason: 'previously-used' as const },
        };
      }

      /*
       * The OLD key is released in the same step. Done separately it could be
       * skipped by a crash between the two writes, leaving a handle that is
       * held by nobody and claimable by anybody -- which is precisely the
       * impersonation the never-reuse rule exists to stop.
       */
      if (current.usernameKey) this.releasedUsernames.set(current.usernameKey, accountId);
      this.releasedUsernames.delete(key);

      const updated: AccountRecord = {
        ...current,
        username,
        usernameKey: key,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: { ok: true as const, record: updated } };
    });
    return outcome ?? { ok: false, reason: 'unknown-account' };
  }

  /**
   * Opt into, or out of, being findable by username.
   *
   * Stored as given and read through readDiscoveryMode, which treats anything
   * that is not exactly 'discoverable' as private -- so a null, a typo and a
   * value from a future version all fail toward not being found.
   */
  async setDiscoveryMode(accountId: string, mode: string): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        discoveryMode: mode,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /**
   * Why a handle is unavailable, or null when it is free.
   *
   * ONE implementation, used by registration and by a later change. Two
   * implementations of "is this handle free" is two chances to disagree, and
   * the disagreement is an account somebody else can be mistaken for.
   *
   * @param forAccountId - The account asking. Its own current handle and its
   * own released handles do not block it.
   */
  private usernameConflict(
    key: string,
    forAccountId: string | null,
  ): 'username-taken' | 'username-previously-used' | null {
    const holder = this.findByUsernameKey(key);
    if (holder && holder.accountId !== forAccountId) return 'username-taken';

    const previouslyHeldBy = this.releasedUsernames.get(key);
    if (previouslyHeldBy !== undefined && previouslyHeldBy !== forAccountId) {
      return 'username-previously-used';
    }
    return null;
  }

  /** The language this person's calls enter with. See AccountDefaultLanguage. */
  async setDefaultLanguage(
    accountId: string,
    defaultLanguage: AccountDefaultLanguage,
  ): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        defaultLanguage,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /** Set the label shown in calls. Carries no uniqueness and resolves to nobody. */
  async setDisplayName(accountId: string, displayName: string): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        displayName,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /** Record one policy acceptance, keeping every superseded version. */
  async acceptPolicy(
    accountId: string,
    policyType: PolicyType,
    policyVersion: string,
  ): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const held = recordConsent({
        held: current.consents ?? [],
        accountId,
        policyType,
        policyVersion,
        nowMs: this.now(),
      });
      const updated: AccountRecord = {
        ...current,
        consents: held,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /** Store or clear the MFA enrolment. */
  async setMfa(accountId: string, mfa: MfaEnrolment | null): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        mfa,
        // Disabling the factor also clears any grant it produced. Otherwise
        // somebody who stepped up and then removed MFA would keep a live
        // step-up for its full freshness window with no second factor behind it.
        ...(mfa === null ? { stepUpAtMs: null, stepUpMethod: null } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /** Record that a second factor was just satisfied. */
  async grantStepUp(
    accountId: string,
    method: 'totp' | 'recovery-code',
  ): Promise<AccountRecord | null> {
    return this.withMutationLock<AccountRecord | null>(accountId, async (current) => {
      if (!current) return { record: null, result: null };
      const updated: AccountRecord = {
        ...current,
        stepUpAtMs: this.now(),
        stepUpMethod: method,
        updatedAt: new Date(this.now()).toISOString(),
      };
      return { record: updated, result: updated };
    });
  }

  /**
   * The step-up evidence for this account, in the shape satisfiesStepUp wants.
   *
   * Freshness is decided by satisfiesStepUp, not here: one place decides how
   * old is too old, and this only reports what is stored.
   */
  stepUpEvidenceOf(accountId: string): StepUpEvidence {
    const record = this.byId.get(accountId);
    const method = record?.stepUpMethod;
    return {
      verifiedAtMs: record?.stepUpAtMs ?? null,
      method:
        method === 'totp' || method === 'recovery-code' || method === 'password'
          ? method
          : null,
    };
  }

  /** What this account has accepted. Always a list. */
  consentsOf(accountId: string): readonly ConsentRecord[] {
    return this.byId.get(accountId)?.consents ?? [];
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
    await this.persist(updated);
    return updated;
  }

  get(accountId: string): AccountRecord | null {
    return this.byId.get(accountId) ?? null;
  }

  /**
   * Create an account, and claim its handle in the same atomic section.
   *
   * WHY THE HANDLE IS CHOSEN HERE rather than afterwards. Left until later,
   * people forget, and an account with no handle cannot be added by anybody --
   * it exists and is unreachable. Auto-assigning instead is worse under the
   * never-reuse rule: the first thing somebody does with a handle they did not
   * choose is change it, and that burns the original forever.
   */
  async register(input: {
    email: string;
    password: string;
    voiceGender?: AccountVoiceGender;
    /** The handle, already shape-checked. Both halves or neither. */
    username?: string;
    usernameKey?: string;
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

    /*
     * Checked before the hash, like the email above, so an obviously taken
     * handle does not cost tens of milliseconds of scrypt. Re-checked with it
     * below, because this check is separated from the write by that hash.
     */
    if (input.usernameKey !== undefined) {
      const conflict = this.usernameConflict(input.usernameKey, null);
      if (conflict) return { ok: false, reason: conflict, message: 'That username is not available.' };
    }

    const timestamp = new Date(this.now()).toISOString();
    const account: AccountRecord = {
      accountId: createAccountId(this.newAccountSuffix),
      email,
      ...(input.username !== undefined && input.usernameKey !== undefined
        ? { username: input.username, usernameKey: input.usernameKey }
        : {}),
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
    /*
     * The handle is re-checked in the SAME no-await section as the email, for
     * the same reason: two registrations naming one handle can both pass the
     * early check, both hash, and both write. Two accounts sharing a handle is
     * precisely the impersonation the whole design exists to prevent, so it
     * cannot be allowed to happen even once.
     */
    if (input.usernameKey !== undefined) {
      const conflict = this.usernameConflict(input.usernameKey, null);
      if (conflict) return { ok: false, reason: conflict, message: 'That username is not available.' };
    }
    this.byId.set(account.accountId, account);
    this.byEmail.set(email, account.accountId);
    await this.persist(account);
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
    await this.persist(updated);
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
    await this.persist(updated);
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

  /**
   * Write one record through to the store.
   *
   * Still serialised on `writing`, so two writes cannot land out of order and
   * leave the durable copy describing a state that never existed. The chain is
   * global rather than per-account on purpose: it is about ordering writes to
   * the same backing store, which the per-account lock -- about ordering
   * read-modify-write sequences -- does not and should not do.
   */
  private async persist(record: AccountRecord): Promise<void> {
    const write = this.writing.then(() => this.records.upsert(record));
    this.writing = write.catch(() => {});
    await write;
  }
}
