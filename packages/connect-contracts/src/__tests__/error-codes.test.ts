/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  CONNECT_ERROR_CLASSIFICATION,
  CONNECT_ERROR_CLASSIFICATIONS,
  CONNECT_ERROR_CODES,
  ErrorEnvelopeSchema,
  buildErrorEnvelope,
  classifyConnectError,
  isRetryableConnectError,
} from '../index.js';

describe('error-code taxonomy', () => {
  it('carries exactly the 24 locked codes, no duplicates', () => {
    expect(CONNECT_ERROR_CODES).toHaveLength(24);
    expect(new Set(CONNECT_ERROR_CODES).size).toBe(24);
  });

  it('classifies every code with exactly one of the three classifications', () => {
    for (const code of CONNECT_ERROR_CODES) {
      expect(CONNECT_ERROR_CLASSIFICATIONS).toContain(CONNECT_ERROR_CLASSIFICATION[code]);
    }
    expect(Object.keys(CONNECT_ERROR_CLASSIFICATION).sort()).toEqual([...CONNECT_ERROR_CODES].sort());
  });

  it('pins the classifications behaviour depends on', () => {
    // Spent/expired credentials are terminal: R6 burns a claimed token that
    // fails later — the partner re-mints, the client never retries the old one.
    expect(classifyConnectError('AUTH_TOKEN_USED')).toBe('terminal');
    expect(classifyConnectError('AUTH_EXPIRED_TOKEN')).toBe('terminal');
    expect(classifyConnectError('CALL_ENDED')).toBe('terminal');
    expect(classifyConnectError('IDEMPOTENCY_CONFLICT')).toBe('terminal');
    expect(classifyConnectError('SUBJECT_ALREADY_ACTIVE')).toBe('terminal');
    // Only the end user can clear these.
    expect(classifyConnectError('DISPLAY_NAME_TAKEN')).toBe('user-action');
    expect(classifyConnectError('MEDIA_PERMISSION_DENIED')).toBe('user-action');
    expect(classifyConnectError('MEDIA_UNAVAILABLE')).toBe('user-action');
    // Transient by nature.
    expect(classifyConnectError('RATE_LIMITED')).toBe('retryable');
    expect(classifyConnectError('CONNECTION_LOST')).toBe('retryable');
    expect(classifyConnectError('TRANSLATION_UNAVAILABLE')).toBe('retryable');
    expect(classifyConnectError('GENERATED_AUDIO_UNAVAILABLE')).toBe('retryable');
    expect(classifyConnectError('INTERNAL')).toBe('retryable');
  });

  it('derives the envelope retryable flag from the taxonomy, never from the caller', () => {
    const retryable = buildErrorEnvelope('RATE_LIMITED', 'slow down', 'req_1');
    expect(retryable.error.retryable).toBe(true);
    const terminal = buildErrorEnvelope('CALL_NOT_FOUND', 'no such call', 'req_2');
    expect(terminal.error.retryable).toBe(false);
    const userAction = buildErrorEnvelope('DISPLAY_NAME_TAKEN', 'name taken', 'req_3');
    expect(userAction.error.retryable).toBe(false);
    expect(isRetryableConnectError('DISPLAY_NAME_TAKEN')).toBe(false);
  });

  it('accepts every built envelope back through the schema', () => {
    for (const code of CONNECT_ERROR_CODES) {
      const envelope = buildErrorEnvelope(code, 'message', 'req_x');
      expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    }
  });

  it('refuses unknown codes, missing fields, and surface growth', () => {
    const valid = buildErrorEnvelope('INTERNAL', 'boom', 'req_9');
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { ...valid.error, code: 'SOMETHING_NEW' },
      }).success,
    ).toBe(false);
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'INTERNAL', message: 'boom', retryable: true },
      }).success,
    ).toBe(false); // requestId is not optional
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { ...valid.error, detail: 'extra' },
      }).success,
    ).toBe(false);
    expect(
      ErrorEnvelopeSchema.safeParse({ ...valid, statusCode: 500 }).success,
    ).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ error: { ...valid.error, message: '' } }).success).toBe(
      false,
    );
  });
});
