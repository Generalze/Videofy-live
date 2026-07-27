import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  type WebRtcIceCandidateEnvelope,
  type WebRtcIceCompleteEnvelope,
  type WebRtcPeerReadyEnvelope,
  type WebRtcSdpAnswerEnvelope,
  type WebRtcSignallingClient,
} from '@videofy-live/shared-types';

export type BroadcasterWebRtcTransportState =
  | 'idle'
  | 'preparing'
  | 'creating-offer'
  | 'awaiting-answer'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'recovering'
  | 'failed'
  | 'closing'
  | 'closed';

export type BroadcasterWebRtcTransportErrorCode =
  | 'webrtc-api-unavailable'
  | 'missing-audio-track'
  | 'duplicate-audio-track'
  | 'offer-creation-failure'
  | 'local-description-failure'
  | 'invalid-answer'
  | 'remote-description-failure'
  | 'ice-candidate-failure'
  | 'negotiation-timeout'
  | 'stale-negotiation'
  | 'connection-closed'
  | 'audio-track-ended'
  | 'cleanup-failure';

export interface BroadcasterWebRtcTransportErrorDetails {
  code: BroadcasterWebRtcTransportErrorCode;
  message: string;
  retryable: boolean;
}

export class BroadcasterWebRtcTransportError extends Error {
  constructor(
    readonly code: BroadcasterWebRtcTransportErrorCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'BroadcasterWebRtcTransportError';
  }
}

export interface BroadcasterWebRtcTransportSnapshot {
  state: BroadcasterWebRtcTransportState;
  revision: number;
  connectionState: RTCPeerConnectionState | 'none';
  iceConnectionState: RTCIceConnectionState | 'none';
  localAudioTrackAttached: boolean;
  backendPeerConnected: boolean;
  backendAudioTrackReceived: boolean;
  backendAudioActivityDetected: boolean;
  queuedRemoteCandidates: number;
  recoveryAttempts: number;
  lastError: BroadcasterWebRtcTransportErrorDetails | null;
  updatedAt: string;
}

interface PeerConnectionLike {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  localDescription: RTCSessionDescription | null;
  remoteDescription: RTCSessionDescription | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: ((event?: Event) => void) | null;
  oniceconnectionstatechange: ((event?: Event) => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export interface BroadcasterWebRtcTransportControllerOptions {
  signallingClient: WebRtcSignallingClient;
  targetPeerId?: string;
  createPeerConnection?: () => PeerConnectionLike;
  answerTimeoutMs?: number;
  iceConnectionTimeoutMs?: number;
  maxQueuedRemoteCandidates?: number;
  maxRecoveryAttempts?: number;
  recoveryBackoffMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
  onStateChange?: (snapshot: BroadcasterWebRtcTransportSnapshot) => void;
  onSafeLog?: (event: string, metadata: Record<string, string | number | boolean | null>) => void;
}

const DEFAULT_ANSWER_TIMEOUT_MS = 8_000;
const DEFAULT_ICE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED_CANDIDATES = 32;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;
const DEFAULT_RECOVERY_BACKOFF_MS = 500;

export function createInitialBroadcasterWebRtcTransportSnapshot(): BroadcasterWebRtcTransportSnapshot {
  return {
    state: 'idle',
    revision: 0,
    connectionState: 'none',
    iceConnectionState: 'none',
    localAudioTrackAttached: false,
    backendPeerConnected: false,
    backendAudioTrackReceived: false,
    backendAudioActivityDetected: false,
    queuedRemoteCandidates: 0,
    recoveryAttempts: 0,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export class BroadcasterWebRtcTransportController {
  private readonly signallingClient: WebRtcSignallingClient;
  private readonly targetPeerId: string;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly answerTimeoutMs: number;
  private readonly iceConnectionTimeoutMs: number;
  private readonly maxQueuedRemoteCandidates: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timer: number) => void;
  private readonly onStateChange:
    | ((snapshot: BroadcasterWebRtcTransportSnapshot) => void)
    | undefined;
  private readonly onSafeLog:
    | ((event: string, metadata: Record<string, string | number | boolean | null>) => void)
    | undefined;

  private snapshot = createInitialBroadcasterWebRtcTransportSnapshot();
  private peer: PeerConnectionLike | null = null;
  private attachedTrack: MediaStreamTrack | null = null;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private seenRemoteCandidates = new Set<string>();
  private answerTimer: number | null = null;
  private iceTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private sourceStream: MediaStream | null = null;
  private disposed = false;

  constructor(options: BroadcasterWebRtcTransportControllerOptions) {
    this.signallingClient = options.signallingClient;
    this.targetPeerId = options.targetPeerId ?? WEBRTC_BACKEND_MEDIA_PEER_ID;
    this.createPeerConnection =
      options.createPeerConnection ??
      (() => {
        if (!globalThis.RTCPeerConnection) {
          throw new BroadcasterWebRtcTransportError(
            'webrtc-api-unavailable',
            'This browser does not support WebRTC audio transport.',
            false,
          );
        }
        return new RTCPeerConnection({ iceServers: readIceServers() }) as unknown as PeerConnectionLike;
      });
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.iceConnectionTimeoutMs = options.iceConnectionTimeoutMs ?? DEFAULT_ICE_TIMEOUT_MS;
    this.maxQueuedRemoteCandidates =
      options.maxQueuedRemoteCandidates ?? DEFAULT_MAX_QUEUED_CANDIDATES;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS;
    this.recoveryBackoffMs = options.recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number);
    this.clearTimer =
      options.clearTimer ??
      ((timer) => globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));
    this.onStateChange = options.onStateChange;
    this.onSafeLog = options.onSafeLog;
  }

  getSnapshot(): BroadcasterWebRtcTransportSnapshot {
    return this.snapshot;
  }

  async start(stream: MediaStream | null): Promise<BroadcasterWebRtcTransportSnapshot> {
    if (this.snapshot.state !== 'idle' && this.snapshot.state !== 'closed' && this.snapshot.state !== 'failed') {
      throw this.fail(
        new BroadcasterWebRtcTransportError(
          'duplicate-audio-track',
          'Audio transport is already starting or active.',
        ),
      );
    }
    const audioTrack = this.requireSingleActiveAudioTrack(stream);
    this.sourceStream = stream;
    const signalling = this.signallingClient.getSnapshot();
    if (!signalling.connected || !signalling.sessionId) {
      throw this.fail(
        new BroadcasterWebRtcTransportError(
          'missing-audio-track',
          'Create a broadcaster signalling session before starting audio transport.',
        ),
      );
    }

    this.update({
      state: 'preparing',
      revision: signalling.revision + 1,
      backendPeerConnected: false,
      backendAudioTrackReceived: false,
      backendAudioActivityDetected: false,
      recoveryAttempts: this.snapshot.recoveryAttempts,
      lastError: null,
    });

    try {
      const peer = this.createPeerConnection();
      this.peer = peer;
      peer.onicecandidate = this.handleLocalIceCandidate;
      peer.onconnectionstatechange = this.handleConnectionStateChange;
      peer.oniceconnectionstatechange = this.handleIceConnectionStateChange;
      audioTrack.addEventListener?.('ended', this.handleTrackEnded);
      peer.addTrack(audioTrack, stream!);
      this.attachedTrack = audioTrack;
      this.update({ localAudioTrackAttached: true });

      this.update({ state: 'creating-offer' });
      const offer = await peer.createOffer().catch((error: unknown) => {
        throw normalizeTransportError(error, 'offer-creation-failure', 'Unable to create WebRTC audio offer.');
      });
      await peer.setLocalDescription(offer).catch((error: unknown) => {
        throw normalizeTransportError(error, 'local-description-failure', 'Unable to apply local WebRTC offer.');
      });
      this.update({ state: 'awaiting-answer' });
      this.startAnswerTimer();
      this.signallingClient.sendSdpOffer({
        targetPeerId: this.targetPeerId,
        sdp: peer.localDescription?.sdp ?? offer.sdp ?? '',
        revision: this.snapshot.revision,
      });
      this.safeLog('offer-sent', { revision: this.snapshot.revision });
      return this.snapshot;
    } catch (error) {
      throw this.fail(normalizeTransportError(error));
    }
  }

  async handleSignallingEvent(
    event:
      | WebRtcSdpAnswerEnvelope
      | WebRtcIceCandidateEnvelope
      | WebRtcIceCompleteEnvelope
      | WebRtcPeerReadyEnvelope,
  ): Promise<void> {
    if (this.disposed) return;
    if (event.revision !== this.snapshot.revision) {
      this.update({
        lastError: errorDetails(
          new BroadcasterWebRtcTransportError(
            'stale-negotiation',
            'Ignored stale WebRTC media negotiation message.',
          ),
        ),
      });
      return;
    }
    if (event.type === 'sdp-answer') {
      await this.applyRemoteAnswer(event);
      return;
    }
    if (event.type === 'ice-candidate') {
      const candidate: RTCIceCandidateInit = {
        candidate: event.payload.candidate,
        sdpMid: event.payload.sdpMid ?? null,
        sdpMLineIndex: event.payload.sdpMLineIndex ?? null,
      };
      if (event.payload.usernameFragment !== undefined) {
        candidate.usernameFragment = event.payload.usernameFragment;
      }
      await this.applyRemoteCandidate(candidate);
      return;
    }
    if (event.type === 'peer-ready') {
      this.update({
        backendPeerConnected: true,
        backendAudioTrackReceived: true,
        backendAudioActivityDetected: true,
        state: this.snapshot.state === 'connected' ? 'connected' : this.snapshot.state,
      });
    }
  }

  async close(reason = 'operator stopped backend audio transport'): Promise<BroadcasterWebRtcTransportSnapshot> {
    if (this.snapshot.state === 'closed' || this.snapshot.state === 'closing') return this.snapshot;
    this.update({ state: 'closing' });
    try {
      this.signalBackendPeerDisconnect(reason);
      this.clearTimers();
      this.clearRecoveryTimer();
      this.attachedTrack?.removeEventListener?.('ended', this.handleTrackEnded);
      this.attachedTrack = null;
      this.pendingRemoteCandidates = [];
      this.seenRemoteCandidates.clear();
      this.peer?.close();
      this.peer = null;
      this.update({
        state: 'closed',
        connectionState: 'closed',
        iceConnectionState: 'closed',
        localAudioTrackAttached: false,
        queuedRemoteCandidates: 0,
      });
      this.safeLog('transport-closed', { reason });
      return this.snapshot;
    } catch (error) {
      throw this.fail(normalizeTransportError(error, 'cleanup-failure', 'WebRTC audio transport cleanup failed.'));
    }
  }

  async recover(stream: MediaStream | null): Promise<BroadcasterWebRtcTransportSnapshot> {
    await this.close('transport recovery reset').catch(() => undefined);
    this.update({
      state: 'idle',
      revision: this.signallingClient.getSnapshot().revision,
      recoveryAttempts: this.snapshot.recoveryAttempts,
    });
    return this.start(stream);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.close('component teardown').catch(() => undefined);
  }

  private async applyRemoteAnswer(event: WebRtcSdpAnswerEnvelope): Promise<void> {
    const peer = this.requirePeer();
    if (!event.payload.sdp.trim()) {
      throw this.fail(new BroadcasterWebRtcTransportError('invalid-answer', 'Backend returned an invalid WebRTC answer.'));
    }
    this.clearAnswerTimer();
    await peer.setRemoteDescription({ type: 'answer', sdp: event.payload.sdp }).catch((error: unknown) => {
      throw normalizeTransportError(error, 'remote-description-failure', 'Unable to apply backend WebRTC answer.');
    });
    this.update({ state: 'connecting' });
    this.startIceTimer();
    await this.flushQueuedRemoteCandidates();
  }

  private async applyRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const key = `${candidate.sdpMid ?? ''}:${candidate.sdpMLineIndex ?? ''}:${candidate.candidate}`;
    if (this.seenRemoteCandidates.has(key)) return;
    this.seenRemoteCandidates.add(key);
    if (this.seenRemoteCandidates.size > this.maxQueuedRemoteCandidates) {
      const [first] = this.seenRemoteCandidates;
      if (first) this.seenRemoteCandidates.delete(first);
    }
    if (!this.peer?.remoteDescription) {
      if (this.pendingRemoteCandidates.length >= this.maxQueuedRemoteCandidates) {
        throw this.fail(new BroadcasterWebRtcTransportError('ice-candidate-failure', 'Too many queued remote ICE candidates.'));
      }
      this.pendingRemoteCandidates.push(candidate);
      this.update({ queuedRemoteCandidates: this.pendingRemoteCandidates.length });
      return;
    }
    await this.peer.addIceCandidate(candidate).catch((error: unknown) => {
      throw normalizeTransportError(error, 'ice-candidate-failure', 'Unable to apply backend ICE candidate.');
    });
  }

  private async flushQueuedRemoteCandidates(): Promise<void> {
    const candidates = this.pendingRemoteCandidates.splice(0);
    this.update({ queuedRemoteCandidates: 0 });
    for (const candidate of candidates) {
      await this.peer?.addIceCandidate(candidate).catch((error: unknown) => {
        throw normalizeTransportError(error, 'ice-candidate-failure', 'Unable to apply backend ICE candidate.');
      });
    }
  }

  private handleLocalIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!event.candidate || !event.candidate.candidate.trim()) {
      this.signallingClient.sendIceComplete({
        targetPeerId: this.targetPeerId,
        revision: this.snapshot.revision,
      });
      return;
    }
    this.signallingClient.sendIceCandidate({
      targetPeerId: this.targetPeerId,
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid?.trim() ? event.candidate.sdpMid : null,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      usernameFragment: event.candidate.usernameFragment,
      revision: this.snapshot.revision,
    });
  };

  private handleConnectionStateChange = (): void => {
    const peer = this.peer;
    if (!peer) return;
    const state = peer.connectionState;
    this.update({ connectionState: state });
    if (state === 'connected') {
      this.clearIceTimer();
      this.update({ state: 'connected', backendPeerConnected: true });
      return;
    }
    if (state === 'disconnected') this.update({ state: 'disconnected' });
    if (state === 'failed') {
      this.fail(new BroadcasterWebRtcTransportError('ice-candidate-failure', 'WebRTC audio transport failed.'));
    }
    if (state === 'closed') this.update({ state: 'closed' });
  };

  private handleIceConnectionStateChange = (): void => {
    const peer = this.peer;
    if (!peer) return;
    const state = peer.iceConnectionState;
    this.update({ iceConnectionState: state });
    if (state === 'connected' || state === 'completed') {
      this.clearIceTimer();
      this.update({ backendPeerConnected: true });
    }
    if (state === 'failed') {
      this.fail(new BroadcasterWebRtcTransportError('ice-candidate-failure', 'WebRTC ICE connection failed.'));
    }
  };

  private handleTrackEnded = (): void => {
    this.fail(new BroadcasterWebRtcTransportError('audio-track-ended', 'Local programme audio track ended.'));
    void this.close('local programme audio track ended').catch(() => undefined);
  };

  private requireSingleActiveAudioTrack(stream: MediaStream | null): MediaStreamTrack {
    const audioTracks = stream?.getAudioTracks() ?? [];
    const activeTracks = audioTracks.filter((track) => track.readyState === 'live');
    if (activeTracks.length === 0) {
      throw new BroadcasterWebRtcTransportError(
        'missing-audio-track',
        'Start local broadcaster capture before starting audio transport.',
      );
    }
    if (activeTracks.length > 1) {
      throw new BroadcasterWebRtcTransportError(
        'duplicate-audio-track',
        'Only one programme audio track can be sent to the backend.',
      );
    }
    return activeTracks[0]!;
  }

  private requirePeer(): PeerConnectionLike {
    if (!this.peer) {
      throw this.fail(new BroadcasterWebRtcTransportError('connection-closed', 'WebRTC audio transport is closed.'));
    }
    return this.peer;
  }

  private startAnswerTimer(): void {
    this.clearAnswerTimer();
    this.answerTimer = this.setTimer(() => {
      this.fail(new BroadcasterWebRtcTransportError('negotiation-timeout', 'Timed out waiting for backend WebRTC answer.'));
    }, this.answerTimeoutMs);
  }

  private startIceTimer(): void {
    this.clearIceTimer();
    this.iceTimer = this.setTimer(() => {
      this.fail(new BroadcasterWebRtcTransportError('negotiation-timeout', 'Timed out waiting for WebRTC ICE connection.'));
    }, this.iceConnectionTimeoutMs);
  }

  private clearTimers(): void {
    this.clearAnswerTimer();
    this.clearIceTimer();
    this.clearRecoveryTimer();
  }

  private clearAnswerTimer(): void {
    if (!this.answerTimer) return;
    this.clearTimer(this.answerTimer);
    this.answerTimer = null;
  }

  private clearIceTimer(): void {
    if (!this.iceTimer) return;
    this.clearTimer(this.iceTimer);
    this.iceTimer = null;
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) return;
    this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private fail(error: BroadcasterWebRtcTransportError): BroadcasterWebRtcTransportError {
    if (!this.disposed) {
      this.clearTimers();
      this.update({ state: 'failed', lastError: errorDetails(error) });
      this.safeLog('transport-failed', { code: error.code, retryable: error.retryable });
      this.scheduleRecovery(error);
    }
    return error;
  }

  private scheduleRecovery(error: BroadcasterWebRtcTransportError): void {
    if (!error.retryable || !this.canRecoverSourceStream()) return;
    if (this.snapshot.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.update({
        lastError: errorDetails(
          new BroadcasterWebRtcTransportError(
            'negotiation-timeout',
            'Transport retry exhausted. Restart broadcaster transport manually.',
            false,
          ),
        ),
      });
      return;
    }
    const nextAttempt = this.snapshot.recoveryAttempts + 1;
    const delayMs = this.recoveryBackoffMs * 2 ** (nextAttempt - 1);
    this.update({ state: 'recovering', recoveryAttempts: nextAttempt });
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = null;
      const stream = this.sourceStream;
      if (!this.canRecoverSourceStream()) return;
      void this.recover(stream).catch(() => undefined);
    }, delayMs);
  }

  private canRecoverSourceStream(): boolean {
    const stream = this.sourceStream;
    if (!stream) return false;
    return stream.getAudioTracks().filter((track) => track.readyState === 'live').length === 1;
  }

  private update(next: Partial<BroadcasterWebRtcTransportSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, updatedAt: new Date().toISOString() };
    this.onStateChange?.(this.snapshot);
  }

  private safeLog(
    event: string,
    metadata: Record<string, string | number | boolean | null> = {},
  ): void {
    this.onSafeLog?.(event, {
      state: this.snapshot.state,
      revision: this.snapshot.revision,
      backendPeerConnected: this.snapshot.backendPeerConnected,
      backendAudioActivityDetected: this.snapshot.backendAudioActivityDetected,
      ...metadata,
    });
  }

  private signalBackendPeerDisconnect(reason: string): void {
    const signalling = this.signallingClient.getSnapshot();
    if (!signalling.connected || !signalling.sessionId || this.snapshot.revision <= 0) return;
    try {
      this.signallingClient.sendPeerDisconnect({
        targetPeerId: this.targetPeerId,
        reason,
        revision: this.snapshot.revision,
      });
    } catch (error) {
      this.safeLog('transport-disconnect-signal-failed', {
        code: error instanceof Error ? 'peer-disconnect-failure' : 'unknown',
      });
    }
  }
}

function normalizeTransportError(
  error: unknown,
  fallbackCode: BroadcasterWebRtcTransportErrorCode = 'offer-creation-failure',
  fallbackMessage = 'WebRTC audio transport failed.',
): BroadcasterWebRtcTransportError {
  if (error instanceof BroadcasterWebRtcTransportError) return error;
  if (error instanceof Error) {
    return new BroadcasterWebRtcTransportError(fallbackCode, fallbackMessage);
  }
  return new BroadcasterWebRtcTransportError(fallbackCode, fallbackMessage);
}

function errorDetails(
  error: BroadcasterWebRtcTransportError,
): BroadcasterWebRtcTransportErrorDetails {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function readIceServers(): RTCIceServer[] {
  const raw = import.meta.env['VITE_WEBRTC_ICE_SERVERS'];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
