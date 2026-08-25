/**
 * Per-request correlation, and the widened caller.
 *
 * Two properties are load-bearing and easy to lose in a refactor: that an
 * UNAUTHENTICATED request still gets an id — those are the requests an incident
 * is reconstructed from — and that a client cannot choose the id, because an
 * attacker who can would be able to poison the trace an investigation depends
 * on.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { AccountStore } from '../account-store.js';
import { createCallerResolver, registerAccountRoutes } from '../routes.js';
import { CORRELATION_HEADER, correlationIdOf, correlationMiddleware } from '../request-context.js';

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
  app.use(correlationMiddleware());
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

async function register(): Promise<string> {
  const response = await fetch(`${app.url}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

describe('correlation ids', () => {
  /*
   * The requests worth correlating are mostly the ones with no caller: a
   * failed sign-in, a reset for an address that may not exist, a signup flood.
   */
  it('are issued on an unauthenticated request', async () => {
    const response = await fetch(`${app.url}/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get(CORRELATION_HEADER)).toMatch(/[0-9a-f-]{36}/);
  });

  it('are issued on an authenticated request', async () => {
    const token = await register();
    const response = await fetch(`${app.url}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(CORRELATION_HEADER)).toMatch(/[0-9a-f-]{36}/);
  });

  it('differ between requests, so one trace is one request', async () => {
    const first = await fetch(`${app.url}/me`);
    const second = await fetch(`${app.url}/me`);
    expect(first.headers.get(CORRELATION_HEADER)).not.toBe(
      second.headers.get(CORRELATION_HEADER),
    );
  });

  /*
   * The important refusal. A caller who could choose the id could stamp their
   * requests with somebody else's, or flood one value until a search for it is
   * useless.
   */
  it('ignore a client-supplied id', async () => {
    const forged = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const response = await fetch(`${app.url}/me`, {
      headers: { [CORRELATION_HEADER]: forged },
    });
    expect(response.headers.get(CORRELATION_HEADER)).not.toBe(forged);
  });

  /*
   * An event recorded with '' joins every other unattributed event into one
   * meaningless group, which hides a bug rather than merely failing to help.
   */
  it('fall back to a fresh id rather than an empty string', () => {
    expect(correlationIdOf({ locals: {} } as unknown as express.Response)).toMatch(/[0-9a-f-]{36}/);
    expect(correlationIdOf({ locals: { correlationId: '' } } as unknown as express.Response)).toMatch(
      /[0-9a-f-]{36}/,
    );
  });
});

describe('the resolved caller', () => {
  function resolverFor(store: AccountStore) {
    return createCallerResolver({ store, secret: SECRET, nowSeconds: () => Math.floor(Date.now() / 1000) });
  }

  function requestWith(token: string | null): express.Request {
    return {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' && token !== null ? `Bearer ${token}` : undefined,
    } as unknown as express.Request;
  }

  it('carries the record and normalised trust, not merely an id', async () => {
    const token = await register();
    const caller = resolverFor(app.store)(requestWith(token));

    expect(caller).not.toBeNull();
    expect(caller?.record.email).toBe(EMAIL);
    expect(caller?.accountId).toBe(caller?.record.accountId);
    // Normalised: a fresh account has components, never a bare boolean.
    expect(caller?.trust.email).toBe('unverified');
  });

  it('refuses a request with no token', () => {
    expect(resolverFor(app.store)(requestWith(null))).toBeNull();
  });

  it('refuses a garbage token', async () => {
    expect(resolverFor(app.store)(requestWith('not-a-token'))).toBeNull();
  });

  /*
   * What makes sign-out-everywhere and password reset actually end sessions,
   * rather than issue a new token alongside the ones an attacker holds.
   */
  it('refuses a token issued before the version was bumped', async () => {
    const token = await register();
    const caller = resolverFor(app.store)(requestWith(token));
    expect(caller).not.toBeNull();

    await app.store.signOutEverywhere(caller!.accountId);
    expect(resolverFor(app.store)(requestWith(token))).toBeNull();
  });
});
