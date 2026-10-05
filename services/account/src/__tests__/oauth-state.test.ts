/**
 * The CSRF token for provider logins, and the open redirect it must not become.
 *
 * KingsChat calls this parameter `origin` and echoes it back verbatim, so
 * everything arriving at the callback is a string somebody else may have
 * chosen. These tests are written from that side: not "does it round trip"
 * but "what happens when the value is hostile".
 */
import { describe, expect, it } from 'vitest';
import { OAuthStateStore, safeReturnPath } from '../oauth-state.js';

const START = 1_760_000_000_000;

function store(options: { now?: () => number; ttlMs?: number; maxPending?: number } = {}) {
  let serial = 0;
  return new OAuthStateStore({
    now: options.now ?? (() => START),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
    newToken: () => `token-${++serial}`,
  });
}

describe('oauth login state', () => {
  it('redeems a token it issued, once', () => {
    const s = store();
    const token = s.issue('kingschat', '/dashboard');

    const first = s.consume(token);
    expect(first?.provider).toBe('kingschat');
    expect(first?.returnPath).toBe('/dashboard');

    // Replay is the attack. A token that works twice is a token that can be
    // caught and used again.
    expect(s.consume(token)).toBeNull();
  });

  it('refuses a token it never issued', () => {
    const s = store();
    s.issue('google');
    expect(s.consume('token-not-ours')).toBeNull();
    expect(s.consume('')).toBeNull();
    expect(s.consume(null)).toBeNull();
    expect(s.consume(undefined)).toBeNull();
  });

  it('refuses a token that has expired', () => {
    let clock = START;
    const s = store({ now: () => clock, ttlMs: 60_000 });
    const token = s.issue('kingschat');

    clock += 59_000;
    expect(s.consume(token)).not.toBeNull();

    const second = s.issue('kingschat');
    clock += 61_000;
    expect(s.consume(second)).toBeNull();
  });

  it('spends an expired token rather than leaving it to pile up', () => {
    let clock = START;
    const s = store({ now: () => clock, ttlMs: 60_000 });
    s.issue('google');
    expect(s.pendingCount).toBe(1);

    clock += 61_000;
    s.consume('token-1');
    expect(s.pendingCount).toBe(0);
  });

  it('cannot be made to hold memory without bound', () => {
    const s = store({ maxPending: 10 });
    for (let i = 0; i < 50; i += 1) s.issue('kingschat');
    expect(s.pendingCount).toBeLessThanOrEqual(10);
  });

  it('drops the oldest attempt rather than refusing new logins', () => {
    const s = store({ maxPending: 3 });
    const first = s.issue('kingschat');
    s.issue('kingschat');
    s.issue('kingschat');
    const newest = s.issue('kingschat');

    // The twenty-minute-old attempt is nearly dead anyway; refusing the fresh
    // one would turn somebody else's flood into an outage for this person.
    expect(s.consume(first)).toBeNull();
    expect(s.consume(newest)).not.toBeNull();
  });

  it('forgets an attempt that expired before anyone redeemed it', () => {
    let clock = START;
    const s = store({ now: () => clock, ttlMs: 60_000 });
    s.issue('google');
    s.issue('google');
    clock += 61_000;
    // Issuing sweeps, so abandoned logins do not accumulate for the life of
    // the process.
    s.issue('google');
    expect(s.pendingCount).toBe(1);
  });
});

describe('return path', () => {
  it('keeps an ordinary local path', () => {
    expect(safeReturnPath('/dashboard/reports')).toBe('/dashboard/reports');
    expect(safeReturnPath('/c/zoe?tab=live')).toBe('/c/zoe?tab=live');
  });

  it('refuses every way of leaving the site while looking like we sent them', () => {
    // Each of these, followed blindly, puts a stranger's page behind our
    // domain in the address bar of somebody who just signed in.
    expect(safeReturnPath('https://evil.test/x')).toBe('/');
    expect(safeReturnPath('http://evil.test/x')).toBe('/');
    // Protocol-relative: a browser reads this as another origin entirely.
    expect(safeReturnPath('//evil.test/x')).toBe('/');
    // Some browsers normalise the backslash to a slash, making it the above.
    expect(safeReturnPath('/\\evil.test/x')).toBe('/');
    expect(safeReturnPath('javascript:alert(1)')).toBe('/');
    expect(safeReturnPath('data:text/html,<script>')).toBe('/');
  });

  it('refuses a path carrying control characters', () => {
    // A newline in a Location header splits the response.
    expect(safeReturnPath('/ok\r\nLocation: https://evil.test')).toBe('/');
    expect(safeReturnPath('/ok\u0000')).toBe('/');
  });

  it('falls back to the root for anything missing or absurd', () => {
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath('   ')).toBe('/');
    expect(safeReturnPath('dashboard')).toBe('/');
    expect(safeReturnPath(`/${'a'.repeat(600)}`)).toBe('/');
  });

  it('is applied when the attempt is issued, not when it comes back', () => {
    const s = store();
    // The only moment we hold a value we chose ourselves is on the way out.
    const token = s.issue('kingschat', 'https://evil.test/x');
    expect(s.consume(token)?.returnPath).toBe('/');
  });
});
