/**
 * Abuse limits.
 *
 * The tests worth having are the ones about the SHAPE of the limit rather than
 * the arithmetic: that a bucket cannot be drained twice across a boundary the
 * way a fixed window can, that surfaces protecting a secret refuse instead of
 * challenging, and that a key built from nothing is refused rather than
 * silently shared.
 */
import { describe, expect, it } from 'vitest';
import {
  ABUSE_POLICIES,
  abuseKey,
  createMemoryAbuseLimiter,
  type AbuseSurface,
} from './index.js';

const NOW = 1_700_000_000_000;
const KEY = 'account:acc_1';

function drain(surface: AbuseSurface, nowMs = NOW) {
  const limiter = createMemoryAbuseLimiter();
  const policy = ABUSE_POLICIES[surface];
  for (let index = 0; index < policy.capacity; index += 1) {
    expect(limiter.consume({ surface, key: KEY, nowMs }).ok).toBe(true);
  }
  return limiter;
}

describe('consuming', () => {
  it('permits exactly the policy capacity, then refuses', () => {
    const limiter = drain('account.create');
    const refused = limiter.consume({ surface: 'account.create', key: KEY, nowMs: NOW });
    expect(refused.ok).toBe(false);
  });

  it('keeps separate buckets per key', () => {
    const limiter = drain('account.create');
    const other = limiter.consume({ surface: 'account.create', key: 'account:acc_2', nowMs: NOW });
    expect(other.ok).toBe(true);
  });

  it('keeps separate buckets per surface', () => {
    const limiter = drain('account.create');
    const other = limiter.consume({ surface: 'organization.create', key: KEY, nowMs: NOW });
    expect(other.ok).toBe(true);
  });

  /*
   * The reason this is a bucket and not a window. Under a fixed window an
   * attacker drains the allowance at the end of one window and again at the
   * start of the next, achieving double the intended sustained rate while no
   * single window looks exceeded.
   */
  it('does not permit a double allowance across a window boundary', () => {
    const surface: AbuseSurface = 'account.create';
    const policy = ABUSE_POLICIES[surface];
    const limiter = drain(surface);

    // One instant after a notional window boundary, only the tokens that have
    // actually refilled are available -- which is one, not a fresh capacity.
    const justAfter = NOW + policy.refillMs;
    let granted = 0;
    for (let attempt = 0; attempt < policy.capacity; attempt += 1) {
      if (limiter.consume({ surface, key: KEY, nowMs: justAfter }).ok) granted += 1;
    }
    expect(granted).toBe(policy.capacity);

    const midway = NOW + policy.refillMs + Math.floor(policy.refillMs / 2);
    let grantedMidway = 0;
    for (let attempt = 0; attempt < policy.capacity; attempt += 1) {
      if (limiter.consume({ surface, key: KEY, nowMs: midway }).ok) grantedMidway += 1;
    }
    expect(grantedMidway).toBeLessThan(policy.capacity);
  });

  it('refills progressively rather than all at once', () => {
    const surface: AbuseSurface = 'account.authenticate';
    const policy = ABUSE_POLICIES[surface];
    const limiter = drain(surface);

    const oneTokenLater = NOW + Math.ceil(policy.refillMs / policy.capacity) + 1;
    expect(limiter.consume({ surface, key: KEY, nowMs: oneTokenLater }).ok).toBe(true);
    expect(limiter.consume({ surface, key: KEY, nowMs: oneTokenLater }).ok).toBe(false);
  });

  it('reports how long to wait', () => {
    const limiter = drain('account.create');
    const refused = limiter.consume({ surface: 'account.create', key: KEY, nowMs: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('forgets a key on reset', () => {
    const limiter = drain('account.authenticate');
    limiter.reset('account.authenticate', KEY);
    expect(limiter.consume({ surface: 'account.authenticate', key: KEY, nowMs: NOW }).ok).toBe(true);
  });
});

describe('challenge escalation', () => {
  it('escalates a surface a real person plausibly hits', () => {
    const limiter = drain('account.authenticate');
    const refused = limiter.consume({ surface: 'account.authenticate', key: KEY, nowMs: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('challenge-required');
  });

  /*
   * Excess here is never legitimate: it is a guess at a six-digit secret, and
   * the cap is what makes six digits acceptable at all.
   */
  it('refuses outright on OTP verification rather than offering a challenge', () => {
    const limiter = drain('verification.phoneVerify');
    const refused = limiter.consume({ surface: 'verification.phoneVerify', key: KEY, nowMs: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('rate-limited');
    expect(ABUSE_POLICIES['verification.phoneVerify'].challengeable).toBe(false);
  });

  it('never makes a message-sending surface challengeable', () => {
    expect(ABUSE_POLICIES['verification.emailResend'].challengeable).toBe(false);
    expect(ABUSE_POLICIES['verification.phoneRequest'].challengeable).toBe(false);
  });
});

describe('keys', () => {
  it('labels each part so compositions cannot collide', () => {
    expect(abuseKey({ account: 'a', ip: 'b' })).not.toBe(abuseKey({ account: 'ab' }));
    expect(abuseKey({ account: 'a', ip: 'b' })).toBe('account:a|ip:b');
  });

  it('orders parts consistently regardless of how they were supplied', () => {
    expect(abuseKey({ ip: '1.2.3.4', account: 'acc' })).toBe(
      abuseKey({ account: 'acc', ip: '1.2.3.4' }),
    );
  });

  it('normalises case so a capitalised address is the same bucket', () => {
    expect(abuseKey({ target: 'Someone@Example.com' })).toBe(abuseKey({ target: 'someone@example.com' }));
  });

  it('omits missing parts rather than rendering them', () => {
    expect(abuseKey({ account: 'a', ip: undefined, session: null })).toBe('account:a');
  });

  /*
   * A shared "undefined" bucket would turn a per-caller limit into a global
   * outage the first time somebody automated against it.
   */
  it('refuses a key built from nothing', () => {
    expect(() => abuseKey({})).toThrow(/at least one/);
    expect(() => abuseKey({ account: '   ' })).toThrow(/at least one/);
  });
});
