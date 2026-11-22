/**
 * Google ID token verification.
 *
 * This is the whole security boundary for signing in with Google: everything
 * after it trusts what it returns. So these tests mint REAL RSA-signed tokens
 * against a key generated here and serve a real JWKS document, rather than
 * stubbing the verifier and asserting it was called. A stub would agree with
 * a verifier that accepts `alg: none`.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleIdTokenVerifier } from '../google-id-token.js';

const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const AUDIENCE = '692573915541-13t0122j4bd8vkgkainvh91cjt9vfdil.apps.googleusercontent.com';
const OTHER_APP = '111111111111-someoneelsesapp.apps.googleusercontent.com';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function base64url(value: object | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return buffer.toString('base64url');
}

function sign(
  payload: Record<string, unknown>,
  options: { kid?: string; alg?: string; key?: KeyObject; signature?: Buffer } = {},
): string {
  const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? 'key-1', typ: 'JWT' };
  const body = `${base64url(header)}.${base64url(payload)}`;
  if (options.signature) return `${body}.${base64url(options.signature)}`;
  if (header.alg === 'none') return `${body}.`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  signer.end();
  return `${body}.${signer.sign(options.key ?? pair.privateKey).toString('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '1098765',
    email: 'Zoe@Example.com',
    email_verified: true,
    name: 'Zoe',
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

/** A JWKS document holding the public halves we want the verifier to see. */
function jwks(entries: Array<{ kid: string; key: KeyObject }>): string {
  return JSON.stringify({
    keys: entries.map(({ kid, key }) => ({
      ...(key.export({ format: 'jwk' }) as Record<string, unknown>),
      kid,
      use: 'sig',
      alg: 'RS256',
    })),
  });
}

function verifier(
  options: {
    body?: string;
    status?: number;
    audiences?: readonly string[];
    now?: () => number;
    onFetch?: () => void;
  } = {},
) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    options.onFetch?.();
    const status = options.status ?? 200;
    return new Response(options.body ?? jwks([{ kid: 'key-1', key: pair.publicKey }]), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
    });
  }) as unknown as typeof fetch;

  return {
    verifier: new GoogleIdTokenVerifier({
      audiences: options.audiences ?? [AUDIENCE],
      jwksUrl: 'https://keys.test/certs',
      now: options.now ?? (() => NOW_MS),
      fetchImpl,
    }),
    fetchCount: () => calls,
  };
}

describe('google id token', () => {
  it('refuses to exist without an audience to check against', () => {
    // An empty list read as "accept anything" is one missing env line away
    // from accepting every Google user on earth, looking healthy throughout.
    expect(() => new GoogleIdTokenVerifier({ audiences: [] })).toThrow(/audience/i);
    expect(() => new GoogleIdTokenVerifier({ audiences: ['  '] })).toThrow(/audience/i);
  });

  it('accepts a properly signed token and normalises what it carries', async () => {
    const { verifier: v } = verifier();
    const result = await v.verify(sign(claims()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe('1098765');
    // Lowercased here so the account index is asked the same question it was
    // populated with; a mixed-case address would miss an existing account.
    expect(result.email).toBe('zoe@example.com');
    expect(result.emailVerified).toBe(true);
    expect(result.displayName).toBe('Zoe');
  });

  it('refuses a token minted for somebody else\'s app', async () => {
    const { verifier: v } = verifier();
    // Correctly signed by Google, genuinely issued, simply not for us. Without
    // this check, any app's users could sign into Videofy as themselves.
    const result = await v.verify(sign(claims({ aud: OTHER_APP })));
    expect(result).toEqual({ ok: false, reason: 'wrong-audience' });
  });

  it('accepts any of our own client ids', async () => {
    const { verifier: v } = verifier({ audiences: [AUDIENCE, OTHER_APP] });
    const result = await v.verify(sign(claims({ aud: OTHER_APP })));
    expect(result.ok).toBe(true);
  });

  it('refuses alg none, which asks us to skip the signature', async () => {
    const { verifier: v } = verifier();
    const result = await v.verify(sign(claims(), { alg: 'none' }));
    expect(result).toEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('refuses HS256, which asks us to use a public key as a shared secret', async () => {
    const { verifier: v } = verifier();
    // The key is published. If we honoured `alg`, anyone could HMAC a token
    // with it and we would verify their forgery happily.
    const result = await v.verify(sign(claims(), { alg: 'HS256' }));
    expect(result).toEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('refuses a token signed with the wrong key', async () => {
    const { verifier: v } = verifier();
    const result = await v.verify(sign(claims(), { key: otherPair.privateKey }));
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a tampered payload even though the signature is real', async () => {
    const { verifier: v } = verifier();
    const token = sign(claims());
    const [header, , signature] = token.split('.') as [string, string, string];
    const swapped = base64url(claims({ sub: 'somebody-else' }));
    const result = await v.verify(`${header}.${swapped}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a wrong issuer', async () => {
    const { verifier: v } = verifier();
    const result = await v.verify(sign(claims({ iss: 'https://accounts.evil.test' })));
    expect(result).toEqual({ ok: false, reason: 'wrong-issuer' });
  });

  it('refuses an expired token, allowing only a little clock skew', async () => {
    const { verifier: v } = verifier();
    expect(await v.verify(sign(claims({ exp: NOW_SECONDS - 3600 })))).toEqual({
      ok: false,
      reason: 'expired',
    });
    // Thirty seconds past expiry is drift, not an attack.
    expect((await v.verify(sign(claims({ exp: NOW_SECONDS - 30 })))).ok).toBe(true);
  });

  it('refuses a token with no subject, which is the only join key there is', async () => {
    const { verifier: v } = verifier();
    expect(await v.verify(sign(claims({ sub: '' })))).toEqual({ ok: false, reason: 'no-subject' });
  });

  it('treats a non-boolean email_verified as unverified', async () => {
    const { verifier: v } = verifier();
    // The string "false" is truthy. A truthy check here would mark an
    // unproven address proven, and the linking rule would hand over an
    // existing account on the strength of it.
    const result = await v.verify(sign(claims({ email_verified: 'false' })));
    expect(result.ok && result.emailVerified).toBe(false);
  });

  it('refuses malformed input without throwing', async () => {
    const { verifier: v } = verifier();
    for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '!!!.???.***']) {
      const result = await v.verify(bad);
      expect(result.ok).toBe(false);
    }
  });

  it('caches the key set instead of fetching on every sign-in', async () => {
    const { verifier: v, fetchCount } = verifier();
    await v.verify(sign(claims()));
    await v.verify(sign(claims()));
    await v.verify(sign(claims()));
    expect(fetchCount()).toBe(1);
  });

  it('fetches once when many sign-ins arrive together', async () => {
    const { verifier: v, fetchCount } = verifier();
    await Promise.all([
      v.verify(sign(claims())),
      v.verify(sign(claims())),
      v.verify(sign(claims())),
    ]);
    expect(fetchCount()).toBe(1);
  });

  it('does not let invented key ids turn us into a flood against Google', async () => {
    let clock = NOW_MS;
    const { verifier: v, fetchCount } = verifier({ now: () => clock });
    await v.verify(sign(claims()));
    expect(fetchCount()).toBe(1);

    /*
     * Twenty tokens naming keys that do not exist, straight after a fetch.
     * NONE of them causes a refetch: the key set is current, so an unknown
     * kid is simply a bad token and going back to Google could not change
     * that. This is the amplification being refused -- without it, one sender
     * of junk turns into one outbound request per junk token.
     */
    for (let i = 0; i < 20; i += 1) {
      expect(await v.verify(sign(claims(), { kid: `invented-${i}` }))).toEqual({
        ok: false,
        reason: 'unknown-key',
      });
    }
    expect(fetchCount()).toBe(1);

    // Once the key set is old enough to be worth doubting, twenty more junk
    // tokens buy exactly ONE refetch between them, not twenty.
    clock += 120_000;
    for (let i = 0; i < 20; i += 1) {
      await v.verify(sign(claims(), { kid: `invented-later-${i}` }));
    }
    expect(fetchCount()).toBe(2);
  });

  it('picks up a rotated key before the cache expires', async () => {
    let body = jwks([{ kid: 'key-1', key: pair.publicKey }]);
    let clock = NOW_MS;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(body, {
        status: 200,
        // An hour, so this test is about rotation and NOT about expiry: the
        // new key has to be found while the cache still considers itself good.
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      });
    }) as unknown as typeof fetch;
    const v = new GoogleIdTokenVerifier({
      audiences: [AUDIENCE],
      jwksUrl: 'https://keys.test/certs',
      now: () => clock,
      fetchImpl,
    });

    expect((await v.verify(sign(claims()))).ok).toBe(true);
    expect(calls).toBe(1);

    body = jwks([{ kid: 'key-2', key: otherPair.publicKey }]);
    clock += 120_000; // older than the refetch floor, far younger than max-age
    const rotated = await v.verify(sign(claims(), { kid: 'key-2', key: otherPair.privateKey }));
    expect(rotated.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('says the keys are unavailable rather than calling the token bad', async () => {
    const { verifier: v } = verifier({ status: 500 });
    // These are different failures and must not be collapsed: one is their
    // token, the other is our outage, and telling somebody their sign-in was
    // rejected sends them to fix something that is not broken.
    expect(await v.verify(sign(claims()))).toEqual({ ok: false, reason: 'keys-unavailable' });
  });

  it('keeps working on a stale key set when the fetch fails', async () => {
    let fail = false;
    let clock = NOW_MS;
    const fetchImpl = (async () => {
      if (fail) throw new Error('network down');
      return new Response(jwks([{ kid: 'key-1', key: pair.publicKey }]), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=1' },
      });
    }) as unknown as typeof fetch;
    const v = new GoogleIdTokenVerifier({
      audiences: [AUDIENCE],
      jwksUrl: 'https://keys.test/certs',
      now: () => clock,
      fetchImpl,
    });

    expect((await v.verify(sign(claims()))).ok).toBe(true);
    fail = true;
    clock += 10_000; // cache past its max-age, and Google unreachable
    // Google's keys long outlive their cache header, so refusing every
    // sign-in here would be an outage we chose rather than one we suffered.
    expect((await v.verify(sign(claims()))).ok).toBe(true);
  });
});
