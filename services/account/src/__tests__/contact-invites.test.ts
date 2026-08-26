/**
 * Private contact invite links, over HTTP.
 *
 * THE ONLY ROUTE TO A PRIVATE ACCOUNT, which is what every account is by
 * default. Somebody who has not opted into being findable cannot be requested by
 * username at all, so a link they issue is how they choose to be reachable.
 *
 * Single use is the whole design: a link that works twice works a hundred times
 * once it is forwarded, and then it is a standing invitation rather than an
 * invitation. Most of these tests are about that, and about the fact that every
 * refusal reads the same.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { AccountStore } from '../account-store.js';
import { ContactStore } from '../contact-store.js';
import { registerAccountRoutes } from '../routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const PASSWORD = 'correct horse battery staple';

interface Harness {
  url: string;
  contacts: ContactStore;
  close: () => Promise<void>;
}

let app: Harness;

beforeEach(async () => {
  const store = new AccountStore();
  const contacts = new ContactStore();
  const server = express();
  server.use(express.json());
  registerAccountRoutes(server, { store, contacts, secret: SECRET });
  const listening = server.listen(0);
  await new Promise<void>((r) => listening.once('listening', r));
  const { port } = listening.address() as AddressInfo;
  app = {
    url: `http://127.0.0.1:${port}`,
    contacts,
    close: () => new Promise<void>((r) => listening.close(() => r())),
  };
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

async function person(handle: string): Promise<{ token: string; accountId: string }> {
  const response = await call('POST', '/accounts', {
    email: `${handle}@example.com`,
    password: PASSWORD,
    username: handle,
  });
  return (await response.json()) as { token: string; accountId: string };
}

async function mintInvite(token: string): Promise<{ inviteId: string; inviteToken: string }> {
  const response = await call('POST', '/contacts/invites', {}, token);
  const body = (await response.json()) as { inviteId: string; token: string };
  return { inviteId: body.inviteId, inviteToken: body.token };
}

describe('minting a link', () => {
  it('returns a link the issuer can hand out', async () => {
    const zoe = await person('zoe');
    const response = await call('POST', '/contacts/invites', {}, zoe.token);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { inviteId: string; token: string };
    expect(body.inviteId).toMatch(/^inv_/);
    expect(body.token.length).toBeGreaterThan(16);
  });

  /*
   * SHOWN ONCE. The token is not stored in plaintext, so it cannot be re-read
   * later even by its issuer -- a link recoverable from storage would be a
   * standing key to somebody's contact list.
   */
  it('never returns the token again', async () => {
    const zoe = await person('zoe');
    const minted = await mintInvite(zoe.token);

    const listed = await (await call('GET', '/contacts/invites', undefined, zoe.token)).text();
    expect(listed).toContain(minted.inviteId);
    expect(listed).not.toContain(minted.inviteToken);
  });

  it('requires signing in', async () => {
    expect((await call('POST', '/contacts/invites', {})).status).toBe(401);
  });
});

describe('redeeming a link', () => {
  it('makes the two of them contacts directly, with no request to approve', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);

    const response = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    expect(response.status).toBe(200);
    expect(app.contacts.mayReach(zoe.accountId, ami.accountId)).toBe(true);
  });

  it('tells the redeemer who they just connected to', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);

    const body = (await (
      await call(
        'POST',
        '/contacts/invites/redeem',
        { inviteId: minted.inviteId, token: minted.inviteToken },
        ami.token,
      )
    ).json()) as { contact: { username: string } };

    expect(body.contact.username).toBe('c7zoe');
  });

  /*
   * SINGLE USE IS THE WHOLE DESIGN. A link that works twice works a hundred
   * times once it has been forwarded, and is then a standing invitation to
   * anybody who ever saw it.
   */
  it('cannot be used a second time, by anybody', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const carol = await person('carol');
    const minted = await mintInvite(zoe.token);

    await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );
    const second = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      carol.token,
    );

    expect(second.status).toBe(400);
    expect(app.contacts.mayReach(zoe.accountId, carol.accountId)).toBe(false);
  });

  /*
   * EVERY REFUSAL READS THE SAME. Telling them apart tells somebody holding a
   * guessed link which part they got right -- and "already used" in particular
   * would confirm that a real link existed.
   */
  it('answers a wrong token, an unknown id and a spent link identically', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const carol = await person('carol');
    const minted = await mintInvite(zoe.token);
    await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    const spent = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      carol.token,
    );
    const wrongToken = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: 'not-the-token' },
      carol.token,
    );
    const unknownId = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: 'inv_does-not-exist', token: minted.inviteToken },
      carol.token,
    );

    // Each body is read ONCE: a Response body is a stream, and reading it twice
    // throws rather than returning the same value again.
    const spentBody = await spent.json();
    const wrongBody = await wrongToken.json();
    const unknownBody = await unknownId.json();

    expect(spent.status).toBe(wrongToken.status);
    expect(unknownId.status).toBe(wrongToken.status);
    expect(spentBody).toEqual(wrongBody);
    expect(unknownBody).toEqual(wrongBody);
  });

  /* Opening your own link is a mistake, not an attack, and must not spend it. */
  it('does not let the issuer spend their own link on themselves', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);

    const own = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      zoe.token,
    );
    expect(own.status).toBe(400);

    // Still usable by the person it was meant for.
    const real = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );
    expect(real.status).toBe(200);
  });

  /*
   * A BLOCK SURVIVES AN INVITE. Somebody who blocked a person and later hands
   * out a general-purpose link has not thereby unblocked them, and a link that
   * quietly overrides a block is a way around one.
   */
  it('does not let a blocked person in through a link', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    await call('POST', '/contacts/block', { accountId: ami.accountId }, zoe.token);
    const minted = await mintInvite(zoe.token);

    const response = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    expect(response.status).toBe(400);
    expect(app.contacts.mayReach(zoe.accountId, ami.accountId)).toBe(false);
  });

  it('requires signing in to redeem', async () => {
    const zoe = await person('zoe');
    const minted = await mintInvite(zoe.token);
    const response = await call('POST', '/contacts/invites/redeem', {
      inviteId: minted.inviteId,
      token: minted.inviteToken,
    });
    expect(response.status).toBe(401);
  });
});

describe('withdrawing a link', () => {
  it('stops it being redeemed', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);

    await call('POST', '/contacts/invites/revoke', { inviteId: minted.inviteId }, zoe.token);
    const response = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    expect(response.status).toBe(400);
    expect(app.contacts.mayReach(zoe.accountId, ami.accountId)).toBe(false);
  });

  /* Otherwise this endpoint reports which invite ids exist. */
  it('answers somebody elses link exactly like one that does not exist', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);

    const notYours = await call(
      'POST',
      '/contacts/invites/revoke',
      { inviteId: minted.inviteId },
      ami.token,
    );
    const invented = await call(
      'POST',
      '/contacts/invites/revoke',
      { inviteId: 'inv_nope' },
      ami.token,
    );

    expect(notYours.status).toBe(invented.status);
    expect(await notYours.json()).toEqual(await invented.json());
  });

  it('leaves contacts already made through it alone', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');
    const minted = await mintInvite(zoe.token);
    await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    await call('POST', '/contacts/invites/revoke', { inviteId: minted.inviteId }, zoe.token);
    expect(app.contacts.mayReach(zoe.accountId, ami.accountId)).toBe(true);
  });
});

describe('what the link is for', () => {
  /*
   * The point of the whole mechanism: a private account cannot be requested by
   * username, and this is the way in.
   */
  it('reaches a private account that a username request cannot', async () => {
    const zoe = await person('zoe');
    const ami = await person('ami');

    const bySearch = await call('POST', '/contacts/request', { username: 'c7zoe' }, ami.token);
    expect(bySearch.status).toBe(404);

    const minted = await mintInvite(zoe.token);
    const byLink = await call(
      'POST',
      '/contacts/invites/redeem',
      { inviteId: minted.inviteId, token: minted.inviteToken },
      ami.token,
    );

    expect(byLink.status).toBe(200);
    expect(app.contacts.mayReach(zoe.accountId, ami.accountId)).toBe(true);
  });
});
