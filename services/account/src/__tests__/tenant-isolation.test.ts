/**
 * A1b — tenant isolation, over real HTTP.
 *
 * The store tests prove the model refuses. These prove the ROUTES refuse, which
 * is a different claim: a correct authorization function that one endpoint
 * forgot to call is the normal shape of this bug.
 *
 * Every organization endpoint is exercised by a member of a DIFFERENT
 * organization holding a real, valid session. Nothing here is malformed — the
 * id exists, the route exists, the caller is authenticated. Only membership is
 * missing, and that must be enough.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AccountStore } from '../account-store.js';
import { OrganizationStore } from '../organization-store.js';
import { createCallerResolver, registerAccountRoutes } from '../routes.js';
import { registerOrganizationRoutes } from '../organization-routes.js';
import { issueSessionToken } from '@videofy-live/account-tokens';

const SECRET = Buffer.alloc(32, 7);

interface Harness {
  url: string;
  server: Server;
  accounts: AccountStore;
  organizations: OrganizationStore;
}

let harness: Harness;
let orgA = '';
let orgB = '';
let tokenA = '';
let tokenB = '';
let tokenOutsider = '';
let accountBId = '';

async function verifiedAccount(accounts: AccountStore, email: string) {
  const created = await accounts.register({ email, password: 'a-long-enough-passphrase-42' });
  if (!created.ok) throw new Error('registration failed');
  await accounts.setTrust(created.account.accountId, {
    email: 'verified',
    phone: 'verified',
    identity: 'verified',
    risk: 'normal',
    restriction: 'none',
  });
  const token = issueSessionToken({
    secret: SECRET,
    accountId: created.account.accountId,
    version: created.account.tokenVersion,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  return { accountId: created.account.accountId, token };
}

async function request(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

beforeAll(async () => {
  const accounts = new AccountStore();
  const organizations = new OrganizationStore();
  const app = express();
  app.use(express.json());
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  registerAccountRoutes(app, { store: accounts, secret: SECRET, nowSeconds });
  registerOrganizationRoutes(app, {
    store: accounts,
    organizations,
    callerAccountId: createCallerResolver({ store: accounts, secret: SECRET, nowSeconds }),
  });

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  harness = { url: `http://127.0.0.1:${port}`, server, accounts, organizations };

  const a = await verifiedAccount(accounts, 'owner-a@example.com');
  const b = await verifiedAccount(accounts, 'owner-b@example.com');
  const outsider = await verifiedAccount(accounts, 'nobody@example.com');
  tokenA = a.token;
  tokenB = b.token;
  tokenOutsider = outsider.token;
  accountBId = b.accountId;

  const createdA = await organizations.create({
    legalName: 'Org A Ltd',
    displayName: 'Org A',
    packageId: 'corporate',
    contractedSeats: 5,
    createdByAccountId: a.accountId,
  });
  const createdB = await organizations.create({
    legalName: 'Org B Ltd',
    displayName: 'Org B',
    packageId: 'corporate',
    contractedSeats: 5,
    createdByAccountId: b.accountId,
  });
  await organizations.setState(createdA.organizationId, 'verified');
  await organizations.setState(createdB.organizationId, 'verified');
  orgA = createdA.organizationId;
  orgB = createdB.organizationId;
});

afterAll(() => {
  harness?.server.close();
});

describe('IDOR: a valid id belonging to somebody else', () => {
  const endpoints = (organizationId: string) =>
    [
      ['GET', `/organizations/${organizationId}`, undefined],
      ['GET', `/organizations/${organizationId}/people`, undefined],
      ['POST', `/organizations/${organizationId}/invitations`, { email: 'x@example.com' }],
      ['DELETE', `/organizations/${organizationId}/invitations/inv_anything`, undefined],
      ['DELETE', `/organizations/${organizationId}/members/account_anything`, undefined],
      [
        'POST',
        `/organizations/${organizationId}/transfer-ownership`,
        { toAccountId: 'account_anything' },
      ],
    ] as const;

  it("PIN: Org A's owner is refused on every one of Org B's endpoints", async () => {
    for (const [method, path, body] of endpoints(orgB)) {
      const response = await request(method, path, tokenA, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('PIN: a verified account in NO organization is refused everywhere', async () => {
    for (const [method, path, body] of endpoints(orgA)) {
      const response = await request(method, path, tokenOutsider, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('PIN: refusal is indistinguishable from non-existence', async () => {
    // Otherwise the endpoint is a membership oracle: iterate ids, and the
    // difference between 403 and 404 maps out every organization on the
    // platform and who is in them.
    const real = await request('GET', `/organizations/${orgB}`, tokenA);
    const imaginary = await request('GET', '/organizations/org_does_not_exist', tokenA);
    expect(real.status).toBe(imaginary.status);
    expect(real.body).toEqual(imaginary.body);
  });

  it('and the rightful owner still gets through', async () => {
    const response = await request('GET', `/organizations/${orgB}`, tokenB);
    expect(response.status).toBe(200);
    expect(response.body['displayName']).toBe('Org B');
    expect(response.body['role']).toBe('organization-owner');
  });
});

describe('authentication', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await request('GET', `/organizations/${orgA}`, null);
    expect(response.status).toBe(404);
  });

  it('refuses a forged token', async () => {
    const forged = issueSessionToken({
      secret: Buffer.alloc(32, 9),
      accountId: 'account_anything',
      version: 1,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const response = await request('GET', `/organizations/${orgA}`, forged);
    expect(response.status).toBe(404);
  });
});

describe('organization listing', () => {
  it('PIN: lists only organizations the server confirms membership in', async () => {
    const response = await request('GET', '/organizations', tokenA);
    expect(response.status).toBe(200);
    const listed = (response.body['organizations'] as { organizationId: string }[]) ?? [];
    expect(listed.map((entry) => entry.organizationId)).toEqual([orgA]);
  });

  it('an account in no organization gets an empty list, not an error', async () => {
    const response = await request('GET', '/organizations', tokenOutsider);
    expect(response.status).toBe(200);
    expect(response.body['organizations']).toEqual([]);
  });
});

describe('role enforcement over HTTP', () => {
  it('PIN: a Member cannot invite, and an Admin cannot transfer ownership', async () => {
    // Seat a member and an admin in Org A.
    const memberAccount = await verifiedAccount(harness.accounts, 'member-a@example.com');
    const adminAccount = await verifiedAccount(harness.accounts, 'admin-a@example.com');

    for (const [account, role, email] of [
      [memberAccount, 'member', 'member-a@example.com'],
      [adminAccount, 'organization-admin', 'admin-a@example.com'],
    ] as const) {
      const invited = await harness.organizations.invite({
        organizationId: orgA,
        email,
        role,
        invitedByAccountId: 'seed',
      });
      if (!invited.ok) throw new Error('seed invite failed');
      await harness.organizations.accept({
        organizationId: orgA,
        invitationId: invited.invitation.invitationId,
        token: invited.token,
        accountId: account.accountId,
        accountEmail: email,
      });
    }

    const memberInvite = await request(
      'POST',
      `/organizations/${orgA}/invitations`,
      memberAccount.token,
      { email: 'someone@example.com' },
    );
    expect(memberInvite.status).toBe(404);

    const adminInvite = await request(
      'POST',
      `/organizations/${orgA}/invitations`,
      adminAccount.token,
      { email: 'someone-else@example.com' },
    );
    expect(adminInvite.status).toBe(201);

    // The escalation that matters: an administrator taking ownership.
    const adminTransfer = await request(
      'POST',
      `/organizations/${orgA}/transfer-ownership`,
      adminAccount.token,
      { toAccountId: adminAccount.accountId },
    );
    expect(adminTransfer.status).toBe(404);
  });
});

describe('unverified accounts', () => {
  it('PIN: an unverified account cannot create an organization', async () => {
    const created = await harness.accounts.register({
      email: 'fresh@example.com',
      password: 'a-long-enough-passphrase-42', username: 'ua0a0e034e8' });
    if (!created.ok) throw new Error('registration failed');
    const token = issueSessionToken({
      secret: SECRET,
      accountId: created.account.accountId,
      version: created.account.tokenVersion,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const response = await request('POST', '/organizations', token, {
      legalName: 'Brand New Ltd',
      packageId: 'corporate',
      contractedSeats: 5,
    });
    // This one DOES explain itself: the person is looking at their own account,
    // and "complete verification" is the actionable answer.
    expect(response.status).toBe(403);
    expect(String(response.body['error'])).toContain('verification');
  });

  it('a verified account can', async () => {
    const response = await request('POST', '/organizations', tokenOutsider, {
      legalName: 'Outsider Holdings Ltd',
      packageId: 'corporate',
      contractedSeats: 3,
    });
    expect(response.status).toBe(201);
    // Created UNVERIFIED: typing a name is not evidence of anything.
    expect(response.body['state']).not.toBe('verified');
  });
});

describe('seat exhaustion over HTTP', async () => {
  it('refuses the invitation that would exceed the contracted seats', async () => {
    const owner = await verifiedAccount(harness.accounts, 'tiny-owner@example.com');
    const tiny = await harness.organizations.create({
      legalName: 'Tiny Ltd',
      displayName: 'Tiny',
      packageId: 'corporate',
      contractedSeats: 2,
      createdByAccountId: owner.accountId,
    });
    await harness.organizations.setState(tiny.organizationId, 'verified');

    const first = await request(
      'POST',
      `/organizations/${tiny.organizationId}/invitations`,
      owner.token,
      { email: 'one@example.com' },
    );
    expect(first.status).toBe(201);

    const second = await request(
      'POST',
      `/organizations/${tiny.organizationId}/invitations`,
      owner.token,
      { email: 'two@example.com' },
    );
    expect(second.status).toBe(409);
    expect(second.body['reason']).toBe('no-seats-available');
    // The response carries the seat picture, so the UI can say "2 of 2
    // allocated" rather than inventing its own arithmetic.
    expect(second.body['seats']).toMatchObject({ contracted: 2, available: 0 });
  });

  it('PIN: an invitation response never carries the token', async () => {
    const owner = await verifiedAccount(harness.accounts, 'token-check@example.com');
    const organization = await harness.organizations.create({
      legalName: 'Token Check Ltd',
      displayName: 'Token Check',
      packageId: 'corporate',
      contractedSeats: 5,
      createdByAccountId: owner.accountId,
    });
    await harness.organizations.setState(organization.organizationId, 'verified');

    const response = await request(
      'POST',
      `/organizations/${organization.organizationId}/invitations`,
      owner.token,
      { email: 'invitee@example.com' },
    );
    expect(response.status).toBe(201);
    // Returning it would let an administrator accept on somebody's behalf.
    expect(Object.keys(response.body)).not.toContain('token');
    expect(JSON.stringify(response.body)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});
