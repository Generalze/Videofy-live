/** @author masterzee001 */
/**
 * The OFF switches, as the running service behaves with them.
 *
 * C7 has to launch on the production hostname before an SMS vendor and a KYC
 * vendor exist. The 30 Aug 2026 production ruling says how: "a missing provider
 * must refuse the capability honestly or fail startup where the capability is
 * mandatory -- NEVER a silent fall back to a synthetic/mock provider in
 * production."
 *
 * So these tests hold two properties at once, and the second is the one that is
 * easy to lose:
 *
 *   1. An off channel REFUSES -- 503, in words a person can read, from an
 *      endpoint that still exists because it will work later.
 *   2. An off channel changes NOBODY'S TRUST. Not verified, not pending, not
 *      failed. Being offered no check is not the same as passing one, and it is
 *      not the same as failing one either. Trust derivation is untouched.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import {
  createIdentityProvider,
  createPhoneProvider,
  createSyntheticProvider,
} from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';
import { VerificationService } from '../verification.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const OFF_ENV = { C7_PHONE_PROVIDER: 'off', C7_IDENTITY_PROVIDER: 'off' } as const;

interface Harness {
  url: string;
  store: AccountStore;
  verification: VerificationService;
  token: string;
  accountId: string;
  close: () => Promise<void>;
}

/**
 * The service composed the way a launch-day production box composes it: a real
 * email provider stands in as synthetic here (email is never off), and both
 * other channels are explicitly switched off.
 */
async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const verification = new VerificationService({
    store,
    emailProvider: createSyntheticProvider('email'),
    phoneProvider: createPhoneProvider(OFF_ENV, 'production'),
    identityProvider: createIdentityProvider(OFF_ENV, 'production'),
    identityCallbackSecret: 'callback-secret-long-enough-for-a-test',
  });

  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, { store, secret: SECRET, verification });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const created = await fetch(`${url}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'zoe@example.com',
      password: 'a-long-enough-passphrase-42',
      username: 'uoff0000001',
    }),
  });
  const account = (await created.json()) as { token: string; accountId: string };

  return {
    url,
    store,
    verification,
    token: account.token,
    accountId: account.accountId,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function post(
  h: Harness,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${h.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('C7_PHONE_PROVIDER=off', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => h.close());

  it('answers 503 in words a person can read', async () => {
    const requested = await post(h, '/verification/phone', { phone: '+2348000000000' });
    expect(requested.status).toBe(503);
    expect(requested.json['error']).toBe('Phone verification is not available yet.');
  });

  it('answers 503 on confirm too, rather than pretending a code was sent', async () => {
    const confirmed = await post(h, '/verification/phone/confirm', { code: '000000' });
    expect(confirmed.status).toBe(503);
    expect(confirmed.json['error']).toBe('Phone verification is not available yet.');
  });

  it('still demands a session first: off is not an unauthenticated endpoint', async () => {
    const response = await fetch(`${h.url}/verification/phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+2348000000000' }),
    });
    expect(response.status).toBe(401);
  });

  it('PIN: the phone component stays UNVERIFIED -- off is never verified', async () => {
    await post(h, '/verification/phone', { phone: '+2348000000000' });
    expect(h.store.trustOf(h.accountId).phone).toBe('unverified');
  });

  it('PIN: nothing at all is written -- no challenge, no pending transition', async () => {
    const outcome = await h.verification.requestPhoneVerification(h.accountId, '+2348000000000');
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.store.get(h.accountId)?.phoneChallenge ?? null).toBeNull();
    expect(h.store.trustOf(h.accountId).phone).toBe('unverified');
  });

  it('reports the channel as disabled, not as synthetic', () => {
    expect(h.verification.deliverabilityOf('phone')).toBe('disabled');
    expect(h.verification.channelAvailable('phone')).toBe(false);
    // Email is untouched by this lane and keeps working.
    expect(h.verification.channelAvailable('email')).toBe(true);
  });
});

describe('C7_IDENTITY_PROVIDER=off', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => h.close());

  it('answers 503 in words a person can read', async () => {
    const started = await post(h, '/verification/identity');
    expect(started.status).toBe(503);
    expect(started.json['error']).toBe('Identity verification is not available yet.');
  });

  it('PIN: no session, no provider reference, no case is ever stored', async () => {
    const outcome = await h.verification.startIdentityVerification(h.accountId);
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.store.get(h.accountId)?.identityCase ?? null).toBeNull();
  });

  it('PIN: the identity component stays UNVERIFIED, and the state is derived as always', async () => {
    await post(h, '/verification/identity');
    const trust = h.store.trustOf(h.accountId);
    expect(trust.identity).toBe('unverified');
    expect(trust.restriction).toBe('none');
    // The derived state is whatever the untouched components say -- the switch
    // has no opinion about it.
    expect(h.store.trustStateOf(h.accountId)).toBe('verification_pending');
  });

  it('shuts the callback endpoint: with no case possible, no callback is honest', async () => {
    const outcome = await h.verification.handleIdentityCallback(
      JSON.stringify({
        providerReference: 'ref_1',
        status: 'verified',
        eventId: 'evt_1',
        issuedAtMs: Date.now(),
      }),
      undefined,
    );
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.store.trustOf(h.accountId).identity).toBe('unverified');
  });

  it('reports the capability as disabled, not as synthetic and not as absent', () => {
    expect(h.verification.identityDeliverability()).toBe('disabled');
    expect(h.verification.identityAvailable()).toBe(false);
  });
});
