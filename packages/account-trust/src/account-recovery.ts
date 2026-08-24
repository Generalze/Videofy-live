/**
 * Account recovery: password reset, and what a reset must do besides.
 *
 * BUILT ON THE EXISTING CHALLENGE, NOT BESIDE IT. A reset token has the same
 * requirements as an email verification token — random, hashed at rest,
 * expiring, single-use, attempt-capped, throttled — and a second implementation
 * of those would be a second place for them to drift. `verification-token.ts`
 * already gets them right, including the `wrong-target` check that stops a
 * token issued for one address from validating another.
 *
 * WHAT THIS MODULE ADDS is the two things a reset needs that a verification
 * does not:
 *
 *  1. ENUMERATION SAFETY. "No account with that email" tells an attacker which
 *     addresses are worth attacking, and the endpoint is unauthenticated, so
 *     they may ask about as many as they like. The public response here is a
 *     type with exactly ONE value, so a caller cannot branch on whether the
 *     account existed even by accident.
 *
 *  2. SESSION REVOCATION. Somebody resetting a password is frequently somebody
 *     who believes they were compromised. Leaving existing sessions alive means
 *     the attacker keeps their access and now cannot be locked out, which
 *     inverts the entire point of the exercise.
 */
import {
  createLinkToken,
  issueChallenge,
  mayResend,
  verifyChallenge,
  type ChallengePolicy,
  type ChallengeRecord,
} from './verification-token.js';

/**
 * Shorter-lived and stricter than an email verification.
 *
 * A verification link sits in an inbox as a convenience; a reset link is a
 * standing key to the account for as long as it lives. Thirty minutes is a
 * reasonable window to find an email — but not one worth leaving a key open
 * for, so this is halved, and the attempt cap tightened to match.
 */
export const PASSWORD_RESET_POLICY: ChallengePolicy = {
  ttlMs: 15 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
};

/**
 * What the SERVER must do. Never serialised to a response.
 *
 * Held separately from the public response precisely so that the token cannot
 * reach a client by being part of the same object somebody spread into JSON.
 */
export interface RecoveryEffect {
  readonly accountId: string;
  readonly challenge: ChallengeRecord;
  /** The plaintext token, for delivery only. Never stored, never logged. */
  readonly token: string;
}

/**
 * The public answer to "please reset my password".
 *
 * A single-valued type, deliberately. If this were a boolean or a union,
 * somewhere a route would eventually render one branch differently from the
 * other — a different status code, a subtly different message, a measurably
 * different response time — and the endpoint would enumerate accounts again.
 * There is nothing here to branch on.
 */
export type RecoveryAcknowledgement = 'accepted';

export interface RecoveryRequest {
  /** Null when no account matches. The caller must NOT reveal which. */
  readonly accountId: string | null;
  readonly target: string;
  readonly previous: ChallengeRecord | null;
  readonly nowMs: number;
}

/**
 * Begin a reset.
 *
 * Returns the acknowledgement ALWAYS, and an effect only when there is a real
 * account and the throttle allows it. An unknown address and a throttled one
 * are therefore indistinguishable from outside, which is the requirement.
 */
export function beginPasswordReset(request: RecoveryRequest): {
  readonly acknowledgement: RecoveryAcknowledgement;
  readonly effect: RecoveryEffect | null;
} {
  if (request.accountId === null) return { acknowledgement: 'accepted', effect: null };

  const allowed = mayResend({
    previous: request.previous,
    nowMs: request.nowMs,
    policy: PASSWORD_RESET_POLICY,
  });
  // Throttled: still acknowledged. Reporting the cooldown would confirm that
  // the address is real, which is the fact being protected.
  if (!allowed.ok) return { acknowledgement: 'accepted', effect: null };

  const token = createLinkToken();
  const challenge = issueChallenge({
    channel: 'email',
    token,
    target: request.target,
    nowMs: request.nowMs,
    policy: PASSWORD_RESET_POLICY,
  });

  return { acknowledgement: 'accepted', effect: { accountId: request.accountId, challenge, token } };
}

export type ResetCompletion =
  | {
      readonly ok: true;
      readonly challenge: ChallengeRecord;
      /**
       * Every token issued before the reset must stop working.
       *
       * Returned rather than applied, because the token version lives with the
       * account record and this package deliberately holds no storage.
       */
      readonly revokeSessions: true;
    }
  | {
      readonly ok: false;
      readonly reason: 'expired' | 'consumed' | 'too-many-attempts' | 'mismatch' | 'wrong-target';
      readonly challenge: ChallengeRecord;
    };

/**
 * Complete a reset by presenting the token.
 *
 * The updated challenge comes back on EVERY path, success or failure, because a
 * failed attempt must still be counted. Persisting only on success hands an
 * attacker unlimited free guesses against the attempt cap.
 */
export function completePasswordReset(input: {
  record: ChallengeRecord;
  token: string;
  target: string;
  nowMs: number;
}): ResetCompletion {
  const verdict = verifyChallenge({
    record: input.record,
    token: input.token,
    target: input.target,
    nowMs: input.nowMs,
    policy: PASSWORD_RESET_POLICY,
  });

  if (!verdict.ok) return { ok: false, reason: verdict.reason, challenge: verdict.record };
  return { ok: true, challenge: verdict.record, revokeSessions: true };
}

/**
 * Reasons a session may be revoked, for the audit trail.
 *
 * Named rather than free text so the security surface can count them: a spike
 * in `credential-compromise-suspected` is a signal, a spike in free-form
 * strings is a grep.
 */
export type SessionRevocationReason =
  | 'password-reset'
  | 'password-changed'
  | 'mfa-disabled'
  | 'user-signed-out-everywhere'
  | 'credential-compromise-suspected'
  | 'account-restricted';

export interface SessionRevocation {
  readonly accountId: string;
  readonly reason: SessionRevocationReason;
  readonly atMs: number;
  /** The token version after revocation. Everything below it is now invalid. */
  readonly tokenVersion: number;
}

/**
 * Revoke every issued session by advancing the token version.
 *
 * This is what makes "sign out everywhere" mean something for a stateless
 * token: there is no session list to delete from, so the version carried in the
 * token is compared against the account's current version and anything older is
 * refused.
 */
export function revokeSessions(input: {
  accountId: string;
  currentTokenVersion: number;
  reason: SessionRevocationReason;
  nowMs: number;
}): SessionRevocation {
  return {
    accountId: input.accountId,
    reason: input.reason,
    atMs: input.nowMs,
    tokenVersion: input.currentTokenVersion + 1,
  };
}
