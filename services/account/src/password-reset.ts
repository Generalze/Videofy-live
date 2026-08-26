/**
 * Password reset, wired.
 *
 * The domain rules live in packages/account-trust/src/account-recovery.ts and
 * have been tested since they were written; this is the part that had never
 * existed -- the service that persists a challenge, delivers a link, and
 * applies the new password.
 *
 * THE PUBLIC ANSWER NEVER VARIES. Every path through `request` returns the same
 * acknowledgement: unknown address, throttled address, delivery failure, real
 * account. The endpoint is unauthenticated and an attacker may ask about as
 * many addresses as they like, so anything that differed -- a status code, a
 * message, a measurably different response time -- would turn it into a
 * "does this person have an account here" oracle.
 */
import {
  beginPasswordReset,
  completePasswordReset,
  type RecoveryAcknowledgement,
} from '@videofy-live/account-trust';
import type { VerificationDeliveryProvider } from '@videofy-live/account-trust';
import type { AccountStore } from './account-store.js';

export interface PasswordResetDependencies {
  readonly store: AccountStore;
  readonly emailProvider: VerificationDeliveryProvider;
  readonly nowMs?: () => number;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
  /**
   * Registration's password policy, REQUIRED rather than optional.
   *
   * Optional, it gets omitted -- and a reset could then set a password that
   * signing up would have refused, so the weakest credential on the system
   * would be the one chosen by somebody who had just been compromised. A test
   * caught exactly that omission here, which is the argument for making it
   * impossible to leave out rather than easy to remember.
   */
  readonly rejectPassword: (password: string, email: string) => unknown;
}

export type ResetCompletionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid' | 'weak-password' | 'unknown-account' };

export class PasswordResetService {
  constructor(private readonly deps: PasswordResetDependencies) {}

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  /**
   * Begin a reset.
   *
   * Returns the acknowledgement and nothing else. The caller cannot learn
   * whether anything happened, which is the entire design.
   */
  async request(email: string): Promise<RecoveryAcknowledgement> {
    const account = this.deps.store.findByEmail(email);
    const started = beginPasswordReset({
      accountId: account?.accountId ?? null,
      target: account?.email ?? email.trim().toLowerCase(),
      previous: account?.passwordResetChallenge ?? null,
      nowMs: this.nowMs(),
    });

    if (started.effect === null) {
      /*
       * No account, or throttled. Counted so a flood is visible on the security
       * surface -- but the caller is told nothing, and the two cases are not
       * distinguished even in the event, because an event stream that separates
       * them recreates the oracle for anybody who can read it.
       */
      this.deps.onEvent?.('passwordReset.noEffect', {});
      return started.acknowledgement;
    }

    // PERSIST BEFORE DELIVERING. Delivering first and then failing to store
    // would send somebody a link that can never work, and they would retry
    // against a challenge that does not exist.
    await this.deps.store.setPasswordResetChallenge(
      started.effect.accountId,
      started.effect.challenge,
    );

    const delivery = await this.deps.emailProvider
      .send({
        channel: 'email',
        target: started.effect.challenge.target,
        token: started.effect.token,
        expiresAtMs: started.effect.challenge.expiresAtMs,
        /*
         * Without this the provider had no way to tell a reset from a
         * verification, so it sent the verification email: wrong subject,
         * wrong words, and a link to the verification page -- which refuses a
         * reset token, because the two live in deliberately separate fields.
         */
        purpose: 'password-reset',
      })
      .catch(() => ({ delivered: false, reference: null, synthetic: false }));

    this.deps.onEvent?.(
      delivery.delivered ? 'passwordReset.sent' : 'passwordReset.deliveryFailed',
      {},
    );
    return started.acknowledgement;
  }

  /**
   * Complete a reset.
   *
   * ONE refusal for every failure. Distinguishing expired from wrong from
   * already-used tells somebody probing links which of their guesses was
   * closest, and the person who legitimately clicked an old link needs the same
   * next step in all three cases: ask for a new one.
   */
  async complete(input: {
    email: string;
    token: string;
    password: string;
  }): Promise<ResetCompletionOutcome> {
    const account = this.deps.store.findByEmail(input.email);
    const challenge = account?.passwordResetChallenge ?? null;
    if (!account || !challenge) return { ok: false, reason: 'invalid' };

    const verdict = completePasswordReset({
      record: challenge,
      token: input.token,
      target: account.email,
      nowMs: this.nowMs(),
    });

    // The attempt counts whether or not it succeeded. A verifier that only
    // persists on success hands an attacker unlimited free guesses.
    await this.deps.store.setPasswordResetChallenge(account.accountId, verdict.challenge);
    if (!verdict.ok) {
      this.deps.onEvent?.('passwordReset.failed', { reason: verdict.reason });
      return { ok: false, reason: 'invalid' };
    }

    const rejection = this.deps.rejectPassword(input.password, account.email);
    if (rejection) return { ok: false, reason: 'weak-password' };

    const updated = await this.deps.store.completePasswordReset(account.accountId, input.password);
    if (!updated) return { ok: false, reason: 'unknown-account' };

    // completePasswordReset bumps tokenVersion, so every session issued before
    // this moment is now refused. That is the point: somebody resetting a
    // password often believes they are compromised.
    this.deps.onEvent?.('passwordReset.completed', { tokenVersion: updated.tokenVersion });
    return { ok: true };
  }
}
