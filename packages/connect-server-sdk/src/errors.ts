/** @author masterzee001 */
/**
 * Typed failures for @videofy/server-sdk.
 *
 * Redaction rule: the project API key must never appear in anything this SDK
 * throws. Every message that could carry server- or caller-derived text is
 * passed through redactSecret before it reaches an Error, so integrators can
 * log SDK errors without leaking their credential. The SDK itself never logs.
 */

export type VideofyErrorCode =
  | 'AUTH_INVALID_KEY'
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_EXPIRED_TOKEN'
  | 'AUTH_TOKEN_USED'
  | 'FORBIDDEN_PROJECT'
  | 'FORBIDDEN_ORIGIN'
  | 'CALL_NOT_FOUND'
  | 'CALL_FULL'
  | 'CALL_ENDED'
  | 'SUBJECT_ALREADY_ACTIVE'
  | 'DISPLAY_NAME_TAKEN'
  | 'OWNER_REQUIRED'
  | 'INVALID_MODE'
  | 'INVALID_LANGUAGE'
  | 'INVALID_REQUEST'
  | 'MEDIA_PERMISSION_DENIED'
  | 'MEDIA_UNAVAILABLE'
  | 'CONNECTION_LOST'
  | 'TRANSLATION_UNAVAILABLE'
  | 'GENERATED_AUDIO_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL';

/** A /v1 error envelope, surfaced as a typed exception. */
export class VideofyApiError extends Error {
  readonly code: VideofyErrorCode;
  /** Correlation id minted by the server; quote it when reporting a problem. */
  readonly requestId: string;
  /** Passed through from the server envelope: true means the same request may succeed later. */
  readonly retryable: boolean;
  /** HTTP status of the response that carried the envelope. */
  readonly status: number;

  constructor(details: {
    code: VideofyErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    status: number;
  }) {
    super(details.message);
    this.name = 'VideofyApiError';
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
    this.status = details.status;
  }
}

/** The server answered, but not with anything the Connect v1 contract allows. */
export class VideofyContractError extends Error {
  /** HTTP status of the non-conforming response. */
  readonly status: number;
  /** X-Request-Id response header when the server sent one. */
  readonly requestId: string | null;
  /** Schema findings ("path: problem"), when the body was JSON but off-contract. */
  readonly issues: readonly string[];

  constructor(details: {
    message: string;
    status: number;
    requestId: string | null;
    issues?: readonly string[];
  }) {
    super(details.message);
    this.name = 'VideofyContractError';
    this.status = details.status;
    this.requestId = details.requestId;
    this.issues = details.issues ?? [];
  }
}

/** The request was refused locally, before any network traffic happened. */
export class VideofyInputError extends Error {
  /** Field-level findings ("path: problem"). */
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'VideofyInputError';
    this.issues = issues;
  }
}

/**
 * Replace every occurrence of a secret in a text. Internal helper —
 * deliberately not exported from the package root.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('[REDACTED]');
}
