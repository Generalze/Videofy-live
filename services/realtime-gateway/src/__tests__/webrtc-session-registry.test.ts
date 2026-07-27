import { describe, expect, it } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIncomingSignallingEnvelope,
} from '@videofy-live/shared-types';
import { WebRtcSessionRegistry } from '../webrtc-session-registry.js';

const now = '2026-07-27T00:00:00.000Z';
type IncomingMessageType = WebRtcIncomingSignallingEnvelope['type'];
type IncomingEnvelopeOf<TType extends IncomingMessageType> = Extract<
  WebRtcIncomingSignallingEnvelope,
  { type: TType }
>;

function envelope<TType extends IncomingMessageType>(
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
  return { ...base, ...sessionFields, ...overrides } as IncomingEnvelopeOf<TType>;
}

function create(registry = new WebRtcSessionRegistry()) {
  const result = registry.createSession(
    'socket_broadcaster',
    envelope('session-create', {
      messageId: 'msg_create_001',
      payload: { requestedSessionId: 'wrs_demo' },
    }),
  );
  return { registry, result };
}

function joinListener(registry: WebRtcSessionRegistry, peerId = 'peer_listener') {
  return registry.joinSession(
    `socket_${peerId}`,
    envelope('session-join', {
      messageId: `msg_join_${peerId}`,
      peerId,
      senderRole: 'listener',
      payload: { requestedRole: 'listener' },
    }),
  );
}

function joinServer(registry: WebRtcSessionRegistry, peerId = 'peer_server') {
  return registry.joinSession(
    `socket_${peerId}`,
    envelope('session-join', {
      messageId: `msg_join_${peerId}`,
      peerId,
      senderRole: 'server',
      payload: { requestedRole: 'server' },
    }),
  );
}

describe('WebRtcSessionRegistry', () => {
  it('creates a session with one joined broadcaster and safe summary', () => {
    const { registry, result } = create();

    expect(result.outgoing).toMatchObject({
      type: 'session-created',
      sessionId: 'wrs_demo',
      senderRole: 'server',
      revision: 0,
      payload: { sessionState: 'waiting', peerState: 'joined' },
    });
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({
      sessionId: 'wrs_demo',
      broadcastId: 'broadcast_demo',
      state: 'waiting',
      peerCount: 1,
      peers: [{ peerId: 'peer_broadcaster', role: 'broadcaster', state: 'joined' }],
    });
  });

  it('rejects duplicate active broadcasters and duplicate requested session IDs', () => {
    const { registry } = create();

    expect(() =>
      registry.createSession(
        'socket_broadcaster_2',
        envelope('session-create', {
          messageId: 'msg_create_002',
          peerId: 'peer_broadcaster_2',
          payload: { requestedSessionId: 'wrs_other' },
        }),
      ),
    ).toThrow(/already active/);

    const other = new WebRtcSessionRegistry();
    create(other);
    expect(() =>
      other.createSession(
        'socket_broadcaster_3',
        envelope('session-create', {
          messageId: 'msg_create_003',
          broadcastId: 'broadcast_other',
          peerId: 'peer_broadcaster_3',
          payload: { requestedSessionId: 'wrs_demo' },
        }),
      ),
    ).toThrow(/already exists/);
  });

  it('registers listeners and rejects duplicate peer ownership', () => {
    const { registry } = create();
    const joined = joinListener(registry);
    expect(joined.outgoing).toMatchObject({
      type: 'session-joined',
      payload: { sessionState: 'waiting', peerState: 'joined' },
    });

    expect(() =>
      registry.joinSession(
        'socket_peer_listener_2',
        envelope('session-join', {
          messageId: 'msg_join_listener_duplicate',
          peerId: 'peer_listener',
          senderRole: 'listener',
          payload: { requestedRole: 'listener' },
        }),
      ),
    ).toThrow(/already owns/);
    expect(() =>
      registry.joinSession(
        'socket_other',
        envelope('session-join', {
          messageId: 'msg_join_dup_role',
          peerId: 'peer_other',
          senderRole: 'listener',
          payload: { requestedRole: 'broadcaster' },
        }),
      ),
    ).toThrow(/does not match/);
  });

  it('enforces offer, answer and ICE negotiation revisions', () => {
    const { registry } = create();
    joinServer(registry);

    const offer = envelope('sdp-offer', {
      messageId: 'msg_offer_001',
      revision: 1,
      payload: { targetPeerId: 'peer_server', sdp: 'opaque-offer-sdp' },
    });
    expect(registry.signal('socket_broadcaster', offer).targetSocketId).toBe('socket_peer_server');
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({
      state: 'negotiating',
      revision: 1,
    });

    expect(() =>
      registry.signal(
        'socket_broadcaster',
        envelope('sdp-offer', {
          messageId: 'msg_offer_stale',
          revision: 1,
          payload: { targetPeerId: 'peer_server', sdp: 'opaque-old-sdp' },
        }),
      ),
    ).toThrow(/one greater/);

    const answer = envelope('sdp-answer', {
      messageId: 'msg_answer_001',
      peerId: 'peer_server',
      senderRole: 'server',
      revision: 1,
      payload: { targetPeerId: 'peer_broadcaster', sdp: 'opaque-answer-sdp' },
    });
    expect(registry.signal('socket_peer_server', answer).targetSocketId).toBe(
      'socket_broadcaster',
    );
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({ state: 'ready' });

    expect(() =>
      registry.signal(
        'socket_peer_server',
        envelope('ice-candidate', {
          messageId: 'msg_ice_stale',
          peerId: 'peer_server',
          senderRole: 'server',
          revision: 0,
          payload: { targetPeerId: 'peer_broadcaster', candidate: 'opaque-old-ice' },
        }),
      ),
    ).toThrow(/stale/);
  });

  it('rejects unknown targets, unknown sessions and duplicate message IDs', () => {
    const { registry } = create();
    joinServer(registry);
    const offer = envelope('sdp-offer', {
      messageId: 'msg_offer_002',
      revision: 1,
      payload: { targetPeerId: 'peer_server', sdp: 'opaque-offer-sdp' },
    });
    registry.signal('socket_broadcaster', offer);

    expect(() => registry.signal('socket_broadcaster', offer)).toThrow(/Duplicate/);
    expect(() =>
      registry.signal(
        'socket_broadcaster',
        envelope('ice-candidate', {
          messageId: 'msg_ice_unknown',
          revision: 1,
          payload: { targetPeerId: 'peer_missing', candidate: 'opaque-missing-ice' },
        }),
      ),
    ).toThrow(/Target WebRTC peer not found/);
    expect(() =>
      registry.signal(
        'socket_broadcaster',
        envelope('ice-candidate', {
          messageId: 'msg_ice_no_session',
          sessionId: 'wrs_missing',
          revision: 1,
          payload: { targetPeerId: 'peer_server', candidate: 'opaque-server-ice' },
        }),
      ),
    ).toThrow(/not found/);
  });

  it('cleans listener disconnects without closing the broadcaster session', () => {
    const { registry } = create();
    joinListener(registry);

    const results = registry.cleanupSocket('socket_peer_listener');
    expect(results).toHaveLength(1);
    expect(results[0]!.outgoing.type).toBe('peer-disconnect');
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({
      state: 'waiting',
      peers: expect.arrayContaining([
        expect.objectContaining({ peerId: 'peer_listener', state: 'disconnected' }),
      ]),
    });
  });

  it('disconnects and rejoins the backend media peer without closing the broadcaster session', () => {
    const { registry } = create();
    registry.ensureBackendMediaPeer('wrs_demo', 'socket_backend_media');

    registry.disconnectBackendMediaPeer(
      'socket_broadcaster',
      envelope('peer-disconnect', {
        messageId: 'msg_disconnect_backend_media',
        revision: 0,
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          reason: 'operator stopped backend audio transport',
        },
      }),
    );
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({
      state: 'waiting',
      peers: expect.arrayContaining([
        expect.objectContaining({
          peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          state: 'disconnected',
        }),
      ]),
    });

    registry.ensureBackendMediaPeer('wrs_demo', 'socket_backend_media');
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({
      state: 'waiting',
      peers: expect.arrayContaining([
        expect.objectContaining({
          peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          state: 'joined',
        }),
      ]),
    });
  });

  it('allows a broadcaster source switch after backend listener delivery negotiation', () => {
    const { registry } = create();
    joinListener(registry);
    registry.ensureBackendMediaPeer('wrs_demo', 'socket_backend_media');

    registry.signal(
      'socket_broadcaster',
      envelope('sdp-offer', {
        messageId: 'msg_broadcaster_offer_uploaded',
        revision: 1,
        payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'uploaded-source-offer' },
      }),
    );
    registry.signal(
      'socket_backend_media',
      envelope('sdp-answer', {
        messageId: 'msg_backend_answer_uploaded',
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision: 1,
        payload: { targetPeerId: 'peer_broadcaster', sdp: 'uploaded-source-answer' },
      }),
    );

    registry.signal(
      'socket_backend_media',
      envelope('sdp-offer', {
        messageId: 'msg_listener_delivery_offer',
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision: 2,
        payload: { targetPeerId: 'peer_listener', sdp: 'listener-delivery-offer' },
      }),
    );
    registry.signal(
      'socket_peer_listener',
      envelope('sdp-answer', {
        messageId: 'msg_listener_delivery_answer',
        peerId: 'peer_listener',
        senderRole: 'listener',
        revision: 2,
        payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'listener-delivery-answer' },
      }),
    );
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({ revision: 1 });

    registry.disconnectBackendMediaPeer(
      'socket_broadcaster',
      envelope('peer-disconnect', {
        messageId: 'msg_disconnect_backend_after_uploaded',
        revision: 1,
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          reason: 'programme source switched to camera',
        },
      }),
    );
    registry.ensureBackendMediaPeer('wrs_demo', 'socket_backend_media');

    expect(() =>
      registry.signal(
        'socket_broadcaster',
        envelope('sdp-offer', {
          messageId: 'msg_broadcaster_offer_camera',
          revision: 2,
          payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'camera-source-offer' },
        }),
      ),
    ).not.toThrow();
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({ revision: 2 });
  });

  it('closes sessions idempotently on broadcaster disconnect or explicit close', () => {
    const { registry } = create();
    joinListener(registry);

    const close = envelope('session-close', {
      messageId: 'msg_close_001',
      payload: { reason: 'operator ended signalling' },
    });
    const first = registry.signal('socket_broadcaster', close);
    expect(first.outgoing.type).toBe('session-close');
    expect(registry.getSessionSummary('wrs_demo')).toMatchObject({ state: 'closed' });

    const cleanup = registry.cleanupSocket('socket_broadcaster');
    expect(cleanup).toEqual([]);
  });

  it('reports safe diagnostics and removes closed sessions from resource counts', () => {
    const { registry } = create();
    joinListener(registry);
    registry.ensureBackendMediaPeer('wrs_demo', 'socket_backend_media');

    expect(registry.getDiagnostics()).toMatchObject({
      activeSessionCount: 1,
      peerCount: 3,
      listenerPeerCount: 1,
      broadcasterPeerCount: 1,
      serverPeerCount: 1,
    });

    registry.signal(
      'socket_broadcaster',
      envelope('session-close', {
        messageId: 'msg_close_for_cleanup',
        payload: { reason: 'operator ended signalling' },
      }),
    );
    expect(registry.cleanupClosedSessions()).toBe(1);
    expect(registry.getDiagnostics()).toMatchObject({
      activeSessionCount: 0,
      totalSessionCount: 0,
      peerCount: 0,
    });
  });
});
