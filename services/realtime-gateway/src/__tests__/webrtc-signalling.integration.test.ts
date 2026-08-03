import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import * as wrtc from '@roamhq/wrtc';
import type {
  MediaStateEvent,
  WebRtcIncomingSignallingEnvelope,
  WebRtcOutgoingSignallingEnvelope,
  WebRtcSignallingErrorEnvelope,
} from '@videofy-live/shared-types';
import {
  SOCKET_EVENTS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WebRtcSignallingClient,
} from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { Gateway } from '../gateway.js';

const now = '2026-07-27T00:00:00.000Z';
type IncomingMessageType = WebRtcIncomingSignallingEnvelope['type'];
type IncomingEnvelopeOf<TType extends IncomingMessageType> = Extract<
  WebRtcIncomingSignallingEnvelope,
  { type: TType }
>;
interface TestIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
interface TestPeerIceEvent {
  candidate: TestIceCandidateInit | null;
}

function message<TType extends IncomingMessageType>(
  type: TType,
  overrides: Partial<IncomingEnvelopeOf<TType>> = {},
): IncomingEnvelopeOf<TType> {
  const base = {
    type,
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: `msg_${type.replace(/-/g, '_')}_${Math.random().toString(16).slice(2)}`,
    broadcastId: 'broadcast_demo',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 0,
    createdAt: now,
    payload: {},
  };
  const sessionFields = type === 'session-create' ? {} : { sessionId: 'wrs_demo' };
  return {
    ...base,
    ...sessionFields,
    ...overrides,
  } as IncomingEnvelopeOf<TType>;
}

function mediaState(): MediaStateEvent {
  return {
    eventId: 'integration-event',
    streamStatus: 'processing',
    videoSource: 'mock',
    videoTimestampMs: 1000,
    sourceAudioActive: true,
    translatedLanguages: ['fr'],
    connectedListeners: 0,
    createdAt: now,
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

function waitForMatchingEvent<T>(
  socket: Socket,
  eventName: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 1000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(eventName, listener);
      resolve(payload);
    };
    socket.on(eventName, listener);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(10);
  }
}

describe('gateway WebRTC signalling integration', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];
  let gateway: Gateway;

  beforeEach(async () => {
    server = createServer(createApp());
    gateway = new Gateway(server, ['http://localhost:5173', 'http://localhost:5174']);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(role: string): Socket {
    const socket = connectClient(baseUrl, {
      query: { role },
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    return socket;
  }

  async function createSession(broadcaster = client('broadcaster')): Promise<{
    broadcaster: Socket;
    created: WebRtcOutgoingSignallingEnvelope;
  }> {
    await waitForConnect(broadcaster);
    const createdEvent = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_CREATE,
      message('session-create', {
        messageId: 'msg_create_001',
        payload: { requestedSessionId: 'wrs_demo' },
      }),
    );
    const created = await createdEvent;
    return { broadcaster, created };
  }

  it('creates a session and lets a listener join the correct signalling room', async () => {
    const { broadcaster, created } = await createSession();
    expect(created).toMatchObject({
      type: 'session-created',
      sessionId: 'wrs_demo',
      payload: { sessionState: 'waiting', peerState: 'joined' },
    });

    const listener = client('listener');
    await waitForConnect(listener);
    const broadcasterJoin = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    const listenerJoin = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      listener,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );

    listener.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_join_listener',
        peerId: 'peer_listener',
        senderRole: 'listener',
        payload: { requestedRole: 'listener' },
      }),
    );

    await expect(listenerJoin).resolves.toMatchObject({
      type: 'session-joined',
      peerId: 'peer_listener',
    });
    await expect(broadcasterJoin).resolves.toMatchObject({
      type: 'session-joined',
      peerId: 'peer_listener',
    });
  });

  it('orchestrates broadcaster and listener lifecycle through typed signalling clients', async () => {
    const broadcasterSocket = client('broadcaster');
    const listenerSocket = client('listener');
    await Promise.all([waitForConnect(broadcasterSocket), waitForConnect(listenerSocket)]);

    const broadcasterStates: string[] = [];
    const listenerStates: string[] = [];
    const broadcasterClient = new WebRtcSignallingClient({
      role: 'broadcaster',
      broadcastId: 'broadcast_demo',
      peerId: 'peer_broadcaster',
      onStateChange: (snapshot) => broadcasterStates.push(snapshot.state),
    });
    const listenerClient = new WebRtcSignallingClient({
      role: 'listener',
      peerId: 'peer_listener',
      onStateChange: (snapshot) => listenerStates.push(snapshot.state),
    });
    broadcasterClient.attach(broadcasterSocket);
    listenerClient.attach(listenerSocket);

    const created = await broadcasterClient.createSession('wrs_client_demo');
    expect(created).toMatchObject({
      state: 'joined',
      sessionId: 'wrs_client_demo',
      shareableSessionId: 'broadcast_demo/wrs_client_demo',
      mediaTransportStarted: false,
    });

    const joined = await listenerClient.joinSession({
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_client_demo',
    });
    expect(joined).toMatchObject({
      state: 'joined',
      sessionId: 'wrs_client_demo',
      listenerCount: 1,
      mediaTransportStarted: false,
    });
    await waitUntil(() => broadcasterClient.getSnapshot().listenerCount === 1);
    expect(broadcasterStates).toEqual(expect.arrayContaining(['creating-session', 'joined']));
    expect(listenerStates).toEqual(expect.arrayContaining(['joining-session', 'joined']));

    await broadcasterClient.closeSession('operator closed signalling');
    await waitUntil(() => listenerClient.getSnapshot().state === 'closed');
    expect(listenerClient.getSnapshot()).toMatchObject({
      state: 'closed',
      mediaTransportStarted: false,
    });

    broadcasterClient.dispose();
    listenerClient.dispose();
  });

  it('routes offer, answer and ICE only to the intended peer', async () => {
    const { broadcaster } = await createSession();
    const serverPeer = client('server');
    const unrelated = client('listener');
    await Promise.all([waitForConnect(serverPeer), waitForConnect(unrelated)]);

    serverPeer.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_join_server',
        peerId: 'peer_server',
        senderRole: 'server',
        payload: { requestedRole: 'server' },
      }),
    );
    await waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      serverPeer,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );

    const unrelatedEvents: WebRtcOutgoingSignallingEnvelope[] = [];
    unrelated.on(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, (event: WebRtcOutgoingSignallingEnvelope) => {
      unrelatedEvents.push(event);
    });

    const offerReceived = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      serverPeer,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-offer', {
        messageId: 'msg_offer_001',
        revision: 1,
        payload: { targetPeerId: 'peer_server', sdp: 'opaque-offer-sdp' },
      }),
    );
    await expect(offerReceived).resolves.toMatchObject({
      type: 'sdp-offer',
      payload: { targetPeerId: 'peer_server' },
    });

    const answerReceived = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    serverPeer.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-answer', {
        messageId: 'msg_answer_001',
        peerId: 'peer_server',
        senderRole: 'server',
        revision: 1,
        payload: { targetPeerId: 'peer_broadcaster', sdp: 'opaque-answer-sdp' },
      }),
    );
    await expect(answerReceived).resolves.toMatchObject({ type: 'sdp-answer' });

    const iceReceived = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      serverPeer,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('ice-candidate', {
        messageId: 'msg_ice_001',
        revision: 1,
        payload: { targetPeerId: 'peer_server', candidate: 'opaque-ice-candidate' },
      }),
    );
    await expect(iceReceived).resolves.toMatchObject({ type: 'ice-candidate' });

    await delay(50);
    expect(unrelatedEvents).toHaveLength(0);
  });

  it('rejects listener impersonation, unknown sessions, stale revisions and duplicate messages', async () => {
    const { broadcaster } = await createSession();
    const listener = client('listener');
    const serverPeer = client('server');
    await Promise.all([waitForConnect(listener), waitForConnect(serverPeer)]);
    serverPeer.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_join_server_for_errors',
        peerId: 'peer_server',
        senderRole: 'server',
        payload: { requestedRole: 'server' },
      }),
    );
    await waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      serverPeer,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );

    const errors: WebRtcSignallingErrorEnvelope[] = [];
    listener.on(SOCKET_EVENTS.WEBRTC_ERROR, (event: WebRtcSignallingErrorEnvelope) => {
      errors.push(event);
    });
    broadcaster.on(SOCKET_EVENTS.WEBRTC_ERROR, (event: WebRtcSignallingErrorEnvelope) => {
      errors.push(event);
    });

    listener.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_CREATE,
      message('session-create', {
        messageId: 'msg_bad_create',
        peerId: 'peer_listener',
        senderRole: 'broadcaster',
        payload: {},
      }),
    );
    listener.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_unknown_session',
        sessionId: 'wrs_missing',
        peerId: 'peer_listener',
        senderRole: 'listener',
        payload: { requestedRole: 'listener' },
      }),
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-offer', {
        messageId: 'msg_stale_offer',
        revision: 0,
        payload: { targetPeerId: 'peer_server', sdp: 'opaque-stale-sdp' },
      }),
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-offer', {
        messageId: 'msg_stale_offer',
        revision: 0,
        payload: { targetPeerId: 'peer_server', sdp: 'opaque-stale-sdp' },
      }),
    );

    await waitUntil(() => errors.length >= 4);
    expect(errors.map((event) => event.payload.code)).toEqual(
      expect.arrayContaining([
        'forbidden-role',
        'session-not-found',
        'stale-negotiation',
        'duplicate-message',
      ]),
    );
  });

  it('rejects a second active broadcaster for the same broadcast', async () => {
    await createSession();
    const second = client('broadcaster');
    await waitForConnect(second);
    const error = waitForEvent<WebRtcSignallingErrorEnvelope>(
      second,
      SOCKET_EVENTS.WEBRTC_ERROR,
    );
    second.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_CREATE,
      message('session-create', {
        messageId: 'msg_create_second',
        peerId: 'peer_broadcaster_2',
        payload: { requestedSessionId: 'wrs_second' },
      }),
    );

    await expect(error).resolves.toMatchObject({
      type: 'signalling-error',
      payload: { code: 'duplicate-broadcaster' },
    });
  });

  it('cleans up ownership on disconnect and rejects signalling after session close', async () => {
    const { broadcaster } = await createSession();
    const listener = client('listener');
    await waitForConnect(listener);
    listener.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_join_listener_close',
        peerId: 'peer_listener',
        senderRole: 'listener',
        payload: { requestedRole: 'listener' },
      }),
    );
    await waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      listener,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );

    const closeSeenByListener = waitForEvent<WebRtcOutgoingSignallingEnvelope>(
      listener,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_CLOSE,
      message('session-close', {
        messageId: 'msg_close_001',
        payload: { reason: 'operator ended signalling' },
      }),
    );
    await expect(closeSeenByListener).resolves.toMatchObject({ type: 'session-close' });

    const error = waitForEvent<WebRtcSignallingErrorEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_ERROR,
    );
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('ice-candidate', {
        messageId: 'msg_after_close',
        revision: 0,
        payload: { targetPeerId: 'peer_listener', candidate: 'opaque-late-ice' },
      }),
    );
    await expect(error).resolves.toMatchObject({ payload: { code: 'session-closed' } });
  });

  it('preserves existing media-state traffic while WebRTC routes are present', async () => {
    const ingest = client('ingest');
    const listener = client('listener');
    await Promise.all([waitForConnect(ingest), waitForConnect(listener)]);

    const media = waitForEvent<MediaStateEvent>(listener, SOCKET_EVENTS.MEDIA_STATE);
    ingest.emit(SOCKET_EVENTS.INGEST_STATE, mediaState());

    await expect(media).resolves.toMatchObject({
      eventId: 'integration-event',
      streamStatus: 'processing',
      connectedListeners: 1,
    });
  });

  it('rejects oversized signalling payloads and bounded rate bursts', async () => {
    const broadcaster = client('broadcaster');
    await waitForConnect(broadcaster);

    const errors: WebRtcSignallingErrorEnvelope[] = [];
    broadcaster.on(SOCKET_EVENTS.WEBRTC_ERROR, (event: WebRtcSignallingErrorEnvelope) => {
      errors.push(event);
    });
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_CREATE,
      message('session-create', {
        messageId: 'msg_oversized_payload',
        payload: { requestedSessionId: `wrs_${'x'.repeat(140_000)}` },
      }),
    );
    await waitUntil(() => errors.some((event) => event.payload.code === 'payload-too-large'));

    for (let index = 0; index <= 125; index++) {
      broadcaster.emit(
        SOCKET_EVENTS.WEBRTC_SESSION_CREATE,
        message('session-create', {
          messageId: `msg_rate_${index}`,
          payload: { requestedSessionId: `wrs_rate_${index}` },
        }),
      );
    }

    await waitUntil(() =>
      errors.some((event) => event.payload.message.includes('rate limit')),
    );
    expect(errors.map((event) => event.payload.code)).toEqual(
      expect.arrayContaining(['payload-too-large', 'invalid-state-transition']),
    );
  });

  it('exposes safe aggregate WebRTC diagnostics without signalling payloads', async () => {
    expect(gateway.getWebRtcDiagnostics()).toMatchObject({
      clientCount: 0,
      activeSignallingSessions: 0,
      broadcasterPeerCount: 0,
      listenerPeerCount: 0,
      transcriptionBridgeSessionCount: 0,
    });
    await createSession();
    expect(gateway.getWebRtcDiagnostics()).toMatchObject({
      activeSignallingSessions: 1,
      broadcasterPeerCount: 0,
      listenerPeerCount: 0,
    });
  });

  it('terminates broadcaster audio at the backend and emits audio activity evidence', async () => {
    const { broadcaster } = await createSession();
    const peer = new wrtc.RTCPeerConnection({ iceServers: [] });
    const source = new wrtc.nonstandard.RTCAudioSource();
    const track = source.createTrack();
    peer.addTrack(track);

    const remoteCandidates: TestIceCandidateInit[] = [];
    peer.onicecandidate = (event: TestPeerIceEvent) => {
      if (!event.candidate) return;
      if (!event.candidate.candidate.trim()) return;
      broadcaster.emit(
        SOCKET_EVENTS.WEBRTC_SIGNAL,
        message('ice-candidate', {
          messageId: `msg_browser_ice_${Math.random().toString(16).slice(2)}`,
          revision: 1,
          payload: {
            targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
            candidate: event.candidate.candidate,
            sdpMid: nonEmptyStringOrNull(event.candidate.sdpMid ?? null),
            sdpMLineIndex: validSdpMLineIndexOrNull(event.candidate.sdpMLineIndex ?? null),
            usernameFragment: nonEmptyStringOrNull(event.candidate.usernameFragment ?? null),
          },
        }),
      );
    };

    broadcaster.on(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, (event: WebRtcOutgoingSignallingEnvelope) => {
      if (event.type === 'ice-candidate') {
        const candidate: TestIceCandidateInit = {
          candidate: event.payload.candidate,
          sdpMid: event.payload.sdpMid ?? null,
          sdpMLineIndex: event.payload.sdpMLineIndex ?? null,
        };
        if (event.payload.usernameFragment !== undefined) {
          candidate.usernameFragment = event.payload.usernameFragment;
        }
        remoteCandidates.push(candidate);
      }
    });

    const readyEvent = waitForMatchingEvent<WebRtcOutgoingSignallingEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      (event) => event.type === 'peer-ready',
      8_000,
    );
    const answerEvent = waitForMatchingEvent<WebRtcOutgoingSignallingEnvelope>(
      broadcaster,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      (event) => event.type === 'sdp-answer',
      8_000,
    );
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-offer', {
        messageId: 'msg_backend_media_offer',
        revision: 1,
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          sdp: peer.localDescription?.sdp ?? offer.sdp ?? '',
        },
      }),
    );

    const answer = await answerEvent;
    expect(answer).toMatchObject({
      type: 'sdp-answer',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      payload: { targetPeerId: 'peer_broadcaster' },
    });
    if (answer.type !== 'sdp-answer') throw new Error('Expected backend SDP answer');
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.payload.sdp });
    for (const candidate of remoteCandidates) {
      await peer.addIceCandidate(candidate);
    }

    let ready = false;
    const boundedReadyEvent = readyEvent.then((event) => {
      ready = true;
      return event;
    });

    const startedAt = Date.now();
    while (!ready && Date.now() - startedAt < 8_000) {
      source.onData({
        samples: new Int16Array(480).fill(1000),
        sampleRate: 48000,
        channelCount: 1,
        bitsPerSample: 16,
        numberOfFrames: 480,
      });
      await Promise.race([delay(20), boundedReadyEvent.then(() => undefined)]);
    }

    await expect(boundedReadyEvent).resolves.toMatchObject({
      type: 'peer-ready',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
    });
    peer.onicecandidate = null;
    track.stop();
    peer.close();
  }, 10_000);

  it('offers backend programme media to joined listeners as soon as broadcaster tracks arrive', async () => {
    const { broadcaster } = await createSession();
    const listener = client('listener');
    await waitForConnect(listener);
    listener.emit(
      SOCKET_EVENTS.WEBRTC_SESSION_JOIN,
      message('session-join', {
        messageId: 'msg_join_listener_delivery',
        peerId: 'peer_listener',
        senderRole: 'listener',
        payload: { requestedRole: 'listener' },
      }),
    );
    await waitForMatchingEvent<WebRtcOutgoingSignallingEnvelope>(
      listener,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      (event) => event.type === 'session-joined',
    );

    const listenerOffer = waitForMatchingEvent<WebRtcOutgoingSignallingEnvelope>(
      listener,
      SOCKET_EVENTS.WEBRTC_SESSION_EVENT,
      (event) =>
        event.type === 'sdp-offer' &&
        event.peerId === WEBRTC_BACKEND_MEDIA_PEER_ID &&
        event.payload.targetPeerId === 'peer_listener',
      8_000,
    );
    const broadcasterPeer = new wrtc.RTCPeerConnection({ iceServers: [] });
    const source = new wrtc.nonstandard.RTCAudioSource();
    const track = source.createTrack();
    broadcasterPeer.addTrack(track);

    broadcasterPeer.onicecandidate = (event: TestPeerIceEvent) => {
      if (!event.candidate?.candidate.trim()) return;
      broadcaster.emit(
        SOCKET_EVENTS.WEBRTC_SIGNAL,
        message('ice-candidate', {
          messageId: `msg_listener_delivery_ice_${Math.random().toString(16).slice(2)}`,
          revision: 1,
          payload: {
            targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
            candidate: event.candidate.candidate,
            sdpMid: nonEmptyStringOrNull(event.candidate.sdpMid ?? null),
            sdpMLineIndex: validSdpMLineIndexOrNull(event.candidate.sdpMLineIndex ?? null),
            usernameFragment: nonEmptyStringOrNull(event.candidate.usernameFragment ?? null),
          },
        }),
      );
    };
    broadcaster.on(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, (event: WebRtcOutgoingSignallingEnvelope) => {
      if (event.type === 'sdp-answer') {
        void broadcasterPeer
          .setRemoteDescription({ type: 'answer', sdp: event.payload.sdp })
          .catch(() => undefined);
      }
      if (event.type === 'ice-candidate') {
        void broadcasterPeer
          .addIceCandidate({
            candidate: event.payload.candidate,
            sdpMid: event.payload.sdpMid ?? null,
            sdpMLineIndex: event.payload.sdpMLineIndex ?? null,
          })
          .catch(() => undefined);
      }
    });

    const offer = await broadcasterPeer.createOffer();
    await broadcasterPeer.setLocalDescription(offer);
    broadcaster.emit(
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      message('sdp-offer', {
        messageId: 'msg_listener_delivery_backend_offer',
        revision: 1,
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          sdp: broadcasterPeer.localDescription?.sdp ?? offer.sdp ?? '',
        },
      }),
    );

    await expect(listenerOffer).resolves.toMatchObject({
      type: 'sdp-offer',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      payload: { targetPeerId: 'peer_listener' },
    });
    broadcasterPeer.onicecandidate = null;
    track.stop();
    broadcasterPeer.close();
  }, 10_000);
});

function nonEmptyStringOrNull(input: string | null): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed ? input : null;
}

function validSdpMLineIndexOrNull(input: number | null): number | null {
  if (input === null) return null;
  return Number.isInteger(input) && input >= 0 && input <= 128 ? input : null;
}
