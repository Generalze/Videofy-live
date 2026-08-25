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
import type { ChannelSummary, MediaStateEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';
import { createApp } from '../app.js';
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

  /** An operator who has moved to their own channel, and the id they were given. */
  async function operatorOnOwnChannel(accountId: string): Promise<{
    socket: Socket;
    channelId: string;
  }> {
    const socket = connect('operator', accountId);
    const assigned = await new Promise<{ channelId: string; active: string }>((resolve) => {
      socket.on(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    /* The gateway offers the channel; it does not move the operator to it. */
    expect(assigned.active).toBe('main');

    socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'own' });
    const moved = await new Promise<{ active: string }>((resolve) => {
      socket.on(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    expect(moved.active).toBe(assigned.channelId);
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
   * BACK COMPATIBILITY, which is the reason moving channel is opt-in. A client
   * that has never heard of channels must keep working unchanged.
   */
  it('serves a listener that never mentions a channel', async () => {
    const operator = connect('operator', ALICE);
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

  it('lists a claimed channel in the directory a listener is given', async () => {
    const alice = await operatorOnOwnChannel(ALICE);
    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });

    expect(directory.map((channel) => channel.channelId)).toContain(alice.channelId);
  });
});

describe('a private programme', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173'], {
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
    const assigned = await new Promise<{ channelId: string }>((resolve) => {
      socket.on(SOCKET_EVENTS.CHANNEL_ASSIGNED, resolve);
    });
    socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'own' });
    await new Promise<void>((resolve) => {
      socket.once(SOCKET_EVENTS.CHANNEL_ASSIGNED, () => resolve());
    });
    socket.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, {
      displayName: 'Invitation Only',
      visibility: 'private',
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
    expect(errors[0]?.message).toContain('private');
  });

  it('refuses a listener with the wrong code', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const errors: { message: string }[] = [];
    listener.on(SOCKET_EVENTS.ERROR, (error: { message: string }) => errors.push(error));

    listener.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: channel.channelId, code: 'guessing' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors[0]?.message).toContain('private');
  });

  /*
   * THE LEAK THIS CLOSES. Translation events went to the bare language room --
   * every listener of that language across every channel -- so a private
   * programme’s source text reached viewers who never had the code.
   */
  it('does not send a private programme’s phrases to another channel', async () => {
    const channel = await privateChannel('let-me-in-please');
    /* Bind the session to the private channel, exactly as running it does. */
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

  it('keeps a private channel out of the public directory', async () => {
    const channel = await privateChannel('let-me-in-please');
    const listener = connect('listener');
    const directory = await new Promise<readonly ChannelSummary[]>((resolve) => {
      listener.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, resolve);
    });
    expect(directory.map((entry) => entry.channelId)).not.toContain(channel.channelId);
  });
});
