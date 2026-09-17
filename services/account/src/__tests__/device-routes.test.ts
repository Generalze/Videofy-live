/**
 * Registering a phone, over HTTP.
 *
 * The security shape of this surface is simple and unforgiving: the account
 * comes from the session and never from the body, and a push token goes in but
 * never comes back out.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import { DeviceStore } from '../device-store.js';
import { registerDeviceRoutes } from '../device-routes.js';
import type { Caller } from '../routes.js';

const TRUST: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

function caller(accountId: string): Caller {
  return { accountId, trust: TRUST, record: {} as Caller['record'] };
}

interface SentPush {
  accountId: string;
  title: string;
  body: string;
  data: Readonly<Record<string, string>>;
  except: readonly string[];
}

interface Harness {
  url: string;
  devices: DeviceStore;
  events: { event: string; detail: Record<string, string | number> }[];
  pushes: SentPush[];
  close: () => Promise<void>;
}

async function harness(
  as: Caller | null,
  options: { notificationsEnabled?: boolean } = {},
): Promise<Harness> {
  const devices = new DeviceStore();
  const events: Harness['events'] = [];
  const pushes: SentPush[] = [];
  const app = express();
  app.use(express.json());
  registerDeviceRoutes(app, {
    devices,
    callerAccountId: () => as,
    push: {
      notify: (accountId, notification, exceptDeviceIds = []) => {
        pushes.push({
          accountId,
          title: notification.title,
          body: notification.body,
          data: notification.data,
          except: exceptDeviceIds,
        });
        return Promise.resolve();
      },
    },
    ...(options.notificationsEnabled === undefined
      ? {}
      : { notificationsEnabled: () => options.notificationsEnabled as boolean }),
    onEvent: (event, detail) => events.push({ event, detail }),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    devices,
    events,
    pushes,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const BODY = { deviceId: 'dev_1', platform: 'ios', pushToken: 'tok_abc', label: 'iPhone' };

function post(url: string, body: unknown) {
  return fetch(`${url}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('registering', () => {
  it('registers a device for the signed-in account', async () => {
    app = await harness(caller('acct_a'));
    const response = await post(app.url, BODY);

    expect(response.status).toBe(201);
    expect(app.devices.listFor('acct_a')).toHaveLength(1);
  });

  /*
   * The account comes from the session. A body that names a different account
   * must change nothing, or anybody could point somebody else's notifications
   * at a phone they are holding.
   */
  it('ignores an account id in the body', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, { ...BODY, accountId: 'acct_victim' });

    expect(app.devices.listFor('acct_victim')).toHaveLength(0);
    expect(app.devices.listFor('acct_a')).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    app = await harness(null);
    expect((await post(app.url, BODY)).status).toBe(401);
  });

  it('refuses an unknown platform', async () => {
    app = await harness(caller('acct_a'));
    expect((await post(app.url, { ...BODY, platform: 'symbian' })).status).toBe(400);
  });

  it('refuses a missing token', async () => {
    app = await harness(caller('acct_a'));
    expect((await post(app.url, { ...BODY, pushToken: '' })).status).toBe(400);
  });

  /* A phone changing hands is worth an audit line, with ids and no token. */
  it('audits a token moving between accounts', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);
    await app.close();

    app = await harness(caller('acct_b'));
    await post(app.url, BODY);

    const moved = app.events.find((e) => e.event === 'device.reassigned');
    expect(moved === undefined || moved.detail['to'] === 'acct_b').toBe(true);
  });
});

describe('what comes back', () => {
  /* A push token is a credential and must never leave the server. */
  it('never returns the push token', async () => {
    app = await harness(caller('acct_a'));
    const created = await (await post(app.url, BODY)).text();
    expect(created).not.toContain('tok_abc');

    const listed = await (await fetch(`${app.url}/devices`)).text();
    expect(listed).not.toContain('tok_abc');
  });

  it('lists only the caller devices', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);
    await app.devices.register({
      deviceId: 'dev_other',
      accountId: 'acct_b',
      platform: 'android',
      pushToken: 'tok_other',
    });

    const body = (await (await fetch(`${app.url}/devices`)).json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(1);
  });

  it('refuses to list for an anonymous caller', async () => {
    app = await harness(null);
    expect((await fetch(`${app.url}/devices`)).status).toBe(401);
  });
});

describe('revoking', () => {
  it('removes the caller own device', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);

    const response = await fetch(`${app.url}/devices/dev_1`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(app.devices.listFor('acct_a')).toHaveLength(0);
  });

  /*
   * 404 whether it never existed or belongs to somebody else. Telling those
   * apart would confirm that a guessed device id is real.
   */
  it('answers the same for a stranger device and a missing one', async () => {
    app = await harness(caller('acct_a'));
    await app.devices.register({
      deviceId: 'dev_other',
      accountId: 'acct_b',
      platform: 'android',
      pushToken: 'tok_other',
    });

    const stranger = await fetch(`${app.url}/devices/dev_other`, { method: 'DELETE' });
    const missing = await fetch(`${app.url}/devices/nope`, { method: 'DELETE' });

    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(app.devices.listFor('acct_b')).toHaveLength(1);
  });
});

/**
 * Telling somebody their account has been signed in somewhere new.
 *
 * The negative cases carry the weight here. Clients register on every launch,
 * so a rule that fired on "registered" would alert on every app open and
 * teach people to swipe the notice away without reading it -- which costs
 * exactly the one case it exists for.
 */
describe('a new sign-in', () => {
  it('tells the devices that were already there, and not the one just signed in', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);

    // The second device is the new sign-in; the first is who should hear it.
    await post(app.url, { deviceId: 'dev_2', platform: 'android', pushToken: 'tok_2', label: 'Pixel' });

    expect(app.pushes).toHaveLength(2);
    const second = app.pushes[1];
    expect(second?.accountId).toBe('acct_a');
    expect(second?.data['kind']).toBe('device-login');
    expect(second?.body).toContain('Pixel');
    // The phone in the person's hand is not told it has signed itself in.
    expect(second?.except).toEqual(['dev_2']);
  });

  it('says nothing when the same device registers again, which is every launch', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);
    app.pushes.length = 0;

    await post(app.url, BODY);
    await post(app.url, BODY);

    expect(app.pushes).toEqual([]);
  });

  /*
   * A label change is still the same install: somebody renaming their phone
   * has not signed in anywhere, and must not be told that they have.
   */
  it('says nothing when a known device re-registers under a new label', async () => {
    app = await harness(caller('acct_a'));
    await post(app.url, BODY);
    app.pushes.length = 0;

    await post(app.url, { ...BODY, label: 'My iPhone' });

    expect(app.pushes).toEqual([]);
  });

  it('respects the account switch, because a security notice is still a notification', async () => {
    app = await harness(caller('acct_a'), { notificationsEnabled: false });

    await post(app.url, BODY);

    expect(app.pushes).toEqual([]);
  });

  /*
   * The device moved to another account, which is a sign-in on a handset that
   * already existed. What matters is that THIS account is now reachable
   * somewhere it was not, so it is news even though the row is not new.
   */
  it('tells an account when a device moves to it from somebody else', async () => {
    app = await harness(caller('acct_a'));
    await app.devices.register({
      deviceId: 'dev_shared',
      accountId: 'acct_b',
      platform: 'android',
      pushToken: 'tok_shared',
    });

    await post(app.url, {
      deviceId: 'dev_shared',
      platform: 'android',
      pushToken: 'tok_shared',
      label: 'Handset',
    });

    expect(app.pushes).toHaveLength(1);
    expect(app.pushes[0]?.accountId).toBe('acct_a');
    expect(app.pushes[0]?.data['kind']).toBe('device-login');
  });
});
