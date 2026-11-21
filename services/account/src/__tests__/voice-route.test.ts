/**
 * The translated-voice preference over HTTP.
 *
 * The account has carried `voiceGender` since registration and returned it on
 * sign-in and `GET /sessions/current`; the store could change it; NO ROUTE
 * CALLED THE SETTER, so the choice was frozen at registration for every
 * account (found 27 Sep 2026). This is the route, and the proof that what it
 * writes is what the session then reports.
 *
 * It is a voice preference. Nothing here, and nothing in the route, calls it
 * the person's gender.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
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

let app: Harness;
beforeEach(async () => {
  app = await harness();
});
afterEach(async () => {
  await app.close();
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  return fetch(`${app.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registered(email: string, voiceGender?: 'male' | 'female'): Promise<{ token: string; accountId: string; voiceGender?: string }> {
  const seed = email.split('@')[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase() ?? 'user';
  const response = await call('POST', '/accounts', {
    email,
    password: PASSWORD,
    username: `start${seed}`,
    ...(voiceGender === undefined ? {} : { voiceGender }),
  });
  return (await response.json()) as { token: string; accountId: string; voiceGender?: string };
}

async function sessionVoice(token: string): Promise<unknown> {
  const body = (await (await call('GET', '/sessions/current', undefined, token)).json()) as { voiceGender?: unknown };
  return body.voiceGender;
}

describe('POST /accounts/voice', () => {
  it('changes the voice, reports what is now held, and the session then says the same', async () => {
    const account = await registered('zoe@example.com', 'female');
    expect(account.voiceGender).toBe('female');

    const response = await call('POST', '/accounts/voice', { voiceGender: 'male' }, account.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voiceGender: 'male' });
    expect(await sessionVoice(account.token)).toBe('male');
    expect(app.store.get(account.accountId)?.voiceGender).toBe('male');
  });

  it('sets a voice on an account that registered without one', async () => {
    const account = await registered('new@example.com');
    expect(await sessionVoice(account.token)).toBeUndefined();

    const response = await call('POST', '/accounts/voice', { voiceGender: 'female' }, account.token);

    expect(response.status).toBe(200);
    expect(await sessionVoice(account.token)).toBe('female');
  });

  it('changes it back', async () => {
    const account = await registered('zoe@example.com', 'male');
    await call('POST', '/accounts/voice', { voiceGender: 'female' }, account.token);
    expect(await sessionVoice(account.token)).toBe('female');
    await call('POST', '/accounts/voice', { voiceGender: 'male' }, account.token);
    expect(await sessionVoice(account.token)).toBe('male');
  });

  it('refuses anything but the two voices, and leaves the stored one alone', async () => {
    const account = await registered('zoe@example.com', 'female');
    // (A bare `null` body never reaches the route: express.json refuses it first.)
    for (const body of [{ voiceGender: 'robot' }, { voiceGender: 'MALE' }, { voiceGender: '' }, { voiceGender: 1 }, { voiceGender: null }, {}]) {
      const response = await call('POST', '/accounts/voice', body, account.token);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Choose the male or the female voice.' });
    }
    expect(await sessionVoice(account.token)).toBe('female');
  });

  it('is signed-in only: the voice belongs to the token, never to a body', async () => {
    const target = await registered('target@example.com', 'female');
    expect((await call('POST', '/accounts/voice', { voiceGender: 'male' })).status).toBe(401);
    expect((await call('POST', '/accounts/voice', { voiceGender: 'male' }, 'nonsense')).status).toBe(401);
    // Naming a real account in the body, with no token, changes nobody.
    expect((await call('POST', '/accounts/voice', { voiceGender: 'male', accountId: target.accountId })).status).toBe(401);
    expect(await sessionVoice(target.token)).toBe('female');
  });

  it('changes only the caller’s own voice', async () => {
    const zoe = await registered('zoe@example.com', 'female');
    const other = await registered('other@example.com', 'female');
    await call('POST', '/accounts/voice', { voiceGender: 'male', accountId: other.accountId }, zoe.token);
    expect(await sessionVoice(zoe.token)).toBe('male');
    expect(await sessionVoice(other.token)).toBe('female');
  });
});
