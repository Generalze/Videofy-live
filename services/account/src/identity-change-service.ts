/**
 * Changing a verified email or phone number.
 *
 * The rules live in `@videofy-live/account-trust/identity-change`, which holds
 * no storage and sends no messages. This is the part that does both, and it
 * exists so a route cannot apply a change and quietly skip the notification --
 * the module hands back a list of effects, and every one of them is discharged
 * here in one place.
 *
 * THE ORDER IS THE SECURITY PROPERTY, and it is worth restating where the code
 * actually runs:
 *
 *   step up -> challenge the NEW address -> prove it -> replace -> warn the OLD
 *   address -> audit
 *
 * Nothing is replaced before it is proven, so a mistyped address cannot lock
 * somebody out of their own account and an unopened confirmation cannot hand an
 * attacker the change.
 */
import {
  beginIdentityChange,
  completeIdentityChange,
  createLinkToken,
  createOtpCode,
  type IdentityChannel,
  type SecurityEventSink,
  type VerificationDeliveryProvider,
} from '@videofy-live/account-trust';
import type { AccountStore } from './account-store.js';
import type { MfaService } from './mfa-service.js';
import { recordSecurity } from './security-log.js';
import { normalisePhone } from './verification.js';

export interface IdentityChangeDependencies {
  readonly store: AccountStore;
  readonly emailProvider: VerificationDeliveryProvider;
  readonly phoneProvider: VerificationDeliveryProvider;
  /**
   * Asked for the enrolment state rather than deriving it here.
   *
   * The MFA service owns what "enrolled" means, including the sealed-secret
   * handling. A second reading of the same record is a second definition, and
   * the two would disagree the day one of them is updated.
   */
  readonly mfa: MfaService;
  readonly security?: SecurityEventSink;
  readonly targetSalt?: string;
  readonly nowMs?: () => number;
}

export type BeginOutcome =
  | { readonly ok: true; readonly expiresAtMs: number; readonly synthetic: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-account'
        | 'invalid-target'
        | 'unchanged'
        | 'taken'
        | 'step-up-required'
        | 'delivery-failed';
    };

export type ConfirmChangeOutcome =
  | { readonly ok: true; readonly channel: IdentityChannel; readonly sessionsRevoked: boolean }
  | { readonly ok: false; readonly reason: 'unknown-account' | 'no-pending-change' | 'invalid' };

export class IdentityChangeService {
  private readonly nowMs: () => number;

  constructor(private readonly deps: IdentityChangeDependencies) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  private providerFor(channel: IdentityChannel): VerificationDeliveryProvider {
    return channel === 'email' ? this.deps.emailProvider : this.deps.phoneProvider;
  }

  /**
   * @param correlationId - Threaded in from the request rather than invented
   * here. It is what ties these events to the HTTP call that caused them, and
   * a value minted inside the service would tie them to nothing.
   */
  private audit(
    kind: Parameters<typeof recordSecurity>[1]['kind'],
    accountId: string,
    correlationId: string,
  ): void {
    if (!this.deps.security) return;
    recordSecurity(this.deps.security, {
      kind,
      correlationId,
      atMs: this.nowMs(),
      accountId,
      ...(this.deps.targetSalt ? { salt: this.deps.targetSalt } : {}),
    });
  }

  /**
   * Begin a change. Requires a fresh step-up BEFORE anything is sent.
   *
   * Demanding step-up first is what stops a stolen session from causing a
   * message to be delivered to an attacker-chosen address at all.
   */
  async begin(
    accountId: string,
    channel: IdentityChannel,
    rawTarget: string,
    correlationId: string,
  ): Promise<BeginOutcome> {
    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };

    const target =
      channel === 'email' ? normaliseEmail(rawTarget) : normalisePhone(rawTarget.trim());
    if (target === null) return { ok: false, reason: 'invalid-target' };

    /*
     * Refused EARLY when the address already belongs to somebody else, so a
     * message is never sent to an address the requester cannot own. This is not
     * the authoritative check -- applyIdentityChange re-checks under the account
     * lock, because between here and there is a gap two requests can both pass.
     */
    if (channel === 'email') {
      const holder = this.deps.store.findByEmail(target);
      if (holder && holder.accountId !== accountId) return { ok: false, reason: 'taken' };
    }

    const token = channel === 'email' ? createLinkToken() : createOtpCode();
    const start = beginIdentityChange({
      channel,
      currentTarget: channel === 'email' ? account.email : (account.phoneNumber ?? null),
      nextTarget: target,
      mfaState: this.deps.mfa.stateOf(accountId),
      evidence: this.deps.store.stepUpEvidenceOf(accountId),
      token,
      nowMs: this.nowMs(),
    });

    if (!start.ok) {
      if (start.reason === 'unchanged') return { ok: false, reason: 'unchanged' };
      this.audit('stepUp.required', accountId, correlationId);
      return { ok: false, reason: 'step-up-required' };
    }

    // Persisted BEFORE delivery. Delivering first and then failing to write
    // would send a token that can never be confirmed.
    await this.deps.store.setPendingIdentityChange(accountId, start.pending);

    const provider = this.providerFor(channel);
    const delivery = await provider
      .send({
        channel,
        target,
        token: start.token,
        expiresAtMs: start.pending.challenge.expiresAtMs,
      })
      .catch(() => ({ delivered: false, reference: null, synthetic: provider.synthetic }));

    if (!delivery.delivered) {
      /*
       * The pending change is CLEARED on a delivery failure. Left in place it
       * would block a retry as "unchanged" while its token was never sent --
       * an account stuck waiting for a message that does not exist.
       */
      await this.deps.store.setPendingIdentityChange(accountId, null);
      return { ok: false, reason: 'delivery-failed' };
    }

    this.audit('account.emailChangeRequested', accountId, correlationId);
    return {
      ok: true,
      expiresAtMs: start.pending.challenge.expiresAtMs,
      synthetic: delivery.synthetic,
    };
  }

  /**
   * Complete a change by presenting the token sent to the NEW address.
   *
   * Every failed attempt is written back, because the attempt counter on the
   * challenge is what makes a six-digit code acceptable at all -- discarding
   * the record on failure would make the code guessable without limit.
   */
  async confirm(
    accountId: string,
    token: string,
    correlationId: string,
  ): Promise<ConfirmChangeOutcome> {
    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };

    const pending = account.pendingIdentityChange ?? null;
    if (!pending) return { ok: false, reason: 'no-pending-change' };

    const completion = completeIdentityChange({
      pending,
      token,
      currentTarget: pending.channel === 'email' ? account.email : (account.phoneNumber ?? null),
      identityVerified: account.identityCase?.status === 'verified',
      nowMs: this.nowMs(),
    });

    if (!completion.ok) {
      await this.deps.store.setPendingIdentityChange(accountId, {
        ...pending,
        challenge: completion.challenge,
      });
      return { ok: false, reason: 'invalid' };
    }

    const applied = await this.deps.store.applyIdentityChange(accountId, completion.effects);
    if (!applied.ok) {
      // 'taken' is reported as invalid: the caller learning that an address is
      // registered to somebody else is an account-enumeration answer.
      return { ok: false, reason: applied.reason === 'not-found' ? 'unknown-account' : 'invalid' };
    }

    /*
     * WARNING THE OLD ADDRESS IS BEST EFFORT, and deliberately so. It is the
     * only message in this flow that reaches somebody who has NOT been
     * compromised, so it matters -- but a bounce must not roll back a change
     * the account holder legitimately made and already proved. A failure is
     * audited and the change stands.
     */
    const { notifyOldTarget, channel } = completion.effects;
    if (notifyOldTarget !== null) {
      const provider = this.providerFor(channel);
      const notified = await provider
        .notify({ channel, target: notifyOldTarget, changedAtMs: this.nowMs() })
        .catch(() => ({ delivered: false, reference: null, synthetic: provider.synthetic }));
      if (!notified.delivered) this.audit('provider.callbackFailed', accountId, correlationId);
    }

    this.audit(
      channel === 'email' ? 'account.emailChanged' : 'account.phoneChanged',
      accountId,
      correlationId,
    );
    if (completion.effects.revokeSessions) this.audit('sessions.revoked', accountId, correlationId);
    if (completion.effects.requiresIdentityReview) {
      this.audit('identity.reviewOpened', accountId, correlationId);
    }

    return { ok: true, channel, sessionsRevoked: completion.effects.revokeSessions };
  }
}

/** Lowercased and trimmed, or nothing. Matches how addresses are stored. */
function normaliseEmail(input: string): string | null {
  const compact = input.trim().toLowerCase();
  if (compact.length < 3 || compact.length > 320) return null;
  // Deliberately shallow. The authoritative test of an address is whether a
  // message sent to it arrives, which is exactly what this flow then does.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(compact) ? compact : null;
}
