import { describe, expect, it, vi } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  type WebRtcPeerReadyEnvelope,
  type WebRtcSdpAnswerEnvelope,
  type WebRtcSignallingClient,
} from '@videofy-live/shared-types';
import {
  BroadcasterWebRtcTransportController,
  createInitialBroadcasterWebRtcTransportSnapshot,
} from './broadcasterWebRtcTransport';

function audioTrack() {
  const listeners = new Set<() => void>();
  return {
    kind: 'audio',
    readyState: 'live',
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.delete(listener);
    }),
    emitEnded: () => listeners.forEach((listener) => listener()),
  } as unknown as MediaStreamTrack & { emitEnded: () => void };
}

function videoTrack() {
  const listeners = new Set<() => void>();
  return {
    kind: 'video',
    readyState: 'live',
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.delete(listener);
    }),
    emitEnded: () => listeners.forEach((listener) => listener()),
  } as unknown as MediaStreamTrack & { emitEnded: () => void };
}

function mediaStream(tracks: MediaStreamTrack[]) {
  return {
    getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
    getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video')),
    getTracks: vi.fn(() => tracks),
  } as unknown as MediaStream;
}

class FakePeer {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'opaque-offer-sdp' }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description as RTCSessionDescription;
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description as RTCSessionDescription;
  });
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  });
  emitLocalIce(candidate = 'opaque-local-ice'): void {
    this.onicecandidate?.({
      candidate: {
        candidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'ufrag',
      },
    } as RTCPeerConnectionIceEvent);
  }
}

function signallingClient(overrides: Partial<ReturnType<WebRtcSignallingClient['getSnapshot']>> = {}) {
  return {
    getSnapshot: vi.fn(() => ({
      connected: true,
      sessionId: 'wrs_demo',
      revision: 0,
      ...overrides,
    })),
    sendSdpOffer: vi.fn(),
    sendIceCandidate: vi.fn(),
    sendIceComplete: vi.fn(),
    sendPeerDisconnect: vi.fn(),
  } as unknown as WebRtcSignallingClient & {
    sendSdpOffer: ReturnType<typeof vi.fn>;
    sendIceCandidate: ReturnType<typeof vi.fn>;
    sendIceComplete: ReturnType<typeof vi.fn>;
    sendPeerDisconnect: ReturnType<typeof vi.fn>;
  };
}

function answer(revision = 1): WebRtcSdpAnswerEnvelope {
  return {
    type: 'sdp-answer',
    protocolVersion: 1,
    messageId: 'msg_answer',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
    senderRole: 'server',
    revision,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { targetPeerId: 'peer_broadcaster', sdp: 'opaque-answer-sdp' },
  };
}

function ready(
  revision = 1,
  payloadOverrides: { audioTrackReceived?: boolean; videoTrackReceived?: boolean } = {},
): WebRtcPeerReadyEnvelope {
  return {
    type: 'peer-ready',
    protocolVersion: 1,
    messageId: 'msg_ready',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
    senderRole: 'server',
    revision,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { state: 'ready', ...payloadOverrides } as WebRtcPeerReadyEnvelope['payload'],
  };
}

describe('BroadcasterWebRtcTransportController', () => {
  it('starts in idle state', () => {
    expect(createInitialBroadcasterWebRtcTransportSnapshot()).toMatchObject({
      state: 'idle',
      localAudioTrackAttached: false,
      backendAudioActivityDetected: false,
    });
  });

  it('rejects missing local audio track', async () => {
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => new FakePeer() as never,
    });

    await expect(controller.start(mediaStream([]))).rejects.toMatchObject({
      code: 'missing-audio-track',
    });
    await expect(controller.start(mediaStream([]))).rejects.not.toMatchObject({
      message: expect.stringContaining('local broadcaster capture'),
    });
  });

  it('creates one audio-only peer offer through the signalling client', async () => {
    const peer = new FakePeer();
    const client = signallingClient();
    const track = audioTrack();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });

    await controller.start(mediaStream([track]));

    expect(peer.addTrack).toHaveBeenCalledTimes(1);
    expect(peer.createOffer).toHaveBeenCalledOnce();
    expect(peer.setLocalDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'opaque-offer-sdp' });
    expect(client.sendSdpOffer).toHaveBeenCalledWith({
      targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      sdp: 'opaque-offer-sdp',
      revision: 1,
    });
    expect(controller.getSnapshot()).toMatchObject({
      state: 'awaiting-answer',
      localAudioTrackAttached: true,
    });
  });

  it('creates one programme peer offer with optional video in the same transport', async () => {
    const peer = new FakePeer();
    const client = signallingClient();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });

    await controller.start(mediaStream([audioTrack(), videoTrack()]));
    await controller.handleSignallingEvent(ready());

    expect(peer.addTrack).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      localAudioTrackAttached: true,
      localVideoTrackAttached: true,
      backendAudioTrackReceived: true,
      backendVideoTrackReceived: true,
    });
  });

  it('consumes backend-reported track receipt from the peer-ready payload', async () => {
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => new FakePeer() as never,
    });

    // Audio-only local stream: the local-flag fallback alone would report
    // backendVideoTrackReceived=false, but the gateway says video arrived.
    await controller.start(mediaStream([audioTrack()]));
    await controller.handleSignallingEvent(
      ready(1, { audioTrackReceived: true, videoTrackReceived: true }),
    );

    expect(controller.getSnapshot()).toMatchObject({
      backendAudioTrackReceived: true,
      backendVideoTrackReceived: true,
    });
  });

  it('trusts the peer-ready payload over the local flag when backend video is missing', async () => {
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => new FakePeer() as never,
    });

    await controller.start(mediaStream([audioTrack(), videoTrack()]));
    await controller.handleSignallingEvent(ready(1, { videoTrackReceived: false }));

    expect(controller.getSnapshot()).toMatchObject({
      backendAudioTrackReceived: true,
      backendVideoTrackReceived: false,
    });
  });

  it('waits until backend confirms programme audio and video are available', async () => {
    const peer = new FakePeer();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => peer as never,
    });

    await controller.start(mediaStream([audioTrack(), videoTrack()]));
    const wait = controller.waitForBackendMedia({ requireVideo: true, timeoutMs: 100 });
    await controller.handleSignallingEvent(ready());

    await expect(wait).resolves.toMatchObject({
      backendAudioTrackReceived: true,
      backendVideoTrackReceived: true,
    });
  });

  it('times out when programme media never reaches the backend', async () => {
    vi.useFakeTimers();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => new FakePeer() as never,
    });
    await controller.start(mediaStream([audioTrack(), videoTrack()]));

    const wait = expect(
      controller.waitForBackendMedia({ requireVideo: true, timeoutMs: 25 }),
    ).rejects.toMatchObject({
      code: 'negotiation-timeout',
      message: 'Timed out waiting for backend programme audio and video.',
    });
    await vi.advanceTimersByTimeAsync(25);

    await wait;
    vi.useRealTimers();
  });

  it('rejects duplicate programme video tracks', async () => {
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => new FakePeer() as never,
    });

    await expect(
      controller.start(mediaStream([audioTrack(), videoTrack(), videoTrack()])),
    ).rejects.toMatchObject({ code: 'duplicate-video-track' });
  });

  it('applies backend answer, local ICE and backend ready events', async () => {
    const peer = new FakePeer();
    const client = signallingClient();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });
    await controller.start(mediaStream([audioTrack()]));
    await controller.handleSignallingEvent(answer());
    peer.emitLocalIce();
    await controller.handleSignallingEvent(ready());

    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'opaque-answer-sdp' });
    expect(client.sendIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, candidate: 'opaque-local-ice' }),
    );
    expect(controller.getSnapshot()).toMatchObject({
      backendAudioTrackReceived: true,
      backendAudioActivityDetected: true,
    });
  });

  it('queues backend ICE before the answer and ignores duplicate candidates', async () => {
    const peer = new FakePeer();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: () => peer as never,
    });
    await controller.start(mediaStream([audioTrack()]));
    const candidate = {
      type: 'ice-candidate' as const,
      protocolVersion: 1 as const,
      messageId: 'msg_ice',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      senderRole: 'server' as const,
      revision: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
      payload: { targetPeerId: 'peer_broadcaster', candidate: 'opaque-remote-ice', sdpMid: '0', sdpMLineIndex: 0 },
    };

    await controller.handleSignallingEvent(candidate);
    await controller.handleSignallingEvent(candidate);
    expect(controller.getSnapshot().queuedRemoteCandidates).toBe(1);
    await controller.handleSignallingEvent(answer());
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
  });

  it('rejects stale answers and closes idempotently', async () => {
    const peer = new FakePeer();
    const client = signallingClient();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });
    await controller.start(mediaStream([audioTrack()]));
    await controller.handleSignallingEvent(answer(0));
    expect(controller.getSnapshot().lastError?.code).toBe('stale-negotiation');

    await controller.close();
    await controller.close();
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(client.sendPeerDisconnect).toHaveBeenCalledWith({
      targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      reason: 'operator stopped backend audio transport',
      revision: 1,
    });
    expect(controller.getSnapshot().state).toBe('closed');
  });

  it('supports recovery with a new revision and no listener media path', async () => {
    const first = new FakePeer();
    const second = new FakePeer();
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });
    const stream = mediaStream([audioTrack()]);

    await controller.start(stream);
    await controller.recover(stream);

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.addTrack).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe('awaiting-answer');
  });

  it('schedules bounded retry on ICE failure when local capture is still live', async () => {
    vi.useFakeTimers();
    const first = new FakePeer();
    const second = new FakePeer();
    const createPeerConnection = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const controller = new BroadcasterWebRtcTransportController({
      signallingClient: signallingClient(),
      createPeerConnection,
      maxRecoveryAttempts: 1,
      recoveryBackoffMs: 25,
    });
    await controller.start(mediaStream([audioTrack()]));

    first.iceConnectionState = 'failed';
    first.oniceconnectionstatechange?.();

    expect(controller.getSnapshot()).toMatchObject({
      state: 'recovering',
      recoveryAttempts: 1,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(createPeerConnection).toHaveBeenCalledTimes(2);
    expect(second.addTrack).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe('awaiting-answer');
    vi.useRealTimers();
  });
});
