/**
 * MFA enrolment and step-up, over HTTP.
 *
 * The TOTP algorithm is tested in account-trust and the encryption in
 * secret-box. What is tested here is the boundary between them that mfa.ts has
 * claimed since it was written and never had: that the secret is SEALED before
 * it is stored, that it is readable exactly once, and that a step-up actually
 * gates the operation that declares it.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { STEP_UP_FRESHNESS_MS, totpCodeAt } from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';
import { MfaService, readMfaKeyring } from '../mfa-service.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';
const KEYRING_CONFIG = `k1:${'a'.repeat(64)}:current`;
const PEPPER = 'a-recovery-pepper-of-sufficient-length-here';

interface Harness {
  url: string;
  store: AccountStore;
  clock: { now: number };
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const clock = { now: 1_700_000_000_000 };
  /*
   * ONE clock for the store and the routes.
   *
   * The step-up grant is written with the STORE's clock and its freshness is
   * judged with the ROUTES' clock. In production both are Date.now() so they
   * agree; given two different clocks they do not, and the symptom is a grant
   * that never expires -- which is exactly what this fixture produced before
   * the clock was shared.
   */
  const store = new AccountStore(undefined, () => clock.now);
  const keyring = readMfaKeyring(KEYRING_CONFIG);
  if (!keyring) throw new Error('keyring did not parse');

  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, {
    store,
    secret: SECRET,
    nowMs: () => clock.now,
    mfa: new MfaService({ store, keyring, recoveryPepper: PEPPER, nowMs: () => clock.now }),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    clock,
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

async function registered(): Promise<{ token: string; accountId: string }> {
  const response = await call('POST', '/accounts', { email: EMAIL, password: PASSWORD });
  return (await response.json()) as { token: string; accountId: string };
}

/** The secret out of the otpauth URI, as an authenticator app would read it. */
function secretFrom(uri: string): string {
  return new URL(uri.replace('otpauth://', 'https://')).searchParams.get('secret') ?? '';
}

describe('the keyring', () => {
  it('parses a configured keyring', () => {
    const keyring = readMfaKeyring(KEYRING_CONFIG);
    expect(keyring?.currentKeyId).toBe('k1');
  });

  it('is absent rather than empty when unconfigured', () => {
    expect(readMfaKeyring(undefined)).toBeNull();
    expect(readMfaKeyring('   ')).toBeNull();
  });

  /*
   * A malformed entry must not silently produce a SMALLER keyring: a record
   * sealed under the missing key would stop opening, and the symptom is
   * somebody locked out of their own second factor.
   */
  it('refuses a malformed entry rather than dropping it', () => {
    expect(() => readMfaKeyring('justakey')).toThrow(/keyId:key/);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => readMfaKeyring('k1:tooshort:current')).toThrow();
  });
});

describe('enrolment', () => {
  it('returns an otpauth URI and recovery codes, once', async () => {
    const { token } = await registered();
    const response = await call('POST', '/accounts/mfa', {}, token);
    expect(response.status).toBe(201);

    const body = (await response.json()) as { otpauthUri: string; recoveryCodes: string[] };
    expect(body.otpauthUri).toContain('otpauth://totp/');
    expect(body.recoveryCodes.length).toBeGreaterThan(0);
  });

  /*
   * THE PROPERTY THIS WHOLE FILE EXISTS FOR. A TOTP secret is a bearer
   * credential: anybody holding it mints valid codes forever, so the stored
   * form must be useless to whoever steals the database.
   */
  it('never stores the secret in a readable form', async () => {
    const { token, accountId } = await registered();
    const response = await call('POST', '/accounts/mfa', {}, token);
    const { otpauthUri } = (await response.json()) as { otpauthUri: string };
    const secret = secretFrom(otpauthUri);
    expect(secret.length).toBeGreaterThan(10);

    const stored = app.store.get(accountId)?.mfa;
    expect(stored).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(secret);
    // And what IS stored is an envelope, not a secret.
    const envelope = JSON.parse(stored!.secret) as { keyId: string; ciphertext: string };
    expect(envelope.keyId).toBe('k1');
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
  });

  it('stores only hashes of the recovery codes', async () => {
    const { token, accountId } = await registered();
    const response = await call('POST', '/accounts/mfa', {}, token);
    const { recoveryCodes } = (await response.json()) as { recoveryCodes: string[] };

    const stored = JSON.stringify(app.store.get(accountId)?.mfa);
    for (const code of recoveryCodes) expect(stored).not.toContain(code);
  });

  /*
   * Enrolling does not arm the factor. Somebody who starts and abandons
   * enrolment has not locked themselves into a factor they never scanned.
   */
  it('is not active until a live code confirms it', async () => {
    const { token, accountId } = await registered();
    await call('POST', '/accounts/mfa', {}, token);
    expect(app.store.get(accountId)?.mfa?.state).toBe('enrolling');
  });

  it('activates on a correct code', async () => {
    const { token, accountId } = await registered();
    const started = await call('POST', '/accounts/mfa', {}, token);
    const { otpauthUri } = (await started.json()) as { otpauthUri: string };
    const code = totpCodeAt(secretFrom(otpauthUri), app.clock.now);

    const confirmed = await call('POST', '/accounts/mfa/confirm', { code }, token);
    expect(confirmed.status).toBe(200);
    expect(app.store.get(accountId)?.mfa?.state).toBe('active');
  });

  it('refuses a wrong code', async () => {
    const { token } = await registered();
    await call('POST', '/accounts/mfa', {}, token);
    const confirmed = await call('POST', '/accounts/mfa/confirm', { code: '000000' }, token);
    expect(confirmed.status).toBe(400);
  });

  /* Re-enrolling would silently invalidate the factor they are still using. */
  it('refuses to re-enrol over an active factor', async () => {
    const { token } = await registered();
    const started = await call('POST', '/accounts/mfa', {}, token);
    const { otpauthUri } = (await started.json()) as { otpauthUri: string };
    await call('POST', '/accounts/mfa/confirm', { code: totpCodeAt(secretFrom(otpauthUri), app.clock.now) }, token);

    const again = await call('POST', '/accounts/mfa', {}, token);
    expect(again.status).toBe(409);
  });

  it('requires a session', async () => {
    expect((await call('POST', '/accounts/mfa', {})).status).toBe(401);
  });
});

describe('step-up', () => {
  async function enrolled(): Promise<{ token: string; secret: string; codes: string[] }> {
    const { token } = await registered();
    const started = await call('POST', '/accounts/mfa', {}, token);
    const body = (await started.json()) as { otpauthUri: string; recoveryCodes: string[] };
    const secret = secretFrom(body.otpauthUri);
    await call('POST', '/accounts/mfa/confirm', { code: totpCodeAt(secret, app.clock.now) }, token);
    return { token, secret, codes: body.recoveryCodes };
  }

  it('is satisfied by a live code', async () => {
    const { token, secret } = await enrolled();
    const response = await call(
      'POST',
      '/accounts/step-up',
      { code: totpCodeAt(secret, app.clock.now) },
      token,
    );
    expect(response.status).toBe(200);
  });

  /*
   * A lost phone must not be a permanently unusable account -- the support
   * process that grows in its place is a far weaker second factor.
   */
  it('is satisfied by a recovery code', async () => {
    const { token, codes } = await enrolled();
    const response = await call('POST', '/accounts/step-up', { recoveryCode: codes[0] }, token);
    expect(response.status).toBe(200);
  });

  it('spends a recovery code, so it cannot be used twice', async () => {
    const { token, codes } = await enrolled();
    await call('POST', '/accounts/step-up', { recoveryCode: codes[0] }, token);
    const replay = await call('POST', '/accounts/step-up', { recoveryCode: codes[0] }, token);
    expect(replay.status).toBe(400);
  });

  /* No bearer value comes back: the grant is server-side so it can be revoked. */
  it('does not hand back a token', async () => {
    const { token, secret } = await enrolled();
    const response = await call(
      'POST',
      '/accounts/step-up',
      { code: totpCodeAt(secret, app.clock.now) },
      token,
    );
    expect(await response.text()).not.toContain('"token"');
  });
});

describe('an operation that requires step-up', () => {
  async function enrolled(): Promise<{ token: string; secret: string }> {
    const { token } = await registered();
    const started = await call('POST', '/accounts/mfa', {}, token);
    const { otpauthUri } = (await started.json()) as { otpauthUri: string };
    const secret = secretFrom(otpauthUri);
    await call('POST', '/accounts/mfa/confirm', { code: totpCodeAt(secret, app.clock.now) }, token);
    return { token, secret };
  }

  it('is refused without a fresh step-up', async () => {
    const { token } = await enrolled();
    const response = await call('DELETE', '/accounts/mfa', undefined, token);

    // 403, not 401: they are authenticated. A 401 would send them to sign in,
    // which fixes nothing.
    expect(response.status).toBe(403);
  });

  it('is allowed immediately after one', async () => {
    const { token, secret } = await enrolled();
    await call('POST', '/accounts/step-up', { code: totpCodeAt(secret, app.clock.now) }, token);

    const response = await call('DELETE', '/accounts/mfa', undefined, token);
    expect(response.status).toBe(200);
  });

  /*
   * A session can be weeks old and belong to an unattended laptop. A step-up
   * from an hour ago is not evidence that the person is still there.
   */
  it('is refused again once the step-up has gone stale', async () => {
    const { token, secret } = await enrolled();
    await call('POST', '/accounts/step-up', { code: totpCodeAt(secret, app.clock.now) }, token);

    app.clock.now += STEP_UP_FRESHNESS_MS + 1000;

    const response = await call('DELETE', '/accounts/mfa', undefined, token);
    expect(response.status).toBe(403);
  });

  /*
   * Otherwise somebody who stepped up and then removed MFA would keep a live
   * step-up for its full window with no second factor behind it.
   */
  it('clears the step-up grant when the factor is disabled', async () => {
    const { token, secret } = await enrolled();
    const me = (await (await call('GET', '/me', undefined, token)).json()) as { accountId: string };
    await call('POST', '/accounts/step-up', { code: totpCodeAt(secret, app.clock.now) }, token);
    await call('DELETE', '/accounts/mfa', undefined, token);

    expect(app.store.get(me.accountId)?.stepUpAtMs ?? null).toBeNull();
  });

  /* An account with no factor cannot step up, so it cannot reach the operation. */
  it('is refused for an account with no second factor', async () => {
    const { token } = await registered();
    const response = await call('DELETE', '/accounts/mfa', undefined, token);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('mfa-required');
  });
});
