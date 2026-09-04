/**
 * Session ownership, against the server contract that actually exists.
 *
 * Every test here is a required regression from the MOBILE-AUTH-01 directive.
 * The ones that matter most are the ones where a mistake produces no error at
 * all: a credential surviving sign-out, a partial write after a failed sign-in,
 * two taps racing to store different tokens.
 */
import { describe, expect, it, vi } from 'vitest';
import { AuthSessionManager } from '../auth/authSessionManager';
import { createSecureSessionStore, type StoredSession } from '../auth/secureSessionStore';

const TOKEN = 'session-token-value-that-must-never-leak';
const BASE = 'https://staging.example/auth';

/** An in-memory stand-in for the Keystore, with the same shape. */
function fakeStorage(initial: string | null = null) {
  let value = initial;
  const calls = { get: 0, set: 0, del: 0 };
  return {
    calls,
    get value() {
      return value;
    },
    storage: {
      async getItemAsync() {
        calls.get += 1;
        return value;
      },
      async setItemAsync(_k: string, v: string) {
        calls.set += 1;
        value = v;
      },
      async deleteItemAsync() {
        calls.del += 1;
        value = null;
      },
    },
  };
}

function storedSession(overrides: Partial<StoredSession> = {}): string {
  return JSON.stringify({
    accountId: 'acct_a',
    token: TOKEN,
    expiresInSeconds: 43_200,
    receivedAtMs: 1_000_000,
    ...overrides,
  });
}

function manager(options: {
  stored?: string | null;
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const fake = fakeStorage(options.stored ?? null);
  const store = createSecureSessionStore(fake.storage);
  const states: string[] = [];
  const auth = new AuthSessionManager({
    accountBaseUrl: BASE,
    store,
    fetchImpl: options.fetchImpl,
    now: options.now ?? (() => 1_000_000),
    onState: (s) => states.push(s.status),
  });
  return { auth, fake, states };
}

const okSession = () =>
  new Response(
    JSON.stringify({ accountId: 'acct_a', token: TOKEN, expiresInSeconds: 43_200 }),
    { status: 200 },
  );

describe('signing in', () => {
  it('stores the session and reports signed in', async () => {
    const { auth, fake } = manager({ fetchImpl: (async () => okSession()) as unknown as typeof fetch });

    expect((await auth.signIn('a@example.com', 'pw')).ok).toBe(true);
    expect(auth.current().status).toBe('signed-in');
    expect(fake.calls.set).toBe(1);
  });

  /*
   * REQUIRED REGRESSION: a failed sign-in must not persist anything. A
   * credential-shaped fragment on the device is worse than nothing -- the next
   * launch spends a round trip discovering the server will not accept it.
   */
  it('persists nothing when the credentials are wrong', async () => {
    const { auth, fake } = manager({
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });

    const result = await auth.signIn('a@example.com', 'wrong');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-credentials');
    expect(fake.calls.set).toBe(0);
    expect(fake.value).toBeNull();
  });

  it('persists nothing when a 200 carries no usable session', async () => {
    const { auth, fake } = manager({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ accountId: 'acct_a' }), { status: 200 })) as unknown as typeof fetch,
    });

    expect((await auth.signIn('a@example.com', 'pw')).ok).toBe(false);
    expect(fake.value).toBeNull();
  });

  it('separates rate limiting from bad credentials', async () => {
    const { auth } = manager({
      fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
    });
    expect((await auth.signIn('a@example.com', 'pw')).reason).toBe('rate-limited');
  });

  /*
   * REQUIRED REGRESSION: two taps must not create conflicting state. Double
   * tapping is what people do when the first tap appears to do nothing.
   */
  it('joins concurrent sign-in attempts rather than racing them', async () => {
    let calls = 0;
    const { auth, fake } = manager({
      fetchImpl: (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return okSession();
      }) as unknown as typeof fetch,
    });

    const [a, b, c] = await Promise.all([
      auth.signIn('a@example.com', 'pw'),
      auth.signIn('a@example.com', 'pw'),
      auth.signIn('a@example.com', 'pw'),
    ]);

    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(calls).toBe(1);
    expect(fake.calls.set).toBe(1);
  });
});

describe('restoring on launch', () => {
  /* REQUIRED REGRESSION: a session must survive an app restart. */
  it('rehydrates a stored session the server accepts', async () => {
    const { auth } = manager({
      stored: storedSession(),
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    const state = await auth.restore();
    expect(state.status).toBe('signed-in');
  });

  /*
   * THE ONE THAT MAKES REVOCATION REAL. Only the server checks `ver` against
   * the account, so a client trusting its own expiry would keep a revoked
   * session alive for up to twelve hours -- the exact window an account
   * recovery is trying to close.
   */
  it('asks the server even when the token has not expired locally', async () => {
    const seen: string[] = [];
    const { auth } = manager({
      stored: storedSession(),
      fetchImpl: (async (url: unknown) => {
        seen.push(String(url));
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await auth.restore();
    expect(seen[0]).toBe(`${BASE}/sessions/current`);
  });

  it('clears a session the server rejects, and says it was revoked', async () => {
    const { auth, fake } = manager({
      stored: storedSession(),
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });

    const state = await auth.restore();
    expect(state.status).toBe('signed-out');
    if (state.status === 'signed-out') expect(state.reason).toBe('revoked');
    expect(fake.value).toBeNull();
  });

  /* Expired locally is not worth a round trip, and is cleared without one. */
  it('clears an expired session without calling the server', async () => {
    let called = false;
    const { auth, fake } = manager({
      stored: storedSession({ receivedAtMs: 0 }),
      now: () => 100_000_000,
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const state = await auth.restore();
    expect(state.status).toBe('signed-out');
    expect(called).toBe(false);
    expect(fake.value).toBeNull();
  });

  /*
   * OFFLINE IS NOT SIGNED OUT. A phone in a lift must not lose its session and
   * demand a sign-in when the network returns.
   */
  it('keeps the credential when the server cannot be reached', async () => {
    const { auth, fake } = manager({
      stored: storedSession(),
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });

    const state = await auth.restore();
    expect(state.status).toBe('validating');
    expect(fake.value).not.toBeNull();
  });

  it('starts signed out when nothing is stored', async () => {
    const { auth } = manager({
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    const state = await auth.restore();
    expect(state.status).toBe('signed-out');
    if (state.status === 'signed-out') expect(state.reason).toBe('never-signed-in');
  });

  /* Half a session is not a session; guessing the rest sends an empty token. */
  it('discards a stored value that no longer matches the shape', async () => {
    const { auth } = manager({
      stored: JSON.stringify({ accountId: 'acct_a' }),
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    expect((await auth.restore()).status).toBe('signed-out');
  });

  it('survives unreadable secure storage', async () => {
    const store = createSecureSessionStore({
      async getItemAsync() {
        throw new Error('keystore invalidated');
      },
      async setItemAsync() {},
      async deleteItemAsync() {},
    });
    const auth = new AuthSessionManager({
      accountBaseUrl: BASE,
      store,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    expect((await auth.restore()).status).toBe('signed-out');
  });
});

describe('signing out', () => {
  /*
   * REQUIRED REGRESSION, and the direction that matters: local state is cleared
   * whether or not the server is told. Somebody tapping sign-out on a train
   * must end up signed out on this device.
   */
  it('clears the credential even when the network call fails', async () => {
    const { auth, fake } = manager({
      stored: storedSession(),
      fetchImpl: (async (url: unknown, init: unknown) => {
        const method = (init as RequestInit | undefined)?.method;
        if (method === 'DELETE') throw new Error('offline');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await auth.restore();
    await auth.signOut();

    expect(auth.current().status).toBe('signed-out');
    expect(fake.value).toBeNull();
  });

  it('tells the server when it can, so the session is revoked everywhere', async () => {
    const methods: (string | undefined)[] = [];
    const { auth } = manager({
      stored: storedSession(),
      fetchImpl: (async (_u: unknown, init: unknown) => {
        methods.push((init as RequestInit | undefined)?.method);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await auth.restore();
    await auth.signOut();
    expect(methods).toContain('DELETE');
  });

  it('is safe when nothing was signed in', async () => {
    const { auth } = manager({
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(auth.signOut()).resolves.toBeUndefined();
  });
});

describe('authenticated requests', () => {
  it('refuses to call a protected endpoint with no session', async () => {
    let called = false;
    const { auth } = manager({
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(await auth.authorizedFetch('/devices', { method: 'POST' })).toBeNull();
    expect(called).toBe(false);
  });

  it('attaches the session without exposing it', async () => {
    let auth7: string | null = null;
    const { auth } = manager({
      stored: storedSession(),
      fetchImpl: (async (_u: unknown, init: unknown) => {
        const headers = new Headers((init as RequestInit).headers);
        auth7 = headers.get('authorization');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await auth.restore();
    await auth.authorizedFetch('/devices', { method: 'POST' });
    expect(auth7).toBe(`Bearer ${TOKEN}`);
    // There is no accessor that hands the token to a caller.
    expect(Object.keys(auth)).not.toContain('token');
  });

  /*
   * REQUIRED REGRESSION: a 401 must never look like success, and must end the
   * session once -- centrally. Left to each caller, one of them eventually
   * retries forever against a credential the server has already rejected.
   */
  it('ends the session on a 401 rather than returning it as a result', async () => {
    const { auth, fake } = manager({
      stored: storedSession(),
      fetchImpl: (async (_u: unknown, init: unknown) => {
        const method = (init as RequestInit | undefined)?.method;
        return new Response('{}', { status: method === 'POST' ? 401 : 200 });
      }) as unknown as typeof fetch,
    });

    await auth.restore();
    const response = await auth.authorizedFetch('/devices', { method: 'POST' });

    expect(response?.status).toBe(401);
    expect(response?.ok).toBe(false);
    expect(auth.current().status).toBe('signed-out');
    expect(fake.value).toBeNull();
  });
});

describe('the credential never escapes', () => {
  /*
   * REQUIRED REGRESSION: the session value must not appear in logs. Checked by
   * capturing every console channel across a full sign-in, request and
   * sign-out, rather than by reading the source and hoping.
   */
  it('writes nothing to any console channel', async () => {
    const written: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((channel) =>
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    );

    try {
      const { auth } = manager({
        fetchImpl: (async () => okSession()) as unknown as typeof fetch,
      });
      await auth.signIn('a@example.com', 'pw');
      await auth.authorizedFetch('/devices', { method: 'POST' });
      await auth.signOut();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }

    expect(written.join('\n')).not.toContain(TOKEN);
  });

  /* What is stored is the session and nothing else -- no password, ever. */
  it('never stores the password', async () => {
    const { auth, fake } = manager({
      fetchImpl: (async () => okSession()) as unknown as typeof fetch,
    });
    await auth.signIn('a@example.com', 'correct horse battery staple');
    expect(fake.value).not.toContain('correct horse');
  });
});

describe('creating an account', () => {
  const created = () =>
    new Response(
      JSON.stringify({ accountId: 'acct_new', token: TOKEN, expiresInSeconds: 43_200 }),
      { status: 201 },
    );

  /* 201 carries a session, so a new account is signed in without a second prompt. */
  it('signs in immediately on success', async () => {
    const { auth, fake } = manager({ fetchImpl: (async () => created()) as unknown as typeof fetch });

    expect((await auth.signUp('a@example.com', 'pw', 'c7zoe')).ok).toBe(true);
    expect(auth.current().status).toBe('signed-in');
    expect(fake.calls.set).toBe(1);
  });

  it('sends the username, which the server requires', async () => {
    let body: Record<string, unknown> = {};
    const { auth } = manager({
      fetchImpl: (async (_u: unknown, init: unknown) => {
        body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return created();
      }) as unknown as typeof fetch,
    });

    await auth.signUp('a@example.com', 'pw', 'c7zoe');
    expect(body['username']).toBe('c7zoe');
  });

  /*
   * A used address and a used username are ONE answer. Separating them would
   * let anybody discover which addresses and handles are registered by trying
   * them -- the account-existence oracle sign-in refuses to be, arriving through
   * the registration door instead.
   */
  it('does not say whether it was the email or the username', async () => {
    const { auth } = manager({
      fetchImpl: (async () => new Response('{}', { status: 409 })) as unknown as typeof fetch,
    });

    const result = await auth.signUp('a@example.com', 'pw', 'c7zoe');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('taken');
  });

  it('persists nothing when creation fails', async () => {
    const { auth, fake } = manager({
      fetchImpl: (async () => new Response('{}', { status: 409 })) as unknown as typeof fetch,
    });

    await auth.signUp('a@example.com', 'pw', 'c7zoe');
    expect(fake.value).toBeNull();
    expect(auth.current().status).not.toBe('signed-in');
  });

  it('persists nothing when a 201 carries no usable session', async () => {
    const { auth, fake } = manager({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ accountId: 'acct_new' }), { status: 201 })) as unknown as typeof fetch,
    });

    expect((await auth.signUp('a@example.com', 'pw', 'c7zoe')).ok).toBe(false);
    expect(fake.value).toBeNull();
  });

  it('never stores the password', async () => {
    const { auth, fake } = manager({ fetchImpl: (async () => created()) as unknown as typeof fetch });
    await auth.signUp('a@example.com', 'correct horse battery staple', 'c7zoe');
    expect(fake.value).not.toContain('correct horse');
  });
});
