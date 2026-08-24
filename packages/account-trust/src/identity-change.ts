/**
 * Changing a verified email or phone number.
 *
 * WHY THIS IS NOT A PROFILE EDIT. A verified address is not a display
 * preference — it is the thing password reset is sent to. An attacker holding a
 * live session and nothing else can, if this is treated as an ordinary field
 * update, point recovery at an address they control and own the account
 * permanently. Every later control depends on this one being right.
 *
 * THE ORDER IS THE SECURITY PROPERTY:
 *
 *   1. step up  ->  2. verify the NEW address  ->  3. replace  ->  4. notify
 *      the old address  ->  5. audit
 *
 * Replacing before verifying is the common mistake: it locks the person out of
 * their own account the moment they mistype, and it hands an attacker the
 * change even when the confirmation is never opened. So the new address is
 * proven first and the old one stays authoritative until the instant it is
 * superseded.
 *
 * NOTIFYING THE OLD ADDRESS is what makes a silent takeover loud. It is the
 * only step that reaches somebody who has NOT been compromised, and it is sent
 * on a best-effort basis: a bounce must not roll back a change the account
 * holder legitimately made and already proved.
 */
import { satisfiesStepUp, type MfaState, type StepUpEvidence } from './mfa.js';
import {
  EMAIL_POLICY,
  PHONE_POLICY,
  issueChallenge,
  verifyChallenge,
  type ChallengeRecord,
} from './verification-token.js';

export type IdentityChannel = 'email' | 'phone';

export type IdentityChangeRefusal =
  | 'mfa-required'
  | 'step-up-required'
  | 'stale'
  | 'unchanged'
  | 'expired'
  | 'consumed'
  | 'too-many-attempts'
  | 'mismatch'
  | 'wrong-target';

/**
 * A change that has been authorised but NOT yet applied.
 *
 * Held separately from the account's live address for the whole of its life.
 * The moment a pending change is stored in the same field as the verified one,
 * something downstream reads it as authoritative.
 */
export interface PendingIdentityChange {
  readonly channel: IdentityChannel;
  /** The address being moved TO. Not yet trusted for anything. */
  readonly target: string;
  readonly challenge: ChallengeRecord;
  readonly requestedAtMs: number;
}

export type IdentityChangeStart =
  | {
      readonly ok: true;
      readonly pending: PendingIdentityChange;
      /** For delivery to the NEW address only. Never to the old one. */
      readonly token: string;
    }
  | { readonly ok: false; readonly reason: IdentityChangeRefusal };

/**
 * Begin a change: require step-up, then challenge the new address.
 *
 * Step-up is demanded BEFORE anything is sent, so a stolen session cannot even
 * cause a message to be delivered to an attacker-chosen address.
 */
export function beginIdentityChange(input: {
  channel: IdentityChannel;
  currentTarget: string | null;
  nextTarget: string;
  mfaState: MfaState;
  evidence: StepUpEvidence;
  token: string;
  nowMs: number;
}): IdentityChangeStart {
  const stepUp = satisfiesStepUp({
    operation: input.channel === 'email' ? 'account.changeEmail' : 'account.changePhone',
    mfaState: input.mfaState,
    evidence: input.evidence,
    nowMs: input.nowMs,
  });
  if (!stepUp.ok) return { ok: false, reason: stepUp.reason };

  const next = input.nextTarget.trim().toLowerCase();
  // A no-op change still costs a message and still notifies the old address,
  // which trains people to ignore exactly the warning that matters.
  if (input.currentTarget !== null && input.currentTarget.trim().toLowerCase() === next) {
    return { ok: false, reason: 'unchanged' };
  }

  const policy = input.channel === 'email' ? EMAIL_POLICY : PHONE_POLICY;
  const challenge = issueChallenge({
    channel: input.channel,
    token: input.token,
    target: next,
    nowMs: input.nowMs,
    policy,
  });

  return {
    ok: true,
    token: input.token,
    pending: {
      channel: input.channel,
      target: next,
      challenge,
      requestedAtMs: input.nowMs,
    },
  };
}

/**
 * What the caller must do once a change is confirmed.
 *
 * Returned as instructions rather than performed here, because this package
 * holds no storage and sends no messages. Making them explicit means a route
 * cannot apply the change and quietly skip the notification.
 */
export interface IdentityChangeEffects {
  readonly channel: IdentityChannel;
  /** The address that becomes authoritative. */
  readonly nextTarget: string;
  /** The address to warn. Null when there was nothing verified before. */
  readonly notifyOldTarget: string | null;
  /**
   * Whether the change invalidates existing sessions.
   *
   * A changed email is a recovery-path change, so sessions are revoked: if this
   * was an attacker, the change is exactly when to end their access rather than
   * the moment to leave it running.
   */
  readonly revokeSessions: boolean;
  /**
   * Whether the identity check must be looked at again.
   *
   * Changing the contact details behind a verified identity is a MATERIAL
   * change, and a verification that survives it unexamined is a verification of
   * facts that no longer hold.
   */
  readonly requiresIdentityReview: boolean;
}

export type IdentityChangeCompletion =
  | { readonly ok: true; readonly challenge: ChallengeRecord; readonly effects: IdentityChangeEffects }
  | { readonly ok: false; readonly reason: IdentityChangeRefusal; readonly challenge: ChallengeRecord };

/**
 * Complete a change by presenting the token sent to the NEW address.
 *
 * `verifyChallenge` carries the essential guard: a token issued for one target
 * cannot confirm another, so a pending change-of-address challenge can never be
 * redirected onto the address it was meant to replace.
 */
export function completeIdentityChange(input: {
  pending: PendingIdentityChange;
  token: string;
  currentTarget: string | null;
  identityVerified: boolean;
  nowMs: number;
}): IdentityChangeCompletion {
  const policy = input.pending.channel === 'email' ? EMAIL_POLICY : PHONE_POLICY;
  const verdict = verifyChallenge({
    record: input.pending.challenge,
    token: input.token,
    target: input.pending.target,
    nowMs: input.nowMs,
    policy,
  });

  if (!verdict.ok) return { ok: false, reason: verdict.reason, challenge: verdict.record };

  return {
    ok: true,
    challenge: verdict.record,
    effects: {
      channel: input.pending.channel,
      nextTarget: input.pending.target,
      notifyOldTarget: input.currentTarget,
      // Only the email change moves the recovery path; a phone change is
      // serious but does not by itself hand over password reset.
      revokeSessions: input.pending.channel === 'email',
      requiresIdentityReview: input.identityVerified,
    },
  };
}
