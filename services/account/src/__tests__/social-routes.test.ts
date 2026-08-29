/** @author masterzee001 */
/**
 * The social surface, tested for what a caller may LEARN.
 *
 * Presence reaches accepted contacts and nobody else; a suggestion never
 * names a private account or anybody already related; the live push wakes
 * only followers who asked and have not switched notifications off; a
 * reporter is bounded per hour; and the four counts add up. The routes are
 * mounted with the same account routes the app mounts, so /contacts, /me
 * and /profiles are exercised through their real registration.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import { AccountStore } from '../account-store.js';
import { createInMemoryCallRecordPort, parseCallRecord } from '../call-records.js';
import { createInMemoryChannelFollowPort } from '../channel-follows.js';
import { ContactStore } from '../contact-store.js';
import { DeviceStore } from '../device-store.js';
import { createInMemoryMessageActionPort } from '../message-actions.js';
import { MessageStore, createInMemoryMessagePort } from '../message-store.js';
import { PresenceRegistry } from '../presence.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { createInMemoryReportPort } from '../reports.js';
import { createCallerResolver, registerAccountRoutes } from '../routes.js';
import { registerSocialRoutes } from '../social-routes.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');
const PASSWORD = 'correct horse battery staple';
const TOKEN = 'internal-token-that-is-long-enough';
const ENFORCED = { mode: 'enforced', token: TOKEN, fingerprint: 'abcd1234' } as InternalIngressAuthResolution;

interface Harness {
  url: string;
  store: AccountStore;
  contacts: ContactStore;
  devices: DeviceStore;
  presence: PresenceRegistry;
  sent: ReturnType<typeof createRecordingPushProvider>['sent'];
  calls: ReturnType<typeof createInMemoryCallRecordPort>;
  messages: MessageStore;
  events: string[];
  clock: { now: number };
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const clock = { now: 1_700_000_000_000 };
  const store = new AccountStore();
  const contacts = new ContactStore();
  const devices = new DeviceStore();
  const presence = new PresenceRegistry(() => clock.now);
  const provider = createRecordingPushProvider();
  const calls = createInMemoryCallRecordPort();
  const messages = new MessageStore({
    port: createInMemoryMessagePort(),
    actions: createInMemoryMessageActionPort(),
  });
  const events: string[] = [];
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, { store, contacts, presence, secret: SECRET });
  registerSocialRoutes(app, {
    store,
    contacts,
    presence,
    follows: createInMemoryChannelFollowPort(),
    reports: createInMemoryReportPort(),
    push: new PushDispatcher({ devices, providers: [provider] }),
    calls,
    messages,
    internalAuth: ENFORCED,
    callerAccountId: createCallerResolver({
      store,
      secret: SECRET,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
    nowMs: () => clock.now,
    onEvent: (event) => events.push(event),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    contacts,
    devices,
    presence,
    sent: provider.sent,
    calls,
    messages,
    events,
    clock,
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
  await call('POST', '/accounts/languages', { spokenLanguage: 'es' }, account.token);
  if (options.discoverable) {
    await call('POST', '/accounts/discovery', { discoverable: true }, account.token);
  }
  return account;
}

async function befriend(a: string, b: string): Promise<void> {
  await app.contacts.request(a, b);
  await app.contacts.accept(b, a);
}

describe('presence', () => {
  it('is visible to accepted contacts and to nobody else', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const carol = await person('carol');
    await befriend(alice.accountId, bob.accountId);
    await app.contacts.request(alice.accountId, carol.accountId);

    expect((await call('POST', '/presence/heartbeat', { state: 'active' }, bob.token)).status).toBe(200);
    await call('POST', '/presence/heartbeat', { state: 'busy' }, carol.token);

    const ids = `${bob.accountId},${carol.accountId},${alice.accountId}`;
    const seen = (await (await call('GET', `/presence?ids=${ids}`, undefined, alice.token)).json()) as {
      presence: Record<string, string>;
    };
    expect(seen.presence).toEqual({ [bob.accountId]: 'active' });
  });

  it('decays to away after two minutes, and the override wins over the heartbeat', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    await befriend(alice.accountId, bob.accountId);
    await call('POST', '/presence/heartbeat', { state: 'busy' }, bob.token);

    const read = async () =>
      ((await (await call('GET', `/presence?ids=${bob.accountId}`, undefined, alice.token)).json()) as {
        presence: Record<string, string>;
      }).presence[bob.accountId];

    expect(await read()).toBe('busy');
    app.clock.now += 119_000;
    expect(await read()).toBe('busy');
    app.clock.now += 2_000;
    expect(await read()).toBe('away');

    await call('POST', '/presence/heartbeat', { state: 'active' }, bob.token);
    expect(await read()).toBe('active');
    await call('PATCH', '/profile', { availability: 'away' }, bob.token);
    expect(await read()).toBe('away');
    await call('PATCH', '/profile', { availability: 'busy' }, bob.token);
    expect(await read()).toBe('busy');
  });

  it('refuses a state that is not active or busy', async () => {
    const alice = await person('alice');
    expect((await call('POST', '/presence/heartbeat', { state: 'away' }, alice.token)).status).toBe(400);
    expect((await call('POST', '/presence/heartbeat', { state: 'active' })).status).toBe(401);
  });
});

describe('the profile extras', () => {
  it('round-trip through /me and appear on the profile a contact sees', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    await befriend(alice.accountId, bob.accountId);

    const patched = await call(
      'PATCH',
      '/profile',
      { bio: '  Hola  ', availability: 'busy', notificationsEnabled: false },
      bob.token,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ bio: 'Hola', availability: 'busy', notificationsEnabled: false });

    const me = (await (await call('GET', '/me', undefined, bob.token)).json()) as {
      profile: { bio: string; availability: string; notificationsEnabled: boolean };
    };
    expect(me.profile).toMatchObject({ bio: 'Hola', availability: 'busy', notificationsEnabled: false });

    const profile = (await (await call('GET', `/profiles/${bob.accountId}`, undefined, alice.token)).json()) as {
      bio: string;
      presence?: string;
      notificationsEnabled?: unknown;
    };
    expect(profile.bio).toBe('Hola');
    expect(profile.presence).toBe('busy');
    // The notification switch is the person's own business.
    expect(profile.notificationsEnabled).toBeUndefined();
  });

  it('shows a stranger the bio but never presence', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    await call('PATCH', '/profile', { bio: 'Public', availability: 'busy' }, bob.token);
    const profile = (await (await call('GET', `/profiles/${bob.accountId}`, undefined, alice.token)).json()) as {
      bio: string;
      presence?: string;
    };
    expect(profile.bio).toBe('Public');
    expect(profile.presence).toBeUndefined();
  });

  it('refuses a bio over 160 characters and an unknown availability', async () => {
    const alice = await person('alice');
    expect((await call('PATCH', '/profile', { bio: 'x'.repeat(161) }, alice.token)).status).toBe(400);
    expect((await call('PATCH', '/profile', { availability: 'invisible' }, alice.token)).status).toBe(400);
    expect((await call('PATCH', '/profile', { notificationsEnabled: 'no' }, alice.token)).status).toBe(400);
  });
});

describe('the contact wire', () => {
  it('carries spoken language and official on every entry, presence on accepted contacts only', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const carol = await person('carol');
    await befriend(alice.accountId, bob.accountId);
    await app.contacts.request(carol.accountId, alice.accountId);
    await call('POST', '/presence/heartbeat', { state: 'active' }, bob.token);
    await call('POST', '/presence/heartbeat', { state: 'active' }, carol.token);

    const list = (await (await call('GET', '/contacts', undefined, alice.token)).json()) as {
      contacts: Record<string, unknown>[];
      requests: Record<string, unknown>[];
    };
    expect(list.contacts[0]).toMatchObject({
      accountId: bob.accountId,
      spokenLanguage: 'es',
      official: false,
      presence: 'active',
    });
    expect(list.requests[0]).toMatchObject({ accountId: carol.accountId, spokenLanguage: 'es', official: false });
    expect(list.requests[0]).not.toHaveProperty('presence');
  });
});

describe('suggested connections', () => {
  it('ranks contacts-of-contacts by mutual count, never self or anyone related', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    const carol = await person('carol', { discoverable: true });
    const dave = await person('dave', { discoverable: true });
    const erin = await person('erin', { discoverable: true });
    const frank = await person('frank', { discoverable: true });
    const gina = await person('gina', { discoverable: true });
    // Alice knows Bob and Carol. Both know Dave; Bob knows Erin; Carol knows Frank (blocked by Alice); Gina pending.
    await befriend(alice.accountId, bob.accountId);
    await befriend(alice.accountId, carol.accountId);
    await befriend(bob.accountId, dave.accountId);
    await befriend(carol.accountId, dave.accountId);
    await befriend(bob.accountId, erin.accountId);
    await befriend(carol.accountId, frank.accountId);
    await app.contacts.block(alice.accountId, frank.accountId);
    await app.contacts.request(gina.accountId, alice.accountId);

    const { suggestions } = (await (await call('GET', '/contacts/suggestions', undefined, alice.token)).json()) as {
      suggestions: { accountId: string; mutualCount: number; reason: string; spokenLanguage: string }[];
    };
    expect(suggestions.map((s) => s.accountId)).toEqual([dave.accountId, erin.accountId]);
    expect(suggestions[0]).toMatchObject({ mutualCount: 2, reason: 'mutual-contacts', spokenLanguage: 'es' });
    expect(suggestions.map((s) => s.accountId)).not.toContain(alice.accountId);
    expect(suggestions.map((s) => s.accountId)).not.toContain(frank.accountId);
    expect(suggestions.map((s) => s.accountId)).not.toContain(gina.accountId);
  });

  it('never surfaces a private account, even one with many mutual contacts', async () => {
    const alice = await person('alice');
    const bob = await person('bob', { discoverable: true });
    const carol = await person('carol', { discoverable: true });
    const secret = await person('secret');
    await befriend(alice.accountId, bob.accountId);
    await befriend(alice.accountId, carol.accountId);
    await befriend(bob.accountId, secret.accountId);
    await befriend(carol.accountId, secret.accountId);

    const { suggestions } = (await (await call('GET', '/contacts/suggestions', undefined, alice.token)).json()) as {
      suggestions: { accountId: string }[];
    };
    expect(suggestions.map((s) => s.accountId)).not.toContain(secret.accountId);
    expect(JSON.stringify(suggestions)).not.toContain('secret');
  });

  it('tops up with newcomers when fewer than three mutual suggestions exist', async () => {
    const alice = await person('alice');
    await person('old', { discoverable: true });
    await person('hidden');
    const newer = await person('newer', { discoverable: true });

    const { suggestions } = (await (await call('GET', '/contacts/suggestions', undefined, alice.token)).json()) as {
      suggestions: { accountId: string; reason: string; username: string }[];
    };
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.reason === 'new-on-c7')).toBe(true);
    expect(suggestions.map((s) => s.username)).not.toContain('c7hidden');
    expect(suggestions.map((s) => s.accountId)).toContain(newer.accountId);
  });
});

describe('channel follows and the live push', () => {
  async function phone(accountId: string, deviceId: string): Promise<void> {
    await app.devices.register({ deviceId, accountId, platform: 'android', pushToken: `tok-${deviceId}` });
  }
  const live = (channelId: string, body: unknown, token = TOKEN) =>
    fetch(`${app.url}/internal/channels/${channelId}/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Videofy-Internal-Token': token },
      body: JSON.stringify(body),
    });

  it('follows, lists, counts publicly and unfollows', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    expect((await call('PUT', '/channels/ch_1/follow', { following: true, remind: true }, alice.token)).status).toBe(200);
    await call('PUT', '/channels/ch_1/follow', { following: true }, bob.token);
    app.clock.now += 1_000;
    await call('PUT', '/channels/ch_2/follow', { following: true }, alice.token);

    const mine = (await (await call('GET', '/channels/follows', undefined, alice.token)).json()) as {
      follows: { channelId: string; remind: boolean }[];
    };
    expect(mine.follows).toEqual([
      { channelId: 'ch_2', remind: false },
      { channelId: 'ch_1', remind: true },
    ]);

    const interest = (await (await call('GET', '/channels/interest?ids=ch_1,ch_2,ch_3')).json()) as {
      counts: Record<string, number>;
    };
    expect(interest.counts).toEqual({ ch_1: 2, ch_2: 1, ch_3: 0 });

    await call('PUT', '/channels/ch_1/follow', { following: false }, alice.token);
    const after = (await (await call('GET', '/channels/interest?ids=ch_1')).json()) as { counts: Record<string, number> };
    expect(after.counts['ch_1']).toBe(1);
    expect((await call('PUT', '/channels/bad%20id/follow', { following: true }, alice.token)).status).toBe(400);
  });

  it('pushes to remind-followers only, and respects the notification switch', async () => {
    const remind = await person('remind');
    const quiet = await person('quiet');
    const muted = await person('muted');
    const nobody = await person('nobody');
    for (const p of [remind, quiet, muted, nobody]) await phone(p.accountId, `dev-${p.accountId}`);
    await call('PUT', '/channels/ch_live/follow', { following: true, remind: true }, remind.token);
    await call('PUT', '/channels/ch_live/follow', { following: true, remind: false }, quiet.token);
    await call('PUT', '/channels/ch_live/follow', { following: true, remind: true }, muted.token);
    await call('PATCH', '/profile', { notificationsEnabled: false }, muted.token);

    expect((await live('ch_live', { live: true, displayName: 'Kings' }, 'wrong')).status).toBe(404);
    expect((await live('ch_live', { live: 'yes', displayName: 'Kings' })).status).toBe(400);

    const response = await live('ch_live', { live: true, displayName: 'Kings' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: 1 });
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]?.target.deviceId).toBe(`dev-${remind.accountId}`);
    expect(app.sent[0]?.notification).toMatchObject({
      kind: 'message',
      title: 'Kings is live on C7',
      data: { kind: 'channel-live', channelId: 'ch_live' },
      collapseId: 'channel-live-ch_live',
    });

    // Going offline is silent.
    expect(await (await live('ch_live', { live: false, displayName: 'Kings' })).json()).toEqual({ notified: 0 });
    expect(app.sent).toHaveLength(1);
  });
});

describe('reports', () => {
  it('accepts every reason the phone offers and refuses one it does not know', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    for (const reason of ['spam', 'harassment', 'hate', 'sexual', 'violence', 'impersonation', 'other']) {
      expect((await call('POST', '/reports', { accountId: bob.accountId, reason }, alice.token)).status).toBe(201);
    }
    expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'rude' }, alice.token)).status).toBe(400);
  });

  it('files a report and bounds a reporter to ten an hour', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const first = await call('POST', '/reports', { accountId: bob.accountId, reason: 'spam', note: 'hm' }, alice.token);
    expect(first.status).toBe(201);
    expect((await first.json()) as { reportId: string }).toMatchObject({ reportId: expect.stringMatching(/^rep_/) });

    for (let i = 0; i < 9; i += 1) {
      expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'abuse' }, alice.token)).status).toBe(201);
    }
    expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'other' }, alice.token)).status).toBe(429);
    app.clock.now += 60 * 60 * 1000 + 1;
    expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'other' }, alice.token)).status).toBe(201);
    expect(app.events.filter((e) => e === 'report.rate-limited')).toHaveLength(1);
  });

  it('refuses a self-report, an unknown reason and an oversized note', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    expect((await call('POST', '/reports', { accountId: alice.accountId, reason: 'spam' }, alice.token)).status).toBe(400);
    expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'rude' }, alice.token)).status).toBe(400);
    expect(
      (await call('POST', '/reports', { accountId: bob.accountId, reason: 'spam', note: 'x'.repeat(501) }, alice.token))
        .status,
    ).toBe(400);
    expect((await call('POST', '/reports', { accountId: bob.accountId, reason: 'spam' })).status).toBe(401);
  });
});

describe('/me/counts', () => {
  it('adds up connections, calls, follows and saved messages', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const carol = await person('carol');
    await befriend(alice.accountId, bob.accountId);
    await befriend(alice.accountId, carol.accountId);
    await app.contacts.request(alice.accountId, (await person('dave')).accountId);

    await app.calls.upsert(
      parseCallRecord({
        callId: 'c1', callerAccountId: alice.accountId, peerAccountId: bob.accountId, mode: 'normal',
        createdAtMs: 1, endedAtMs: 2, outcome: 'missed',
      })!,
    );
    await app.calls.upsert(
      parseCallRecord({
        callId: 'c2', callerAccountId: carol.accountId, peerAccountId: alice.accountId, mode: 'normal',
        createdAtMs: 1, endedAtMs: 2, outcome: 'completed',
      })!,
    );
    await app.calls.upsert(
      parseCallRecord({
        callId: 'c3', callerAccountId: carol.accountId, peerAccountId: bob.accountId, mode: 'normal',
        createdAtMs: 1, endedAtMs: 2, outcome: 'completed',
      })!,
    );
    await call('PUT', '/channels/ch_1/follow', { following: true }, alice.token);
    await call('PUT', '/channels/ch_2/follow', { following: true }, alice.token);
    await app.messages.setPin('msg_x', alice.accountId, true);

    const counts = await (await call('GET', '/me/counts', undefined, alice.token)).json();
    expect(counts).toEqual({ connections: 2, calls: 2, following: 2, saved: 1 });
  });
});
