/** @author masterzee001 */
/**
 * These tests are adversarial on purpose.
 *
 * This module decides whether somebody is who they say they are, and everything
 * downstream — whose voice may be spoken, whose recording may be deleted —
 * trusts its answer completely. So the interesting cases are not "a good token
 * works", they are the ones where an attacker gets to choose the input.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  issueSessionToken,
  requireSessionSecret,
  verifySessionToken,
  SESSION_LIFETIME_SECONDS,
} from '../session-token.js';

const SECRET = requireSessionSecret('x'.repeat(48), 'TEST_SECRET');
const OTHER_SECRET = requireSessionSecret('y'.repeat(48), 'TEST_SECRET');
const ACCOUNT = 'acct_0123456789abcdef';
const NOW = 1_760_000_000;

function token(overrides: { version?: number; nowSeconds?: number; lifetimeSeconds?: number } = {}) {
  return issueSessionToken({
    secret: SECRET,
    accountId: ACCOUNT,
    version: overrides.version ?? 1,
    nowSeconds: overrides.nowSeconds ?? NOW,
    ...(overrides.lifetimeSeconds === undefined
      ? {}
      : { lifetimeSeconds: overrides.lifetimeSeconds }),
  });
}

/** Re-sign a chosen payload, the way a forger with the secret would. */
function forge(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${signature}`;
}

describe('a token issued here is accepted here', () => {
  it('round-trips the account and its token generation', () => {
    const result = verifySessionToken({ secret: SECRET, token: token({ version: 7 }), nowSeconds: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.accountId).toBe(ACCOUNT);
    expect(result.claims.version).toBe(7);
    expect(result.claims.expiresAt).toBe(NOW + SESSION_LIFETIME_SECONDS);
  });
});

describe('a token nobody here issued is refused', () => {
  it('refuses a signature from a different secret', () => {
    // The whole basis of trusting the payload.
    const foreign = issueSessionToken({
      secret: OTHER_SECRET,
      accountId: ACCOUNT,
      version: 1,
      nowSeconds: NOW,
    });

    expect(verifySessionToken({ secret: SECRET, token: foreign, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a payload edited after signing', () => {
    // Swapping the subject for somebody else's account is the attack this
    // exists to stop: it would hand over their voice.
    const good = token();
    const [, signature] = good.split('.');
    const tampered = forge({ sub: 'acct_ffffffffffffffff', iat: NOW, exp: NOW + 60, ver: 1 }).split('.')[0];

    expect(
      verifySessionToken({ secret: SECRET, token: `${tampered}.${signature}`, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a token with no signature at all', () => {
    // The shape a JWT `alg: none` attack takes. There is no algorithm field to
    // confuse here, and an unsigned token is simply malformed.
    const body = token().split('.')[0]!;

    expect(verifySessionToken({ secret: SECRET, token: body, nowSeconds: NOW }).ok).toBe(false);
    expect(verifySessionToken({ secret: SECRET, token: `${body}.`, nowSeconds: NOW }).ok).toBe(false);
  });

  it('refuses junk without throwing', () => {
    // A verifier that throws on malformed input turns a bad request into a 500,
    // and a 500 into a way of probing.
    for (const candidate of ['', '.', 'a.b.c', 'not-a-token', '....', '%%%.%%%']) {
      expect(() =>
        verifySessionToken({ secret: SECRET, token: candidate, nowSeconds: NOW }),
      ).not.toThrow();
      expect(verifySessionToken({ secret: SECRET, token: candidate, nowSeconds: NOW }).ok).toBe(false);
    }
  });
});

describe('a validly signed token still has to make sense', () => {
  it('refuses a subject that is not an account id', () => {
    // Signed by us, so the signature holds — and still refused, because a
    // participant id or display name in `sub` is not an identity.
    for (const subject of ['participant_1', 'Zoe Meak', 'devid_aaaaaaaaaaaa', '', 42, null]) {
      const signed = forge({ sub: subject, iat: NOW, exp: NOW + 60, ver: 1 });
      expect(verifySessionToken({ secret: SECRET, token: signed, nowSeconds: NOW }).ok).toBe(false);
    }
  });

  it('refuses a retired prototype identity specifically', () => {
    // Accounts exist to end browser-scoped ownership. A devid_ must not become
    // an account by being placed in a signed token.
    const signed = forge({ sub: 'devid_aaaaaaaaaaaa', iat: NOW, exp: NOW + 60, ver: 1 });

    expect(verifySessionToken({ secret: SECRET, token: signed, nowSeconds: NOW }).ok).toBe(false);
  });

  it('refuses missing or non-numeric timestamps rather than treating them as zero', () => {
    // A missing `exp` coerced to 0 would be "expired"; coerced to Infinity it
    // would be a token that never dies. Neither is a decision to make silently.
    for (const payload of [
      { sub: ACCOUNT, iat: NOW, ver: 1 },
      { sub: ACCOUNT, iat: NOW, exp: 'soon', ver: 1 },
      { sub: ACCOUNT, iat: NOW, exp: Infinity, ver: 1 },
      { sub: ACCOUNT, iat: NOW, exp: NOW + 60 },
    ]) {
      expect(verifySessionToken({ secret: SECRET, token: forge(payload), nowSeconds: NOW }).ok).toBe(
        false,
      );
    }
  });
});

describe('expiry', () => {
  it('refuses a token at and after its expiry, and reports why', () => {
    const short = token({ lifetimeSeconds: 60 });

    expect(verifySessionToken({ secret: SECRET, token: short, nowSeconds: NOW + 59 }).ok).toBe(true);
    expect(verifySessionToken({ secret: SECRET, token: short, nowSeconds: NOW + 60 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('the secret is required, not defaulted', () => {
  it('refuses to operate on a missing or trivial secret', () => {
    // A repository-wide default key is a key everybody has. Failing to start is
    // the correct outcome, and the message says how to make one.
    for (const candidate of [undefined, '', '   ', 'short', 'x'.repeat(31)]) {
      expect(() => requireSessionSecret(candidate, 'VIDEOFY_AUTH_SECRET')).toThrow(
        /VIDEOFY_AUTH_SECRET/,
      );
    }
    expect(() => requireSessionSecret('x'.repeat(32), 'VIDEOFY_AUTH_SECRET')).not.toThrow();
  });
});

describe('bearerToken', () => {
  it('takes the token and nothing else', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('  Bearer   abc.def  ')).toBe('abc.def');
    expect(bearerToken('bearer abc.def')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
