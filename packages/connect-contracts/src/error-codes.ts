/** @author masterzee001 */
/**
 * Error taxonomy for /v1 and both public SDKs.
 *
 * Every code carries exactly one classification, because "should I retry" is a
 * decision integrator code has to make mechanically:
 *
 *   retryable   — the same request may succeed later; back off and retry.
 *   terminal    — retrying the same request can never succeed; obtain new
 *                 state first (a fresh token, a new call, a different mode).
 *   user-action — only the end user can unblock it (grant a permission,
 *                 attach a device, pick a different name).
 *
 * The envelope's `retryable` boolean is DERIVED from the classification so the
 * wire and the taxonomy can never disagree.
 */
import { z } from 'zod';

export const CONNECT_ERROR_CLASSIFICATIONS = ['retryable', 'terminal', 'user-action'] as const;
export type ConnectErrorClassification = (typeof CONNECT_ERROR_CLASSIFICATIONS)[number];

export const CONNECT_ERROR_CODES = [
  'AUTH_INVALID_KEY',
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED_TOKEN',
  'AUTH_TOKEN_USED',
  'FORBIDDEN_PROJECT',
  'FORBIDDEN_ORIGIN',
  'CALL_NOT_FOUND',
  'CALL_FULL',
  'CALL_ENDED',
  'SUBJECT_ALREADY_ACTIVE',
  'DISPLAY_NAME_TAKEN',
  'OWNER_REQUIRED',
  'INVALID_MODE',
  'INVALID_LANGUAGE',
  'INVALID_REQUEST',
  'MEDIA_PERMISSION_DENIED',
  'MEDIA_UNAVAILABLE',
  'CONNECTION_LOST',
  'TRANSLATION_UNAVAILABLE',
  'GENERATED_AUDIO_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL',
] as const;
export const ConnectErrorCodeSchema = z.enum(CONNECT_ERROR_CODES);
export type ConnectErrorCode = z.infer<typeof ConnectErrorCodeSchema>;

export const CONNECT_ERROR_CLASSIFICATION: Record<ConnectErrorCode, ConnectErrorClassification> = {
  // Credential refusals are terminal FOR THE CREDENTIAL PRESENTED: a bad,
  // expired, or spent token never becomes good by resending it. R6 makes a
  // burned token cheap to replace — the partner mints a fresh one.
  AUTH_INVALID_KEY: 'terminal',
  AUTH_INVALID_TOKEN: 'terminal',
  AUTH_EXPIRED_TOKEN: 'terminal',
  AUTH_TOKEN_USED: 'terminal',
  FORBIDDEN_PROJECT: 'terminal',
  FORBIDDEN_ORIGIN: 'terminal',
  // The request as written cannot succeed against the call as it stands.
  CALL_NOT_FOUND: 'terminal',
  CALL_FULL: 'terminal',
  CALL_ENDED: 'terminal',
  SUBJECT_ALREADY_ACTIVE: 'terminal',
  OWNER_REQUIRED: 'terminal',
  INVALID_MODE: 'terminal',
  INVALID_LANGUAGE: 'terminal',
  INVALID_REQUEST: 'terminal',
  UNSUPPORTED_CAPABILITY: 'terminal',
  IDEMPOTENCY_CONFLICT: 'terminal',
  // Only the person at the keyboard can clear these.
  DISPLAY_NAME_TAKEN: 'user-action',
  MEDIA_PERMISSION_DENIED: 'user-action',
  MEDIA_UNAVAILABLE: 'user-action',
  // Transient by nature; the identical request is expected to succeed later.
  CONNECTION_LOST: 'retryable',
  TRANSLATION_UNAVAILABLE: 'retryable',
  GENERATED_AUDIO_UNAVAILABLE: 'retryable',
  RATE_LIMITED: 'retryable',
  INTERNAL: 'retryable',
};

export function classifyConnectError(code: ConnectErrorCode): ConnectErrorClassification {
  return CONNECT_ERROR_CLASSIFICATION[code];
}

export function isRetryableConnectError(code: ConnectErrorCode): boolean {
  return CONNECT_ERROR_CLASSIFICATION[code] === 'retryable';
}

/**
 * The single error shape every /v1 endpoint returns, on every failure. Strict
 * on both levels: an envelope with extra keys is not this contract.
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ConnectErrorCodeSchema,
        message: z.string().min(1),
        requestId: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type ConnectErrorBody = ErrorEnvelope['error'];

/** Build an envelope whose `retryable` cannot contradict the taxonomy. */
export function buildErrorEnvelope(
  code: ConnectErrorCode,
  message: string,
  requestId: string,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      retryable: isRetryableConnectError(code),
    },
  };
}
