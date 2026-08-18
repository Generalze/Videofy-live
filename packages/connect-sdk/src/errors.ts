/** @owner masterzee001 */
/**
 * Public error construction. Every error the SDK throws or emits carries a
 * ConnectErrorCode; retryable is ALWAYS derived from the contracts taxonomy
 * so the SDK and the /v1 wire can never disagree about it.
 */
import { CONNECT_ERROR_CODES, isRetryableConnectError } from '@videofy-live/connect-contracts';
import type { ConnectErrorCode, ConnectPublicError } from '@videofy-live/connect-contracts';

export class VideofyConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly retryable: boolean;

  constructor(code: ConnectErrorCode, message: string) {
    super(message);
    this.name = 'VideofyConnectError';
    this.code = code;
    this.retryable = isRetryableConnectError(code);
  }

  toPublicError(): ConnectPublicError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

const PUBLIC_CODES: ReadonlySet<string> = new Set<string>(CONNECT_ERROR_CODES);

/**
 * Map a wire code (legacy kebab-case ack codes today, public codes once the
 * Connect gateway wave lands) onto the public taxonomy. Unknown codes fail to
 * INTERNAL rather than inventing vocabulary.
 */
export function publicErrorCode(wireCode: string | undefined): ConnectErrorCode {
  if (wireCode !== undefined && PUBLIC_CODES.has(wireCode)) {
    return wireCode as ConnectErrorCode;
  }
  switch (wireCode) {
    case 'call-full':
      return 'CALL_FULL';
    case 'duplicate-display-name':
      return 'DISPLAY_NAME_TAKEN';
    case 'invalid-input':
      return 'INVALID_REQUEST';
    case 'unknown-participant':
      // A join naming a seat the registry no longer knows: the credential in
      // hand cannot admit anyone any more.
      return 'AUTH_INVALID_TOKEN';
    default:
      return 'INTERNAL';
  }
}

export function connectErrorFromJoinFailure(
  wireCode: string | undefined,
  message: string | null,
): VideofyConnectError {
  return new VideofyConnectError(
    publicErrorCode(wireCode),
    message ?? 'This call could not be joined right now.',
  );
}

/** Normalize anything a join path can throw into a VideofyConnectError. */
export function asConnectError(error: unknown): VideofyConnectError {
  if (error instanceof VideofyConnectError) return error;
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'The call service could not be reached. Please try again.';
  return new VideofyConnectError('CONNECTION_LOST', message);
}
