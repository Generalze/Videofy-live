/** @author masterzee001 */
/**
 * Email and phone verification, as a service the routes call.
 *
 * The routes stay thin because the rules live here: one place decides when a
 * challenge may be issued, what a presented token proves, and which trust
 * component moves as a result. Two places would eventually disagree, and the
 * disagreement would be a way to become verified.
 *
 * NOTHING here returns or logs a plaintext token outside the provider call.
 * The token exists in exactly two places: the message being delivered, and the
 * hash on the account record.
 */
import {
  EMAIL_POLICY,
  PHONE_POLICY,
  applyTransition,
  createLinkToken,
  createOtpCode,
  issueChallenge,
  mayResend,
  readTrust,
  resolveTrustState,
  verifyChallenge,
  type AccountTrustState,
  type ChallengePolicy,
  type VerificationDeliveryProvider,
  applyCallback,
  validateCallback,
  type IdentityCase,
  type IdentitySession,
  type IdentityVerificationProvider,
} from '@videofy-live/account-trust';
import type { AccountStore } from './account-store.js';

export interface VerificationDependencies {
  readonly store: AccountStore;
  readonly emailProvider: VerificationDeliveryProvider;
  readonly phoneProvider: VerificationDeliveryProvider;
  readonly identityProvider?: IdentityVerificationProvider;
  /** Shared secret the provider signs callbacks with. Never leaves the server. */
  readonly identityCallbackSecret?: string;
  readonly nowMs?: () => number;
  /** Observability hook. Receives event names only — never a token or a target. */
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

export type RequestOutcome =
  | { readonly ok: true; readonly expiresAtMs: number; readonly synthetic: boolean }
  | { readonly ok: false; readonly reason: 'unknown-account'; }
  | { readonly ok: false; readonly reason: 'already-verified' }
  | { readonly ok: false; readonly reason: 'throttled'; readonly retryAfterMs: number }
  | { readonly ok: false; readonly reason: 'invalid-target' }
  | { readonly ok: false; readonly reason: 'delivery-failed' };

export type ConfirmOutcome =
  | { readonly ok: true; readonly state: AccountTrustState }
  | { readonly ok: false; readonly reason: string };

const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

/** E.164, or nothing. A stored number that is not dialable is not a number. */
export function normalisePhone(input: string): string | null {
  const compact = input.replace(/[\s()-]/g, '');
  return PHONE_PATTERN.test(compact) ? compact : null;
}

export class VerificationService {
  private readonly nowMs: () => number;

  constructor(private readonly deps: VerificationDependencies) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  private async request(
    accountId: string,
    channel: 'email' | 'phone',
    target: string | null,
    policy: ChallengePolicy,
    token: string,
    provider: VerificationDeliveryProvider,
  ): Promise<RequestOutcome> {
    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };
    if (target === null) return { ok: false, reason: 'invalid-target' };

    const trust = readTrust(account.trust);
    if (trust[channel] === 'verified') return { ok: false, reason: 'already-verified' };

    const previous = channel === 'email' ? account.emailChallenge : account.phoneChallenge;
    const allowed = mayResend({ previous: previous ?? null, nowMs: this.nowMs(), policy });
    if (!allowed.ok) {
      this.deps.onEvent?.('verification.throttled', { channel });
      return { ok: false, reason: 'throttled', retryAfterMs: allowed.retryAfterMs };
    }

    const record = issueChallenge({
      channel,
      target,
      token,
      nowMs: this.nowMs(),
      policy,
    });

    // Persist BEFORE delivering. Delivering first and crashing would send a
    // token that can never be verified, and the person would be left retrying
    // against a challenge that does not exist.
    await this.deps.store.setChallenge(accountId, channel, record);

    const delivery = await provider
      .send({ channel, target, token, expiresAtMs: record.expiresAtMs })
      .catch(() => ({ delivered: false, reference: null, synthetic: provider.synthetic }));

    if (!delivery.delivered) {
      this.deps.onEvent?.('verification.delivery_failed', { channel, provider: provider.name });
      return { ok: false, reason: 'delivery-failed' };
    }

    const moved = applyTransition(readTrust(account.trust), { channel, to: 'pending' });
    if (moved.ok) await this.deps.store.setTrust(accountId, moved.trust);

    this.deps.onEvent?.('verification.requested', { channel, provider: provider.name });
    return { ok: true, expiresAtMs: record.expiresAtMs, synthetic: delivery.synthetic };
  }

  requestEmailVerification(accountId: string): Promise<RequestOutcome> {
    const account = this.deps.store.get(accountId);
    return this.request(
      accountId,
      'email',
      account?.email ?? null,
      EMAIL_POLICY,
      createLinkToken(),
      this.deps.emailProvider,
    );
  }

  requestPhoneVerification(accountId: string, phone: string): Promise<RequestOutcome> {
    return this.request(
      accountId,
      'phone',
      normalisePhone(phone),
      PHONE_POLICY,
      createOtpCode(),
      this.deps.phoneProvider,
    );
  }

  private async confirm(
    accountId: string,
    channel: 'email' | 'phone',
    token: string,
    policy: ChallengePolicy,
  ): Promise<ConfirmOutcome> {
    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };

    const record = channel === 'email' ? account.emailChallenge : account.phoneChallenge;
    if (!record) return { ok: false, reason: 'no-challenge' };

    const verdict = verifyChallenge({
      record,
      token,
      target: record.target,
      nowMs: this.nowMs(),
      policy,
    });

    // The updated record is persisted on FAILURE too, because that is what
    // makes the attempt counter mean anything. Persisting only on success is
    // unlimited free guesses.
    await this.deps.store.setChallenge(accountId, channel, verdict.record);

    if (!verdict.ok) {
      this.deps.onEvent?.('verification.failed', { channel, reason: verdict.reason });
      return { ok: false, reason: verdict.reason };
    }

    const moved = applyTransition(readTrust(account.trust), { channel, to: 'verified' });
    if (!moved.ok) return { ok: false, reason: 'transition-refused' };
    await this.deps.store.setTrust(accountId, moved.trust);
    if (channel === 'phone') await this.deps.store.setPhoneNumber(accountId, record.target);

    this.deps.onEvent?.('verification.completed', { channel });
    return { ok: true, state: resolveTrustState(moved.trust) };
  }

  confirmEmail(accountId: string, token: string): Promise<ConfirmOutcome> {
    return this.confirm(accountId, 'email', token, EMAIL_POLICY);
  }

  confirmPhone(accountId: string, token: string): Promise<ConfirmOutcome> {
    return this.confirm(accountId, 'phone', token, PHONE_POLICY);
  }

  /**
   * Begin an identity check.
   *
   * Returns a REDIRECT to the provider's hosted flow. Deliberately hosted: an
   * in-house capture form would route documents through C7 on their way to the
   * provider, which is exactly what keeping a reference instead of a document
   * is meant to avoid.
   */
  async startIdentityVerification(
    accountId: string,
  ): Promise<
    | { ok: true; session: IdentitySession }
    | { ok: false; reason: 'unknown-account' | 'already-verified' | 'not-configured' | 'in-progress' }
  > {
    const provider = this.deps.identityProvider;
    if (!provider) return { ok: false, reason: 'not-configured' };

    const account = this.deps.store.get(accountId);
    if (!account) return { ok: false, reason: 'unknown-account' };

    const trust = readTrust(account.trust);
    if (trust.identity === 'verified') return { ok: false, reason: 'already-verified' };

    // One open case at a time. Two live cases means two callbacks racing to
    // decide the same account, and whichever lands last wins by accident.
    const current = account.identityCase;
    if (current && (current.status === 'created' || current.status === 'submitted' || current.status === 'processing')) {
      return { ok: false, reason: 'in-progress' };
    }

    const nowMs = this.nowMs();
    const caseId = `idcase_${accountId}_${nowMs.toString(36)}`;
    const session = await provider.createVerificationSession({ accountId, reference: caseId, nowMs });

    const identityCase: IdentityCase = {
      caseId,
      provider: provider.name,
      providerReference: session.providerReference,
      status: 'created',
      jurisdiction: null,
      outcomeCode: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      completedAtMs: null,
      reviewOpenedAtMs: null,
    };
    await this.deps.store.setIdentityCase(accountId, identityCase);

    const moved = applyTransition(trust, { channel: 'identity', to: 'pending' });
    if (moved.ok) await this.deps.store.setTrust(accountId, moved.trust);

    this.deps.onEvent?.('identity.session_created', { provider: provider.name });
    return { ok: true, session };
  }

  /**
   * Apply a provider callback.
   *
   * The ONLY way an identity result enters the system. A browser can start a
   * check; it can never report the outcome of one.
   */
  async handleIdentityCallback(
    rawBody: string,
    signature: string | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const secret = this.deps.identityCallbackSecret;
    if (!secret) return { ok: false, reason: 'not-configured' };

    // Signature is checked against the account's own seen-event list, which
    // requires knowing the account -- so validate signature and shape first
    // with an empty set, then re-check duplication once the case is found.
    const validated = validateCallback({
      rawBody,
      signature,
      secret,
      nowMs: this.nowMs(),
      seenEventIds: new Set(),
    });
    if (!validated.ok) {
      this.deps.onEvent?.('identity.callback_rejected', { reason: validated.reason });
      return { ok: false, reason: validated.reason };
    }

    const account = this.deps.store.findByProviderReference(validated.callback.providerReference);
    if (!account?.identityCase) {
      this.deps.onEvent?.('identity.callback_rejected', { reason: 'unknown-case' });
      return { ok: false, reason: 'unknown-case' };
    }
    if ((account.seenCallbackEvents ?? []).includes(validated.callback.eventId)) {
      // Not an error: at-least-once delivery means the provider is doing its
      // job. Accepted and ignored.
      this.deps.onEvent?.('identity.callback_duplicate', {});
      return { ok: true };
    }

    const applied = applyCallback(account.identityCase, validated.callback, this.nowMs());
    if (!applied.ok) {
      this.deps.onEvent?.('identity.callback_rejected', { reason: applied.reason });
      return { ok: false, reason: applied.reason };
    }

    await this.deps.store.setIdentityCase(account.accountId, applied.next);
    await this.deps.store.rememberCallbackEvent(account.accountId, validated.callback.eventId);

    const trust = readTrust(account.trust);
    if (applied.next.status === 'verified') {
      const moved = applyTransition(trust, { channel: 'identity', to: 'verified' });
      if (moved.ok) await this.deps.store.setTrust(account.accountId, moved.trust);
    } else if (applied.next.status === 'rejected') {
      const moved = applyTransition(trust, { channel: 'identity', to: 'failed' });
      if (moved.ok) await this.deps.store.setTrust(account.accountId, moved.trust);
    } else if (applied.next.status === 'review') {
      // A case a human must look at restricts nothing yet, but it must be
      // visible: `under_review` is what the dashboard shows instead of
      // pretending the check is still simply pending.
      await this.deps.store.setTrust(account.accountId, { ...trust, restriction: 'under_review' });
    }

    this.deps.onEvent?.('identity.callback_applied', { status: applied.next.status });
    return { ok: true };
  }

  /** What the registered shell shows: per-channel status and the derived state. */
  status(accountId: string) {
    const trust = this.deps.store.trustOf(accountId);
    return {
      state: resolveTrustState(trust),
      email: trust.email,
      phone: trust.phone,
      identity: trust.identity,
      restriction: trust.restriction,
      risk: trust.risk,
      // The case STATUS only. No provider reference, no outcome code, no
      // jurisdiction: a person needs to know where they stand, not the
      // provider's internal vocabulary.
      identityCaseStatus: this.deps.store.get(accountId)?.identityCase?.status ?? null,
    };
  }
}
