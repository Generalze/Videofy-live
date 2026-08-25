/**
 * Password reset and policy consent, over HTTP.
 *
 * The domain rules are tested in account-trust. What is tested here is the part
 * that had never existed: that the endpoints exist at all, that the reset
 * actually ends existing sessions, and that the unauthenticated endpoint cannot
 * be used to discover who has an account.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import type { VerificationDeliveryProvider } from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';
import { PasswordResetService } from '../password-reset.js';
import { rejectPassword } from '../password.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

const REQUIRED_POLICIES = [
  { policyType: 'terms-of-service' as const, requiredVersion: '2026-01-15' },
  { policyType: 'privacy-policy' as const, requiredVersion: '2026-01-15' },
];

interface Sent {
  target: string;
  token: string;
}

interface Harness {
  url: string;
  store: AccountStore;
  sent: Sent[];
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const sent: Sent[] = [];
  // Captures instead of delivering, so a test can follow the link a real user
  // would receive without the token ever being returned by an endpoint.
  const emailProvider: VerificationDeliveryProvider = {
    name: 'capture',
    synthetic: true,
    async send(message) {
      sent.push({ target: message.target, token: message.token });
      return { delivered: true, reference: 'test', synthetic: true };
    },
    // Password reset never warns an old address; present because the interface
    // requires it, and required there so no provider can silently lack it.
    async notify() {
      return { delivered: true, reference: 'test', synthetic: true };
    },
  };

  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, {
    store,
    secret: SECRET,
    passwordReset: new PasswordResetService({ store, emailProvider, rejectPassword }),
    requiredPolicies: REQUIRED_POLICIES,
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    sent,
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

async function post(path: string, body: unknown, token?: string) {
  return fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function register(): Promise<string> {
  const response = await post('/accounts', { email: EMAIL, password: PASSWORD });
  return ((await response.json()) as { token: string }).token;
}

describe('requesting a reset', () => {
  it('sends a link to a real account', async () => {
    await register();
    const response = await post('/accounts/password-reset', { email: EMAIL });

    expect(response.status).toBe(202);
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.target).toBe(EMAIL);
  });

  /*
   * The property this endpoint exists to protect. It is unauthenticated and an
   * attacker may ask about as many addresses as they like.
   */
  it('answers identically for an address with no account', async () => {
    await register();
    const known = await post('/accounts/password-reset', { email: EMAIL });
    const unknown = await post('/accounts/password-reset', { email: 'nobody@example.com' });

    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    // And nothing was sent for the address that does not exist.
    expect(app.sent).toHaveLength(1);
  });

  it('answers identically for a malformed address', async () => {
    const known = await post('/accounts/password-reset', { email: EMAIL });
    const malformed = await post('/accounts/password-reset', { email: 'not-an-address' });
    const missing = await post('/accounts/password-reset', {});

    expect(malformed.status).toBe(known.status);
    expect(missing.status).toBe(known.status);
    expect(await malformed.text()).toBe(await known.text());
  });

  it('never returns the token, which would make the email pointless', async () => {
    await register();
    const response = await post('/accounts/password-reset', { email: EMAIL });
    const body = await response.text();

    expect(app.sent[0]?.token).toBeTruthy();
    expect(body).not.toContain(app.sent[0]!.token);
  });

  it('is throttled without revealing that it was', async () => {
    await register();
    await post('/accounts/password-reset', { email: EMAIL });
    const second = await post('/accounts/password-reset', { email: EMAIL });

    expect(second.status).toBe(202);
    // Throttling is real -- only one message went out.
    expect(app.sent).toHaveLength(1);
  });
});

describe('completing a reset', () => {
  async function requested(): Promise<string> {
    await register();
    await post('/accounts/password-reset', { email: EMAIL });
    return app.sent[0]!.token;
  }

  it('sets the new password', async () => {
    const token = await requested();
    const response = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token,
      password: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);

    const signIn = await post('/sessions', { email: EMAIL, password: NEW_PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it('makes the old password stop working', async () => {
    const token = await requested();
    await post('/accounts/password-reset/complete', { email: EMAIL, token, password: NEW_PASSWORD });

    const old = await post('/sessions', { email: EMAIL, password: PASSWORD });
    expect(old.status).toBe(401);
  });

  /*
   * The reason a reset revokes sessions at all: somebody resetting a password
   * often believes they are compromised. Leaving the attacker's session alive
   * means they keep access and can no longer be locked out.
   */
  it('ends sessions issued before the reset', async () => {
    await register();
    await post('/accounts/password-reset', { email: EMAIL });
    const token = app.sent[0]!.token;
    const beforeReset = (await (await post('/sessions', { email: EMAIL, password: PASSWORD })).json()) as {
      token: string;
    };

    // That session works right now.
    const worksBefore = await fetch(`${app.url}/me`, {
      headers: { authorization: `Bearer ${beforeReset.token}` },
    });
    expect(worksBefore.status).toBe(200);

    await post('/accounts/password-reset/complete', { email: EMAIL, token, password: NEW_PASSWORD });

    const worksAfter = await fetch(`${app.url}/me`, {
      headers: { authorization: `Bearer ${beforeReset.token}` },
    });
    expect(worksAfter.status).toBe(401);
  });

  it('does not hand back a session, which would complete a takeover', async () => {
    const token = await requested();
    const response = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token,
      password: NEW_PASSWORD,
    });
    expect(await response.text()).not.toContain('"token"');
  });

  it('refuses the same link twice', async () => {
    const token = await requested();
    await post('/accounts/password-reset/complete', { email: EMAIL, token, password: NEW_PASSWORD });
    const replay = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token,
      password: 'yet another passphrase here',
    });
    expect(replay.status).toBe(400);
  });

  it('refuses a wrong token', async () => {
    await requested();
    const response = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token: 'not-the-token',
      password: NEW_PASSWORD,
    });
    expect(response.status).toBe(400);
  });

  /*
   * Expired, wrong, already-used and unknown-account must be indistinguishable,
   * or somebody probing links learns which guess was closest.
   */
  it('gives one message for every kind of failure', async () => {
    await requested();
    const wrongToken = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token: 'wrong',
      password: NEW_PASSWORD,
    });
    const unknownAccount = await post('/accounts/password-reset/complete', {
      email: 'nobody@example.com',
      token: 'wrong',
      password: NEW_PASSWORD,
    });

    expect(await wrongToken.text()).toBe(await unknownAccount.text());
  });

  it('still applies the registration password policy', async () => {
    const token = await requested();
    const response = await post('/accounts/password-reset/complete', {
      email: EMAIL,
      token,
      password: 'short',
    });
    expect(response.status).toBe(400);
  });
});

describe('policy consent', () => {
  it('reports what is outstanding for a new account', async () => {
    const token = await register();
    const me = (await (
      await fetch(`${app.url}/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { outstandingConsents: { policyType: string }[] };

    expect(me.outstandingConsents.map((entry) => entry.policyType)).toEqual([
      'terms-of-service',
      'privacy-policy',
    ]);
  });

  it('records an acceptance and removes it from outstanding', async () => {
    const token = await register();
    const response = await post(
      '/accounts/consents',
      { policyType: 'terms-of-service', policyVersion: '2026-01-15' },
      token,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { outstanding: { policyType: string }[] };
    expect(body.outstanding.map((entry) => entry.policyType)).toEqual(['privacy-policy']);
  });

  /*
   * Without this the endpoint accepts any string as a version, and an account
   * holds evidence of consenting to a document that was never published.
   */
  it('refuses a version that is not currently in force', async () => {
    const token = await register();
    const response = await post(
      '/accounts/consents',
      { policyType: 'terms-of-service', policyVersion: '1999-01-01' },
      token,
    );
    expect(response.status).toBe(400);
  });

  it('refuses an unknown policy type', async () => {
    const token = await register();
    const response = await post(
      '/accounts/consents',
      { policyType: 'made-up-policy', policyVersion: '2026-01-15' },
      token,
    );
    expect(response.status).toBe(400);
  });

  it('requires a session, because consent is personal', async () => {
    const response = await post('/accounts/consents', {
      policyType: 'terms-of-service',
      policyVersion: '2026-01-15',
    });
    expect(response.status).toBe(401);
  });

  it('survives being accepted twice without duplicating', async () => {
    const token = await register();
    await post(
      '/accounts/consents',
      { policyType: 'terms-of-service', policyVersion: '2026-01-15' },
      token,
    );
    await post(
      '/accounts/consents',
      { policyType: 'terms-of-service', policyVersion: '2026-01-15' },
      token,
    );

    const me = (await (
      await fetch(`${app.url}/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { accountId: string };
    expect(app.store.consentsOf(me.accountId)).toHaveLength(1);
  });
});
