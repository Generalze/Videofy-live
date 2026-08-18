/** @owner masterzee001 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueSessionToken, verifySessionToken } from '@videofy-live/account-tokens';
import type { AccountId } from '@videofy-live/participant-contracts';
import {
  CONNECT_JOIN_TOKEN_DEFAULT_TTL_SECONDS,
  CONNECT_JOIN_TOKEN_MAX_TTL_SECONDS,
  ConnectJtiRegistry,
  issueConnectJoinToken,
  requireConnectAuthSecret,
  verifyConnectJoinToken,
  type ConnectJoinTokenPrefs,
} from '../join-token.js';

const CONNECT_SECRET = Buffer.from('connect-secret-0123456789abcdef0123456789abcdef', 'utf8');
const OTHER_SECRET = Buffer.from('another-secret-0123456789abcdef0123456789abcdef', 'utf8');
const NOW = 1_755_500_000;

const PREFS: ConnectJoinTokenPrefs = {
  speak: 'en',
  hear: 'es',
  audioMode: 'translated',
  captions: true,
  voiceGender: 'female',
};

function mint(overrides: Partial<Parameters<typeof issueConnectJoinToken>[0]> = {}) {
  return issueConnectJoinToken({
    secret: CONNECT_SECRET,
    proj: 'proj_abc123def456',
    call: 'vc_0123456789abcdef',
    sub: 'customer_8291',
    name: 'Ana',
    prefs: PREFS,
    jti: 'jti_000000000000000000000001',
    nowSeconds: NOW,
    ...overrides,
  });
}

describe('connect join tokens', () => {
  it('round-trips every claim through issue and verify', () => {
    const { token, expiresAtSeconds } = mint();
    expect(expiresAtSeconds).toBe(NOW + CONNECT_JOIN_TOKEN_DEFAULT_TTL_SECONDS);
    const verified = verifyConnectJoinToken({ secret: CONNECT_SECRET, token, nowSeconds: NOW + 1 });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toEqual({
      aud: 'vc-join',
      proj: 'proj_abc123def456',
      call: 'vc_0123456789abcdef',
      sub: 'customer_8291',
      name: 'Ana',
      prefs: PREFS,
      jti: 'jti_000000000000000000000001',
      iat: NOW,
      exp: NOW + 300,
    });
  });

  it('honours a custom TTL and refuses out-of-range TTLs rather than clamping', () => {
    expect(mint({ ttlSeconds: CONNECT_JOIN_TOKEN_MAX_TTL_SECONDS }).expiresAtSeconds).toBe(NOW + 900);
    expect(() => mint({ ttlSeconds: 0 })).toThrow(/between 1 and 900/);
    expect(() => mint({ ttlSeconds: 901 })).toThrow(/between 1 and 900/);
    expect(() => mint({ ttlSeconds: 30.5 })).toThrow(/between 1 and 900/);
  });

  it('reports an expired token as expired, not invalid', () => {
    const { token } = mint();
    const atExpiry = verifyConnectJoinToken({ secret: CONNECT_SECRET, token, nowSeconds: NOW + 300 });
    expect(atExpiry).toEqual({ ok: false, reason: 'expired' });
    const justBefore = verifyConnectJoinToken({
      secret: CONNECT_SECRET,
      token,
      nowSeconds: NOW + 299,
    });
    expect(justBefore.ok).toBe(true);
  });

  it('refuses a token signed with a different secret', () => {
    const { token } = mint();
    expect(verifyConnectJoinToken({ secret: OTHER_SECRET, token, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses tampered bodies, malformed tokens, and missing claims', () => {
    const { token } = mint();
    const [body, signature] = token.split('.') as [string, string];
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64').toString('utf8')), sub: 'victim' }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    for (const candidate of [
      `${tamperedBody}.${signature}`,
      'not-a-token',
      'a.b.c',
      `${body}.`,
      `.${signature}`,
    ]) {
      expect(verifyConnectJoinToken({ secret: CONNECT_SECRET, token: candidate, nowSeconds: NOW })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('refuses a validly signed body whose prefs are malformed', () => {
    const claims = {
      aud: 'vc-join',
      proj: 'proj_x',
      call: 'vc_0123456789abcdef',
      sub: 's',
      name: 'n',
      prefs: { speak: 'en', hear: 'es', audioMode: 'loud', captions: true, voiceGender: 'female' },
      jti: 'jti_1',
      iat: NOW,
      exp: NOW + 60,
    };
    const forged = signLike(claims, CONNECT_SECRET);
    expect(verifyConnectJoinToken({ secret: CONNECT_SECRET, token: forged, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('requires a usable secret and refuses short ones', () => {
    expect(() => requireConnectAuthSecret(undefined, 'CONNECT_AUTH_SECRET')).toThrow(
      /CONNECT_AUTH_SECRET/,
    );
    expect(() => requireConnectAuthSecret('short', 'CONNECT_AUTH_SECRET')).toThrow(/at least 32/);
    expect(
      requireConnectAuthSecret('0123456789abcdef0123456789abcdef', 'CONNECT_AUTH_SECRET'),
    ).toBeInstanceOf(Buffer);
  });
});

describe('cross-verification with account session tokens is structurally impossible', () => {
  it('an account session token never verifies as a connect token — even under the SAME secret', () => {
    const accountToken = issueSessionToken({
      secret: CONNECT_SECRET, // deliberately the same secret: aud must be the wall
      accountId: 'acct_0123456789abcdef' as AccountId,
      version: 1,
      nowSeconds: NOW,
    });
    expect(
      verifyConnectJoinToken({ secret: CONNECT_SECRET, token: accountToken, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: 'invalid' });
    // And with the honest configuration (different secrets) it fails on the signature too.
    expect(
      verifyConnectJoinToken({ secret: OTHER_SECRET, token: accountToken, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a connect token never verifies as an account session token — even under the SAME secret', () => {
    const { token } = mint();
    const sameSecret = verifySessionToken({ secret: CONNECT_SECRET, token, nowSeconds: NOW });
    expect(sameSecret.ok).toBe(false);
    const differentSecret = verifySessionToken({ secret: OTHER_SECRET, token, nowSeconds: NOW });
    expect(differentSecret.ok).toBe(false);
  });
});

describe('ConnectJtiRegistry (R6 single use)', () => {
  it('claims a jti exactly once', () => {
    const registry = new ConnectJtiRegistry();
    expect(registry.claim('jti_a', NOW + 300, NOW)).toBe(true);
    expect(registry.claim('jti_a', NOW + 300, NOW)).toBe(false);
    expect(registry.claim('jti_b', NOW + 300, NOW)).toBe(true);
  });

  it('prunes entries only after expiry plus the retention margin', () => {
    const registry = new ConnectJtiRegistry();
    registry.claim('jti_a', NOW + 10, NOW);
    // Still burned right after expiry (skew margin).
    expect(registry.claim('jti_a', NOW + 10, NOW + 11)).toBe(false);
    // Long after expiry the entry is pruned; verify would refuse the token
    // as expired anyway, so re-claim is harmless — and memory stays bounded.
    expect(registry.claim('jti_a', NOW + 10, NOW + 10 + 61)).toBe(true);
    expect(registry.size).toBe(1);
  });
});

function signLike(claims: unknown, secret: Buffer): string {
  // Mirrors the module's construction for forged-body tests.
  const body = Buffer.from(JSON.stringify(claims), 'utf8')
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
