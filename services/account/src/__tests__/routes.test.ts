/** @author masterzee001 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';

interface Harness {
  url: string;
  store: AccountStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, { store, secret: SECRET });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function send(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('signing up', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => h.close());

  it('creates the account and signs the person in, in one step', async () => {
    const result = await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });

    expect(result.status).toBe(201);
    expect(String(result.json['accountId']).startsWith('acct_')).toBe(true);
    const verified = verifySessionToken({
      secret: SECRET,
      token: String(result.json['token']),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect(verified.ok).toBe(true);
  });

  it('never returns the password or its hash', async () => {
    const result = await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });

    expect(JSON.stringify(result.json)).not.toContain(PASSWORD);
    expect(JSON.stringify(result.json)).not.toContain('scrypt');
  });

  it('refuses a duplicate address distinctly, because uniqueness cannot be hidden', async () => {
    await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });

    const again = await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });

    expect(again.status).toBe(409);
  });

  it('refuses a missing or non-string field rather than coercing it', async () => {
    for (const body of [{}, { email: EMAIL }, { email: 1, password: PASSWORD }, null]) {
      expect((await send(h, 'POST', '/accounts', body)).status).toBe(400);
    }
  });
});

describe('signing in', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });
  });
  afterEach(async () => h.close());

  it('issues a token for the right password', async () => {
    const result = await send(h, 'POST', '/sessions', { email: EMAIL, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(typeof result.json['token']).toBe('string');
  });

  it('answers identically for a wrong password and an unknown address', async () => {
    // The endpoint an attacker would enumerate with. It must not become a way
    // to discover who has an account.
    const wrong = await send(h, 'POST', '/sessions', { email: EMAIL, password: 'nope nope nope' });
    const unknown = await send(h, 'POST', '/sessions', {
      email: 'nobody@example.com',
      password: 'nope nope nope',
    });

    expect(wrong.status).toBe(unknown.status);
    expect(wrong.json).toEqual(unknown.json);
    expect(wrong.status).toBe(401);
  });
});

describe('the current session', async () => {
  let h: Harness;
  let token: string;
  beforeEach(async () => {
    h = await harness();
    const created = await send(h, 'POST', '/accounts', { email: EMAIL, password: PASSWORD });
    token = String(created.json['token']);
  });
  afterEach(async () => h.close());

  it('reports the account behind a valid token', async () => {
    const result = await send(h, 'GET', '/sessions/current', undefined, token);

    expect(result.status).toBe(200);
    expect(result.json['email']).toBe(EMAIL);
  });

  it('refuses a missing, malformed or foreign token', async () => {
    expect((await send(h, 'GET', '/sessions/current')).status).toBe(401);
    expect((await send(h, 'GET', '/sessions/current', undefined, 'nonsense')).status).toBe(401);
    const foreign = requireSessionSecret('q'.repeat(48), 'TEST');
    const { issueSessionToken } = await import('@videofy-live/account-tokens');
    const forged = issueSessionToken({
      secret: foreign,
      accountId: 'acct_0123456789abcdef',
      version: 1,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect((await send(h, 'GET', '/sessions/current', undefined, forged)).status).toBe(401);
  });

  it('stops accepting a token after signing out everywhere', async () => {
    // The only revocation a stateless token has, and the reason the account
    // service checks the token generation while other services do not.
    expect((await send(h, 'GET', '/sessions/current', undefined, token)).status).toBe(200);

    const signedOut = await send(h, 'DELETE', '/sessions', undefined, token);

    expect(signedOut.status).toBe(204);
    expect((await send(h, 'GET', '/sessions/current', undefined, token)).status).toBe(401);
  });

  it('signs out quietly when the token was already unusable', async () => {
    // Idempotent: a client holding a token this service will not accept has
    // already got what it asked for, and failing loudly helps nobody.
    expect((await send(h, 'DELETE', '/sessions', undefined, 'nonsense')).status).toBe(204);
    expect((await send(h, 'DELETE', '/sessions')).status).toBe(204);
  });
});
