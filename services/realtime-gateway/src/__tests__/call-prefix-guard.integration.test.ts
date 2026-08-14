/** @owner masterzee001 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import type {
  WebRtcOutgoingSignallingEnvelope,
  WebRtcSignallingErrorEnvelope,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS, WEBRTC_SIGNALLING_PROTOCOL_VERSION } from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { Gateway } from '../gateway.js';

/**
 * Review finding 8 (gateway half): programme/broadcaster signalling must never
 * be able to claim a `call_`-prefixed session id — those are reserved for the
 * native call runtime's media-ingest sessions.
 */

function sessionCreate(requestedSessionId: string): Record<string, unknown> {
  return {
    type: 'session-create',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: `msg_create_${Math.random().toString(16).slice(2)}`,
    broadcastId: 'broadcast_prefix_guard',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 0,
    createdAt: '2026-08-14T00:00:00.000Z',
    payload: { requestedSessionId },
  };
}

function waitForConnect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function waitForEvent<T>(socket: Socket, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(eventName, (payload: T) => resolve(payload));
  });
}

describe('gateway call_ session id reservation', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173']);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function broadcaster(): Socket {
    const socket = connectClient(baseUrl, {
      query: { role: 'broadcaster' },
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    return socket;
  }

  it.each(['call_hijack', 'CALL_hijack', 'Call_demo_participant_1_r1'])(
    'rejects a broadcaster session-create requesting the reserved id %s',
    async (requestedSessionId) => {
      const socket = broadcaster();
      await waitForConnect(socket);
      const errorEvent = waitForEvent<WebRtcSignallingErrorEnvelope>(
        socket,
        SOCKET_EVENTS.WEBRTC_ERROR,
      );
      socket.emit(SOCKET_EVENTS.WEBRTC_SESSION_CREATE, sessionCreate(requestedSessionId));
      const error = await errorEvent;
      expect(error.payload).toMatchObject({
        code: 'invalid-payload',
        message: 'WebRTC session ids beginning with "call_" are reserved for native call sessions.',
        retryable: false,
      });
    },
  );

  it('still creates programme sessions with ordinary ids', async () => {
    const socket = broadcaster();
    await waitForConnect(socket);
    const createdEvent = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      socket,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    socket.emit(SOCKET_EVENTS.WEBRTC_SESSION_CREATE, sessionCreate('wrs_callable_demo'));
    const created = await createdEvent;
    expect(created).toMatchObject({ type: 'session-created', sessionId: 'wrs_callable_demo' });
  });
});
