/**
 * Redeeming a KingsChat authorization code.
 *
 * The responses stubbed here are the ones their reference documents, status
 * codes included, because the refusals are the part that matters: a 403 from
 * the token endpoint is OUR unapproved client, a 422 is THEIR expired code,
 * and a 401 from the profile endpoint is our missing api key. Collapsing
 * those into one failure sends somebody to retry a login forever against a
 * deployment that can never succeed.
 */
import { describe, expect, it } from 'vitest';
import { KingsChatIdentity } from '../kingschat-identity.js';

const CLIENT_ID = '11c1340f-cbfa-4de3-b12d-dbe24f77b0d8';
const API_KEY = 'project-api-key-for-tests';
const BASE = 'https://connect.test';

interface StubOptions {
  token?: { status: number; body?: unknown };
  profile?: { status: number; body?: unknown };
  tokenThrows?: boolean;
  profileThrows?: boolean;
}

function harness(options: StubOptions = {}) {
  const requests: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const warnings: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    requests.push({
      url: target,
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });

    if (target.endsWith('/oauth2/token')) {
      if (options.tokenThrows) throw new Error('network down');
      const spec = options.token ?? {
        status: 200,
        body: { access_token: 'access-abc', refresh_token: 'refresh-abc' },
      };
      return new Response(JSON.stringify(spec.body ?? {}), {
        status: spec.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (options.profileThrows) throw new Error('network down');
    const spec = options.profile ?? {
      status: 200,
      body: {
        profile: {
          id: 'user_abc123',
          name: 'Zoe Meak',
          username: 'meakzoe',
          email: 'Zoe@Example.com',
          is_email_verified: true,
        },
      },
    };
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    requests,
    warnings,
    identity: new KingsChatIdentity({
      clientId: CLIENT_ID,
      apiKey: API_KEY,
      baseUrl: BASE,
      fetchImpl,
      warn: (message) => warnings.push(message),
    }),
  };
}

describe('kingschat identity', () => {
  it('refuses to exist without the two values it cannot work without', () => {
    // Discovered at boot rather than by the first person who tries to sign in.
    expect(() => new KingsChatIdentity({ clientId: '', apiKey: API_KEY })).toThrow(/client id/i);
    expect(() => new KingsChatIdentity({ clientId: CLIENT_ID, apiKey: '  ' })).toThrow(/api key/i);
  });

  it('exchanges the code and reads the profile', async () => {
    const { identity, requests } = harness();
    const result = await identity.verify('code-xyz');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe('user_abc123');
    // Lowercased so the account index is asked the question it was filled with.
    expect(result.email).toBe('zoe@example.com');
    expect(result.emailVerified).toBe(true);
    expect(result.displayName).toBe('Zoe Meak');
    expect(result.username).toBe('meakzoe');

    // The exchange carries no secret -- they do not accept one -- and the
    // profile read carries both the project key and this person's token.
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      grant_type: 'code',
      client_id: CLIENT_ID,
      code: 'code-xyz',
    });
    expect(requests[1]?.headers['api-key']).toBe(API_KEY);
    expect(requests[1]?.headers['authorization']).toBe('Bearer access-abc');
  });

  it('never sends the api key to the token endpoint', async () => {
    const { identity, requests } = harness();
    await identity.verify('code-xyz');
    // It is a project-wide secret shared by all four applications. It belongs
    // on exactly one call, and widening that is how it ends up somewhere it
    // can be read.
    expect(JSON.stringify(requests[0])).not.toContain(API_KEY);
  });

  it('tells our unapproved client apart from their expired code', async () => {
    const refusedClient = harness({
      token: { status: 403, body: { code: 'invalid_client' } },
    });
    expect(await refusedClient.identity.verify('code-xyz')).toEqual({
      ok: false,
      reason: 'client-rejected',
    });
    // Our fault, so it has to be audible rather than looking like a user error.
    expect(refusedClient.warnings.join(' ')).toMatch(/client id/i);

    const expiredCode = harness({ token: { status: 422, body: {} } });
    expect(await expiredCode.identity.verify('code-xyz')).toEqual({
      ok: false,
      reason: 'code-rejected',
    });
    // Theirs to retry, so nothing is logged as our failure.
    expect(expiredCode.warnings).toHaveLength(0);
  });

  it('names a refused api key instead of blaming the person signing in', async () => {
    const { identity, warnings } = harness({
      profile: { status: 401, body: { error: 'invalid_api_key', message: 'nope' } },
    });
    expect(await identity.verify('code-xyz')).toEqual({ ok: false, reason: 'api-key-rejected' });
    expect(warnings.join(' ')).toMatch(/api key/i);
    // Their code is the part that says WHICH header was refused; the first
    // live failure threw it away and could only say 'check the key'.
    expect(warnings.join(' ')).toContain('invalid_api_key');
  });

  it('reports an unreachable provider as unavailable, not as a bad code', async () => {
    const tokenDown = harness({ tokenThrows: true });
    expect(await tokenDown.identity.verify('code-xyz')).toEqual({
      ok: false,
      reason: 'provider-unavailable',
    });
    const profileDown = harness({ profileThrows: true });
    expect(await profileDown.identity.verify('code-xyz')).toEqual({
      ok: false,
      reason: 'provider-unavailable',
    });
  });

  it('refuses a profile with no id, which is the only join key there is', async () => {
    const { identity } = harness({
      profile: { status: 200, body: { profile: { id: '', name: 'Zoe' } } },
    });
    expect(await identity.verify('code-xyz')).toEqual({ ok: false, reason: 'no-subject' });
  });

  it('treats a non-boolean is_email_verified as unverified', async () => {
    const { identity } = harness({
      profile: {
        status: 200,
        body: { profile: { id: 'u1', email: 'zoe@example.com', is_email_verified: 'false' } },
      },
    });
    const result = await identity.verify('code-xyz');
    // "false" is a truthy string. Read loosely, it would mark an unproven
    // address proven and let this identity claim an existing account.
    expect(result.ok && result.emailVerified).toBe(false);
  });

  it('treats a missing email as absent rather than empty', async () => {
    const { identity } = harness({
      profile: { status: 200, body: { profile: { id: 'u1', is_email_verified: true } } },
    });
    const result = await identity.verify('code-xyz');
    expect(result.ok && result.email).toBeNull();
  });

  it('refuses an empty code without troubling the provider', async () => {
    const { identity, requests } = harness();
    expect(await identity.verify('   ')).toEqual({ ok: false, reason: 'code-rejected' });
    expect(requests).toHaveLength(0);
  });

  it('refuses a token response that carries no access token', async () => {
    const { identity, warnings } = harness({ token: { status: 200, body: { expires_in_millis: 1 } } });
    expect(await identity.verify('code-xyz')).toEqual({
      ok: false,
      reason: 'provider-unavailable',
    });
    expect(warnings.join(' ')).toMatch(/no access token/i);
  });

  it('survives a response body that is not the shape they document', async () => {
    for (const body of [null, [], 'nonsense', { profile: null }]) {
      const { identity } = harness({ profile: { status: 200, body } });
      const result = await identity.verify('code-xyz');
      expect(result.ok).toBe(false);
    }
  });
});
