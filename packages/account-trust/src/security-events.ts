/**
 * Security observability: what happened, correlated, without the secrets.
 *
 * THE DESIGN DECISION HERE IS THE ABSENCE OF A PAYLOAD FIELD. The usual shape
 * for this is `{ kind, ...anything }` or a `details: Record<string, unknown>`,
 * and every such field eventually receives a request body — which is how OTP
 * codes, reset tokens and identity documents end up in a log aggregator that
 * a much wider group of people can read than could ever read the database.
 * Redaction filters are the standard answer and they fail the same way every
 * time: they match the key names somebody thought of.
 *
 * So a SecurityEvent has a closed set of named fields, all of which are safe by
 * construction. Anything that does not fit cannot be logged through this module
 * at all, and adding a field is a deliberate act with a reviewer.
 *
 * WHAT IS DELIBERATELY NOT HERE: passwords, password hashes, OTP values,
 * verification or reset tokens, MFA secrets, recovery codes, identity document
 * data, raw provider payloads, and email addresses or phone numbers in the
 * clear. Addresses are represented by `targetDigest` so velocity per address
 * can be measured without the address itself being retained.
 */
import { createHash, randomUUID } from 'node:crypto';

/**
 * The events worth watching.
 *
 * Named rather than free text so they can be COUNTED. A spike in
 * `authentication.failed` against one account is a different incident from the
 * same count spread across thousands, and neither is visible if the log line is
 * a sentence.
 */
export type SecurityEventKind =
  | 'authentication.succeeded'
  | 'authentication.failed'
  | 'authentication.locked'
  | 'verification.issued'
  | 'verification.succeeded'
  | 'verification.failed'
  | 'verification.resendThrottled'
  | 'passwordReset.requested'
  | 'passwordReset.completed'
  | 'sessions.revoked'
  | 'mfa.enrolled'
  | 'mfa.disabled'
  | 'mfa.challengeFailed'
  | 'stepUp.required'
  | 'stepUp.satisfied'
  | 'account.created'
  | 'account.emailChangeRequested'
  | 'account.emailChanged'
  | 'account.phoneChanged'
  | 'organization.created'
  | 'organization.invited'
  | 'organization.inviteRejectedWrongRecipient'
  | 'organization.seatLimitRefused'
  | 'organization.ownershipTransferred'
  | 'organization.memberRemoved'
  | 'organization.stateChanged'
  | 'identity.reviewOpened'
  | 'identity.reviewResolved'
  | 'identity.revoked'
  | 'abuse.rateLimited'
  | 'abuse.challengeRequired'
  | 'provider.callbackFailed';

/**
 * Machine-readable outcome codes.
 *
 * Kept SEPARATE from anything shown to a person. §115 forbids exposing why
 * fraud logic reached a conclusion, and the way that leaks is a reason code
 * being rendered straight into a user-facing message because it happened to be
 * a readable string.
 */
export type SecurityReasonCode =
  | 'bad-credentials'
  | 'unknown-account'
  | 'expired'
  | 'consumed'
  | 'too-many-attempts'
  | 'mismatch'
  | 'wrong-target'
  | 'wrong-recipient'
  | 'mfa-required'
  | 'step-up-required'
  | 'stale'
  | 'over-capacity'
  | 'no-seats-available'
  | 'last-owner'
  | 'not-permitted'
  | 'provider-unavailable'
  | 'provider-rejected';

/**
 * A correlation id.
 *
 * Random per request and carried through every event it causes. Deliberately
 * NOT derived from anything about the person: an id computed from an account or
 * an address would silently link records that were meant to be separate, and
 * would survive in logs long after the account was closed.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * A one-way digest of an address or phone number.
 *
 * Lets velocity be measured per target -- "this address has requested forty
 * resets" -- without the log retaining the address. Salted per deployment for
 * the same reason recovery codes are peppered: an unsalted digest of an email
 * address is reversible by anyone with a word list of email addresses, which is
 * everyone.
 */
export function targetDigest(target: string, salt: string): string {
  if (typeof salt !== 'string' || salt.trim().length < 16) {
    throw new Error('targetDigest requires a deployment salt of at least 16 characters');
  }
  return createHash('sha256')
    // NUL-separated for DOMAIN SEPARATION: it cannot occur in an address, so
    // no pair of (salt, target) values can concatenate to the same bytes as a
    // different pair. Written as an escape sequence, never as the character --
    // a literal NUL compiles, passes every test, and makes the file undiffable.
    .update(salt + '\u0000' + target.trim().toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export interface SecurityEvent {
  readonly kind: SecurityEventKind;
  readonly correlationId: string;
  readonly atMs: number;
  /** Opaque internal id. Never an email address or phone number. */
  readonly accountId?: string;
  readonly organizationId?: string;
  /** See targetDigest. Never the address itself. */
  readonly targetDigest?: string;
  readonly reasonCode?: SecurityReasonCode;
  /**
   * Which network address the request came from, when the event is about abuse.
   *
   * Present only where it is operationally necessary, because an IP address is
   * personal data with its own retention obligations -- it is not attached to
   * every event merely because it was available.
   */
  readonly sourceIp?: string;
  /** Set when the event should page somebody rather than merely be recorded. */
  readonly alert?: boolean;
}

/**
 * The events that warrant an alert rather than a dashboard.
 *
 * Chosen because each one either means somebody is under attack now, or means a
 * control that other controls depend on has stopped working.
 */
export const ALERTABLE: ReadonlySet<SecurityEventKind> = new Set<SecurityEventKind>([
  'authentication.locked',
  'mfa.disabled',
  'organization.ownershipTransferred',
  'organization.inviteRejectedWrongRecipient',
  'identity.revoked',
  'provider.callbackFailed',
  'abuse.challengeRequired',
]);

export interface SecurityEventSink {
  record(event: SecurityEvent): void;
}

/**
 * Build an event, stamping the alert flag from one table.
 *
 * Callers do not decide alertability. Left to each call site it drifts, and the
 * question "what pages us?" stops having an answer that can be read anywhere.
 */
export function securityEvent(input: Omit<SecurityEvent, 'alert'>): SecurityEvent {
  return { ...input, alert: ALERTABLE.has(input.kind) };
}

/**
 * Field names that must never appear in a security event.
 *
 * Exported so the test can assert it, and so a future contributor adding a
 * field to SecurityEvent trips a red test rather than a review comment they
 * might not get.
 *
 * TRACKS DP-170 in docs/privacy/DATA_PROTECTION_POSITIONS.md, which is a LOCKED
 * position: the logging layer must reject message bodies, transcript and
 * translation text, call audio and video bytes, attachment contents, auth
 * tokens, passwords, provider API secrets, payment credentials and raw
 * cookie/session secrets. This list is the executable form of that rule, and
 * the generic bags at the end -- payload, details, body -- are included because
 * they are where every one of the others eventually arrives.
 */
export const FORBIDDEN_EVENT_FIELDS: readonly string[] = [
  // Credentials
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'authorization',
  'bearer',
  'otp',
  'code',
  'secret',
  'recoveryCode',
  'mfaSecret',
  'apiKey',
  'apiSecret',
  'cookie',
  // Communications CONTENT. DP-040 treats this as high-sensitivity regardless
  // of whether it is legally special category, because a message may reveal
  // health, religion, politics, finances or trade secrets without the platform
  // ever having asked for any of it.
  'message',
  'messageBody',
  'content',
  'transcript',
  'transcriptText',
  'translation',
  'translationText',
  'audio',
  'video',
  'media',
  'samples',
  'attachment',
  // Identity and payment
  'email',
  'phone',
  'phoneNumber',
  'document',
  'card',
  'cardNumber',
  'cvv',
  'pan',
  'iban',
  // Generic bags, which is where everything above eventually arrives
  'payload',
  'details',
  'body',
];

/**
 * Does this object contain anything that must not be logged?
 *
 * A BACKSTOP, not the primary defence -- the primary defence is that
 * SecurityEvent has nowhere to put these. This catches an object that reached a
 * sink by some other route, and is what the test uses to prove the type has not
 * quietly grown a hole.
 */
export function containsForbiddenField(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_EVENT_FIELDS.includes(key)) return key;
    const nested = containsForbiddenField((value as Record<string, unknown>)[key]);
    if (nested !== null) return nested;
  }
  return null;
}
