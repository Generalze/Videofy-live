/**
 * The acceptance list the owner would otherwise have to perform by hand.
 *
 * Everything here drives REAL HTTP against the real routes. The one thing it
 * does not do over HTTP is read a verification token: the synthetic provider is
 * held directly by the test, in process, so tokens never cross the wire. A
 * "give me the token" endpoint added for convenience would be a verification
 * bypass wearing a test costume.
 *
 * Sections mirror the acceptance list: A registration, B email, C phone,
 * D synthetic KYC, E verified dashboard, F organization, G foreign tenant,
 * H sign-out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AccountStore } from '../account-store.js';
import { OrganizationStore } from '../organization-store.js';
import { createCallerResolver, registerAccountRoutes } from '../routes.js';
import { registerOrganizationRoutes } from '../organization-routes.js';
import { VerificationService } from '../verification.js';
import {
  EMAIL_POLICY,
  PHONE_POLICY,
  createSyntheticIdentityProvider,
  createSyntheticProvider,
  signCallback,
  type VerificationMessage,
} from '@videofy-live/account-trust';

const SECRET = Buffer.alloc(32, 11);
const CALLBACK_SECRET = 'acceptance-identity-callback-secret';

let server: Server;
let url = '';
let accounts: AccountStore;
let organizations: OrganizationStore;
let verification: VerificationService;
/** What the provider WOULD have delivered. Held here, never served over HTTP. */
let outbox: VerificationMessage[] = [];
let clock = 1_700_000_000_000;

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, raw };
}

async function signUp(email: string): Promise<{ accountId: string; token: string }> {
  const created = await api('POST', '/accounts', null, {
    email,
    password: 'a-long-enough-passphrase-42',
  });
  expect(created.status).toBe(201);
  return {
    accountId: String(created.body['accountId']),
    token: String(created.body['token']),
  };
}

beforeAll(async () => {
  accounts = new AccountStore();
  organizations = new OrganizationStore();
  outbox = [];

  const emailProvider = createSyntheticProvider('email', (message) => outbox.push(message));
  const phoneProvider = createSyntheticProvider('phone', (message) => outbox.push(message));
  verification = new VerificationService({
    store: accounts,
    emailProvider,
    phoneProvider,
    identityProvider: createSyntheticIdentityProvider(),
    identityCallbackSecret: CALLBACK_SECRET,
    nowMs: () => clock,
  });

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as unknown as { rawBody: string }).rawBody = buffer.toString('utf8');
      },
    }),
  );
  const nowSeconds = () => Math.floor(clock / 1000);
  registerAccountRoutes(app, {
    store: accounts,
    secret: SECRET,
    nowSeconds,
    verification,
    organizations,
  });
  registerOrganizationRoutes(app, {
    store: accounts,
    organizations,
    callerAccountId: createCallerResolver({ store: accounts, secret: SECRET, nowSeconds }),
  });

  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => server?.close());

describe('A — registration', () => {
  it('PIN: a fresh account is authenticated but NOT verified or entitled', async () => {
    const { accountId, token } = await signUp('a-fresh@example.com');

    const me = await api('GET', '/me', token);
    expect(me.status).toBe(200);
    expect(me.body['accountId']).toBe(accountId);

    const trust = me.body['trust'] as Record<string, unknown>;
    expect(trust['state']).toBe('registered');
    expect(trust['state']).not.toBe('verified');

    // No product authority whatsoever.
    const capabilities = me.body['capabilities'] as string[];
    expect(capabilities).toContain('workspace.view');
    expect(capabilities).not.toContain('session.host');
    expect(capabilities).not.toContain('organization.create');
    expect(capabilities).not.toContain('product.activate');
  });

  it('PIN: nothing in the payload claims the account is active or verified', async () => {
    const { token } = await signUp('wording@example.com');
    const me = await api('GET', '/me', token);
    const text = me.raw.toLowerCase();
    for (const claim of ['fully verified', 'products activated', '"active"']) {
      expect(text, claim).not.toContain(claim);
    }
  });

  it('PIN: signup never returns a verification token', async () => {
    const created = await api('POST', '/accounts', null, {
      email: 'no-token@example.com',
      password: 'a-long-enough-passphrase-42',
    });
    expect(Object.keys(created.body)).not.toContain('verificationToken');
    expect(outbox.every((message) => !created.raw.includes(message.token))).toBe(true);
  });
});

describe('B — email verification', () => {
  it('runs the full lifecycle and refuses every misuse', async () => {
    const { accountId, token } = await signUp('email-flow@example.com');
    const before = outbox.length;

    const requested = await api('POST', '/verification/email', token);
    expect(requested.status).toBe(202);

    // The adapter was invoked, with the right recipient.
    expect(outbox.length).toBe(before + 1);
    const message = outbox[outbox.length - 1]!;
    expect(message.channel).toBe('email');
    expect(message.target).toBe('email-flow@example.com');
    expect(message.expiresAtMs).toBeGreaterThan(clock);

    // The token is NOT in the HTTP response.
    expect(requested.raw).not.toContain(message.token);

    // Wrong token refused.
    expect((await api('POST', '/verification/email/confirm', token, { token: 'wrong' })).status).toBe(
      400,
    );

    // Resend is throttled.
    expect((await api('POST', '/verification/email', token)).status).toBe(429);

    // The right token verifies.
    const confirmed = await api('POST', '/verification/email/confirm', token, {
      token: message.token,
    });
    expect(confirmed.status).toBe(200);
    expect(accounts.trustOf(accountId).email).toBe('verified');

    // Replay refused.
    expect(
      (await api('POST', '/verification/email/confirm', token, { token: message.token })).status,
    ).toBe(400);

    // Verified email alone is not a verified account.
    expect(accounts.trustStateOf(accountId)).toBe('verification_required');
  });

  it('PIN: the attempt cap bounds guessing', async () => {
    const { token } = await signUp('email-attempts@example.com');
    await api('POST', '/verification/email', token);

    for (let attempt = 0; attempt < EMAIL_POLICY.maxAttempts + 2; attempt += 1) {
      const response = await api('POST', '/verification/email/confirm', token, {
        token: `guess-${attempt}`,
      });
      expect(response.status).toBe(400);
    }
    // Even the correct token cannot rescue an exhausted challenge.
    const real = outbox[outbox.length - 1]!;
    expect(
      (await api('POST', '/verification/email/confirm', token, { token: real.token })).status,
    ).toBe(400);
  });

  it('refuses an expired link', async () => {
    const { token } = await signUp('email-expiry@example.com');
    await api('POST', '/verification/email', token);
    const message = outbox[outbox.length - 1]!;

    clock += EMAIL_POLICY.ttlMs + 1;
    const late = await api('POST', '/verification/email/confirm', token, { token: message.token });
    expect(late.status).toBe(400);
    clock -= EMAIL_POLICY.ttlMs + 1;
  });

  it('PIN: one message for every failure reason', async () => {
    const { token } = await signUp('email-oracle@example.com');
    await api('POST', '/verification/email', token);
    const wrong = await api('POST', '/verification/email/confirm', token, { token: 'nope' });
    const malformed = await api('POST', '/verification/email/confirm', token, { token: 'x' });
    // Distinguishing expired from wrong from already-used tells somebody
    // probing links which of their guesses was closest.
    expect(wrong.body['error']).toBe(malformed.body['error']);
  });
});

describe('C — phone verification', () => {
  it('runs the full lifecycle against a normalised target', async () => {
    const { accountId, token } = await signUp('phone-flow@example.com');

    const requested = await api('POST', '/verification/phone', token, {
      phone: '+234 800 000 1111',
    });
    expect(requested.status).toBe(202);

    const message = outbox[outbox.length - 1]!;
    expect(message.channel).toBe('phone');
    // Stored and sent in E.164, not as typed.
    expect(message.target).toBe('+2348000001111');
    expect(message.token).toMatch(/^\d{6}$/);
    expect(requested.raw).not.toContain(message.token);

    expect(
      (await api('POST', '/verification/phone/confirm', token, { code: '000000' })).status,
    ).toBe(400);

    const confirmed = await api('POST', '/verification/phone/confirm', token, {
      code: message.token,
    });
    expect(confirmed.status).toBe(200);
    expect(accounts.trustOf(accountId).phone).toBe('verified');
    expect(accounts.get(accountId)?.phoneNumber).toBe('+2348000001111');

    // Replay refused.
    expect(
      (await api('POST', '/verification/phone/confirm', token, { code: message.token })).status,
    ).toBe(400);
  });

  it('refuses a number that is not international', async () => {
    const { token } = await signUp('phone-format@example.com');
    const response = await api('POST', '/verification/phone', token, { phone: '08000000000' });
    expect(response.status).toBe(400);
  });

  it('PIN: the OTP attempt cap holds', async () => {
    const { token } = await signUp('phone-attempts@example.com');
    await api('POST', '/verification/phone', token, { phone: '+2348000002222' });
    const real = outbox[outbox.length - 1]!;

    for (let attempt = 0; attempt < PHONE_POLICY.maxAttempts + 1; attempt += 1) {
      await api('POST', '/verification/phone/confirm', token, { code: '111111' });
    }
    expect(
      (await api('POST', '/verification/phone/confirm', token, { code: real.token })).status,
    ).toBe(400);
  });

  it('throttles resend', async () => {
    const { token } = await signUp('phone-throttle@example.com');
    expect((await api('POST', '/verification/phone', token, { phone: '+2348000003333' })).status).toBe(
      202,
    );
    expect((await api('POST', '/verification/phone', token, { phone: '+2348000003333' })).status).toBe(
      429,
    );
  });
});

describe('D — synthetic identity verification', () => {
  it('PIN: a browser starts a check and can never report its outcome', async () => {
    const { accountId, token } = await signUp('kyc-flow@example.com');

    const started = await api('POST', '/verification/identity', token);
    expect(started.status).toBe(200);
    expect(String(started.body['redirectUrl'])).toContain('.invalid');
    expect(accounts.trustOf(accountId).identity).toBe('pending');

    const reference = accounts.get(accountId)?.identityCase?.providerReference ?? '';

    // Unsigned callback: refused, and nothing moves.
    const unsigned = await api('POST', '/provider-callbacks/identity', null, {
      providerReference: reference,
      status: 'verified',
      eventId: 'evt_unsigned',
      issuedAtMs: clock,
    });
    expect(unsigned.status).toBe(401);
    expect(accounts.trustOf(accountId).identity).toBe('pending');

    // Signed callback: accepted.
    const payload = JSON.stringify({
      providerReference: reference,
      status: 'verified',
      eventId: 'evt_signed',
      issuedAtMs: clock,
    });
    const signedResponse = await fetch(`${url}/provider-callbacks/identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-c7-signature': signCallback(payload, CALLBACK_SECRET),
      },
      body: payload,
    });
    expect(signedResponse.status).toBe(200);
    expect(accounts.trustOf(accountId).identity).toBe('verified');

    // Replayed: harmless and idempotent.
    const replay = await fetch(`${url}/provider-callbacks/identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-c7-signature': signCallback(payload, CALLBACK_SECRET),
      },
      body: payload,
    });
    expect(replay.status).toBe(200);
    expect(accounts.trustOf(accountId).identity).toBe('verified');
  });
});

/** Take one account all the way to verified, through the real endpoints. */
async function fullyVerified(email: string, phone: string) {
  const { accountId, token } = await signUp(email);

  await api('POST', '/verification/email', token);
  await api('POST', '/verification/email/confirm', token, {
    token: outbox[outbox.length - 1]!.token,
  });

  await api('POST', '/verification/phone', token, { phone });
  await api('POST', '/verification/phone/confirm', token, {
    code: outbox[outbox.length - 1]!.token,
  });

  await api('POST', '/verification/identity', token);
  const reference = accounts.get(accountId)?.identityCase?.providerReference ?? '';
  const payload = JSON.stringify({
    providerReference: reference,
    status: 'verified',
    eventId: `evt_${accountId}`,
    issuedAtMs: clock,
  });
  await fetch(`${url}/provider-callbacks/identity`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-c7-signature': signCallback(payload, CALLBACK_SECRET),
    },
    body: payload,
  });

  return { accountId, token };
}

describe('E — verified dashboard', () => {
  it('shows a verified account with the entitlements it actually has', async () => {
    const { accountId, token } = await fullyVerified('verified@example.com', '+2348000004444');
    expect(accounts.trustStateOf(accountId)).toBe('verified');

    const me = await api('GET', '/me', token);
    const trust = me.body['trust'] as Record<string, unknown>;
    expect(trust['state']).toBe('verified');

    const capabilities = me.body['capabilities'] as string[];
    expect(capabilities).toContain('session.host');
    expect(capabilities).toContain('organization.create');

    const workspaces = me.body['workspaces'] as Record<string, unknown>[];
    const personal = workspaces[0]!;
    const entitlement = personal['entitlement'] as { capabilities: string[] };
    // A personal workspace gets calls. Conferences and programmes belong to an
    // organization plan, and recording/SIP belong to nobody yet.
    expect(entitlement.capabilities).toContain('call');
    expect(entitlement.capabilities).not.toContain('recording');
    expect(entitlement.capabilities).not.toContain('sip');
  });
});

describe('F — organization and seats', () => {
  it('creates a Corporate organization and reserves a seat on invitation', async () => {
    const { token } = await fullyVerified('org-owner@example.com', '+2348000005555');

    const created = await api('POST', '/organizations', token, {
      legalName: 'Tech Advance Concept Ltd',
      displayName: 'Tech Advance Concept',
      packageId: 'corporate',
      contractedSeats: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body['packageId']).toBe('corporate');
    // Starts UNVERIFIED: typing a name proves nothing.
    expect(created.body['state']).not.toBe('verified');

    const organizationId = String(created.body['organizationId']);
    // Staging-only KYB transition, server-side.
    organizations.setState(organizationId, 'verified');

    const overview = await api('GET', `/organizations/${organizationId}`, token);
    expect(overview.status).toBe(200);
    expect(overview.body['seats']).toMatchObject({
      contracted: 3,
      activeMembers: 1,
      allocated: 1,
      available: 2,
    });

    const invited = await api('POST', `/organizations/${organizationId}/invitations`, token, {
      email: 'staff@example.com',
      role: 'member',
    });
    expect(invited.status).toBe(201);
    // The pending invitation reserves a seat.
    expect(invited.body['seats']).toMatchObject({
      reservedByInvitations: 1,
      allocated: 2,
      available: 1,
    });
    // And the token is never returned.
    expect(Object.keys(invited.body)).not.toContain('token');
  });
});

describe('G — foreign organization', () => {
  it('PIN: an account in Org A is refused every Org B endpoint', async () => {
    const a = await fullyVerified('tenant-a@example.com', '+2348000006666');
    const b = await fullyVerified('tenant-b@example.com', '+2348000007777');

    const orgB = String(
      (
        await api('POST', '/organizations', b.token, {
          legalName: 'Org B Ltd',
          packageId: 'corporate',
          contractedSeats: 3,
        })
      ).body['organizationId'],
    );
    organizations.setState(orgB, 'verified');

    for (const [method, path, body] of [
      ['GET', `/organizations/${orgB}`, undefined],
      ['GET', `/organizations/${orgB}/people`, undefined],
      ['POST', `/organizations/${orgB}/invitations`, { email: 'x@example.com' }],
      ['DELETE', `/organizations/${orgB}/invitations/inv_x`, undefined],
      ['DELETE', `/organizations/${orgB}/members/account_x`, undefined],
      ['POST', `/organizations/${orgB}/transfer-ownership`, { toAccountId: 'account_x' }],
    ] as const) {
      const response = await api(method, path, a.token, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    // Indistinguishable from a non-existent organization.
    const imaginary = await api('GET', '/organizations/org_nonexistent', a.token);
    const real = await api('GET', `/organizations/${orgB}`, a.token);
    expect(real.status).toBe(imaginary.status);
    expect(real.raw).toBe(imaginary.raw);
  });
});

describe('H — sign out', () => {
  it('PIN: after sign-out everywhere, the session exposes nothing', async () => {
    const { token } = await fullyVerified('signout@example.com', '+2348000008888');

    // Working before.
    expect((await api('GET', '/me', token)).status).toBe(200);

    expect((await api('DELETE', '/sessions', token)).status).toBe(204);

    // The token is signed and unexpired, and must still be refused: revocation
    // works by token VERSION, not by the browser having forgotten it.
    expect((await api('GET', '/me', token)).status).toBe(401);
    expect((await api('GET', '/sessions/current', token)).status).toBe(401);
    expect((await api('GET', '/verification', token)).status).toBe(401);
    expect((await api('GET', '/organizations', token)).status).toBe(401);
    expect((await api('POST', '/verification/email', token)).status).toBe(401);
  });
});
