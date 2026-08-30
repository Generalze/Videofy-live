/** @author masterzee001 */
/**
 * The gateway's client for persisted channel identity.
 *
 * WHAT THESE PIN. Founder directive (A, 30 Aug 2026): channel identity
 * persists outside gateway memory. The client reads it with a short timeout
 * and a one-minute cache, writes only what the gateway owns (the claim and
 * the visibility mirror), and on any failure answers "nothing known" while
 * logging a warning that carries no id and no credential.
 */
import { describe, expect, it } from 'vitest';
import {
  NULL_CHANNEL_IDENTITY,
  createChannelIdentityClient,
  parseChannelProfile,
} from '../channel-identity.js';

const TOKEN = 'internal-token-that-must-never-be-logged';
const ALICE = 'acct_a1b2c3d4e5f60718';
const CHANNEL = 'c0ffee0123456789';

function profileJson(channelId: string, overrides: Record<string, unknown> = {}) {
  return {
    channelId,
    ownerAccountId: ALICE,
    handle: 'alice-live',
    displayName: 'Alice Live',
    description: 'Sunday services',
    category: 'faith',
    visibility: 'public',
    avatarUrl: `/channels/${channelId}/avatar`,
    bannerUrl: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records every call and answers from a script. */
function fakeFetch(answer: (call: Call) => { status: number; body?: unknown } | 'hang') {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const scripted = answer(call);
    if (scripted === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify(scripted.body ?? {}), {
        status: scripted.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(
  fetchImpl: typeof fetch,
  extra: { now?: () => number; timeoutMs?: number; ttlMs?: number } = {},
) {
  const warnings: { message: string; detail: Record<string, unknown> }[] = [];
  const port = createChannelIdentityClient({
    accountServiceUrl: 'http://account.internal/',
    internalToken: TOKEN,
    fetchImpl,
    warn: (message, detail) => warnings.push({ message, detail }),
    ...extra,
  });
  return { port, warnings };
}

describe('claiming a channel', () => {
  it('posts the owner to the claim route with the internal token, and answers the profile', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: profileJson(CHANNEL) }));
    const { port } = client(fetchImpl);

    const profile = await port.claim(CHANNEL, ALICE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `http://account.internal/internal/channels/${CHANNEL}/claim`,
      method: 'POST',
      body: { ownerAccountId: ALICE },
    });
    expect(calls[0]?.headers['X-Videofy-Internal-Token']).toBe(TOKEN);
    expect(profile).toMatchObject({ channelId: CHANNEL, handle: 'alice-live', category: 'faith' });
  });

  it('caches the claimed profile so the next read is free', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: profileJson(CHANNEL) }));
    const { port } = client(fetchImpl);

    await port.claim(CHANNEL, ALICE);
    const read = await port.profiles([CHANNEL]);

    expect(calls).toHaveLength(1);
    expect(read.get(CHANNEL)?.displayName).toBe('Alice Live');
  });
});

describe('reading profiles', () => {
  it('asks for every uncached id in one request and caches absence too', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { profiles: { a: profileJson('a') } },
    }));
    const { port } = client(fetchImpl);

    const first = await port.profiles(['a', 'b']);
    const second = await port.profiles(['a', 'b']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://account.internal/internal/channels/profiles?ids=a%2Cb');
    expect([...first.keys()]).toEqual(['a']);
    expect([...second.keys()]).toEqual(['a']);
  });

  it('asks again once the cache has aged past its TTL', async () => {
    let clock = 1_000;
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { profiles: { a: profileJson('a') } },
    }));
    const { port } = client(fetchImpl, { now: () => clock, ttlMs: 60_000 });

    await port.profiles(['a']);
    clock += 59_000;
    await port.profiles(['a']);
    expect(calls).toHaveLength(1);
    clock += 2_000;
    await port.profiles(['a']);
    expect(calls).toHaveLength(2);
  });

  it('shares one request between concurrent readers of the same id', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { profiles: { a: profileJson('a') } },
    }));
    const { port } = client(fetchImpl);

    const [x, y] = await Promise.all([port.profiles(['a']), port.profiles(['a'])]);

    expect(calls).toHaveLength(1);
    expect(x.get('a')?.handle).toBe('alice-live');
    expect(y.get('a')?.handle).toBe('alice-live');
  });

  /*
   * FAILURE KEEPS THE IN-MEMORY VALUES. The answer is "nothing known", the
   * warning names no channel, no account and no credential, and reads pause
   * briefly so a down account service is not asked on every broadcast.
   */
  it('answers nothing on a refused request, warns without ids, and pauses further reads', async () => {
    let clock = 1_000;
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 503 }));
    const { port, warnings } = client(fetchImpl, { now: () => clock });

    const read = await port.profiles([CHANNEL]);
    expect(read.size).toBe(0);
    expect(warnings).toHaveLength(1);
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain(CHANNEL);
    expect(logged).not.toContain(ALICE);
    expect(logged).not.toContain(TOKEN);
    expect(warnings[0]?.detail['status']).toBe(503);

    clock += 1_000;
    await port.profiles([CHANNEL]);
    expect(calls).toHaveLength(1);

    clock += 10_000;
    await port.profiles([CHANNEL]);
    expect(calls).toHaveLength(2);
  });

  it('gives up on a request that does not answer within the timeout', async () => {
    const { fetchImpl } = fakeFetch(() => 'hang');
    const { port, warnings } = client(fetchImpl, { timeoutMs: 20 });

    const startedAt = Date.now();
    const profile = await port.claim(CHANNEL, ALICE);

    expect(profile).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(warnings[0]?.detail['reason']).toBe('AbortError');
    expect(JSON.stringify(warnings)).not.toContain(CHANNEL);
  });
});

describe('mirroring visibility', () => {
  it('puts the visibility and caches the profile the account answers with', async () => {
    const { calls, fetchImpl } = fakeFetch((call) =>
      call.method === 'PUT'
        ? { status: 200, body: profileJson(CHANNEL, { visibility: 'locked', updatedAt: 9 }) }
        : { status: 200, body: { profiles: {} } },
    );
    const { port } = client(fetchImpl);

    const answered = await port.setVisibility(CHANNEL, 'locked');
    const read = await port.profiles([CHANNEL]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `http://account.internal/internal/channels/${CHANNEL}/visibility`,
      method: 'PUT',
      body: { visibility: 'locked' },
    });
    expect(answered?.visibility).toBe('locked');
    expect(read.get(CHANNEL)?.updatedAt).toBe(9);
  });

  it('forgets a cached profile when the mirror fails, so the next read asks again', async () => {
    let putFails = false;
    const { calls, fetchImpl } = fakeFetch((call) =>
      call.method === 'PUT' && putFails
        ? { status: 500 }
        : { status: 200, body: call.method === 'GET' ? { profiles: { [CHANNEL]: profileJson(CHANNEL) } } : profileJson(CHANNEL) },
    );
    const { port } = client(fetchImpl);

    await port.claim(CHANNEL, ALICE);
    putFails = true;
    expect(await port.setVisibility(CHANNEL, 'private')).toBeNull();
    await port.profiles([CHANNEL]);

    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'GET']);
  });
});

describe('invalidation', () => {
  it('makes the next read ask the account again', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: { profiles: { [CHANNEL]: profileJson(CHANNEL) } },
    }));
    const { port } = client(fetchImpl);

    await port.profiles([CHANNEL]);
    port.invalidate(CHANNEL);
    await port.profiles([CHANNEL]);

    expect(calls).toHaveLength(2);
  });
});

describe('parsing a profile', () => {
  it('requires the fields the registry acts on', () => {
    expect(parseChannelProfile(profileJson(CHANNEL, { handle: '' }))).toBeNull();
    expect(parseChannelProfile(profileJson(CHANNEL, { displayName: '   ' }))).toBeNull();
    expect(parseChannelProfile(profileJson(CHANNEL, { visibility: 'hidden' }))).toBeNull();
    expect(parseChannelProfile(profileJson(CHANNEL, { ownerAccountId: undefined }))).toBeNull();
    expect(parseChannelProfile('nonsense')).toBeNull();
  });

  it('treats a category off the controlled list as none, and an empty avatar as none', () => {
    const parsed = parseChannelProfile(
      profileJson(CHANNEL, { category: 'gossip', avatarUrl: '', bannerUrl: undefined }),
    );
    expect(parsed?.category).toBeNull();
    expect(parsed?.avatarUrl).toBeNull();
    expect(parsed?.bannerUrl).toBeNull();
  });

  it('reads the older millisecond spelling of the timestamps too', () => {
    const parsed = parseChannelProfile(
      profileJson(CHANNEL, { createdAt: undefined, updatedAt: undefined, createdAtMs: 5, updatedAtMs: 6 }),
    );
    expect(parsed?.createdAt).toBe(5);
    expect(parsed?.updatedAt).toBe(6);
  });

  it('bounds the display name the way the registry does', () => {
    const parsed = parseChannelProfile(profileJson(CHANNEL, { displayName: `  ${'x'.repeat(100)}  ` }));
    expect(parsed?.displayName).toHaveLength(80);
  });
});

describe('no identity source', () => {
  it('answers nothing and never throws', async () => {
    expect(await NULL_CHANNEL_IDENTITY.claim(CHANNEL, ALICE)).toBeNull();
    expect((await NULL_CHANNEL_IDENTITY.profiles([CHANNEL])).size).toBe(0);
    expect(await NULL_CHANNEL_IDENTITY.setVisibility(CHANNEL, 'locked')).toBeNull();
    expect(() => NULL_CHANNEL_IDENTITY.invalidate(CHANNEL)).not.toThrow();
  });
});
