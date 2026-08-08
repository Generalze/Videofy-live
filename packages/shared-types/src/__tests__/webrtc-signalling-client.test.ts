import { describe, expect, it, vi } from 'vitest';
import { SOCKET_EVENTS } from '../socket-events.js';
import { WEBRTC_SIGNALLING_PROTOCOL_VERSION } from '../webrtc-signalling.js';
import type {
  WebRtcOutgoingSignallingEnvelope,
  WebRtcSessionCreatedEnvelope,
  WebRtcSessionJoinedEnvelope,
  WebRtcSignallingErrorEnvelope,
} from '../webrtc-signalling.js';
import {
  createShareableWebRtcSessionId,
  parseShareableWebRtcSessionId,
  WebRtcSignallingClient,
  type WebRtcSignallingTransport,
} from '../webrtc-signalling-client.js';

class MockTransport implements WebRtcSignallingTransport {
  connected = false;
  emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  serverEmit(event: string, payload?: unknown): void {
    if (event === SOCKET_EVENTS.CONNECTED) this.connected = true;
    if (event === SOCKET_EVENTS.DISCONNECTED) this.connected = false;
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function ids(): () => string {
  let index = 0;
  return () => `id_${++index}`;
}

function createAck(
  request: Record<string, unknown>,
  overrides: Partial<WebRtcSessionCreatedEnvelope> = {},
): WebRtcSessionCreatedEnvelope {
  return {
    type: 'session-created',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_created',
    correlationId: request['correlationId'] as string,
    broadcastId: request['broadcastId'] as string,
    sessionId: 'wrs_demo',
    peerId: request['peerId'] as string,
    senderRole: 'server',
    revision: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { sessionState: 'waiting', peerState: 'joined' },
    ...overrides,
  };
}

function joinAck(
  request: Record<string, unknown>,
  overrides: Partial<WebRtcSessionJoinedEnvelope> = {},
): WebRtcSessionJoinedEnvelope {
  return {
    type: 'session-joined',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_joined',
    correlationId: request['correlationId'] as string,
    broadcastId: request['broadcastId'] as string,
    sessionId: request['sessionId'] as string,
    peerId: request['peerId'] as string,
    senderRole: 'server',
    revision: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: {
      sessionState: 'waiting',
      peerState: 'joined',
      peers: [
        { peerId: 'peer_broadcaster', role: 'broadcaster', state: 'joined', revision: 0 },
        { peerId: request['peerId'] as string, role: 'listener', state: 'joined', revision: 0 },
      ],
    },
    ...overrides,
  };
}

function signallingError(
  request: Record<string, unknown>,
  code = 'duplicate-broadcaster',
): WebRtcSignallingErrorEnvelope {
  return {
    type: 'signalling-error',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_error',
    correlationId: request['correlationId'] as string,
    broadcastId: request['broadcastId'] as string,
    peerId: request['peerId'] as string,
    senderRole: 'server',
    revision: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: {
      code: code as WebRtcSignallingErrorEnvelope['payload']['code'],
      message: 'Rejected by gateway.',
      retryable: false,
    },
  };
}

describe('WebRtcSignallingClient', () => {
  it('starts idle and parses shareable session identifiers', () => {
    const client = new WebRtcSignallingClient({ role: 'broadcaster', createId: ids() });
    expect(client.getSnapshot()).toMatchObject({
      state: 'idle',
      role: 'broadcaster',
      connected: false,
      mediaTransportStarted: false,
    });
    expect(createShareableWebRtcSessionId('broadcast_demo', 'wrs_demo')).toBe(
      'broadcast_demo/wrs_demo',
    );
    expect(parseShareableWebRtcSessionId('broadcast_demo:wrs_demo')).toEqual({
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
    });
  });

  it('tracks socket connection and creates a broadcaster session with correlated acknowledgement', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const created = client.createSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    expect(transport.emitted[0]!.event).toBe(SOCKET_EVENTS.WEBRTC_SESSION_CREATE);
    expect(request).toMatchObject({
      type: 'session-create',
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      senderRole: 'broadcaster',
      revision: 0,
      payload: {},
    });

    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, createAck(request));
    await expect(created).resolves.toMatchObject({
      state: 'joined',
      sessionId: 'wrs_demo',
      shareableSessionId: 'broadcast_demo/wrs_demo',
    });
  });

  it('creates a new broadcaster session after the previous session closes', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const firstCreated = client.createSession();
    const firstRequest = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      createAck(firstRequest, { revision: 4 }),
    );
    await firstCreated;

    const closed = client.closeSession('programme completed');
    const closeRequest = transport.emitted[1]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, {
      ...closeRequest,
      messageId: 'msg_closed',
      senderRole: 'server',
    });
    await expect(closed).resolves.toMatchObject({ state: 'closed', sessionId: 'wrs_demo' });

    const secondCreated = client.createSession();
    const secondRequest = transport.emitted[2]!.payload as Record<string, unknown>;
    transport.serverEmit(
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      createAck(secondRequest, {
        messageId: 'msg_created_again',
        sessionId: 'wrs_next',
        revision: 0,
      }),
    );

    await expect(secondCreated).resolves.toMatchObject({
      state: 'joined',
      sessionId: 'wrs_next',
      revision: 0,
    });
  });

  it('joins a listener session and rejects duplicate joins', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'listener',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: 'peer_listener',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const joined = client.joinSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    await expect(client.joinSession()).rejects.toMatchObject({ code: 'duplicate-peer' });
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, joinAck(request));
    await expect(joined).resolves.toMatchObject({
      state: 'joined',
      listenerCount: 1,
    });
  });

  it('times out acknowledgements and rejects correlation mismatches', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      ackTimeoutMs: 25,
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const created = client.createSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, {
      ...createAck(request),
      correlationId: 'corr_wrong',
    });
    const expectedTimeout = expect(created).rejects.toMatchObject({
      code: 'acknowledgement-timeout',
    });
    await vi.advanceTimersByTimeAsync(25);
    await expectedTimeout;
    vi.useRealTimers();
  });

  it('rejects malformed and unsupported acknowledgements', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, { type: 'session-created' });
    expect(client.getSnapshot().lastError).toMatchObject({ code: 'malformed-acknowledgement' });
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, {
      type: 'session-created',
      protocolVersion: 99,
      messageId: 'msg_bad_version',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      revision: 0,
      payload: {},
    });
    expect(client.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: { code: 'unsupported-protocol-version' },
    });
  });

  it('ignores unrelated and duplicate lifecycle events', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);
    const created = client.createSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, createAck(request));
    await created;

    const unrelated: WebRtcOutgoingSignallingEnvelope = {
      ...joinAck({ ...request, sessionId: 'wrs_other', peerId: 'peer_other' }),
      messageId: 'msg_unrelated',
      broadcastId: 'broadcast_other',
      sessionId: 'wrs_other',
    };
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, unrelated);
    expect(client.getSnapshot().listenerCount).toBe(0);

    const joined = joinAck({ ...request, sessionId: 'wrs_demo', peerId: 'peer_listener' });
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, joined);
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, joined);
    expect(client.getSnapshot().listenerCount).toBe(1);
  });

  it('marks disconnects as reconnecting and rejects stale pending acknowledgements', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);
    const created = client.createSession();
    transport.serverEmit(SOCKET_EVENTS.DISCONNECTED, 'transport close');
    await expect(created).rejects.toMatchObject({ code: 'gateway-unavailable' });
    expect(client.getSnapshot()).toMatchObject({ state: 'reconnecting', connected: false });
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);
    expect(client.getSnapshot()).toMatchObject({ state: 'reconnecting', connected: true });
  });

  it('recovers by explicitly creating a fresh broadcaster session', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const recovered = client.recoverSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, createAck(request));
    await expect(recovered).resolves.toMatchObject({ state: 'joined', sessionId: 'wrs_demo' });
  });

  it('uses bounded recovery attempts and reports exhausted reconnects', async () => {
    vi.useFakeTimers();
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'listener',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: 'peer_listener',
      ackTimeoutMs: 10,
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const recovered = client.recoverSessionWithBackoff({ maxAttempts: 2, initialDelayMs: 1 });
    const expectedRecovery = expect(recovered).rejects.toMatchObject({ code: 'reconnect-failed' });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);

    await expectedRecovery;
    expect(client.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: { code: 'reconnect-failed' },
    });
    expect(transport.emitted.filter((item) => item.event === SOCKET_EVENTS.WEBRTC_SESSION_JOIN)).toHaveLength(2);
    vi.useRealTimers();
  });

  it('leaves and closes idempotently', async () => {
    const transport = new MockTransport();
    const listener = new WebRtcSignallingClient({
      role: 'listener',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: 'peer_listener',
      createId: ids(),
    });
    listener.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);
    const left = listener.leaveSession();
    const leaveRequest = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, {
      type: 'peer-disconnect',
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId: 'msg_left',
      correlationId: leaveRequest['correlationId'] as string,
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: 'peer_listener',
      senderRole: 'listener',
      revision: 0,
      createdAt: '2026-07-27T00:00:00.000Z',
      payload: { reason: 'left' },
    });
    await expect(left).resolves.toMatchObject({ state: 'closed' });
    await expect(listener.leaveSession()).resolves.toMatchObject({ state: 'closed' });
  });

  it('maps gateway errors and disposes without removing unrelated socket listeners', async () => {
    const transport = new MockTransport();
    const unrelated = vi.fn();
    transport.on(SOCKET_EVENTS.MEDIA_STATE, unrelated);
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);
    const created = client.createSession();
    const request = transport.emitted[0]!.payload as Record<string, unknown>;
    transport.serverEmit(SOCKET_EVENTS.WEBRTC_ERROR, signallingError(request));
    await expect(created).rejects.toMatchObject({ code: 'duplicate-broadcaster' });

    client.dispose();
    expect(transport.listenerCount(SOCKET_EVENTS.MEDIA_STATE)).toBe(1);
    expect(transport.listenerCount(SOCKET_EVENTS.WEBRTC_SESSION_EVENT)).toBe(0);
  });

  it('emits backend-targeted peer disconnect over the signalling channel', async () => {
    const transport = new MockTransport();
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: 'peer_broadcaster',
      createId: ids(),
    });
    client.attach(transport);
    transport.serverEmit(SOCKET_EVENTS.CONNECTED);

    const envelope = client.sendPeerDisconnect({
      targetPeerId: 'peer_backend_media',
      reason: 'operator stopped backend audio transport',
      revision: 1,
    });

    expect(transport.emitted.at(-1)).toMatchObject({
      event: SOCKET_EVENTS.WEBRTC_SIGNAL,
      payload: {
        type: 'peer-disconnect',
        sessionId: 'wrs_demo',
        peerId: 'peer_broadcaster',
        senderRole: 'broadcaster',
        revision: 1,
        payload: {
          targetPeerId: 'peer_backend_media',
          reason: 'operator stopped backend audio transport',
        },
      },
    });
    expect(envelope.payload.targetPeerId).toBe('peer_backend_media');
  });
});
