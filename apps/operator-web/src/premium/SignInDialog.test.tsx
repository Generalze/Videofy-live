/** @author masterzee001 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BARE_SESSION_KEY, SHARED_SESSION_KEY, SIGN_IN_MISMATCH, SIGN_IN_UNREACHABLE, readSession, signIn, signOut, writeSession } from './operatorSession';
import { SignInDialog } from './SignInDialog';

const SECRET = 'tok_secret_value_9a1';

function respond(status: number, body: unknown): typeof fetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
}

const stored = new Map<string, string>();
const logged: unknown[][] = [];

beforeEach(() => {
  stored.clear();
  logged.length = 0;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.restoreAllMocks();
});

describe('signIn', () => {
  it('POSTs a browser-class session request and returns the session', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await signIn({
      accountUrl: 'https://c7.test/auth/',
      email: 'zoe@example.test',
      password: 'pw',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return respond(200, { accountId: 'acct_z', token: SECRET, voiceGender: 'female' })(url, init);
      },
    });
    expect(calls[0]?.url).toBe('https://c7.test/auth/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: 'zoe@example.test', password: 'pw' });
    expect(result).toEqual({ ok: true, session: { accountId: 'acct_z', token: SECRET, voiceGender: 'female' } });
  });

  it('maps 401, 429 (the server sentence), other failures and the network by status', async () => {
    const deps = { accountUrl: 'https://c7.test/auth', email: 'e', password: 'p' };
    expect(await signIn({ ...deps, fetchImpl: respond(401, { error: 'anything' }) })).toEqual({ ok: false, message: SIGN_IN_MISMATCH });
    expect(await signIn({ ...deps, fetchImpl: respond(429, { error: 'Too many attempts. Try again in a few minutes.' }) })).toEqual({
      ok: false,
      message: 'Too many attempts. Try again in a few minutes.',
    });
    expect(await signIn({ ...deps, fetchImpl: respond(503, {}) })).toEqual({ ok: false, message: 'C7 answered 503.' });
    expect(await signIn({ ...deps, fetchImpl: respond(200, { token: SECRET }) })).toEqual({ ok: false, message: 'C7 answered with a session this console could not read.' });
    expect(
      await signIn({
        ...deps,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toEqual({ ok: false, message: SIGN_IN_UNREACHABLE });
  });

  it('never puts the token in a message, a thrown error or a log', async () => {
    const outcomes: unknown[] = [];
    const attempts: (typeof fetch)[] = [
      respond(200, { accountId: 'a', token: SECRET }),
      respond(401, { error: SECRET }),
      respond(500, { error: `broken ${SECRET}` }),
      async () => {
        throw new Error(`network ${SECRET}`);
      },
    ];
    for (const fetchImpl of attempts) {
      try {
        const result = await signIn({ accountUrl: 'https://c7.test/auth', email: 'e', password: 'p', fetchImpl });
        outcomes.push(result.ok ? 'ok' : result.message);
      } catch (error) {
        outcomes.push(error instanceof Error ? error.message : String(error));
      }
    }
    // The 500 repeats the server's sentence; it is the only place a message is not this console's own.
    expect(outcomes[0]).toBe('ok');
    expect(outcomes[1]).toBe(SIGN_IN_MISMATCH);
    expect(outcomes[3]).toBe(SIGN_IN_UNREACHABLE);
    // token-logging: allowed (asserting the secret is absent from every log line)
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});

describe('signOut', () => {
  it('DELETEs the session with the bearer and clears both keys, even when the service is down', async () => {
    writeSession({ accountId: 'acct_z', token: SECRET });
    let seenAuth: unknown = null;
    await signOut({
      accountUrl: 'https://c7.test/auth',
      token: SECRET,
      fetchImpl: async (_url, init) => {
        seenAuth = (init?.headers as Record<string, string>)['authorization'];
        return { ok: true, status: 204, json: async () => null } as Response;
      },
    });
    expect(seenAuth).toBe(`Bearer ${SECRET}`);
    expect(stored.has(SHARED_SESSION_KEY)).toBe(false);
    expect(stored.has(BARE_SESSION_KEY)).toBe(false);

    writeSession({ accountId: 'acct_z', token: SECRET });
    await signOut({
      accountUrl: 'https://c7.test/auth',
      token: SECRET,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(readSession()).toBeNull();
  });
});

describe('SignInDialog', () => {
  const noop = (): void => undefined;

  it('is a labelled modal with email and password, and says why it opened', () => {
    const signedOut = renderToStaticMarkup(<SignInDialog accountUrl="https://c7.test/auth" reason="signed-out" onClose={noop} />);
    expect(signedOut).toContain('role="dialog"');
    expect(signedOut).toContain('aria-modal="true"');
    expect(signedOut).toContain('Sign in to C7');
    expect(signedOut).toContain('type="email"');
    expect(signedOut).toContain('type="password"');
    expect(signedOut).not.toContain('reload');

    const expired = renderToStaticMarkup(<SignInDialog accountUrl="https://c7.test/auth" reason="expired" onClose={noop} />);
    expect(expired).toContain('Session expired');
    expect(expired).toContain('Sign in again');
  });
});
