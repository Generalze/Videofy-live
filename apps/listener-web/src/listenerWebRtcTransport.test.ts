import { describe, expect, it, vi } from 'vitest';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
  WebRtcSignallingClient,
  type WebRtcSdpOfferEnvelope,
} from '@videofy-live/shared-types';
import { ListenerWebRtcTransportController } from './listenerWebRtcTransport';

class FakeSignallingTransport {
  connected = true;
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly listeners = new Map<string, ((payload?: unknown) => void)[]>();
  on(event: string, listener: (payload?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  off(event: string, listener: (payload?: unknown) => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((item) => item !== listener),
    );
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }
  fire(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class FakePeer {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((event?: Event) => void) | null = null;
  oniceconnectionstatechange: ((event?: Event) => void) | null = null;
  addTransceiver = vi.fn();
  setRemoteDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => {
    this.remoteDescription = offer as RTCSessionDescription;
  });
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'opaque-answer-sdp' }));
  setLocalDescription = vi.fn(async (answer: RTCSessionDescriptionInit) => {
    this.localDescription = answer as RTCSessionDescription;
  });
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
}

class FakeTrack implements MediaStreamTrack {
  readonly contentHint = '';
  enabled = true;
  readonly id: string;
  readonly isolated = false;
  readonly kind: string;
  label = 'test track';
  muted = false;
  onended: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onunmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  readyState: MediaStreamTrackState = 'live';
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
    this.id = `track-${kind}`;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    if (event.type === 'ended') this.onended?.call(this, event);
    return true;
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }

  clone(): MediaStreamTrack {
    return new FakeTrack(this.kind as 'audio' | 'video') as unknown as MediaStreamTrack;
  }

  getCapabilities(): MediaTrackCapabilities {
    return {};
  }

  getConstraints(): MediaTrackConstraints {
    return {};
  }

  getSettings(): MediaTrackSettings {
    return {};
  }

  stop(): void {
    this.readyState = 'ended';
  }
}

function createClient(): { client: WebRtcSignallingClient; transport: FakeSignallingTransport } {
  const transport = new FakeSignallingTransport();
  const client = new WebRtcSignallingClient({
    role: 'listener',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: 'peer_listener',
    createId: () => 'id',
  });
  client.attach(transport as never);
  return { client, transport };
}

function offer(overrides: Partial<WebRtcSdpOfferEnvelope> = {}): WebRtcSdpOfferEnvelope {
  return {
    type: 'sdp-offer',
    protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
    messageId: 'msg_offer',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_demo',
    peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
    senderRole: 'server',
    revision: 1,
    createdAt: '2026-07-27T00:00:00.000Z',
    payload: { targetPeerId: 'peer_listener', sdp: 'opaque-offer-sdp' },
    ...overrides,
  };
}

describe('ListenerWebRtcTransportController', () => {
  it('answers backend offers without creating local media tracks', async () => {
    const { client, transport } = createClient();
    const peer = new FakePeer();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    });

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());

    expect(peer.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'opaque-offer-sdp' });
    expect(peer.createAnswer).toHaveBeenCalledOnce();
    expect(transport.emitted.at(-1)?.payload).toMatchObject({
      type: 'sdp-answer',
      peerId: 'peer_listener',
      payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp: 'opaque-answer-sdp' },
    });
  });

  it('receives one remote audio stream and rejects duplicate tracks', async () => {
    const { client } = createClient();
    const peer = new FakePeer();
    const onRemoteStream = vi.fn();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      setTimer: () => 1,
      clearTimer: vi.fn(),
      onRemoteStream,
    });
    const track = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const secondTrack = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);
    peer.ontrack?.({ track: secondTrack, streams: [] } as unknown as RTCTrackEvent);

    expect(onRemoteStream).toHaveBeenCalledWith(stream);
    expect(controller.getSnapshot()).toMatchObject({
      state: 'failed',
      remoteAudioTrackReceived: true,
      lastError: { code: 'duplicate-peer' },
    });
  });

  it('receives one remote video track on the same programme stream', async () => {
    const { client } = createClient();
    const peer = new FakePeer();
    const onRemoteStream = vi.fn();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      setTimer: () => 1,
      clearTimer: vi.fn(),
      onRemoteStream,
    });
    const audio = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const video = {
      kind: 'video',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const tracks: MediaStreamTrack[] = [audio, video];
    const programmeStream = {
      addTrack: vi.fn((track: MediaStreamTrack) => tracks.push(track)),
      getTracks: vi.fn(() => tracks),
      getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
      getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video')),
    } as unknown as MediaStream;

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.ontrack?.({ track: audio, streams: [programmeStream] } as unknown as RTCTrackEvent);
    peer.ontrack?.({ track: video, streams: [programmeStream] } as unknown as RTCTrackEvent);

    expect(peer.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(peer.addTransceiver).toHaveBeenCalledWith('video', { direction: 'recvonly' });
    expect(onRemoteStream).toHaveBeenCalledTimes(2);
    expect(onRemoteStream).toHaveBeenLastCalledWith(programmeStream);
    expect(controller.getRemoteStream()).toBe(programmeStream);
    expect(controller.getSnapshot()).toMatchObject({
      remoteAudioTrackReceived: true,
      remoteVideoTrackReceived: true,
      remoteVideoTrackActive: true,
    });
  });

  it('keeps both programme tracks when video arrives before audio on separate streams', async () => {
    const { client } = createClient();
    const peer = new FakePeer();
    const onRemoteStream = vi.fn();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      setTimer: () => 1,
      clearTimer: vi.fn(),
      onRemoteStream,
    });
    const audio = {
      kind: 'audio',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const video = {
      kind: 'video',
      readyState: 'live',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const videoTracks: MediaStreamTrack[] = [video];
    const videoStream = {
      addTrack: vi.fn((track: MediaStreamTrack) => videoTracks.push(track)),
      getTracks: vi.fn(() => videoTracks),
    } as unknown as MediaStream;
    const audioStream = {
      addTrack: vi.fn(),
      getTracks: vi.fn(() => [audio]),
    } as unknown as MediaStream;

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.ontrack?.({ track: video, streams: [videoStream] } as unknown as RTCTrackEvent);
    peer.ontrack?.({ track: audio, streams: [audioStream] } as unknown as RTCTrackEvent);

    expect(videoStream.addTrack).toHaveBeenCalledWith(audio);
    expect(audioStream.addTrack).not.toHaveBeenCalled();
    expect(onRemoteStream).toHaveBeenCalledTimes(2);
    expect(onRemoteStream).toHaveBeenLastCalledWith(videoStream);
    expect(controller.getRemoteStream()).toBe(videoStream);
    expect(videoTracks).toEqual([video, audio]);
    expect(controller.getSnapshot()).toMatchObject({
      remoteAudioTrackReceived: true,
      remoteVideoTrackReceived: true,
      remoteAudioTrackActive: true,
      remoteVideoTrackActive: true,
    });
  });

  it('ignores stale offers and reports blocked playback truthfully', async () => {
    const { client } = createClient();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => new FakePeer() as never,
    });

    controller.startWaiting();
    await controller.handleSignallingEvent(offer({ revision: 1 }));
    await controller.handleSignallingEvent(offer({ revision: 0, messageId: 'stale' }));
    controller.markPlaybackBlocked('Autoplay requires user gesture.');

    expect(controller.getSnapshot()).toMatchObject({
      state: 'playback-blocked',
      lastError: { code: 'playback-blocked' },
    });
  });

  it('stops listener transport retries after the configured bound', async () => {
    const { client } = createClient();
    const peer = new FakePeer();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      maxRecoveryAttempts: 0,
    });

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange?.();

    expect(controller.getSnapshot()).toMatchObject({
      state: 'failed',
      recoveryAttempts: 0,
      lastError: { code: 'negotiation-timeout', retryable: false },
    });
  });

  it('treats peer failure after both remote tracks end as normal source completion', async () => {
    const { client } = createClient();
    const peer = new FakePeer();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
      maxRecoveryAttempts: 2,
    });
    const audio = new FakeTrack('audio');
    const video = new FakeTrack('video');
    const programmeStream = {
      addTrack: vi.fn(),
      getTracks: vi.fn(() => [audio, video]),
    } as unknown as MediaStream;

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.ontrack?.({ track: audio, streams: [programmeStream] } as unknown as RTCTrackEvent);
    peer.ontrack?.({ track: video, streams: [programmeStream] } as unknown as RTCTrackEvent);

    audio.stop();
    video.stop();
    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange?.();

    expect(controller.getSnapshot()).toMatchObject({
      state: 'source-ended',
      recoveryAttempts: 0,
      remoteAudioTrackActive: false,
      remoteVideoTrackActive: false,
      lastError: null,
    });
  });

  it('can close terminal source media without sending a redundant peer disconnect', async () => {
    const { client, transport } = createClient();
    const peer = new FakePeer();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    controller.close('programme source completed', false);

    expect(peer.close).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      state: 'closed',
      lastError: null,
    });
    expect(
      transport.emitted.some(
        (event) => (event.payload as { type?: string }).type === 'peer-disconnect',
      ),
    ).toBe(false);
  });

  it('preserves source-ended state when the remote programme peer disconnects after media arrives', async () => {
    const { client, transport } = createClient();
    const peer = new FakePeer();
    const controller = new ListenerWebRtcTransportController({
      signallingClient: client,
      createPeerConnection: () => peer as never,
    });
    const audio = new FakeTrack('audio');
    const video = new FakeTrack('video');
    const programmeStream = {
      addTrack: vi.fn(),
      getTracks: vi.fn(() => [audio, video]),
    } as unknown as MediaStream;

    controller.startWaiting();
    await controller.handleSignallingEvent(offer());
    peer.ontrack?.({ track: audio, streams: [programmeStream] } as unknown as RTCTrackEvent);
    peer.ontrack?.({ track: video, streams: [programmeStream] } as unknown as RTCTrackEvent);

    await controller.handleSignallingEvent({
      type: 'peer-disconnect',
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId: 'msg_disconnect',
      broadcastId: 'broadcast_demo',
      sessionId: 'wrs_demo',
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      senderRole: 'server',
      revision: 1,
      createdAt: '2026-07-27T00:00:01.000Z',
      payload: {
        targetPeerId: 'peer_listener',
        reason: 'programme source ended',
      },
    });

    expect(controller.getSnapshot()).toMatchObject({
      state: 'source-ended',
      remoteAudioTrackReceived: true,
      remoteAudioTrackActive: false,
      remoteVideoTrackReceived: true,
      remoteVideoTrackActive: false,
      lastError: null,
    });
    expect(
      transport.emitted.some(
        (event) => (event.payload as { type?: string }).type === 'peer-disconnect',
      ),
    ).toBe(false);
  });
});
