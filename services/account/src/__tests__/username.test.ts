/**
 * The C7 username over HTTP, and who can find you by it.
 *
 * Zoe's ruling: "c7 username is different from profile name that would appear
 * in calls or else our fraud check in protecting people adding id will be
 * flawed." The shape rules are tested in account-trust; what is tested here is
 * the part that needs storage and a request -- uniqueness under contention,
 * never-reuse, and the fact that a private account cannot be found at all.
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

async function registered(email: string): Promise<{ token: string; accountId: string }> {
  // Registration claims a handle now, so each account here starts with a
  // distinct one that the tests below then change.
  const seed = email.split('@')[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase() ?? 'user';
  const response = await call('POST', '/accounts', {
    email,
    password: PASSWORD,
    username: `start${seed}`,
  });
  return (await response.json()) as { token: string; accountId: string };
}

describe('claiming a username', () => {
  it('claims one and reports it back', async () => {
    const account = await registered('zoe@example.com');
    const response = await call('POST', '/accounts/username', { username: 'zoemeak' }, account.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: 'c7zoemeak' });
  });

  it('refuses a second account the same handle', async () => {
    const first = await registered('zoe@example.com');
    const second = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, first.token);

    const response = await call('POST', '/accounts/username', { username: 'zoemeak' }, second.token);
    expect(response.status).toBe(409);
  });

  /*
   * THE ANTI-IMPERSONATION PROPERTY, over the wire. If a lookalike could be
   * claimed, adding somebody by id would be exactly as unreliable as adding
   * them by the name shown in a call.
   */
  it('refuses a lookalike of a taken handle', async () => {
    const first = await registered('zoe@example.com');
    const second = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, first.token);

    for (const lookalike of ['z0emeak', 'zoe.meak', 'z0e.me4k', 'ZOEMEAK']) {
      const response = await call('POST', '/accounts/username', { username: lookalike }, second.token);
      expect(response.status).toBe(409);
    }
  });

  it('lets the holder re-spell their own handle', async () => {
    const account = await registered('zoe@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, account.token);

    // Same claim, different spelling: idempotent, not a conflict with itself.
    const response = await call('POST', '/accounts/username', { username: 'zoe.meak' }, account.token);
    expect(response.status).toBe(200);
  });

  it('refuses one that claims to be C7', async () => {
    const account = await registered('zoe@example.com');
    const response = await call('POST', '/accounts/username', { username: 'supp0rt' }, account.token);
    expect(response.status).toBe(400);
  });

  it('requires signing in', async () => {
    expect((await call('POST', '/accounts/username', { username: 'zoemeak' })).status).toBe(401);
  });
});

describe('releasing a username', () => {
  /*
   * NEVER REUSED. A freed handle is a ready-made impersonation of whoever held
   * it -- somebody who watched a known person change theirs could otherwise
   * pick it up and inherit every future add-by-id aimed at them.
   */
  it('does not let anybody else take a handle that was given up', async () => {
    const first = await registered('zoe@example.com');
    const second = await registered('other@example.com');

    await call('POST', '/accounts/username', { username: 'zoemeak' }, first.token);
    await call('POST', '/accounts/username', { username: 'zoe.live' }, first.token);

    const response = await call('POST', '/accounts/username', { username: 'zoemeak' }, second.token);
    expect(response.status).toBe(409);
  });

  it('does not let a lookalike of a released handle be taken either', async () => {
    const first = await registered('zoe@example.com');
    const second = await registered('other@example.com');

    await call('POST', '/accounts/username', { username: 'zoemeak' }, first.token);
    await call('POST', '/accounts/username', { username: 'zoe.live' }, first.token);

    const response = await call('POST', '/accounts/username', { username: 'z0emeak' }, second.token);
    expect(response.status).toBe(409);
  });

  /*
   * The one exception, and it carries no impersonation risk: the original
   * holder taking their own name back. Refusing would punish the only person
   * the rule is not aimed at.
   */
  it('lets the original holder take their own handle back', async () => {
    const account = await registered('zoe@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, account.token);
    await call('POST', '/accounts/username', { username: 'zoe.live' }, account.token);

    const response = await call('POST', '/accounts/username', { username: 'zoemeak' }, account.token);
    expect(response.status).toBe(200);
  });
});

describe('the display name', () => {
  it('accepts a real name and reports it back', async () => {
    const account = await registered('zoe@example.com');
    const response = await call('POST', '/accounts/display-name', { displayName: 'Zoe Meak' }, account.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ displayName: 'Zoe Meak' });
  });

  /*
   * THE SPLIT, ASSERTED. A display name may copy anybody's username, because it
   * proves nothing and nobody is ever added by it. Refusing it would imply the
   * opposite -- that a display name carries identity -- which is the belief the
   * whole design exists to remove.
   */
  it('allows a display name that copies somebody elses username', async () => {
    const first = await registered('zoe@example.com');
    const second = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, first.token);

    const response = await call('POST', '/accounts/display-name', { displayName: 'zoemeak' }, second.token);
    expect(response.status).toBe(200);
  });

  it('refuses a name carrying a counterfeit verified badge', async () => {
    const account = await registered('zoe@example.com');
    const response = await call(
      'POST',
      '/accounts/display-name',
      { displayName: `Zoe Meak ${String.fromCodePoint(0x2705)}` },
      account.token,
    );
    expect(response.status).toBe(400);
  });
});

describe('finding somebody by username', () => {
  /*
   * PRIVATE BY DEFAULT. An account that has not opted in is not findable, and
   * the answer is identical to a handle nobody holds -- anything else makes
   * this a way to ask whether a given person has a C7 account.
   */
  it('does not find a private account, even by its exact handle', async () => {
    const holder = await registered('zoe@example.com');
    const seeker = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, holder.token);

    const response = await call('GET', '/accounts/lookup?username=zoemeak', undefined, seeker.token);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ found: false });
  });

  it('answers a nonexistent handle identically', async () => {
    const seeker = await registered('other@example.com');
    const response = await call('GET', '/accounts/lookup?username=nobodyhere', undefined, seeker.token);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ found: false });
  });

  it('finds an account that opted into being discoverable', async () => {
    const holder = await registered('zoe@example.com');
    const seeker = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, holder.token);
    await app.store.setDiscoveryMode(holder.accountId, 'discoverable');

    const response = await call('GET', '/accounts/lookup?username=zoemeak', undefined, seeker.token);
    expect(response.status).toBe(200);
    expect((await response.json()) as { username: string }).toMatchObject({ username: 'c7zoemeak' });
  });

  /*
   * Echoed in ITS spelling, not the caller's: somebody who typed a lookalike
   * should see the real handle and be able to tell they found the person they
   * meant rather than a near-match.
   */
  it('answers a lookalike with the real spelling', async () => {
    const holder = await registered('zoe@example.com');
    const seeker = await registered('other@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, holder.token);
    await app.store.setDiscoveryMode(holder.accountId, 'discoverable');

    const response = await call('GET', '/accounts/lookup?username=z0emeak', undefined, seeker.token);
    expect((await response.json()) as { username: string }).toMatchObject({ username: 'c7zoemeak' });
  });

  it('requires signing in to resolve a handle to a person', async () => {
    expect((await call('GET', '/accounts/lookup?username=zoemeak')).status).toBe(401);
  });
});

describe('what the shell is told about you', () => {
  /*
   * The two fields arrive apart, and stay apart. Collapsing them into one
   * object with one label is the first step back toward treating a display
   * name as an identity, which is the belief the split exists to remove.
   */
  it('reports the handle and the display name separately', async () => {
    const account = await registered('zoe@example.com');
    await call('POST', '/accounts/username', { username: 'zoemeak' }, account.token);
    await call('POST', '/accounts/display-name', { displayName: 'Zoe Meak' }, account.token);

    const me = (await (await call('GET', '/me', undefined, account.token)).json()) as {
      profile: { username: string; displayName: string; discoverable: boolean };
    };

    expect(me.profile.username).toBe('c7zoemeak');
    expect(me.profile.displayName).toBe('Zoe Meak');
  });

  /* Private by default: nobody has to opt out of being findable. */
  it('reports a new account as not discoverable', async () => {
    const account = await registered('zoe@example.com');
    const me = (await (await call('GET', '/me', undefined, account.token)).json()) as {
      profile: { discoverable: boolean };
    };

    expect(me.profile.discoverable).toBe(false);
  });

  it('reports the resolved answer, not the stored string', async () => {
    const account = await registered('zoe@example.com');
    // Anything that is not exactly 'discoverable' must resolve to private --
    // including a value a future version might write that this one does not
    // understand.
    await app.store.setDiscoveryMode(account.accountId, 'contacts-only');

    const me = (await (await call('GET', '/me', undefined, account.token)).json()) as {
      profile: { discoverable: boolean };
    };
    expect(me.profile.discoverable).toBe(false);
  });

  it('turns discovery on and off through its own endpoint', async () => {
    const account = await registered('zoe@example.com');

    const on = await call('POST', '/accounts/discovery', { discoverable: true }, account.token);
    expect(await on.json()).toEqual({ discoverable: true });

    const off = await call('POST', '/accounts/discovery', { discoverable: false }, account.token);
    expect(await off.json()).toEqual({ discoverable: false });
  });

  it('refuses anything that is not a plain yes or no', async () => {
    const account = await registered('zoe@example.com');
    const response = await call(
      'POST',
      '/accounts/discovery',
      { discoverable: 'yes' },
      account.token,
    );
    expect(response.status).toBe(400);
  });
});
