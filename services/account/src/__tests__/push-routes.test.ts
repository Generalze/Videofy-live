/**
 * The seam another service rings a phone through.
 *
 * An open push endpoint lets anybody make anybody's phone ring, at any hour, as
 * often as they like. So the tests that matter are the ones about who is turned
 * away, and about what happens when the shared secret was never configured.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import { DeviceStore } from '../device-store.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { registerPushRoutes } from '../push-routes.js';

const TOKEN = 'internal-token-that-is-long-enough';

const ENFORCED: InternalIngressAuthResolution = {
  mode: 'enforced',
  token: TOKEN,
  fingerprint: 'abcd1234',
} as InternalIngressAuthResolution;

const UNCONFIGURED: InternalIngressAuthResolution = {
  mode: 'unconfigured',
  token: null,
  fingerprint: null,
} as unknown as InternalIngressAuthResolution;

interface Harness {
  url: string;
  devices: DeviceStore;
  provider: ReturnType<typeof createRecordingPushProvider>;
  close: () => Promise<void>;
}

async function harness(auth: InternalIngressAuthResolution): Promise<Harness> {
  const devices = new DeviceStore();
  await devices.register({
    deviceId: 'dev_1',
    accountId: 'acct_a',
    platform: 'ios',
    pushToken: 'tok_abc',
  });
  const provider = createRecordingPushProvider();
  const app = express();
  app.use(express.json());
  registerPushRoutes(app, {
    push: new PushDispatcher({ devices, providers: [provider] }),
    auth,
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    devices,
    provider,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function ring(url: string, token: string | null, body: unknown) {
  return fetch(`${url}/internal/push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const RING = {
  accountId: 'acct_a',
  kind: 'call',
  privacy: 'visible',
  urgency: 'high',
  title: 'Incoming call',
  data: { callId: 'call_1' },
};

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('who may ring a phone', () => {
  it('accepts a first-party caller holding the internal token', async () => {
    app = await harness(ENFORCED);
    const response = await ring(app.url, TOKEN, RING);

    expect(response.status).toBe(200);
    expect(app.provider.sent).toHaveLength(1);
  });

  it('refuses a caller with no token', async () => {
    app = await harness(ENFORCED);
    expect((await ring(app.url, null, RING)).status).toBe(404);
    expect(app.provider.sent).toHaveLength(0);
  });

  it('refuses a caller with the wrong token', async () => {
    app = await harness(ENFORCED);
    expect((await ring(app.url, 'not-the-token', RING)).status).toBe(404);
    expect(app.provider.sent).toHaveLength(0);
  });

  /*
   * THE ONE THAT MATTERS. A missing secret must produce a service that CANNOT
   * push, never one that pushes for strangers. The route is not registered at
   * all, so there is nothing to authenticate against.
   */
  it('does not exist at all when no internal token is configured', async () => {
    app = await harness(UNCONFIGURED);
    const response = await ring(app.url, TOKEN, RING);

    expect(response.status).toBe(404);
    expect(app.provider.sent).toHaveLength(0);
  });
});

describe('what it accepts', () => {
  it('refuses an unknown kind', async () => {
    app = await harness(ENFORCED);
    expect((await ring(app.url, TOKEN, { ...RING, kind: 'spam' })).status).toBe(400);
  });

  it('refuses a missing account', async () => {
    app = await harness(ENFORCED);
    expect((await ring(app.url, TOKEN, { ...RING, accountId: '  ' })).status).toBe(400);
  });

  /* Both providers flatten payloads to strings; refuse early rather than there. */
  it('refuses non-string data values', async () => {
    app = await harness(ENFORCED);
    const response = await ring(app.url, TOKEN, { ...RING, data: { count: 3 } });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown privacy level', async () => {
    app = await harness(ENFORCED);
    expect((await ring(app.url, TOKEN, { ...RING, privacy: 'shouty' })).status).toBe(400);
  });

  it('defaults privacy and urgency when not given', async () => {
    app = await harness(ENFORCED);
    const response = await ring(app.url, TOKEN, {
      accountId: 'acct_a',
      kind: 'system',
      data: {},
    });
    expect(response.status).toBe(200);
  });
});

describe('what it reports back', () => {
  it('summarises the fan-out', async () => {
    app = await harness(ENFORCED);
    const body = (await (await ring(app.url, TOKEN, RING)).json()) as {
      summary: { attempted: number; delivered: number };
    };
    expect(body.summary.attempted).toBe(1);
    expect(body.summary.delivered).toBe(1);
  });

  /*
   * A caller setting up a call may want to act on this -- by not waiting for an
   * answer that cannot arrive.
   */
  it('reports zero devices rather than failing', async () => {
    app = await harness(ENFORCED);
    const body = (await (await ring(app.url, TOKEN, { ...RING, accountId: 'acct_nobody' })).json()) as {
      summary: { attempted: number };
    };
    expect(body.summary.attempted).toBe(0);
  });

  it('never echoes a push token', async () => {
    app = await harness(ENFORCED);
    const text = await (await ring(app.url, TOKEN, RING)).text();
    expect(text).not.toContain('tok_abc');
  });
});
