/**
 * Security observability.
 *
 * These tests exist to hold ONE line: nothing secret may be recorded. The
 * primary defence is structural -- SecurityEvent has nowhere to put a token --
 * so the most valuable test here is the one that fails if the type ever grows
 * a field that would give it somewhere.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERTABLE,
  FORBIDDEN_EVENT_FIELDS,
  containsForbiddenField,
  newCorrelationId,
  securityEvent,
  targetDigest,
} from './index.js';

const NOW = 1_700_000_000_000;
const SALT = 'deployment-salt-0123456789abcdef';

describe('correlation ids', () => {
  it('are unique per request', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCorrelationId()));
    expect(ids.size).toBe(200);
  });

  /*
   * Derived from the account, an id would link records meant to be separate
   * and would outlive the account in logs.
   */
  it('are not derived from anything about the person', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe('target digests', () => {
  it('are stable for the same address, so velocity can be counted', () => {
    expect(targetDigest('someone@example.com', SALT)).toBe(targetDigest('someone@example.com', SALT));
  });

  it('normalise case and surrounding space', () => {
    expect(targetDigest('  Someone@Example.com ', SALT)).toBe(
      targetDigest('someone@example.com', SALT),
    );
  });

  it('differ per address', () => {
    expect(targetDigest('a@example.com', SALT)).not.toBe(targetDigest('b@example.com', SALT));
  });

  it('never contain the address', () => {
    const digest = targetDigest('someone@example.com', SALT);
    expect(digest).not.toContain('someone');
    expect(digest).not.toContain('@');
  });

  /*
   * An unsalted digest of an email address is reversible by anybody holding a
   * list of email addresses, which is everybody.
   */
  it('differ per deployment salt', () => {
    expect(targetDigest('someone@example.com', SALT)).not.toBe(
      targetDigest('someone@example.com', 'a-completely-different-salt-value'),
    );
  });

  it('refuse a salt too short to be one', () => {
    expect(() => targetDigest('someone@example.com', '')).toThrow(/at least/);
    expect(() => targetDigest('someone@example.com', 'short')).toThrow(/at least/);
  });
});

describe('events', () => {
  it('stamps alertability from the single table, not the caller', () => {
    const paging = securityEvent({
      kind: 'mfa.disabled',
      correlationId: newCorrelationId(),
      atMs: NOW,
      accountId: 'acc_1',
    });
    const routine = securityEvent({
      kind: 'authentication.succeeded',
      correlationId: newCorrelationId(),
      atMs: NOW,
      accountId: 'acc_1',
    });

    expect(paging.alert).toBe(true);
    expect(routine.alert).toBe(false);
  });

  it('alerts on a forwarded-invitation rejection', () => {
    expect(ALERTABLE.has('organization.inviteRejectedWrongRecipient')).toBe(true);
  });

  it('carries a machine reason code rather than prose', () => {
    const event = securityEvent({
      kind: 'authentication.failed',
      correlationId: newCorrelationId(),
      atMs: NOW,
      reasonCode: 'bad-credentials',
    });
    expect(event.reasonCode).toBe('bad-credentials');
  });

  /*
   * The line this module exists to hold. A realistic event is assembled and
   * proven to contain nothing that would be a disclosure in a log aggregator.
   */
  it('cannot carry a secret', () => {
    const event = securityEvent({
      kind: 'passwordReset.requested',
      correlationId: newCorrelationId(),
      atMs: NOW,
      accountId: 'acc_1',
      targetDigest: targetDigest('someone@example.com', SALT),
      reasonCode: 'unknown-account',
      sourceIp: '203.0.113.7',
    });

    expect(containsForbiddenField(event)).toBeNull();
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('someone@example.com');
    expect(serialised).not.toContain('example.com');
  });

  it('detects a forbidden field if one ever reaches a sink by another route', () => {
    expect(containsForbiddenField({ kind: 'x', token: 'abc' })).toBe('token');
    expect(containsForbiddenField({ kind: 'x', nested: { otp: '123456' } })).toBe('otp');
    expect(containsForbiddenField({ kind: 'x', accountId: 'acc_1' })).toBeNull();
  });

  it('forbids the field names that carry credentials and identity data', () => {
    for (const field of ['password', 'token', 'otp', 'mfaSecret', 'document', 'email']) {
      expect(FORBIDDEN_EVENT_FIELDS).toContain(field);
    }
  });

  /*
   * DP-170 is a LOCKED position and names these explicitly. Communications
   * content is treated as high-sensitivity whether or not it is legally
   * special category, because a message may reveal health, religion, politics
   * or trade secrets without the platform having asked for any of it.
   */
  it('forbids every category DP-170 names', () => {
    for (const field of [
      'message',
      'transcript',
      'translation',
      'audio',
      'video',
      'attachment',
      'authorization',
      'apiKey',
      'cookie',
      'cardNumber',
    ]) {
      expect(FORBIDDEN_EVENT_FIELDS).toContain(field);
    }
  });

  it('catches communications content nested inside an event', () => {
    expect(containsForbiddenField({ kind: 'x', transcript: 'what was said' })).toBe('transcript');
    expect(containsForbiddenField({ kind: 'x', nested: { audio: 'bytes' } })).toBe('audio');
  });
});
