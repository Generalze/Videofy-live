/**
 * Identity verification (KYC), as a boundary rather than a vendor.
 *
 * DATA MINIMISATION IS THE DESIGN. C7 does not want a passport scan. A stored
 * identity document is a permanent liability that grows with every signup: it
 * cannot be rotated like a password, it identifies a real person for life, and
 * the day it leaks is the day the company is explaining itself to a regulator.
 *
 * So the qualified provider holds the documents and the liveness capture, and
 * C7 keeps a REFERENCE and an OUTCOME. What is stored here would be useless to
 * anybody who stole it: a case id, a status, a jurisdiction, some timestamps.
 *
 * The second design rule: the browser is never the source of a verification
 * result. A client that could report "identity verified" would be the entire
 * attack. Results arrive server-to-server, signed, and are validated here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type IdentityCaseStatus =
  | 'created'
  | 'submitted'
  | 'processing'
  | 'verified'
  | 'rejected'
  | 'review'
  | 'expired'
  | 'abandoned';

/**
 * What C7 keeps about an identity check.
 *
 * Note what is ABSENT: no document images, no document numbers, no date of
 * birth, no selfie, no liveness video. If a field here would identify the
 * person beyond the account that already exists, it does not belong.
 */
export interface IdentityCase {
  readonly caseId: string;
  readonly provider: string;
  /** The provider's own handle for this case, for support and reconciliation. */
  readonly providerReference: string;
  readonly status: IdentityCaseStatus;
  /** Where the check was performed, when the provider reports it. */
  readonly jurisdiction: string | null;
  /** The provider's outcome code, kept verbatim for support conversations. */
  readonly outcomeCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
  /** Set when a human must look at it. Never carries the reason publicly. */
  readonly reviewOpenedAtMs: number | null;
}

export interface IdentitySession {
  readonly caseId: string;
  readonly providerReference: string;
  /**
   * Where the person completes the check — the provider's hosted flow.
   *
   * Hosted on purpose: an in-house capture form would mean the documents pass
   * through C7 on their way to the provider, which is exactly what holding a
   * reference instead of a document is meant to avoid.
   */
  readonly redirectUrl: string;
  readonly expiresAtMs: number;
}

export interface IdentityVerificationProvider {
  readonly name: string;
  readonly synthetic: boolean;
  createVerificationSession(input: {
    accountId: string;
    /** Correlates the provider's callback back to this account. */
    reference: string;
    nowMs: number;
  }): Promise<IdentitySession>;
  getVerificationStatus(providerReference: string): Promise<IdentityCaseStatus>;
}

/**
 * Legal transitions.
 *
 * A provider callback can arrive late, twice, or out of order — retries and
 * at-least-once delivery are normal. Without this table a stale `processing`
 * callback arriving after `verified` would quietly un-verify somebody, and a
 * replayed `rejected` would undo a completed check.
 */
const ALLOWED_NEXT: Readonly<Record<IdentityCaseStatus, readonly IdentityCaseStatus[]>> = {
  // A terminal status straight from `created` is normal: plenty of providers
  // emit only the final outcome and never the intermediate steps. Requiring
  // `submitted` first would silently reject every one of their callbacks.
  created: ['submitted', 'processing', 'verified', 'rejected', 'review', 'abandoned', 'expired'],
  submitted: ['processing', 'verified', 'rejected', 'review', 'expired'],
  processing: ['verified', 'rejected', 'review', 'expired'],
  review: ['verified', 'rejected', 'expired'],
  // Terminal. Re-verification starts a NEW case rather than reopening one, so
  // the history of what was decided when stays intact.
  verified: [],
  rejected: [],
  expired: [],
  abandoned: [],
};

export function isLegalTransition(from: IdentityCaseStatus, to: IdentityCaseStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_NEXT[from] ?? []).includes(to);
}

export interface ProviderCallback {
  readonly providerReference: string;
  readonly status: IdentityCaseStatus;
  readonly jurisdiction?: string | null;
  readonly outcomeCode?: string | null;
  /** The provider's own event id, for idempotency. */
  readonly eventId: string;
  /** Unix ms, for replay rejection. */
  readonly issuedAtMs: number;
}

export type CallbackRejection =
  | 'bad-signature'
  | 'malformed'
  | 'stale'
  | 'unknown-case'
  | 'illegal-transition'
  | 'duplicate';

export type CallbackVerdict =
  | { readonly ok: true; readonly callback: ProviderCallback }
  | { readonly ok: false; readonly reason: CallbackRejection };

const STATUSES: readonly IdentityCaseStatus[] = [
  'created',
  'submitted',
  'processing',
  'verified',
  'rejected',
  'review',
  'expired',
  'abandoned',
];

/** Beyond this a signed payload is treated as a replay rather than a late call. */
export const CALLBACK_MAX_AGE_MS = 5 * 60 * 1000;

export function signCallback(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Validate a provider callback before anything else looks at it.
 *
 * Signature FIRST, on the raw body. Parsing before verifying means running a
 * JSON parser and a schema over bytes from an unauthenticated caller, and the
 * signature covers the exact bytes — re-serialising a parsed object produces
 * different bytes and a signature that never matches.
 */
export function validateCallback(input: {
  rawBody: string;
  signature: string | undefined;
  secret: string;
  nowMs: number;
  seenEventIds: ReadonlySet<string>;
}): CallbackVerdict {
  if (typeof input.signature !== 'string' || input.signature.length === 0) {
    return { ok: false, reason: 'bad-signature' };
  }
  const expected = Buffer.from(signCallback(input.rawBody, input.secret), 'hex');
  const presented = Buffer.from(input.signature, 'hex');
  if (
    expected.length === 0 ||
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
  const body = parsed as Record<string, unknown>;

  const providerReference = body['providerReference'];
  const status = body['status'];
  const eventId = body['eventId'];
  const issuedAtMs = body['issuedAtMs'];

  if (
    typeof providerReference !== 'string' ||
    providerReference.length === 0 ||
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    typeof issuedAtMs !== 'number' ||
    !Number.isFinite(issuedAtMs) ||
    typeof status !== 'string' ||
    !STATUSES.includes(status as IdentityCaseStatus)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // A correctly signed payload replayed tomorrow is still correctly signed.
  // Age is what makes a captured callback stop working.
  if (Math.abs(input.nowMs - issuedAtMs) > CALLBACK_MAX_AGE_MS) {
    return { ok: false, reason: 'stale' };
  }
  if (input.seenEventIds.has(eventId)) return { ok: false, reason: 'duplicate' };

  const jurisdiction = typeof body['jurisdiction'] === 'string' ? body['jurisdiction'] : null;
  const outcomeCode = typeof body['outcomeCode'] === 'string' ? body['outcomeCode'] : null;

  return {
    ok: true,
    callback: {
      providerReference,
      status: status as IdentityCaseStatus,
      jurisdiction,
      outcomeCode,
      eventId,
      issuedAtMs,
    },
  };
}

/** Apply a validated callback to a case, refusing an illegal transition. */
export function applyCallback(
  identityCase: IdentityCase,
  callback: ProviderCallback,
  nowMs: number,
): { ok: true; next: IdentityCase } | { ok: false; reason: CallbackRejection } {
  if (!isLegalTransition(identityCase.status, callback.status)) {
    return { ok: false, reason: 'illegal-transition' };
  }
  const terminal =
    callback.status === 'verified' ||
    callback.status === 'rejected' ||
    callback.status === 'expired';

  return {
    ok: true,
    next: {
      ...identityCase,
      status: callback.status,
      jurisdiction: callback.jurisdiction ?? identityCase.jurisdiction,
      outcomeCode: callback.outcomeCode ?? identityCase.outcomeCode,
      updatedAtMs: nowMs,
      completedAtMs: terminal ? nowMs : identityCase.completedAtMs,
      reviewOpenedAtMs:
        callback.status === 'review' ? (identityCase.reviewOpenedAtMs ?? nowMs) : identityCase.reviewOpenedAtMs,
    },
  };
}

export class SyntheticIdentityProviderInProductionError extends Error {
  constructor(providerName: string) {
    super(
      `refusing to start: identity verification is configured with the synthetic provider ` +
        `"${providerName}" while the environment is production. Synthetic identity verification ` +
        `certifies nobody, and an account marked verified through it looks identical to one that ` +
        `passed a real check.`,
    );
    this.name = 'SyntheticIdentityProviderInProductionError';
  }
}

export function assertIdentityProviderAllowed(
  provider: IdentityVerificationProvider,
  environment: 'development' | 'staging' | 'production',
): void {
  if (environment === 'production' && provider.synthetic) {
    throw new SyntheticIdentityProviderInProductionError(provider.name);
  }
}

/**
 * A provider that verifies nobody.
 *
 * It exists so the STATE MACHINE can be exercised — sessions, callbacks,
 * transitions, review — without a vendor account and without anybody uploading
 * a real document. It never accepts one: there is no upload here at all, which
 * is the point. `synthetic: true` is what keeps it out of production.
 */
export function createSyntheticIdentityProvider(): IdentityVerificationProvider {
  const statuses = new Map<string, IdentityCaseStatus>();
  return {
    name: 'synthetic-identity',
    synthetic: true,
    async createVerificationSession(input) {
      const providerReference = `syn_${input.reference}`;
      statuses.set(providerReference, 'created');
      return {
        caseId: input.reference,
        providerReference,
        // Deliberately an obviously fake, clearly-labelled destination. A URL
        // that looked like a real vendor's would eventually be screenshotted
        // into a document describing a verification C7 does not have.
        redirectUrl: `https://synthetic-identity.invalid/verify/${providerReference}?mode=test`,
        expiresAtMs: input.nowMs + 24 * 60 * 60 * 1000,
      };
    },
    async getVerificationStatus(providerReference) {
      return statuses.get(providerReference) ?? 'expired';
    },
  };
}
