import { describe, expect, it } from 'vitest';
import {
  WEBRTC_SIGNALLING_LIMITS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
} from '@videofy-live/shared-types';
import {
  safeParseWebRtcSignallingEnvelope,
  isUnsupportedWebRtcProtocolVersion,
} from '../webrtc-signalling-schema.js';

const now = '2026-07-27T00:00:00.000Z';

function base(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session-create',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_create_001',
    broadcastId: 'broadcast_demo',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 0,
    createdAt: now,
    payload: {},
    ...overrides,
  };
}

describe('WebRTC signalling contracts', () => {
  it('parses valid session creation, join, SDP, ICE and heartbeat envelopes', () => {
    const valid = [
      base(),
      base({
        type: 'session-join',
        messageId: 'msg_join_001',
        sessionId: 'wrs_session_001',
        peerId: 'peer_listener',
        senderRole: 'listener',
        payload: { requestedRole: 'listener' },
      }),
      base({
        type: 'sdp-offer',
        messageId: 'msg_offer_001',
        sessionId: 'wrs_session_001',
        revision: 1,
        payload: { targetPeerId: 'peer_server', sdp: 'opaque-offer-sdp' },
      }),
      base({
        type: 'sdp-answer',
        messageId: 'msg_answer_001',
        sessionId: 'wrs_session_001',
        peerId: 'peer_server',
        senderRole: 'server',
        revision: 1,
        payload: { targetPeerId: 'peer_broadcaster', sdp: 'opaque-answer-sdp' },
      }),
      base({
        type: 'ice-candidate',
        messageId: 'msg_ice_001',
        sessionId: 'wrs_session_001',
        revision: 1,
        payload: {
          targetPeerId: 'peer_server',
          candidate: 'opaque-ice-candidate',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: 'ufrag',
        },
      }),
      base({
        type: 'heartbeat-ack',
        messageId: 'msg_heartbeat_001',
        sessionId: 'wrs_session_001',
        revision: 1,
        payload: { observedAt: now },
      }),
    ];

    for (const envelope of valid) {
      expect(safeParseWebRtcSignallingEnvelope(envelope).success).toBe(true);
    }
  });

  it('rejects unsupported protocol versions explicitly', () => {
    const envelope = base({ protocolVersion: 2 });

    expect(isUnsupportedWebRtcProtocolVersion(envelope)).toBe(true);
    expect(safeParseWebRtcSignallingEnvelope(envelope).success).toBe(false);
  });

  it('rejects missing or weak identifiers and malformed roles', () => {
    expect(safeParseWebRtcSignallingEnvelope(base({ messageId: 'x' })).success).toBe(false);
    expect(safeParseWebRtcSignallingEnvelope(base({ broadcastId: '../room' })).success).toBe(false);
    expect(safeParseWebRtcSignallingEnvelope(base({ senderRole: 'operator' })).success).toBe(false);
  });

  it('rejects empty and oversized SDP payloads', () => {
    const offer = base({
      type: 'sdp-offer',
      messageId: 'msg_offer_002',
      sessionId: 'wrs_session_001',
      revision: 1,
      payload: { targetPeerId: 'peer_server', sdp: '' },
    });
    expect(safeParseWebRtcSignallingEnvelope(offer).success).toBe(false);

    expect(
      safeParseWebRtcSignallingEnvelope({
        ...offer,
        payload: { targetPeerId: 'peer_server', sdp: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength + 1) },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed and oversized ICE candidates', () => {
    const ice = base({
      type: 'ice-candidate',
      messageId: 'msg_ice_002',
      sessionId: 'wrs_session_001',
      revision: 1,
      payload: { targetPeerId: 'peer_server', candidate: '' },
    });
    expect(safeParseWebRtcSignallingEnvelope(ice).success).toBe(false);

    expect(
      safeParseWebRtcSignallingEnvelope({
        ...ice,
        payload: {
          targetPeerId: 'peer_server',
          candidate: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.iceCandidateMaxLength + 1),
        },
      }).success,
    ).toBe(false);
  });
});
