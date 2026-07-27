import { describe, expect, it, vi } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIceCandidateEnvelope,
  type WebRtcSdpAnswerEnvelope,
  type WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import type { WebRtcPeerRecord } from '../webrtc-session-registry.js';
import { BackendWebRtcListenerPeerRegistry } from '../webrtc-listener-peer-registry.js';
import type { WebRtcAudioDataLike } from '../webrtc-audio-ingest-bridge.js';

class FakePeer {
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp?: string } | null = null;
  remoteDescription: { sdp?: string } | null = null;
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'opaque-offer-sdp' }));
  setLocalDescription = vi.fn(async (offer: { sdp?: string }) => {
    this.localDescription = offer;
  });
  setRemoteDescription = vi.fn(async (answer: { sdp?: string }) => {
    this.remoteDescription = answer;
  });
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  emitLocalIce(candidate = 'opaque-backend-listener-ice') {
    this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } });
  }
}

class FakeAudioSource {
  readonly track = { stop: vi.fn() };
  readonly onData = vi.fn();
  createTrack = vi.fn(() => this.track);
}

function listener(): WebRtcPeerRecord {
  return {
    peerId: 'peer_listener',
    role: 'listener',
    socketId: 'socket_listener',
    state: 'joined',
    revision: 1,
    joinedAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function summary(revision = 1): WebRtcSessionSummary {
  return {
    sessionId: 'wrs_demo',
    broadcastId: 'broadcast_demo',
    state: 'ready',
    revision,
    broadcasterPeerId: 'peer_broadcaster',
    peerCount: 3,
    peers: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function answer(revision = 2): WebRtcSdpAnswerEnvelope {
  return {
    type: 'sdp-answer',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_answer',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: 'peer_listener',
    senderRole: 'listener',
    revision,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'opaque-answer-sdp' },
  };
}

function candidate(): WebRtcIceCandidateEnvelope {
  return {
    type: 'ice-candidate',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_ice',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: 'peer_listener',
    senderRole: 'listener',
    revision: 2,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: {
      targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      candidate: 'opaque-listener-ice',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  };
}

function frame(): WebRtcAudioDataLike {
  return {
    samples: new Int16Array([1, 2, 3]),
    sampleRate: 48000,
    channelCount: 1,
    bitsPerSample: 16,
    numberOfFrames: 3,
  };
}

describe('BackendWebRtcListenerPeerRegistry', () => {
  it('creates a backend offer with an outbound audio track and emits safe ICE', async () => {
    const peer = new FakePeer();
    const source = new FakeAudioSource();
    const signals: unknown[] = [];
    const registry = new BackendWebRtcListenerPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSource: () => source,
      onLocalSignal: (signal) => signals.push(signal),
    });

    const offer = await registry.createOffer(listener(), summary(), 2);
    peer.emitLocalIce();

    expect(source.createTrack).toHaveBeenCalledOnce();
    expect(peer.addTrack).toHaveBeenCalledWith(source.track);
    expect(offer).toMatchObject({
      type: 'sdp-offer',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      revision: 2,
      payload: { targetPeerId: 'peer_listener', sdp: 'opaque-offer-sdp' },
    });
    expect(signals).toHaveLength(1);
  });

  it('accepts listener answers, applies ICE once and fans out broadcaster frames', async () => {
    const peer = new FakePeer();
    const source = new FakeAudioSource();
    const registry = new BackendWebRtcListenerPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSource: () => source,
    });

    await registry.createOffer(listener(), summary(), 2);
    await registry.acceptAnswer(answer());
    await registry.addRemoteCandidate(candidate());
    await registry.addRemoteCandidate(candidate());
    registry.fanOutAudioFrame('wrs_demo', frame());

    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'opaque-answer-sdp' });
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    expect(source.onData).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshots()[0]).toMatchObject({
      sessionId: 'wrs_demo',
      listenerPeerId: 'peer_listener',
      revision: 2,
    });
  });

  it('prevents duplicate listener peers and closes by listener socket', async () => {
    const peer = new FakePeer();
    const source = new FakeAudioSource();
    const registry = new BackendWebRtcListenerPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSource: () => source,
    });

    await registry.createOffer(listener(), summary(), 2);
    await expect(registry.createOffer(listener(), summary(2), 3)).resolves.toBeNull();

    registry.closeByListenerSocket('socket_listener');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(source.track.stop).toHaveBeenCalledOnce();
    expect(registry.getSnapshots()).toHaveLength(0);
  });

  it('rejects stale listener answers clearly', async () => {
    const registry = new BackendWebRtcListenerPeerRegistry({
      createPeerConnection: () => new FakePeer() as never,
      createAudioSource: () => new FakeAudioSource(),
    });

    await registry.createOffer(listener(), summary(), 2);
    await expect(registry.acceptAnswer(answer(1))).rejects.toMatchObject({
      code: 'stale-negotiation',
    });
  });
});
