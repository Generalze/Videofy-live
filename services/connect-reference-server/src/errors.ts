/** @author masterzee001 */
/**
 * The Connect Reference error envelope: { error: { code, message } } with
 * KC-prefixed codes, in the product's own words.
 *
 * Leak rule (absolute): the project key (vfk_) and Connect call ids (vc_)
 * never appear in any response or log line. Upstream failures are therefore
 * translated to KC codes with OUR message text, and every string that could
 * carry upstream- or caller-derived text passes through scrubSecrets before
 * it reaches a response body or the log stream.
 */

export type RefErrorCode =
  | 'REF_INVALID_REQUEST'
  | 'REF_NOT_FOUND'
  | 'REF_ROOM_NOT_FOUND'
  | 'REF_ROOM_ENDED'
  | 'REF_HOST_UNAUTHORIZED'
  | 'REF_ROOM_FULL'
  | 'REF_NAME_TAKEN'
  | 'REF_ALREADY_JOINED'
  | 'REF_RATE_LIMITED'
  | 'REF_UPSTREAM_UNAVAILABLE'
  | 'REF_INTERNAL';

export class RefError extends Error {
  constructor(
    readonly status: number,
    readonly code: RefErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RefError';
  }
}

const PROJECT_KEY_PATTERN = /vfk_[A-Za-z0-9_-]+/g;
const CONNECT_CALL_ID_PATTERN = /vc_[A-Za-z0-9_-]+/g;
// host_ host keys are OUR secret, not Connect's, but the same rule applies:
// caller-derived text (a body-parse error message can embed request bytes)
// must never land a key in the log stream.
const HOST_KEY_PATTERN = /host_[A-Za-z0-9_-]+/g;

/** Belt and braces: even text that should already be ours gets scrubbed. */
export function scrubSecrets(text: string): string {
  return text
    .replace(PROJECT_KEY_PATTERN, '[redacted-key]')
    .replace(HOST_KEY_PATTERN, '[redacted-key]')
    .replace(CONNECT_CALL_ID_PATTERN, '[redacted-id]');
}

export interface RefErrorBody {
  error: { code: RefErrorCode; message: string };
}

export function refErrorBody(code: RefErrorCode, message: string): RefErrorBody {
  return { error: { code, message: scrubSecrets(message) } };
}
