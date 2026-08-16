import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SESSION_STORAGE_KEY,
  clearAccountSession,
  createAccountClient,
  readAccountSession,
  writeAccountSession,
  type SessionStorageLike,
} from './accountSession';

const ACCOUNT = 'acct_0123456789abcdef';

function storage(seed: Record<string, string> = {}): SessionStorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('the stored session', () => {
  it('round-trips an account and its token', () => {
    const store = storage();
    writeAccountSession(store, { accountId: ACCOUNT, token: 'abc.def' });

    expect(readAccountSession(store)).toEqual({ accountId: ACCOUNT, token: 'abc.def' });
  });

  it('refuses a stored value that did not come from here', () => {
    // Including the retired browser identity: a devid_ must not become an
    // account by sitting in storage under a new key.
    for (const raw of [
      'not json',
      '{}',
      JSON.stringify({ accountId: ACCOUNT }),
      JSON.stringify({ token: 'abc' }),
      JSON.stringify({ accountId: 'devid_aaaaaaaaaaaa', token: 'abc' }),
      JSON.stringify({ accountId: 'participant_1', token: 'abc' }),
      JSON.stringify({ accountId: ACCOUNT, token: '' }),
    ]) {
      expect(readAccountSession(storage({ [ACCOUNT_SESSION_STORAGE_KEY]: raw }))).toBeNull();
    }
  });

  it('never invents a session', () => {
    // The old module minted an identity on demand. This one cannot: an account
    // exists because somebody signed in, or it does not exist.
    const store = storage();

    expect(readAccountSession(store)).toBeNull();
    expect(readAccountSession(null)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('forgets on request', () => {
    const store = storage();
    writeAccountSession(store, { accountId: ACCOUNT, token: 'abc.def' });

    clearAccountSession(store);

    expect(readAccountSession(store)).toBeNull();
  });
});

describe('the account client', () => {
  it('signs in and returns the session', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ accountId: ACCOUNT, token: 'abc.def' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAccountClient('http://acct').signIn({
      email: 'zoe@example.com',
      password: 'correct horse battery staple',
    });

    expect(result).toEqual({ ok: true, session: { accountId: ACCOUNT, token: 'abc.def' } });
    vi.unstubAllGlobals();
  });

  it('passes the server’s wording through unchanged', async () => {
    // The server deliberately says the same thing for a wrong password and an
    // unknown address. Rewording here could reintroduce the difference.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'That email address and password do not match.' }), {
          status: 401,
        }),
      ),
    );

    const result = await createAccountClient('http://acct').signIn({
      email: 'zoe@example.com',
      password: 'nope',
    });

    expect(result).toEqual({
      ok: false,
      message: 'That email address and password do not match.',
    });
    vi.unstubAllGlobals();
  });

  it('refuses a success that does not carry a real account id', async () => {
    // A 200 with a malformed body must not produce a session that then fails
    // mysteriously on the next request.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accountId: 'nope', token: 'x' }), { status: 200 })),
    );

    expect(
      (await createAccountClient('http://acct').signIn({ email: 'a@b.com', password: 'x' })).ok,
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it('reports an unreachable service instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const result = await createAccountClient('http://acct').signIn({
      email: 'a@b.com',
      password: 'x',
    });

    expect(result.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
