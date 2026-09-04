/** @author masterzee001 */
/**
 * The channel identity routes, through their real registration: accounts
 * are created with the same routes the app mounts, so the claim reads a
 * real username; the internal seam is exercised with the real token guard.
 *
 * Founder directive (LOCKED, 30 Aug 2026): "public canonical route
 * /streams/<handle> with opaque links still working"; "preserve channel
 * isolation, visibility rules, join-code security and opaque ids".
 */
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import { AccountStore } from '../account-store.js';
import {
  ChannelProfiles,
  createFileChannelImageStore,
  createInMemoryChannelProfilePort,
} from '../channel-profiles.js';
import { registerChannelRoutes } from '../channel-routes.js';
import { ContactStore } from '../contact-store.js';
import { PresenceRegistry } from '../presence.js';
import { createCallerResolver, registerAccountRoutes } from '../routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const PASSWORD = 'correct horse battery staple';
const TOKEN = 'internal-token-that-is-long-enough';
const ENFORCED = { mode: 'enforced', token: TOKEN, fingerprint: 'abcd1234' } as InternalIngressAuthResolution;

const CHANNEL_A = '0123456789abcdef';
const CHANNEL_B = 'fedcba9876543210';

/** Smallest real JPEG header; the sniffer reads magic bytes, not validity. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const dataUrl = (bytes: Buffer, label = 'image/jpeg'): string =>
  `data:${label};base64,${bytes.toString('base64')}`;

interface Harness {
  url: string;
  events: string[];
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const contacts = new ContactStore();
  const presence = new PresenceRegistry(() => Date.now());
  const events: string[] = [];
  const app = express();
  // The app's global parser exempts the two picture routes; mirror that here
  // so the 4mb route-scoped parser is what actually reads them.
  const identityJson = express.json({ limit: '16kb' });
  app.use((req, res, next) => {
    if (/^\/channels\/mine\/(avatar|banner)$/.test(req.path)) {
      next();
      return;
    }
    identityJson(req, res, next);
  });
  registerAccountRoutes(app, { store, contacts, presence, secret: SECRET });
  registerChannelRoutes(app, {
    profiles: new ChannelProfiles({
      port: createInMemoryChannelProfilePort(),
      images: createFileChannelImageStore(await mkdtemp(join(tmpdir(), 'channel-media-'))),
    }),
    store,
    internalAuth: ENFORCED,
    callerAccountId: createCallerResolver({
      store,
      secret: SECRET,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
    onEvent: (event) => events.push(event),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    events,
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

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return fetch(`${app.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function internal(method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${app.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Videofy-Internal-Token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function person(username: string): Promise<{ token: string; accountId: string }> {
  const response = await call('POST', '/accounts', {
    email: `${username}@example.com`,
    password: PASSWORD,
    username,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: string; accountId: string };
}

async function claimed(username: string, channelId: string): Promise<{ token: string; accountId: string }> {
  const account = await person(username);
  const claim = await internal('POST', `/internal/channels/${channelId}/claim`, {
    ownerAccountId: account.accountId,
  });
  expect(claim.status).toBe(200);
  return account;
}

describe('the internal claim', () => {
  it('creates the profile from the username, once, and answers the same row after', async () => {
    const zoe = await person('zoe.meak');
    expect((await call('GET', '/channels/mine', undefined, zoe.token)).status).toBe(404);

    const first = await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, {
      ownerAccountId: zoe.accountId,
    });
    expect(first.status).toBe(200);
    const profile = (await first.json()) as Record<string, unknown>;
    expect(profile).toMatchObject({
      channelId: CHANNEL_A,
      ownerAccountId: zoe.accountId,
      handle: 'zoe_meak',
      // No display name chosen yet: the username's own part, never 'Channel 0123'.
      displayName: 'zoe.meak',
      description: '',
      category: null,
      visibility: 'public',
      avatarUrl: null,
      bannerUrl: null,
    });
    expect(typeof profile['createdAt']).toBe('number');

    const second = await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, {
      ownerAccountId: zoe.accountId,
    });
    expect(await second.json()).toEqual(profile);
    expect(app.events.filter((event) => event === 'channel.claimed')).toHaveLength(1);

    const mine = await call('GET', '/channels/mine', undefined, zoe.token);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual(profile);
  });

  it('is invisible without the internal token, like every internal route', async () => {
    const zoe = await person('zoemeak');
    const wrong = await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, { ownerAccountId: zoe.accountId }, 'nope');
    expect(wrong.status).toBe(404);
    const missing = await call('POST', `/internal/channels/${CHANNEL_A}/claim`, { ownerAccountId: zoe.accountId });
    expect(missing.status).toBe(404);
    expect((await call('GET', '/channels/mine', undefined, zoe.token)).status).toBe(404);
  });

  it('refuses a malformed claim and an unknown account', async () => {
    expect((await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, {})).status).toBe(400);
    expect((await internal('POST', '/internal/channels/not%20ok/claim', { ownerAccountId: 'acct_00000000000000aa' })).status).toBe(400);
    expect(
      (await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, { ownerAccountId: 'acct_00000000000000aa' })).status,
    ).toBe(404);
  });

  it('refuses a channel that belongs to another account', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    const other = await person('other');
    const taken = await internal('POST', `/internal/channels/${CHANNEL_A}/claim`, { ownerAccountId: other.accountId });
    expect(taken.status).toBe(409);
    expect((await internal('GET', `/internal/channels/by-owner/${zoe.accountId}`)).status).toBe(200);
    expect((await internal('GET', `/internal/channels/by-owner/${other.accountId}`)).status).toBe(404);
  });
});

describe('the owner editing', () => {
  it('updates fields, names the rule broken, and refuses a handle somebody holds', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    await claimed('other', CHANNEL_B);

    const ok = await call(
      'PUT',
      '/channels/mine',
      { handle: '@Zoe_Live', displayName: 'Zoe Live', description: 'Morning news', category: 'news', visibility: 'private' },
      zoe.token,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      handle: 'zoe_live',
      displayName: 'Zoe Live',
      description: 'Morning news',
      category: 'news',
      visibility: 'private',
    });

    const bad = await call('PUT', '/channels/mine', { category: 'gossip' }, zoe.token);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Choose a category from the list.' });

    const reserved = await call('PUT', '/channels/mine', { handle: 'main' }, zoe.token);
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: 'That handle is reserved.' });

    // The other channel's handle, in another case: still taken.
    const taken = await call('PUT', '/channels/mine', { handle: 'OTHER' }, zoe.token);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'That handle is taken.' });
  });

  it('is owner-only: the edit lands on the caller, and nobody else can reach it', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    const stranger = await person('stranger');
    // A stranger's PUT edits the stranger's (absent) channel, not Zoe's.
    expect((await call('PUT', '/channels/mine', { displayName: 'Mine now' }, stranger.token)).status).toBe(404);
    expect((await call('PUT', '/channels/mine', { displayName: 'Mine now' })).status).toBe(401);
    const mine = (await (await call('GET', '/channels/mine', undefined, zoe.token)).json()) as { displayName: string };
    expect(mine.displayName).toBe('zoemeak');
  });
});

describe('the public profile', () => {
  it('answers by handle and by opaque id with the same shape, never the owner id', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    await call('PUT', '/channels/mine', { description: 'Morning news', category: 'news' }, zoe.token);

    const byHandle = await fetch(`${app.url}/streams/ZoeMeak`);
    expect(byHandle.status).toBe(200);
    const pub = (await byHandle.json()) as Record<string, unknown>;
    expect(pub).toEqual({
      channelId: CHANNEL_A,
      handle: 'zoemeak',
      displayName: 'zoemeak',
      description: 'Morning news',
      category: 'news',
      visibility: 'public',
      avatarUrl: null,
      bannerUrl: null,
    });
    expect(JSON.stringify(pub)).not.toContain(zoe.accountId);

    const byId = await fetch(`${app.url}/channels/${CHANNEL_A}/profile`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toEqual(pub);
  });

  it('answers 404 for a handle or id nobody holds', async () => {
    expect((await fetch(`${app.url}/streams/nobody`)).status).toBe(404);
    expect((await fetch(`${app.url}/channels/${CHANNEL_B}/profile`)).status).toBe(404);
    expect((await fetch(`${app.url}/channels/not%20an%20id/profile`)).status).toBe(404);
  });

  it('follows a handle change, while the opaque link keeps working', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    await call('PUT', '/channels/mine', { handle: 'zoe_live' }, zoe.token);
    expect((await fetch(`${app.url}/streams/zoemeak`)).status).toBe(404);
    expect((await fetch(`${app.url}/streams/zoe_live`)).status).toBe(200);
    expect((await fetch(`${app.url}/channels/${CHANNEL_A}/profile`)).status).toBe(200);
  });
});

describe('pictures', () => {
  it('round-trips an avatar and a banner through the public paths, and removes them', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    for (const kind of ['avatar', 'banner'] as const) {
      const put = await call('PUT', `/channels/mine/${kind}`, { image: dataUrl(JPEG) }, zoe.token);
      expect(put.status).toBe(200);
      const profile = (await put.json()) as Record<string, string | null>;
      const url = profile[`${kind}Url`];
      expect(url).toMatch(new RegExp(`^/channels/${CHANNEL_A}/${kind}\\?v=[0-9a-f]+$`));

      const got = await fetch(`${app.url}${url}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await got.arrayBuffer()).equals(JPEG)).toBe(true);

      const removed = await call('DELETE', `/channels/mine/${kind}`, undefined, zoe.token);
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as Record<string, unknown>)[`${kind}Url`]).toBeNull();
      expect((await fetch(`${app.url}/channels/${CHANNEL_A}/${kind}`)).status).toBe(404);
    }
  });

  it('judges the bytes, not the label, and needs a session and a channel', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await call('PUT', '/channels/mine/avatar', { image: dataUrl(svg, 'image/jpeg') }, zoe.token)).status).toBe(400);
    expect((await call('PUT', '/channels/mine/avatar', { image: dataUrl(JPEG) })).status).toBe(401);
    const stranger = await person('stranger');
    expect((await call('PUT', '/channels/mine/avatar', { image: dataUrl(JPEG) }, stranger.token)).status).toBe(404);
  });
});

describe('the internal reads and the visibility mirror', () => {
  it('answers profiles for the ids it knows and mirrors visibility by id', async () => {
    const zoe = await claimed('zoemeak', CHANNEL_A);
    const list = await internal('GET', `/internal/channels/profiles?ids=${CHANNEL_A},${CHANNEL_B},bad%20id`);
    expect(list.status).toBe(200);
    const { profiles } = (await list.json()) as { profiles: Record<string, { ownerAccountId: string }> };
    expect(Object.keys(profiles)).toEqual([CHANNEL_A]);
    expect(profiles[CHANNEL_A]?.ownerAccountId).toBe(zoe.accountId);

    const mirrored = await internal('PUT', `/internal/channels/${CHANNEL_A}/visibility`, { visibility: 'locked' });
    expect(mirrored.status).toBe(200);
    expect(((await mirrored.json()) as { visibility: string }).visibility).toBe('locked');
    expect(((await (await fetch(`${app.url}/streams/zoemeak`)).json()) as { visibility: string }).visibility).toBe('locked');

    expect((await internal('PUT', `/internal/channels/${CHANNEL_A}/visibility`, { visibility: 'unlisted' })).status).toBe(400);
    expect((await internal('PUT', `/internal/channels/${CHANNEL_B}/visibility`, { visibility: 'locked' })).status).toBe(404);
    expect((await internal('GET', `/internal/channels/profiles?ids=${CHANNEL_A}`, undefined, 'nope')).status).toBe(404);
  });
});
