import { describe, expect, it, vi } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  type WebRtcIceCandidateEnvelope,
  type WebRtcSdpOfferEnvelope,
  type WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import {
  BackendWebRtcMediaPeerRegistry,
  type WebRtcVideoFrameLike,
} from '../webrtc-media-peer-registry.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';

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
  ondata: ((data: MediaAudioDataLike) => void) | null = null;
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

class FakeVideoSink {
  onframe: ((event: WebRtcVideoFrameLike | { frame?: WebRtcVideoFrameLike }) => void) | null = null;
  stop = vi.fn();
  emitFrame(frame: WebRtcVideoFrameLike = { width: 640, height: 360 }): void {
    this.onframe?.({ frame });
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

  it('does not emit peer-ready for video offers until a backend video frame is active', async () => {
    const peer = new FakePeer();
    const sink = new FakeSink();
    const videoSink = new FakeVideoSink();
    const ready = vi.fn();
    const trackReady = vi.fn();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => sink,
      createVideoSink: () => videoSink,
      onPeerReady: ready,
      onTrackReady: trackReady,
    });

    await registry.acceptOffer(
      'socket_broadcaster',
      offer({
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
        },
      }),
      sessionSummary(),
    );
    peer.emitTrack('audio');
    peer.emitTrack('video');
    sink.emitFrame();

    expect(registry.getSnapshot('wrs_demo')).toMatchObject({
      audioTrackState: 'active',
      videoTrackState: 'received',
      videoExpected: true,
      audioActivityDetected: true,
      videoActivityDetected: false,
    });
    expect(trackReady).toHaveBeenCalledTimes(2);
    expect(ready).not.toHaveBeenCalled();

    videoSink.emitFrame({ width: 1280, height: 720 });

    expect(registry.getSnapshot('wrs_demo')).toMatchObject({
      videoTrackState: 'active',
      videoFrameCount: 1,
      videoActivityDetected: true,
    });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('emits an audio-only peer-ready after the video grace window when video frames never arrive', async () => {
    const peer = new FakePeer();
    const sink = new FakeSink();
    const ready = vi.fn();
    const timers: { callback: () => void; delayMs: number }[] = [];
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => sink,
      createVideoSink: () => new FakeVideoSink(),
      videoReadyGraceMs: 3_000,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      onPeerReady: ready,
    });

    await registry.acceptOffer(
      'socket_broadcaster',
      offer({
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
        },
      }),
      sessionSummary(),
    );
    peer.emitTrack('audio');
    sink.emitFrame();
    expect(ready).not.toHaveBeenCalled();

    const graceTimer = timers.find((timer) => timer.delayMs === 3_000);
    expect(graceTimer).toBeDefined();
    graceTimer!.callback();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'peer-ready',
        payload: { state: 'ready', audioTrackReceived: true, videoTrackReceived: false },
      }),
    );

    // Further audio activity must not emit a second peer-ready.
    sink.emitFrame();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('reports truthful track receipt in the peer-ready payload', async () => {
    const peer = new FakePeer();
    const sink = new FakeSink();
    const videoSink = new FakeVideoSink();
    const ready = vi.fn();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => sink,
      createVideoSink: () => videoSink,
      onPeerReady: ready,
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitTrack('audio');
    peer.emitTrack('video');
    sink.emitFrame();
    videoSink.emitFrame();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { state: 'ready', audioTrackReceived: true, videoTrackReceived: true },
      }),
    );
  });

  it('signals video end through onVideoEnded instead of fanning out a sentinel frame', async () => {
    const peer = new FakePeer();
    const sink = new FakeSink();
    const videoSink = new FakeVideoSink();
    const videoFrames: WebRtcVideoFrameLike[] = [];
    const videoEnded = vi.fn();
    const audioPeerClosed = vi.fn();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => sink,
      createVideoSink: () => videoSink,
      onVideoFrame: (_context, frame) => videoFrames.push(frame),
      onVideoEnded: videoEnded,
      onAudioPeerClosed: audioPeerClosed,
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitTrack('audio');
    const videoTrack = peer.emitTrack('video');
    videoSink.emitFrame({ width: 640, height: 360 });
    sink.emitFrame();

    videoTrack.onended?.();

    expect(videoFrames).toEqual([{ width: 640, height: 360 }]);
    expect(videoEnded).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'wrs_demo' }),
      'broadcaster video track ended',
    );
    expect(audioPeerClosed).not.toHaveBeenCalled();
    expect(registry.getSnapshot('wrs_demo')).toMatchObject({
      videoTrackState: 'ended',
      audioTrackState: 'active',
    });
    expect(registry.getSnapshot('wrs_demo')?.state).not.toBe('failed');

    // Audio keeps flowing after video ends.
    sink.emitFrame();
    expect(registry.getSnapshot('wrs_demo')).toMatchObject({ audioFrameCount: 2 });
  });

  it('rejects duplicate audio tracks and accepts one video track by policy', async () => {
    const peer = new FakePeer();
    const videoSink = new FakeVideoSink();
    const registry = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer as never,
      createAudioSink: () => new FakeSink(),
      createVideoSink: () => videoSink,
    });

    await registry.acceptOffer('socket_broadcaster', offer(), sessionSummary());
    peer.emitTrack('audio');
    peer.emitTrack('video');
    videoSink.emitFrame();
    expect(registry.getSnapshot('wrs_demo')).toMatchObject({
      audioTrackState: 'received',
      videoTrackState: 'active',
      videoFrameCount: 1,
      videoActivityDetected: true,
    });

    const peer2 = new FakePeer();
    const registry2 = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer2 as never,
      createAudioSink: () => new FakeSink(),
      createVideoSink: () => new FakeVideoSink(),
    });
    await registry2.acceptOffer('socket_broadcaster', offer({ sessionId: 'wrs_video' }), {
      ...sessionSummary(),
      sessionId: 'wrs_video',
    });
    peer2.emitTrack('audio');
    peer2.emitTrack('audio');
    expect(registry2.getSnapshot('wrs_video')?.lastError?.code).toBe('duplicate-audio-track');

    const peer3 = new FakePeer();
    const registry3 = new BackendWebRtcMediaPeerRegistry({
      createPeerConnection: () => peer3 as never,
      createAudioSink: () => new FakeSink(),
      createVideoSink: () => new FakeVideoSink(),
    });
    await registry3.acceptOffer('socket_broadcaster', offer({ sessionId: 'wrs_video_duplicate' }), {
      ...sessionSummary(),
      sessionId: 'wrs_video_duplicate',
    });
    peer3.emitTrack('video');
    peer3.emitTrack('video');
    expect(registry3.getSnapshot('wrs_video_duplicate')?.lastError?.code).toBe('duplicate-video-track');
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
