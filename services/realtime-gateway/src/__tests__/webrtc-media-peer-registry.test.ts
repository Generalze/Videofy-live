import { describe, expect, it, vi } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIceCandidateEnvelope,
  type WebRtcSdpOfferEnvelope,
  type WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import { BackendWebRtcMediaPeerRegistry } from '../webrtc-media-peer-registry.js';
import type { WebRtcAudioDataLike } from '../webrtc-audio-ingest-bridge.js';

class FakePeer {
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp?: string } | null = null;
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number } | null }) => void) | null = null;
  ontrack: ((event: { track: { kind: string; addEventListener: ReturnType<typeof vi.fn>; onended?: (() => void) | undefined } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  setRemoteDescription = vi.fn(async () => undefined);
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'opaque-answer-sdp' }));
  setLocalDescription = vi.fn(async (answer: { sdp?: string }) => {
    this.localDescription = answer;
  });
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  emitTrack(kind = 'audio') {
    const track = { kind, addEventListener: vi.fn(), onended: undefined as undefined | (() => void) };
    this.ontrack?.({ track });
    return track;
  }
  emitLocalIce(candidate = 'opaque-backend-ice') {
    this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } });
  }
}

class FakeSink {
  ondata: ((data: WebRtcAudioDataLike) => void) | null = null;
  stop = vi.fn();
  emitFrame(): void {
    this.ondata?.({
      samples: new Int16Array([1, 2]),
      sampleRate: 48000,
      channelCount: 1,
      bitsPerSample: 16,
      numberOfFrames: 1,
    });
  }
}

function sessionSummary(revision = 1): WebRtcSessionSummary {
  return {
    sessionId: 'wrs_demo',
    broadcastId: 'broadcast_demo',
    state: 'negotiating',
    revision,
    broadcasterPeerId: 'peer_broadcaster',
    peerCount: 2,
    peers: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function offer(overrides: Partial<WebRtcSdpOfferEnvelope> = {}): WebRtcSdpOfferEnvelope {
  return {
    type: 'sdp-offer',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_offer',
    correlationId: 'corr_offer',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 1,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'opaque-offer-sdp' },
    ...overrides,
  };
}

function candidate(): WebRtcIceCandidateEnvelope {
  return {
    type: 'ice-candidate',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_ice',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 1,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: {
      targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      candidate: 'opaque-browser-ice',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  };
}

describe('BackendWebRtcMediaPeerRegistry', () => {
  it('creates a backend peer, returns an answer and emits backend ICE safely', async () => {
    const peer = new FakePeer();
    const localSignals: unknown[] = [];
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => new FakeSink(),
      onLocalSignal: (signal) => localSignals.push(signal),
    });

    const answer = await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitLocalIce();

    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'opaque-offer-sdp' });
    expect(peer.createAnswer).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({
      type: 'sdp-answer',
      correlationId: 'corr_offer',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      payload: { targetPeerId: 'peer_broadcaster', sdp: 'opaque-answer-sdp' },
    });
    expect(localSignals).toHaveLength(1);
  });

  it('rejects stale offers and duplicate active peers', async () => {
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => new FakePeer() as never,
      createAudioSink: () => new FakeSink(),
    });

    await expect(registry.acceptOffer('socket_broadcaster', offer(), sessionSummary(0))).rejects.toMatchObject({
      code: 'stale-negotiation',
    });
    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    await expect(registry.acceptOffer('socket_broadcaster', offer(), sessionSummary())).rejects.toMatchObject({
      code: 'peer-already-exists',
    });
  });

  it('accepts one audio track, records activity and emits peer-ready once', async () => {
    const peer = new FakePeer();
    const sink = new FakeSink();
    const ready = vi.fn();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => sink,
      onPeerReady: ready,
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitTrack('audio');
    sink.emitFrame();
    sink.emitFrame();

    expect(registry.getSnapshot('wrs_demo')).toMatchObject({
      audioTrackState: 'active',
      ingestBridgeState: 'active',
      audioFrameCount: 2,
      audioActivityDetected: true,
    });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate audio and video tracks by policy', async () => {
    const peer = new FakePeer();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => new FakeSink(),
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitTrack('audio');
    peer.emitTrack('audio');
    expect(registry.getSnapshot('wrs_demo')?.lastError?.code).toBe('duplicate-audio-track');

    const peer2 = new FakePeer();
    const registry2 = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer2 as never,
      createAudioSink: () => new FakeSink(),
    });
    await registry2.acceptOffer('socket_broadcaster', offer({ sessionId: 'wrs_video' }), {
      ...sessionSummary(),
      sessionId: 'wrs_video',
    });
    peer2.emitTrack('video');
    expect(registry2.getSnapshot('wrs_video')?.lastError?.code).toBe('unexpected-video-track');
  });

  it('applies remote candidates, closes on session cleanup and enforces bounds', async () => {
    const peer = new FakePeer();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => new FakeSink(),
      maxActivePeers: 1,
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    await registry.addRemoteCandidate(candidate());
    await registry.addRemoteCandidate(candidate());
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);

    await expect(
      registry.acceptOffer('socket_other', offer({ sessionId: 'wrs_other', messageId: 'msg_other' }), {
        ...sessionSummary(),
        sessionId: 'wrs_other',
      }),
    ).rejects.toMatchObject({ code: 'backend-webrtc-unavailable' });

    registry.closeSession('wrs_demo');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(registry.getSnapshot('wrs_demo')).toBeNull();
  });
});
