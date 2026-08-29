/**
 * MFA enrolment, and the storage boundary mfa.ts has always claimed.
 *
 * `packages/account-trust/src/mfa.ts` has said since it was written that "the
 * storage boundary encrypts it", and no such boundary existed -- because
 * nothing persisted an enrolment at all. This is that boundary.
 *
 * THE SECRET IS SEALED BEFORE IT IS STORED. A TOTP secret is a bearer
 * credential: anybody holding it mints valid codes forever, so a stolen
 * database must not yield working second factors. It is encrypted with
 * AES-256-GCM under a deployment key, and the key lives in configuration rather
 * than beside the data it protects.
 *
 * THE SECRET IS READABLE EXACTLY ONCE, during enrolment, so the otpauth URI can
 * be shown. After confirmation nothing returns it -- not this service, not any
 * route, not an error message. Somebody who loses their authenticator uses a
 * recovery code; there is no "show me my secret again".
 */
import {
  INITIAL_MFA,
  consumeRecoveryCode,
  createKeyring,
  createRecoveryCodes,
  createTotpSecret,
  open,
  seal,
  totpEnrolmentUri,
  verifyTotp,
  type Keyring,
  type KeyringEntryInput,
  type MfaEnrolment,
  type MfaState,
} from '@videofy-live/account-trust';
import type { AccountStore } from './account-store.js';

/**
 * Parse the keyring from configuration.
 *
 * Format: `keyId:hexOrBase64Key:current,keyId2:hexOrBase64Key2`
 *
 * A LIST rather than a single key, because rotation has to be possible from the
 * first day. A design with one key cannot be rotated without re-encrypting
 * every record while the service is running, and that migration is written
 * under pressure or never.
 */
export function readMfaKeyring(value: string | undefined): Keyring | null {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) return null;

  const entries: KeyringEntryInput[] = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry, index) => {
      const [keyId, key, marker] = entry.split(':');
      if (!keyId || !key) {
        // A malformed entry must not silently become a smaller keyring: the
        // record sealed under the missing key would stop opening, and the
        // symptom is somebody locked out of their own second factor.
        //
        // Named by POSITION and LENGTH, never by a prefix: a short keyId puts
        // key material inside the first twelve characters, and this message
        // lands in the boot log. Founder ruling (29 Aug 2026): no token prefix
        // is ever printed.
        throw new Error(
          `C7_MFA_KEYRING entry ${index + 1} (${entry.length} characters) is not keyId:key[:current].`,
        );
      }
      return { keyId, key, ...(marker === 'current' ? { current: true } : {}) };
    });

  // createKeyring throws on zero entries, duplicate ids, no current, more than
  // one current, and any key of the wrong length. All of those are boot-time
  // configuration errors and none of them should be discovered on first use.
  return createKeyring(entries);
}

export type EnrolmentStart =
  | {
      readonly ok: true;
      /** Shown once, scanned once. Contains the secret by design. */
      readonly otpauthUri: string;
      /** Shown once. Only their hashes are stored. */
      readonly recoveryCodes: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'already-enrolled' | 'unknown-account' };

export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-enrolling' | 'wrong-code' | 'unknown-account' };

export interface MfaDependencies {
  readonly store: AccountStore;
  readonly keyring: Keyring;
  /** Pepper for recovery-code hashes. At least 32 characters; mfa.ts refuses less. */
  readonly recoveryPepper: string;
  readonly issuer?: string;
  readonly nowMs?: () => number;
}

export class MfaService {
  constructor(private readonly deps: MfaDependencies) {}

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  /** The enrolment as stored, with the secret still sealed. */
  private enrolmentOf(accountId: string): MfaEnrolment | null {
    const stored = this.deps.store.get(accountId)?.mfa;
    return stored ?? null;
  }

  stateOf(accountId: string): MfaState {
    return this.enrolmentOf(accountId)?.state ?? 'none';
  }

  /**
   * Begin enrolment: mint a secret, seal it, and return what must be shown once.
   *
   * The enrolment is stored as `enrolling`, which grants nothing. Only
   * confirming a live code moves it to `active`, so somebody who starts
   * enrolment and abandons it has not weakened anything and has not locked
   * themselves into a factor they never scanned.
   */
  async begin(accountId: string, accountEmail: string): Promise<EnrolmentStart> {
    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };
    if (this.stateOf(accountId) === 'active') {
      // Re-enrolling would silently invalidate the factor they are still using.
      // Disabling first is a deliberate act that requires step-up.
      return { ok: false, reason: 'already-enrolled' };
    }

    const secret = createTotpSecret();
    const { codes, hashes } = createRecoveryCodes(this.deps.recoveryPepper);
    const sealed = seal(this.deps.keyring, secret);

    await this.deps.store.setMfa(accountId, {
      ...INITIAL_MFA,
      state: 'enrolling',
      // The stored secret is the ENVELOPE, serialised. Nothing downstream can
      // use it without the keyring, which is the whole point.
      secret: JSON.stringify(sealed),
      createdAtMs: this.nowMs(),
      recoveryCodeHashes: hashes,
    });

    return {
      ok: true,
      otpauthUri: totpEnrolmentUri({
        secret,
        accountEmail,
        issuer: this.deps.issuer ?? 'Consummate 7',
      }),
      recoveryCodes: codes,
    };
  }

  /**
   * Confirm enrolment with a live code.
   *
   * Proves the authenticator actually holds the secret before the factor starts
   * being required. Without this step somebody could enrol, mis-scan, and lock
   * themselves out of every step-up operation with a factor that never worked.
   */
  async confirm(accountId: string, code: string): Promise<ConfirmOutcome> {
    const enrolment = this.enrolmentOf(accountId);
    if (!enrolment) return { ok: false, reason: 'unknown-account' };
    if (enrolment.state !== 'enrolling') return { ok: false, reason: 'not-enrolling' };

    const secret = this.unseal(enrolment.secret);
    if (secret === null) return { ok: false, reason: 'wrong-code' };
    if (!verifyTotp(secret, code, this.nowMs())) return { ok: false, reason: 'wrong-code' };

    await this.deps.store.setMfa(accountId, {
      ...enrolment,
      state: 'active',
      confirmedAtMs: this.nowMs(),
    });
    return { ok: true };
  }

  /** Verify a code against an ACTIVE enrolment. Used by step-up. */
  verify(accountId: string, code: string): boolean {
    const enrolment = this.enrolmentOf(accountId);
    if (!enrolment || enrolment.state !== 'active') return false;
    const secret = this.unseal(enrolment.secret);
    if (secret === null) return false;
    return verifyTotp(secret, code, this.nowMs());
  }

  /**
   * Spend a recovery code.
   *
   * Single use: the hash is removed rather than counted, so the same code can
   * never be presented twice.
   */
  async consumeRecovery(accountId: string, code: string): Promise<boolean> {
    const enrolment = this.enrolmentOf(accountId);
    if (!enrolment || enrolment.state !== 'active') return false;
    const outcome = consumeRecoveryCode(enrolment, code, this.deps.recoveryPepper);
    if (!outcome.ok) return false;
    await this.deps.store.setMfa(accountId, outcome.next);
    return true;
  }

  /** Turn the factor off. The caller is responsible for demanding step-up first. */
  async disable(accountId: string): Promise<void> {
    await this.deps.store.setMfa(accountId, null);
  }

  /**
   * Open a sealed secret, or null.
   *
   * Returns null for every failure -- unknown key, tampering, malformed
   * envelope -- because the caller's only sensible response to all of them is
   * to refuse the code. The DISTINCTION still matters operationally and is
   * preserved inside secret-box; it simply has no bearing on whether this
   * particular sign-in proceeds.
   */
  private unseal(stored: string): string | null {
    let envelope: unknown;
    try {
      envelope = JSON.parse(stored);
    } catch {
      return null;
    }
    const opened = open(this.deps.keyring, envelope);
    return opened.ok ? opened.plaintext : null;
  }
}
