/**
 * Adding a contact, over HTTP.
 *
 * The rules are tested in account-trust and the locking in contact-store. What
 * is tested here is what a CALLER can learn -- which is the part the anti-fraud
 * design actually rests on. Most of these assert that two different situations
 * produce the same answer.
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
  store: AccountStore;
  contacts: ContactStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const contacts = new ContactStore();
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, { store, contacts, secret: SECRET });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    contacts,
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

/** An account with a handle. `discoverable` opts it into being findable. */
async function person(
  handle: string,
  options: { discoverable?: boolean } = {},
): Promise<{ token: string; accountId: string }> {
  const response = await call('POST', '/accounts', {
    email: `${handle}@example.com`,
    password: PASSWORD,
    username: handle,
  });
  const account = (await response.json()) as { token: string; accountId: string };
  await call('POST', '/accounts/display-name', { displayName: handle.toUpperCase() }, account.token);
  if (options.discoverable) {
    await call('POST', '/accounts/discovery', { discoverable: true }, account.token);
  }
  return account;
}

describe('asking somebody to be a contact', () => {
  it('sends a request to a discoverable person', async () => {
    const alice = await person('alice');
    await person('bob', { discoverable: true });

    const response = await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    expect(response.status).toBe(202);
  });

  /*
   * PRIVATE IS UNREACHABLE, and answers exactly as a username nobody holds. A
   * different answer for "exists but private" would make a private account
   * findable by trying, which is the whole thing private mode withholds.
   */
  it('answers a private person exactly like a nonexistent one', async () => {
    const alice = await person('alice');
    await person('bob');

    const priv = await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    const missing = await call('POST', '/contacts/request', { username: 'c7nobody' }, alice.token);

    expect(priv.status).toBe(missing.status);
    expect(await priv.json()).toEqual(await missing.json());
  });

  it('requires signing in', async () => {
    expect((await call('POST', '/contacts/request', { username: 'c7bob' })).status).toBe(401);
  });
});

describe('what a request shows the recipient', () => {
  it('appears for the recipient and not as answerable for the sender', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);

    const bobList = (await (await call('GET', '/contacts', undefined, bob.token)).json()) as {
      requests: { username: string }[];
    };
    const aliceList = (await (await call('GET', '/contacts', undefined, alice.token)).json()) as {
      requests: unknown[];
      sent: { username: string }[];
    };

    expect(bobList.requests.map((r) => r.username)).toEqual(['c7alice']);
    expect(aliceList.requests).toEqual([]);
    expect(aliceList.sent.map((r) => r.username)).toEqual(['c7bob']);
  });

  /*
   * NOT MUTUAL CONTACTS. COMMUNICATION_ARCHITECTURE.md section 2.2 lists them,
   * section 2.5 forbids any path by which being in somebody's contacts exposes
   * you to anybody in theirs -- and a mutual count is such a path. It also lets
   * somebody inside one person's contacts map the graph by sending requests and
   * reading counts. Implemented the narrow way pending a ruling.
   */
  it('carries no mutual-contact information', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);

    const raw = await (await call('GET', '/contacts', undefined, bob.token)).text();
    expect(raw.toLowerCase()).not.toContain('mutual');
  });

  /* Not one word of free text: the type has nowhere to put it. */
  it('carries no message from the sender', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call(
      'POST',
      '/contacts/request',
      { username: 'c7bob', message: 'hello please add me' },
      alice.token,
    );

    const raw = await (await call('GET', '/contacts', undefined, bob.token)).text();
    expect(raw).not.toContain('hello please add me');
  });
});

describe('accepting', () => {
  it('makes them contacts for both sides', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    await call('POST', '/contacts/accept', { accountId: alice.accountId }, bob.token);

    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(true);
  });

  /* The requester accepting their own request would be one-sided consent. */
  it('refuses the sender accepting their own request', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);

    const response = await call('POST', '/contacts/accept', { accountId: bob.accountId }, alice.token);
    expect(response.status).toBe(400);
    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(false);
  });

  /*
   * One answer for every refusal. Distinguishing "no such request" from "not
   * yours to accept" tells a caller which account ids have pending requests,
   * which is the graph read by guessing.
   */
  it('answers an invented account id the same way as a real refusal', async () => {
    const alice = await person('alice');
    const invented = await call(
      'POST',
      '/contacts/accept',
      { accountId: 'acct_00000000deadbeef' },
      alice.token,
    );
    expect(invented.status).toBe(400);
  });
});

describe('blocking', () => {
  it('stops a blocked person reaching you', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    await call('POST', '/contacts/accept', { accountId: alice.accountId }, bob.token);

    await call('POST', '/contacts/block', { accountId: alice.accountId }, bob.token);
    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(false);
  });

  /*
   * THE ANSWER A BLOCKED SENDER GETS IS SUCCESS. If they were told, blocking
   * becomes detectable -- somebody would learn exactly who shut them out and
   * could act on it elsewhere. A detectable block is a signal, not a protection.
   */
  it('tells a blocked sender nothing, answering exactly as it would on success', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    const carol = await person('carol');
    await call('POST', '/contacts/block', { accountId: alice.accountId }, bob.token);

    const blocked = await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    const ordinary = await call('POST', '/contacts/request', { username: 'c7bob' }, carol.token);

    expect(blocked.status).toBe(ordinary.status);
    expect(await blocked.json()).toEqual(await ordinary.json());
    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(false);
  });

  it('can block somebody who never sent anything', async () => {
    const alice = await person('alice');
    const bob = await person('bob');

    const response = await call('POST', '/contacts/block', { accountId: alice.accountId }, bob.token);
    expect(response.status).toBe(200);
  });
});

describe('removing', () => {
  it('removes a contact for both sides', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    await call('POST', '/contacts/accept', { accountId: alice.accountId }, bob.token);

    await call('POST', '/contacts/remove', { accountId: bob.accountId }, alice.token);
    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(false);
  });

  /* Otherwise the control is decorative. */
  it('refuses the blocked party lifting their own block', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/block', { accountId: alice.accountId }, bob.token);

    const response = await call('POST', '/contacts/remove', { accountId: bob.accountId }, alice.token);
    expect(response.status).toBe(400);
  });

  /*
   * Lifting returns to strangers, not to the contact they used to be. Somebody
   * who blocked a contact and later relents has not agreed to resume.
   */
  it('lets the blocker lift it, without restoring the contact', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('POST', '/contacts/request', { username: 'c7bob' }, alice.token);
    await call('POST', '/contacts/accept', { accountId: alice.accountId }, bob.token);
    await call('POST', '/contacts/block', { accountId: alice.accountId }, bob.token);

    const response = await call('POST', '/contacts/remove', { accountId: alice.accountId }, bob.token);
    expect(response.status).toBe(200);
    expect(app.contacts.mayReach(alice.accountId, bob.accountId)).toBe(false);
  });
});
