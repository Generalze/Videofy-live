import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  type WebRtcIceCandidateEnvelope,
  type WebRtcIceCompleteEnvelope,
  type WebRtcPeerDisconnectEnvelope,
  type WebRtcSdpOfferEnvelope,
  type WebRtcSignallingClient,
} from '@videofy-live/shared-types';

export type ListenerWebRtcTransportState =
  | 'idle'
  | 'waiting-for-programme'
  | 'awaiting-broadcaster'
  | 'negotiating-programme-media'
  | 'negotiating'
  | 'connecting'
  | 'track-received'
  | 'playing'
  | 'playback-blocked'
  | 'video-connected'
  | 'audio-connected'
  | 'video-unavailable'
  | 'source-paused'
  | 'source-ended'
  | 'broadcaster-unavailable'
  | 'disconnected'
  | 'recovering'
  | 'failed'
  | 'closing'
  | 'closed';

export type ListenerWebRtcTransportErrorCode =
  | 'webrtc-api-unavailable'
  | 'duplicate-peer'
  | 'stale-negotiation'
  | 'invalid-offer'
  | 'remote-description-failure'
  | 'answer-creation-failure'
  | 'local-description-failure'
  | 'ice-candidate-failure'
  | 'negotiation-timeout'
  | 'connection-closed'
  | 'audio-track-ended'
  | 'video-track-ended'
  | 'playback-blocked'
  | 'cleanup-failure';

export interface ListenerWebRtcTransportErrorDetails {
  code: ListenerWebRtcTransportErrorCode;
  message: string;
  retryable: boolean;
}

export interface ListenerWebRtcTransportSnapshot {
  state: ListenerWebRtcTransportState;
  revision: number;
  connectionState: RTCPeerConnectionState | 'none';
  iceConnectionState: RTCIceConnectionState | 'none';
  remoteAudioTrackReceived: boolean;
  remoteAudioTrackActive: boolean;
  remoteVideoTrackReceived: boolean;
  remoteVideoTrackActive: boolean;
  playbackBlocked: boolean;
  queuedRemoteCandidates: number;
  recoveryAttempts: number;
  lastError: ListenerWebRtcTransportErrorDetails | null;
  updatedAt: string;
}

interface PeerConnectionLike {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  localDescription: RTCSessionDescription | null;
  remoteDescription: RTCSessionDescription | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  onconnectionstatechange: ((event?: Event) => void) | null;
  oniceconnectionstatechange: ((event?: Event) => void) | null;
  addTransceiver(kind: 'audio' | 'video', init: RTCRtpTransceiverInit): RTCRtpTransceiver;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export interface ListenerWebRtcTransportControllerOptions {
  signallingClient: WebRtcSignallingClient;
  createPeerConnection?: () => PeerConnectionLike;
  negotiationTimeoutMs?: number;
  maxQueuedRemoteCandidates?: number;
  maxRecoveryAttempts?: number;
  recoveryBackoffMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (snapshot: ListenerWebRtcTransportSnapshot) => void;
}

const DEFAULT_NEGOTIATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED_REMOTE_CANDIDATES = 32;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;
const DEFAULT_RECOVERY_BACKOFF_MS = 500;

export function createInitialListenerWebRtcTransportSnapshot(): ListenerWebRtcTransportSnapshot {
  return {
    state: 'idle',
    revision: 0,
    connectionState: 'none',
    iceConnectionState: 'none',
  remoteAudioTrackReceived: false,
  remoteAudioTrackActive: false,
  remoteVideoTrackReceived: false,
  remoteVideoTrackActive: false,
  playbackBlocked: false,
    queuedRemoteCandidates: 0,
    recoveryAttempts: 0,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export class ListenerWebRtcTransportController {
  private readonly signallingClient: WebRtcSignallingClient;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly negotiationTimeoutMs: number;
  private readonly maxQueuedRemoteCandidates: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timer: number) => void;
  private readonly onRemoteStream: ((stream: MediaStream) => void) | undefined;
  private readonly onStateChange: ((snapshot: ListenerWebRtcTransportSnapshot) => void) | undefined;

  private snapshot = createInitialListenerWebRtcTransportSnapshot();
  private peer: PeerConnectionLike | null = null;
  private stream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private seenRemoteCandidates = new Set<string>();
  private negotiationTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private disposed = false;

  constructor(options: ListenerWebRtcTransportControllerOptions) {
    this.signallingClient = options.signallingClient;
    this.createPeerConnection =
      options.createPeerConnection ??
      (() => {
        if (!globalThis.RTCPeerConnection) {
          throw error('webrtc-api-unavailable', 'This browser does not support WebRTC audio playback.', false);
        }
        return new RTCPeerConnection({ iceServers: readIceServers() }) as unknown as PeerConnectionLike;
      });
    this.negotiationTimeoutMs = options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;
    this.maxQueuedRemoteCandidates =
      options.maxQueuedRemoteCandidates ?? DEFAULT_MAX_QUEUED_REMOTE_CANDIDATES;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
    this.recoveryBackoffMs = options.recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number);
    this.clearTimer =
      options.clearTimer ??
      ((timer) => globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    this.onRemoteStream = options.onRemoteStream;
    this.onStateChange = options.onStateChange;
  }

  getSnapshot(): ListenerWebRtcTransportSnapshot {
    return this.snapshot;
  }

  startWaiting(): ListenerWebRtcTransportSnapshot {
    if (this.snapshot.state !== 'idle' && this.snapshot.state !== 'closed' && this.snapshot.state !== 'failed') {
      throw this.fail(error('duplicate-peer', 'Listener WebRTC audio transport is already active.'));
    }
    const signalling = this.signallingClient.getSnapshot();
    this.update({
      state: 'awaiting-broadcaster',
      revision: signalling.revision,
      lastError: null,
      remoteAudioTrackReceived: false,
      remoteAudioTrackActive: false,
      remoteVideoTrackReceived: false,
      remoteVideoTrackActive: false,
      playbackBlocked: false,
      queuedRemoteCandidates: 0,
      recoveryAttempts: this.snapshot.recoveryAttempts,
    });
    return this.snapshot;
  }

  async handleSignallingEvent(
    event:
      | WebRtcSdpOfferEnvelope
      | WebRtcIceCandidateEnvelope
      | WebRtcIceCompleteEnvelope
      | WebRtcPeerDisconnectEnvelope,
  ): Promise<void> {
    if (this.disposed) return;
    if (event.type === 'sdp-offer') {
      await this.acceptOffer(event);
      return;
    }
    if (event.type === 'ice-candidate') {
      await this.applyRemoteCandidate(event);
      return;
    }
    if (event.type === 'ice-complete') return;
    if (event.type === 'peer-disconnect') {
      this.close('remote peer disconnected');
    }
  }

  markPlaybackStarted(): void {
    if (
      this.snapshot.state === 'track-received' ||
      this.snapshot.state === 'audio-connected' ||
      this.snapshot.state === 'video-connected' ||
      this.snapshot.state === 'playback-blocked'
    ) {
      this.update({ state: 'playing', playbackBlocked: false, lastError: null });
    }
  }

  markPlaybackBlocked(message: string): void {
    this.update({
      state: 'playback-blocked',
      playbackBlocked: true,
      lastError: details(error('playback-blocked', message, true)),
    });
  }

  close(reason = 'listener transport closed', notifySignalling = true): ListenerWebRtcTransportSnapshot {
    if (this.snapshot.state === 'closed' || this.snapshot.state === 'closing') return this.snapshot;
    this.update({ state: 'closing' });
    this.clearNegotiationTimer();
    this.clearRecoveryTimer();
    try {
      this.audioTrack?.removeEventListener?.('ended', this.handleTrackEnded);
      this.audioTrack = null;
      this.videoTrack?.removeEventListener?.('ended', this.handleVideoTrackEnded);
      this.videoTrack = null;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.pendingRemoteCandidates = [];
      this.seenRemoteCandidates.clear();
      this.peer?.close();
      this.peer = null;
      if (notifySignalling) {
        this.signallingClient.sendPeerDisconnect({
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          revision: this.snapshot.revision,
          reason,
        });
      }
      this.update({
        state: 'closed',
        connectionState: 'none',
        iceConnectionState: 'none',
        remoteAudioTrackReceived: false,
        remoteAudioTrackActive: false,
        remoteVideoTrackReceived: false,
        remoteVideoTrackActive: false,
        playbackBlocked: false,
        queuedRemoteCandidates: 0,
      });
    } catch {
      this.update({
        state: 'failed',
        lastError: details(error('cleanup-failure', 'Listener WebRTC audio cleanup failed.')),
      });
    }
    return this.snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close('listener transport disposed');
  }

  private async acceptOffer(offer: WebRtcSdpOfferEnvelope): Promise<void> {
    const signalling = this.signallingClient.getSnapshot();
    if (
      offer.senderRole !== 'server' ||
      offer.peerId !== WEBRTC_BACKEND_MEDIA_PEER_ID ||
      offer.payload.targetPeerId !== signalling.peerId
    ) {
      throw this.fail(error('invalid-offer', 'Listener received an invalid WebRTC programme-audio offer.', false));
    }
    if (offer.revision < this.snapshot.revision) {
      this.update({
        lastError: details(error('stale-negotiation', 'Ignored stale listener WebRTC offer.')),
      });
      return;
    }
    if (this.peer && this.snapshot.state !== 'closed' && this.snapshot.state !== 'failed') {
      throw this.fail(error('duplicate-peer', 'Listener received a duplicate WebRTC programme-audio offer.', false));
    }
    try {
      const peer = this.createPeerConnection();
      this.peer = peer;
      peer.onicecandidate = this.handleLocalIceCandidate;
      peer.ontrack = this.handleTrack;
      peer.onconnectionstatechange = this.handleConnectionStateChange;
      peer.oniceconnectionstatechange = this.handleIceConnectionStateChange;
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.addTransceiver('video', { direction: 'recvonly' });
      this.update({ state: 'negotiating-programme-media', revision: offer.revision, lastError: null });
      this.startNegotiationTimer();
      await peer.setRemoteDescription({ type: 'offer', sdp: offer.payload.sdp }).catch((err: unknown) => {
        throw normalize(err, 'remote-description-failure', 'Unable to apply listener WebRTC offer.');
      });
      const answer = await peer.createAnswer().catch((err: unknown) => {
        throw normalize(err, 'answer-creation-failure', 'Unable to create listener WebRTC answer.');
      });
      await peer.setLocalDescription(answer).catch((err: unknown) => {
        throw normalize(err, 'local-description-failure', 'Unable to apply listener WebRTC answer.');
      });
      this.signallingClient.sendSdpAnswer({
        targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        sdp: peer.localDescription?.sdp ?? answer.sdp ?? '',
        revision: offer.revision,
      });
      if (!this.snapshot.remoteAudioTrackReceived && !this.snapshot.remoteVideoTrackReceived) {
        this.update({ state: 'connecting' });
      }
      await this.flushCandidates();
    } catch (err) {
      throw this.fail(normalize(err));
    }
  }

  private async applyRemoteCandidate(event: WebRtcIceCandidateEnvelope): Promise<void> {
    if (event.revision !== this.snapshot.revision) {
      this.update({ lastError: details(error('stale-negotiation', 'Ignored stale WebRTC ICE candidate.')) });
      return;
    }
    const candidate: RTCIceCandidateInit = {
      candidate: event.payload.candidate,
      sdpMid: event.payload.sdpMid ?? null,
      sdpMLineIndex: event.payload.sdpMLineIndex ?? null,
    };
    if (event.payload.usernameFragment !== undefined) candidate.usernameFragment = event.payload.usernameFragment;
    const key = `${candidate.sdpMid ?? ''}:${candidate.sdpMLineIndex ?? ''}:${candidate.candidate}`;
    if (this.seenRemoteCandidates.has(key)) return;
    this.seenRemoteCandidates.add(key);
    if (!this.peer?.remoteDescription) {
      if (this.pendingRemoteCandidates.length >= this.maxQueuedRemoteCandidates) {
        throw this.fail(error('ice-candidate-failure', 'Too many queued WebRTC ICE candidates.'));
      }
      this.pendingRemoteCandidates.push(candidate);
      this.update({ queuedRemoteCandidates: this.pendingRemoteCandidates.length });
      return;
    }
    await this.peer.addIceCandidate(candidate).catch((err: unknown) => {
      throw this.fail(normalize(err, 'ice-candidate-failure', 'Unable to apply listener WebRTC ICE candidate.'));
    });
  }

  private async flushCandidates(): Promise<void> {
    while (this.pendingRemoteCandidates.length > 0) {
      const candidate = this.pendingRemoteCandidates.shift();
      if (candidate) await this.peer?.addIceCandidate(candidate);
    }
    this.update({ queuedRemoteCandidates: 0 });
  }

  private handleLocalIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate) return;
    this.signallingClient.sendIceCandidate({
      targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
      revision: this.snapshot.revision,
    });
  };

  private handleTrack = (event: RTCTrackEvent): void => {
    const track = event.track;
    if (!track) return;
    if (track.kind === 'video') {
      this.handleVideoTrack(track, event);
      return;
    }
    if (track.kind !== 'audio') return;
    if (this.audioTrack) {
      this.fail(error('duplicate-peer', 'Listener received duplicate WebRTC audio tracks.', false));
      return;
    }
    this.audioTrack = track;
    track.addEventListener?.('ended', this.handleTrackEnded);
    const shouldPublishStream = this.stream === null;
    const stream = this.mergeRemoteTrack(track, event);
    this.clearNegotiationTimer();
    this.update({
      state: this.snapshot.remoteVideoTrackReceived ? 'video-connected' : 'audio-connected',
      remoteAudioTrackReceived: true,
      remoteAudioTrackActive: track.readyState !== 'ended',
    });
    if (shouldPublishStream) {
      this.onRemoteStream?.(stream);
    }
  };

  private handleVideoTrack(track: MediaStreamTrack, event: RTCTrackEvent): void {
    if (this.videoTrack) {
      this.fail(error('duplicate-peer', 'Listener received duplicate WebRTC video tracks.', false));
      return;
    }
    this.videoTrack = track;
    track.addEventListener?.('ended', this.handleVideoTrackEnded);
    const shouldPublishStream = this.stream === null;
    const stream = this.mergeRemoteTrack(track, event);
    this.clearNegotiationTimer();
    this.update({
      state: this.snapshot.remoteAudioTrackReceived ? 'video-connected' : 'track-received',
      remoteVideoTrackReceived: true,
      remoteVideoTrackActive: track.readyState !== 'ended',
    });
    if (shouldPublishStream) {
      this.onRemoteStream?.(stream);
    }
  }

  private mergeRemoteTrack(track: MediaStreamTrack, event: RTCTrackEvent): MediaStream {
    const stream = this.stream ?? event.streams[0] ?? new MediaStream();
    if (!stream.getTracks().includes(track)) {
      stream.addTrack(track);
    }
    this.stream = stream;
    return stream;
  }

  private handleTrackEnded = (): void => {
    this.update({
      state: 'disconnected',
      remoteAudioTrackActive: false,
      lastError: details(error('audio-track-ended', 'WebRTC programme audio track ended.')),
    });
  };

  private handleVideoTrackEnded = (): void => {
    this.update({
      state: 'video-unavailable',
      remoteVideoTrackActive: false,
      lastError: details(error('video-track-ended', 'WebRTC programme video track ended.')),
    });
  };

  private handleConnectionStateChange = (): void => {
    const state = this.peer?.connectionState ?? 'none';
    if (
      state === 'connected' &&
      (this.snapshot.state === 'track-received' ||
        this.snapshot.state === 'audio-connected' ||
        this.snapshot.state === 'video-connected')
    ) {
      this.markPlaybackStarted();
    }
    if (state === 'failed') {
      if (this.hasEndedRemoteMedia()) {
        this.clearNegotiationTimer();
        this.clearRecoveryTimer();
        this.update({
          state: 'source-ended',
          remoteAudioTrackActive: false,
          remoteVideoTrackActive: false,
          lastError: null,
        });
      } else {
        this.fail(error('connection-closed', 'Listener WebRTC connection failed.'));
      }
    }
    if (state === 'closed') this.update({ state: 'closed' });
    this.update({ connectionState: state });
  };

  private handleIceConnectionStateChange = (): void => {
    const state = this.peer?.iceConnectionState ?? 'none';
    if (state === 'failed') {
      if (this.hasEndedRemoteMedia()) {
        this.clearNegotiationTimer();
        this.clearRecoveryTimer();
        this.update({
          state: 'source-ended',
          remoteAudioTrackActive: false,
          remoteVideoTrackActive: false,
          lastError: null,
        });
      } else {
        this.fail(error('ice-candidate-failure', 'Listener ICE connection failed.'));
      }
    }
    this.update({ iceConnectionState: state });
  };

  private hasEndedRemoteMedia(): boolean {
    const receivedMedia = this.snapshot.remoteAudioTrackReceived || this.snapshot.remoteVideoTrackReceived;
    if (!receivedMedia) return false;
    const audioEnded =
      !this.snapshot.remoteAudioTrackReceived || this.audioTrack?.readyState === 'ended';
    const videoEnded =
      !this.snapshot.remoteVideoTrackReceived || this.videoTrack?.readyState === 'ended';
    return audioEnded && videoEnded;
  }

  private startNegotiationTimer(): void {
    this.clearNegotiationTimer();
    this.negotiationTimer = this.setTimer(() => {
      this.fail(error('negotiation-timeout', 'Timed out waiting for WebRTC programme audio.'));
    }, this.negotiationTimeoutMs);
  }

  private clearNegotiationTimer(): void {
    if (this.negotiationTimer === null) return;
    this.clearTimer(this.negotiationTimer);
    this.negotiationTimer = null;
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null) return;
    this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private fail(err: ListenerWebRtcTransportError): ListenerWebRtcTransportError {
    this.clearNegotiationTimer();
    this.peer?.close();
    this.update({ state: 'failed', lastError: details(err) });
    this.scheduleRecovery(err);
    return err;
  }

  private scheduleRecovery(err: ListenerWebRtcTransportError): void {
    if (this.disposed || !err.retryable) return;
    if (this.snapshot.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.update({
        lastError: details(error('negotiation-timeout', 'Transport retry exhausted. Rejoin the session manually.', false)),
      });
      return;
    }
    const nextAttempt = this.snapshot.recoveryAttempts + 1;
    const delayMs = this.recoveryBackoffMs * 2 ** (nextAttempt - 1);
    this.update({ state: 'recovering', recoveryAttempts: nextAttempt });
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = null;
      try {
        this.close('listener transport recovery reset');
      } catch {
        return;
      }
      void this.signallingClient
        .recoverSessionWithBackoff({ maxAttempts: 1, initialDelayMs: 0 })
        .then(() => {
          if (!this.disposed) this.startWaiting();
        })
        .catch(() => undefined);
    }, delayMs);
  }

  private update(patch: Partial<ListenerWebRtcTransportSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      connectionState: patch.connectionState ?? this.peer?.connectionState ?? this.snapshot.connectionState,
      iceConnectionState: patch.iceConnectionState ?? this.peer?.iceConnectionState ?? this.snapshot.iceConnectionState,
      updatedAt: new Date().toISOString(),
    };
    this.onStateChange?.(this.snapshot);
  }
}

class ListenerWebRtcTransportError extends Error {
  constructor(
    readonly code: ListenerWebRtcTransportErrorCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ListenerWebRtcTransportError';
  }
}

function error(
  code: ListenerWebRtcTransportErrorCode,
  message: string,
  retryable = true,
): ListenerWebRtcTransportError {
  return new ListenerWebRtcTransportError(code, message, retryable);
}

function normalize(
  err: unknown,
  code: ListenerWebRtcTransportErrorCode = 'connection-closed',
  fallback = 'Listener WebRTC transport failed.',
): ListenerWebRtcTransportError {
  if (err instanceof ListenerWebRtcTransportError) return err;
  return error(code, err instanceof Error ? err.message : fallback);
}

function details(err: ListenerWebRtcTransportError): ListenerWebRtcTransportErrorDetails {
  return { code: err.code, message: err.message, retryable: err.retryable };
}

function readIceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_WEBRTC_ICE_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
