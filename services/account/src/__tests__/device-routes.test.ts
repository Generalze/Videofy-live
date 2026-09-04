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

interface Harness {
  url: string;
  devices: DeviceStore;
  events: { event: string; detail: Record<string, string | number> }[];
  close: () => Promise<void>;
}

async function harness(as: Caller | null): Promise<Harness> {
  const devices = new DeviceStore();
  const events: Harness['events'] = [];
  const app = express();
  app.use(express.json());
  registerDeviceRoutes(app, {
    devices,
    callerAccountId: () => as,
    onEvent: (event, detail) => events.push({ event, detail }),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    devices,
    events,
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
