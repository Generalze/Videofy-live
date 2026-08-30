/**
 * Two programmes at once, and the wall between them.
 *
 * THE DEFECT THIS CLOSES. The gateway held one programme state and broadcast it
 * with `io.emit`, so a second operator did not get a second programme -- they
 * overwrote the first mid-broadcast, and every listener received both states and
 * displayed whichever arrived last.
 *
 * These are integration tests rather than unit tests because the thing worth
 * proving is not that the state map keys correctly -- that is covered next door
 * in programme-channels.test.ts -- but that a real listener on a real socket
 * hears one programme and not the other.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import type {
  ChannelAssignedPayload,
  ChannelSummary,
  MediaStateEvent,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';
import { createApp } from '../app.js';
import type { ChannelIdentityPort, ChannelProfile } from '../channel-identity.js';
import { Gateway } from '../gateway.js';

const OPERATOR_SECRET = 'z'.repeat(48);
const SECRET = requireSessionSecret(OPERATOR_SECRET, 'TEST_OPERATOR_SECRET');
const ALICE = 'acct_a1b2c3d4e5f60718';
const BOB = 'acct_00112233445566aa';

function tokenFor(accountId: string): string {
  return issueSessionToken({
    secret: SECRET,
    accountId,
    version: 1,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}

function programmeConfig(sessionId: string, broadcastId: string) {
  return {
    sessionId,
    broadcastId,
    sourceRevision: 1,
    targetLanguage: 'es',
    targetLanguages: ['es'],
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual' as const,
  };
}

describe('two programmes on one gateway', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173', 'http://localhost:5174'], {
    call: { authorizeHost: async () => true },
      operator: { authSecret: OPERATOR_SECRET, channelSalt: 'isolation-test' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(role: string, accountId?: string): Socket {
    const socket = connectClient(baseUrl, {
      query: { role },
      ...(accountId ? { auth: { token: tokenFor(accountId) } } : {}),
      transports: ['websocket'],
      forceNew: true,
    });
    clients.push(socket);
    return socket;
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** An operator on their own channel, and the id they were given. */
  async function operatorOnOwnChannel(accountId: string): Promise<{
    socket: Socket;
    channelId: string;
  }> {
    const socket = connect('operator', accountId);
    const assigned = await new Promise<ChannelAssignedPayload>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    /*
     * AUTO-LAND (founder directive A, 30 Aug 2026): the gateway puts an
     * entitled operator on their own channel at connect. Until this wave it
     * only offered the channel and waited for JOIN_CHANNEL 'own'.
     */
    expect(assigned.active).toBe(assigned.channelId);
    return { socket, channelId: assigned.channelId };
  }

  function collectMediaState(socket: Socket): MediaStateEvent[] {
    const received: MediaStateEvent[] = [];
    socket.on(SOCKET_EVENTS.MEDIA_STATE, (event: MediaStateEvent) => received.push(event));
    return received;
  }

  it('gives each operator a different channel', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const bob = await operatorOnOwnChannel(BOB);
    expect(alice.channelId).not.toBe(bob.channelId);
  });

  /*
   * THE CORE ASSERTION. Before channels, both listeners received both
   * programmes.
   */
  it('delivers each programme only to its own listeners', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const bob = await operatorOnOwnChannel(BOB);

    const aliceListener = connect('listener');
    const bobListener = connect('listener');
    await waitUntil(() => aliceListener.connected && bobListener.connected);

    aliceListener.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: alice.channelId });
    bobListener.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: bob.channelId });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const heardByAlice = collectMediaState(aliceListener);
    const heardByBob = collectMediaState(bobListener);

    alice.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_alice', 'broadcast_alice'),
    });
    bob.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_bob', 'broadcast_bob'),
    });

    await waitUntil(() => heardByAlice.length >= 1 && heardByBob.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(heardByAlice.map((event) => event.processingSessionId)).toEqual(['wrs_alice']);
    expect(heardByBob.map((event) => event.processingSessionId)).toEqual(['wrs_bob']);
  });

  /*
   * BACK COMPATIBILITY. A client that has never heard of channels sits on
   * the platform channel and must keep working unchanged -- served by an
   * operator who MOVED there. Landing there is no longer automatic
   * (founder directive A, 30 Aug 2026); the move remains for whoever
   * operates the platform channel today, and this is that move.
   */
  it('serves a listener that never mentions a channel', async () => {
    const operator = connect('operator', ALICE);
    operator.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
    const listener = connect('listener');
    await waitUntil(() => operator.connected && listener.connected);
    const heard = collectMediaState(listener);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_legacy', 'broadcast_legacy'),
    });

    await waitUntil(() => heard.length >= 1);
    expect(heard[0]?.processingSessionId).toBe('wrs_legacy');
  });

  it('does not leak a personalised programme to a default-channel listener', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const legacyListener = connect('listener');
    await waitUntil(() => legacyListener.connected);
    const heard = collectMediaState(legacyListener);

    alice.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_alice', 'broadcast_alice'),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard).toEqual([]);
  });

  it('refuses an operator moving onto a channel another account claimed', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const bob = connect('operator', BOB);
    await waitUntil(() => bob.connected);

    const errors: { message: string }[] = [];
    bob.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));
    bob.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: alice.channelId });

    await waitUntil(() => errors.length >= 1);
    expect(errors[0]?.message).toContain('another account');
  });

  /*
   * Authentication alone did not close this. An operator with a valid token
   * could still retarget a stranger's live programme by naming its session id.
   */
  it('refuses an operator reconfiguring a session on another channel', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    alice.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_alice', 'broadcast_alice'),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const bob = await operatorOnOwnChannel(BOB);
    const errors: { message: string }[] = [];
    bob.socket.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));
    bob.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_alice', 'broadcast_hijack'),
    });

    await waitUntil(() => errors.length >= 1);
    expect(errors[0]?.message).toContain('another channel');
  });

  it('lands the operator on their channel without any move, and lets them return to main', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    alice.socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
    const moved = await new Promise<ChannelAssignedPayload>((resolve) => {
      alice.socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    expect(moved.active).toBe('main');
    expect(moved.channelId).toBe(alice.channelId);
    // The platform channel has no persisted identity.
    expect(moved.profile).toBeNull();
  });

  it('lists a claimed channel in the directory a listener is given', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });

    expect(directory.map((channel) => channel.channelId)).toContain(alice.channelId);
  });

  /*
   * Founder ruling (29 Aug 2026): a controlled channel-side category field.
   * Controlled means a value off the list is refused by name, and nothing
   * else in the same message is applied.
   */
  it('refuses a category that is not on the list, and changes nothing', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const errors: { message: string }[] = [];
    alice.socket.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));

    alice.socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, {
      displayName: 'Renamed Anyway',
      category: 'gossip',
    });
    await waitUntil(() => errors.length > 0);
    expect(errors[0]?.message).toBe('Choose a category from the list.');

    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });
    const entry = directory.find((channel) => channel.channelId === alice.channelId);
    expect(entry?.category).toBeNull();
    expect(entry?.displayName).not.toBe('Renamed Anyway');
  });

  it('carries a chosen category to listeners and back to the operator', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    alice.socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, { category: 'faith' });
    const confirmed = await new Promise<{ category?: string | null }>((resolve) => {
      alice.socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    expect(confirmed.category).toBe('faith');

    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });
    expect(directory.find((channel) => channel.channelId === alice.channelId)?.category).toBe(
      'faith',
    );
  });
});

describe('a private programme', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173'], {
    call: { authorizeHost: async () => true },
      operator: { authSecret: OPERATOR_SECRET, channelSalt: 'private-test' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(role: string, accountId?: string): Socket {
    const socket = connectClient(baseUrl, {
      query: { role },
      ...(accountId ? { auth: { token: tokenFor(accountId) } } : {}),
      transports: ['websocket'],
      forceNew: true,
    });
    clients.push(socket);
    return socket;
  }

  /** An operator on their own channel, made private with a code. */
  async function privateChannel(code: string): Promise<{ socket: Socket; channelId: string }> {
    const socket = connect('operator', ALICE);
    // Landed on their own channel at connect (founder directive A).
    const assigned = await new Promise<{ channelId: string }>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, {
      displayName: 'Invitation Only',
      visibility: 'locked',
      code,
    });
    const confirmed = await new Promise<{ hasCode?: boolean }>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    expect(confirmed.hasCode).toBe(true);
    return { socket, channelId: assigned.channelId };
  }

  it('admits a listener holding the code', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const errors: unknown[] = [];
    listener.on(SOCKET_EVENTS.ERROR, (error: unknown) => errors.push(error));

    listener.emit(SOCKET_EVENTS.JOIN_CHANNEL, {
      channelId: channel.channelId,
      code: 'let-me-in-please',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors).toEqual([]);
  });

  it('refuses a listener with the link but no code', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const errors: { message: string }[] = [];
    listener.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));

    listener.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: channel.channelId });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors[0]?.message).toContain('locked');
  });

  it('refuses a listener with the wrong code', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const errors: { message: string }[] = [];
    listener.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));

    listener.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: channel.channelId, code: 'guessing' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors[0]?.message).toContain('locked');
  });

  /*
   * THE LEAK THIS CLOSES. Translation events went to the bare language room --
   * every listener of that language across every channel -- so a private
   * programme’s source text reached viewers who never had the code.
   */
  it('does not send a private programme’s phrases to another channel', async () => {
    const channel = await privateChannel('let-me-in-please');
    /* Bind the session to the locked channel, exactly as running it does. */
    channel.socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_private', 'broadcast_private'),
    });
    const outsider = connect('listener');
    const worker = connect('worker');
    await new Promise((resolve) => setTimeout(resolve, 200));

    outsider.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'es');
    const heard: unknown[] = [];
    outsider.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: unknown) => heard.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));

    worker.emit(SOCKET_EVENTS.WORKER_TRANSLATION, {
      eventId: 'private-event',
      sessionId: 'wrs_private',
      sequence: 1,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceText: 'something confidential',
      translatedText: 'algo confidencial',
      audioUrl: null,
      audioFormat: null,
      audioDurationMs: null,
      final: true,
      videoTimestampMs: 1000,
      createdAt: new Date().toISOString(),
      latency: {
        audioCaptureMs: 0,
        transcriptionMs: 0,
        translationMs: 0,
        speechGenerationMs: 0,
        deliveryMs: 0,
        synchronizationOffsetMs: 0,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard).toEqual([]);
  });

  it('keeps a locked channel out of the public directory', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });
    expect(directory.map((entry) => entry.channelId)).not.toContain(channel.channelId);
  });
});

/**
 * A stand-in for the account service's channel records, so these tests run
 * without HTTP. It records what the gateway asked of it.
 */
interface FakeIdentity extends ChannelIdentityPort {
  readonly store: Map<string, ChannelProfile>;
  readonly claims: { channelId: string; ownerAccountId: string }[];
  readonly mirrored: { channelId: string; visibility: string }[];
  readonly invalidated: string[];
  down: boolean;
}

function fakeIdentity(): FakeIdentity {
  const store = new Map<string, ChannelProfile>();
  const port: FakeIdentity = {
    store,
    claims: [],
    mirrored: [],
    invalidated: [],
    down: false,
    async claim(channelId, ownerAccountId) {
      port.claims.push({ channelId, ownerAccountId });
      if (port.down) return null;
      const existing = store.get(channelId);
      if (existing) return existing;
      const created: ChannelProfile = {
        channelId,
        ownerAccountId,
        handle: `handle-${channelId.slice(0, 4)}`,
        displayName: `Named ${channelId.slice(0, 4)}`,
        description: '',
        category: 'faith',
        visibility: 'public',
        avatarUrl: `/channels/${channelId}/avatar`,
        bannerUrl: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.set(channelId, created);
      return created;
    },
    async profiles(channelIds) {
      const found = new Map<string, ChannelProfile>();
      if (port.down) return found;
      for (const id of channelIds) {
        const profile = store.get(id);
        if (profile) found.set(id, profile);
      }
      return found;
    },
    async setVisibility(channelId, visibility) {
      port.mirrored.push({ channelId, visibility });
      if (port.down) return null;
      const existing = store.get(channelId);
      if (!existing) return null;
      const updated = { ...existing, visibility, updatedAt: Date.now() + 1 };
      store.set(channelId, updated);
      return updated;
    },
    invalidate(channelId) {
      port.invalidated.push(channelId);
    },
  };
  return port;
}

/*
 * Founder directive (A, 30 Aug 2026): identity persists outside gateway
 * memory, and "never expose fallback names like 'Channel abc123' when an
 * identity exists."
 */
describe('persisted channel identity', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];
  let identity: FakeIdentity;

  beforeEach(async () => {
    identity = fakeIdentity();
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173'], {
      call: { authorizeHost: async () => true },
      operator: { authSecret: OPERATOR_SECRET, channelSalt: 'identity-test' },
      channelIdentity: identity,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(role: string, accountId?: string): Socket {
    const socket = connectClient(baseUrl, {
      query: { role },
      ...(accountId ? { auth: { token: tokenFor(accountId) } } : {}),
      transports: ['websocket'],
      forceNew: true,
    });
    clients.push(socket);
    return socket;
  }

  async function landed(accountId: string): Promise<{ socket: Socket; assigned: ChannelAssignedPayload }> {
    const socket = connect('operator', accountId);
    const assigned = await new Promise<ChannelAssignedPayload>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    return { socket, assigned };
  }

  async function directoryRow(channelId: string): Promise<ChannelSummary | undefined> {
    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });
    return directory.find((row) => row.channelId === channelId);
  }

  it('claims the channel for the account and lands the operator on it with its profile', async () => {
    const { assigned } = await landed(ALICE);

    expect(identity.claims).toEqual([{ channelId: assigned.channelId, ownerAccountId: ALICE }]);
    expect(assigned.active).toBe(assigned.channelId);
    expect(assigned.profile).toEqual({
      handle: `handle-${assigned.channelId.slice(0, 4)}`,
      displayName: `Named ${assigned.channelId.slice(0, 4)}`,
      category: 'faith',
      avatarUrl: `/channels/${assigned.channelId}/avatar`,
    });
    expect(assigned.category).toBe('faith');
    expect(assigned.hasCode).toBe(false);
  });

  it('gives the directory the persisted identity, never a fallback name', async () => {
    const { assigned } = await landed(ALICE);
    const row = await directoryRow(assigned.channelId);

    expect(row).toMatchObject({
      displayName: `Named ${assigned.channelId.slice(0, 4)}`,
      handle: `handle-${assigned.channelId.slice(0, 4)}`,
      avatarUrl: `/channels/${assigned.channelId}/avatar`,
      category: 'faith',
      live: false,
      currentProgramme: null,
    });
    expect(row?.displayName).not.toMatch(/^Channel /);
  });

  it('shows a configured channel by name after a restart, before its operator touches anything', async () => {
    // The account already holds the profile; this gateway has never seen the channel.
    const first = await landed(ALICE);
    identity.store.set(first.assigned.channelId, {
      ...identity.store.get(first.assigned.channelId)!,
      displayName: 'Configured Before Restart',
      updatedAt: Date.now() + 1,
    });
    first.socket.disconnect();

    const restarted = createServer(createApp());
    new Gateway(restarted, ['http://localhost:5173'], {
      call: { authorizeHost: async () => true },
      operator: { authSecret: OPERATOR_SECRET, channelSalt: 'identity-test' },
      channelIdentity: identity,
    });
    await new Promise<void>((resolve) => restarted.listen(0, '127.0.0.1', resolve));
    const restartedUrl = `http://127.0.0.1:${(restarted.address() as AddressInfo).port}`;
    try {
      const operator = connectClient(restartedUrl, {
        query: { role: 'operator' },
        auth: { token: tokenFor(ALICE) },
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(operator);
      const assigned = await new Promise<ChannelAssignedPayload>((resolve) => {
        operator.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
      });
      expect(assigned.profile?.displayName).toBe('Configured Before Restart');
      // Closed here rather than in afterEach: the server waits for its sockets.
      operator.disconnect();
    } finally {
      await new Promise<void>((resolve) => restarted.close(() => resolve()));
    }
  });

  it('keeps in-memory values and still lands the operator when the account does not answer', async () => {
    identity.down = true;
    const { assigned } = await landed(ALICE);

    expect(assigned.active).toBe(assigned.channelId);
    expect(assigned.profile).toBeNull();
    const row = await directoryRow(assigned.channelId);
    // No identity exists, so the fallback name is the honest answer here.
    expect(row?.handle).toBeNull();
    expect(row?.displayName).toMatch(/^Channel /);
  });

  it('mirrors a visibility change to the account and acknowledges with the re-read profile', async () => {
    const { socket, assigned } = await landed(ALICE);
    socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, { visibility: 'private' });
    const confirmed = await new Promise<ChannelAssignedPayload>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });

    expect(identity.mirrored).toEqual([{ channelId: assigned.channelId, visibility: 'private' }]);
    expect(confirmed.profile?.handle).toBe(`handle-${assigned.channelId.slice(0, 4)}`);
    expect(identity.store.get(assigned.channelId)?.visibility).toBe('private');
    expect(await directoryRow(assigned.channelId)).toBeUndefined();
  });

  /*
   * The console saves name and category to the account itself (lane A3),
   * then asks the gateway to look again. An empty settings message is that
   * request; the ack carries what the account now holds.
   */
  it('re-reads the profile on an empty settings message', async () => {
    const { socket, assigned } = await landed(ALICE);
    identity.store.set(assigned.channelId, {
      ...identity.store.get(assigned.channelId)!,
      displayName: 'Saved In Account',
      category: 'news',
      updatedAt: Date.now() + 1,
    });

    socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, {});
    const confirmed = await new Promise<ChannelAssignedPayload>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });

    expect(identity.invalidated).toContain(assigned.channelId);
    expect(confirmed.profile).toMatchObject({ displayName: 'Saved In Account', category: 'news' });
    expect(confirmed.category).toBe('news');
    expect((await directoryRow(assigned.channelId))?.displayName).toBe('Saved In Account');
  });

  it('names the programme on air in the directory, and only while it is on', async () => {
    const { socket, assigned } = await landed(ALICE);
    socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      ...programmeConfig('wrs_titled', 'broadcast_titled'),
      programmeTitle: '  Sunday   Service ',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const row = await directoryRow(assigned.channelId);
    expect(row?.live).toBe(true);
    expect(row?.currentProgramme).toBe('Sunday Service');
  });

  it('refuses a stranger the channel the profile names as somebody else\'s', async () => {
    const alice = await landed(ALICE);
    const bob = await landed(BOB);
    const errors: { message: string }[] = [];
    bob.socket.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));

    bob.socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: alice.assigned.channelId });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(errors[0]?.message).toContain('another account');
  });
});
