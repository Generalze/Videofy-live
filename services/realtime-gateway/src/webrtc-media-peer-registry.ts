import { randomUUID } from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import type {
  WebRtcIceCandidateEnvelope,
  WebRtcIncomingSignallingEnvelope,
  WebRtcPeerReadyEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_LIMITS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
} from '@videofy-live/shared-types';
import {
  WebRtcAudioIngestBridge,
  type WebRtcAudioIngestBridgeSnapshot,
  type MediaAudioDataLike,
} from './webrtc-audio-ingest-bridge.js';
import { logger } from './logger.js';

export type BackendMediaPeerState = 'creating' | 'negotiating' | 'connected' | 'failed' | 'closing' | 'closed';
export type BackendMediaTrackState = 'none' | 'received' | 'active' | 'ended' | 'failed';

export type BackendMediaPeerErrorCode =
  | 'backend-webrtc-unavailable'
  | 'dependency-initialization-failure'
  | 'peer-already-exists'
  | 'peer-not-found'
  | 'missing-audio-track'
  | 'duplicate-audio-track'
  | 'missing-video-track'
  | 'duplicate-video-track'
  | 'unexpected-video-track'
  | 'invalid-offer'
  | 'answer-creation-failure'
  | 'local-description-failure'
  | 'remote-description-failure'
  | 'ice-candidate-failure'
  | 'ice-connection-failure'
  | 'negotiation-timeout'
  | 'stale-negotiation'
  | 'connection-closed'
  | 'audio-track-ended'
  | 'video-track-ended'
  | 'ingest-bridge-failure'
  | 'cleanup-failure'
  | 'unsupported-runtime';

export class BackendMediaPeerError extends Error {
  constructor(
    readonly code: BackendMediaPeerErrorCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'BackendMediaPeerError';
  }
}

export interface BackendMediaPeerSnapshot {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  broadcasterSocketId: string;
  backendPeerId: string;
  revision: number;
  state: BackendMediaPeerState;
  connectionState: string;
  iceConnectionState: string;
  audioTrackState: BackendMediaTrackState;
  videoTrackState: BackendMediaTrackState;
  ingestBridgeState: WebRtcAudioIngestBridgeSnapshot['state'];
  /** W3: the true input format, so the diagnostics endpoint stops hiding it. */
  audioInputSampleRate: number | null;
  audioInputChannelCount: number | null;
  videoExpected: boolean;
  audioFrameCount: number;
  videoFrameCount: number;
  audioActivityDetected: boolean;
  videoActivityDetected: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastError: { code: BackendMediaPeerErrorCode; message: string; retryable: boolean } | null;
}

export interface BackendMediaPeerRegistryOptions {
  maxActivePeers?: number;
  offerToAnswerTimeoutMs?: number;
  firstAudioTimeoutMs?: number;
  videoReadyGraceMs?: number;
  maxQueuedCandidates?: number;
  createPeerConnection?: () => PeerConnectionLike;
  createAudioSink?: (track: TrackLike) => AudioSinkLike;
  createVideoSink?: (track: TrackLike) => VideoSinkLike;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onLocalSignal?: (
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
    >,
  ) => void;
  onPeerReady?: (envelope: WebRtcPeerReadyEnvelope) => void;
  onTrackReady?: (context: BackendMediaPeerAudioContext) => void;
  onAudioFrame?: (
    context: BackendMediaPeerAudioContext,
    data: MediaAudioDataLike,
    frame: ReturnType<WebRtcAudioIngestBridge['recordFrame']>,
  ) => void;
  onVideoFrame?: (
    context: BackendMediaPeerAudioContext,
    frame: WebRtcVideoFrameLike,
  ) => void;
  onVideoEnded?: (context: BackendMediaPeerAudioContext, reason: string) => void;
  onAudioPeerClosed?: (context: BackendMediaPeerAudioContext, reason: string) => void;
}

export interface BackendMediaPeerAudioContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
}

interface PeerConnectionLike {
  connectionState: string;
  iceConnectionState: string;
  localDescription?: { sdp?: string | null } | null;
  onicecandidate: ((event: { candidate: CandidateLike | null }) => void) | null;
  ontrack: ((event: TrackEventLike) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>;
  setLocalDescription(description: { type: 'answer'; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: CandidateInitLike): Promise<void>;
  close(): void;
}

interface CandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface CandidateInitLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface TrackLike {
  kind: string;
  readyState?: string;
  id?: string;
  onended?: (() => void) | null;
  addEventListener?: (eventName: string, listener: () => void) => void;
  removeEventListener?: (eventName: string, listener: () => void) => void;
}

interface TrackEventLike {
  track?: TrackLike;
  receiver?: { track?: TrackLike };
  transceiver?: { receiver?: { track?: TrackLike } };
}

interface AudioSinkLike {
  ondata: ((data: MediaAudioDataLike) => void) | null;
  stop(): void;
}

export interface WebRtcVideoFrameLike {
  width?: number;
  height?: number;
  data?: unknown;
}

interface VideoSinkLike {
  onframe: ((event: { frame?: WebRtcVideoFrameLike } | WebRtcVideoFrameLike) => void) | null;
  stop(): void;
}

interface BackendIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface BackendMediaPeerRecord {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  broadcasterSocketId: string;
  backendPeerId: string;
  revision: number;
  peer: PeerConnectionLike;
  bridge: WebRtcAudioIngestBridge;
  audioSink: AudioSinkLike | null;
  videoSink: VideoSinkLike | null;
  audioTrack: TrackLike | null;
  videoTrack: TrackLike | null;
  videoExpected: boolean;
  videoFrameCount: number;
  queuedRemoteCandidates: CandidateInitLike[];
  seenRemoteCandidates: Set<string>;
  state: BackendMediaPeerState;
  audioTrackState: BackendMediaTrackState;
  videoTrackState: BackendMediaTrackState;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date | null;
  lastError: BackendMediaPeerSnapshot['lastError'];
  offerTimer: ReturnType<typeof setTimeout> | null;
  audioTimer: ReturnType<typeof setTimeout> | null;
  videoGraceTimer: ReturnType<typeof setTimeout> | null;
  readyEmitted: boolean;
}

const BACKEND_SOCKET_ID = 'gateway_backend_media';
const DEFAULT_MAX_ACTIVE_PEERS = 25;
const DEFAULT_OFFER_TIMEOUT_MS = 8_000;
const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 12_000;
const DEFAULT_VIDEO_READY_GRACE_MS = 3_000;
const DEFAULT_MAX_QUEUED_CANDIDATES = 64;

export class BackendWebRtcMediaPeerRegistry {
  private readonly peers = new Map<string, BackendMediaPeerRecord>();
  private readonly maxActivePeers: number;
  private readonly offerToAnswerTimeoutMs: number;
  private readonly firstAudioTimeoutMs: number;
  private readonly videoReadyGraceMs: number;
  private readonly maxQueuedCandidates: number;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly createAudioSink: (track: TrackLike) => AudioSinkLike;
  private readonly createVideoSink: (track: TrackLike) => VideoSinkLike;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onLocalSignal:
    | ((
        envelope: Exclude<
          WebRtcIncomingSignallingEnvelope,
          Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
        >,
      ) => void)
    | undefined;
  private readonly onPeerReady: ((envelope: WebRtcPeerReadyEnvelope) => void) | undefined;
  private readonly onTrackReady: ((context: BackendMediaPeerAudioContext) => void) | undefined;
  private readonly onAudioFrame:
    | ((
        context: BackendMediaPeerAudioContext,
        data: MediaAudioDataLike,
        frame: ReturnType<WebRtcAudioIngestBridge['recordFrame']>,
      ) => void)
    | undefined;
  private readonly onVideoFrame:
    | ((context: BackendMediaPeerAudioContext, frame: WebRtcVideoFrameLike) => void)
    | undefined;
  private readonly onVideoEnded:
    | ((context: BackendMediaPeerAudioContext, reason: string) => void)
    | undefined;
  private readonly onAudioPeerClosed:
    | ((context: BackendMediaPeerAudioContext, reason: string) => void)
    | undefined;

  constructor(options: BackendMediaPeerRegistryOptions = {}) {
    assertBackendRuntime();
    this.maxActivePeers = options.maxActivePeers ?? DEFAULT_MAX_ACTIVE_PEERS;
    this.offerToAnswerTimeoutMs = options.offerToAnswerTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
    this.firstAudioTimeoutMs = options.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS;
    this.videoReadyGraceMs = options.videoReadyGraceMs ?? DEFAULT_VIDEO_READY_GRACE_MS;
    this.maxQueuedCandidates = options.maxQueuedCandidates ?? DEFAULT_MAX_QUEUED_CANDIDATES;
    this.createPeerConnection =
      options.createPeerConnection ??
      (() =>
        new wrtc.RTCPeerConnection({
          iceServers: readBackendIceServers(),
        }) as unknown as PeerConnectionLike);
    this.createAudioSink =
      options.createAudioSink ??
      ((track) => new wrtc.nonstandard.RTCAudioSink(track as never) as unknown as AudioSinkLike);
    this.createVideoSink =
      options.createVideoSink ??
      ((track) => new wrtc.nonstandard.RTCVideoSink(track as never) as unknown as VideoSinkLike);
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onLocalSignal = options.onLocalSignal;
    this.onPeerReady = options.onPeerReady;
    this.onTrackReady = options.onTrackReady;
    this.onAudioFrame = options.onAudioFrame;
    this.onVideoFrame = options.onVideoFrame;
    this.onVideoEnded = options.onVideoEnded;
    this.onAudioPeerClosed = options.onAudioPeerClosed;
  }

  get backendSocketId(): string {
    return BACKEND_SOCKET_ID;
  }

  async acceptOffer(
    socketId: string,
    offer: WebRtcSdpOfferEnvelope,
    session: WebRtcSessionSummary,
  ): Promise<WebRtcSdpAnswerEnvelope> {
    if (offer.payload.targetPeerId !== WEBRTC_BACKEND_MEDIA_PEER_ID) {
      throw new BackendMediaPeerError('peer-not-found', 'Offer does not target backend media peer.', false);
    }
    if (offer.revision !== session.revision) {
      throw new BackendMediaPeerError('stale-negotiation', 'Offer revision is stale.', false);
    }
    const existing = this.peers.get(offer.sessionId!);
    if (existing && existing.state !== 'closed' && existing.state !== 'failed') {
      throw new BackendMediaPeerError('peer-already-exists', 'Backend media peer already exists for this session.', false);
    }
    if (this.activePeerCount() >= this.maxActivePeers) {
      throw new BackendMediaPeerError('backend-webrtc-unavailable', 'Backend WebRTC media peer capacity reached.', true);
    }

    const peer = this.createPeerConnection();
    const bridge = new WebRtcAudioIngestBridge({
      sessionId: offer.sessionId!,
      broadcastId: offer.broadcastId,
      broadcasterPeerId: offer.peerId,
      revision: offer.revision,
    });
    bridge.open();
    const now = this.now();
    const record: BackendMediaPeerRecord = {
      sessionId: offer.sessionId!,
      broadcastId: offer.broadcastId,
      broadcasterPeerId: offer.peerId,
      broadcasterSocketId: socketId,
      backendPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      revision: offer.revision,
      peer,
      bridge,
      audioSink: null,
      videoSink: null,
      audioTrack: null,
      videoTrack: null,
      videoExpected: offerHasVideo(offer),
      videoFrameCount: 0,
      queuedRemoteCandidates: [],
      seenRemoteCandidates: new Set(),
      state: 'creating',
      audioTrackState: 'none',
      videoTrackState: 'none',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
      lastError: null,
      offerTimer: null,
      audioTimer: null,
      videoGraceTimer: null,
      readyEmitted: false,
    };
    this.peers.set(record.sessionId, record);
    logger.info('Backend WebRTC media peer created', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      activePeerCount: this.activePeerCount(),
    });
    this.bindPeer(record);
    this.startOfferTimer(record);

    try {
      record.state = 'negotiating';
      await peer.setRemoteDescription({ type: 'offer', sdp: offer.payload.sdp });
      const answer = await peer.createAnswer().catch((error: unknown) => {
        throw normalizeBackendError(error, 'answer-creation-failure', 'Backend could not create WebRTC answer.');
      });
      await peer.setLocalDescription(answer).catch((error: unknown) => {
        throw normalizeBackendError(error, 'local-description-failure', 'Backend could not apply WebRTC answer.');
      });
      this.clearOfferTimer(record);
      this.startAudioTimer(record);
      this.touch(record);
      return {
        type: 'sdp-answer',
        protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
        messageId: `msg_${randomUUID()}`,
        correlationId: offer.correlationId ?? offer.messageId,
        broadcastId: offer.broadcastId,
        sessionId: record.sessionId,
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision: offer.revision,
        createdAt: this.now().toISOString(),
        payload: {
          targetPeerId: offer.peerId,
          sdp: peer.localDescription?.sdp ?? answer.sdp ?? '',
        },
      };
    } catch (error) {
      this.fail(record, normalizeBackendError(error));
      throw error;
    }
  }

  async addRemoteCandidate(envelope: WebRtcIceCandidateEnvelope): Promise<void> {
    const record = this.requirePeer(envelope.sessionId);
    if (envelope.revision !== record.revision) {
      throw new BackendMediaPeerError('stale-negotiation', 'Remote ICE candidate revision is stale.', false);
    }
    const candidate: CandidateInitLike = {
      candidate: envelope.payload.candidate,
      sdpMid: envelope.payload.sdpMid ?? null,
      sdpMLineIndex: envelope.payload.sdpMLineIndex ?? null,
    };
    if (envelope.payload.usernameFragment !== undefined) {
      candidate.usernameFragment = envelope.payload.usernameFragment;
    }
    const key = `${candidate.sdpMid ?? ''}:${candidate.sdpMLineIndex ?? ''}:${candidate.candidate}`;
    if (record.seenRemoteCandidates.has(key)) return;
    record.seenRemoteCandidates.add(key);
    if (record.seenRemoteCandidates.size > this.maxQueuedCandidates) {
      const [first] = record.seenRemoteCandidates;
      if (first) record.seenRemoteCandidates.delete(first);
    }
    if (!record.peer.localDescription) {
      if (record.queuedRemoteCandidates.length >= this.maxQueuedCandidates) {
        throw new BackendMediaPeerError('ice-candidate-failure', 'Too many queued remote ICE candidates.');
      }
      record.queuedRemoteCandidates.push(candidate);
      return;
    }
    await record.peer.addIceCandidate(candidate).catch((error: unknown) => {
      throw normalizeBackendError(error, 'ice-candidate-failure', 'Backend could not apply remote ICE candidate.');
    });
    this.touch(record);
  }

  closeSession(sessionId: string | undefined, reason = 'signalling session closed'): void {
    if (!sessionId) return;
    const record = this.peers.get(sessionId);
    if (!record) return;
    this.closeRecord(record, reason);
  }

  closeByBroadcasterSocket(socketId: string): void {
    for (const record of this.peers.values()) {
      if (record.broadcasterSocketId === socketId) {
        this.closeRecord(record, 'broadcaster socket disconnected');
      }
    }
  }

  getSnapshot(sessionId: string): BackendMediaPeerSnapshot | null {
    const record = this.peers.get(sessionId);
    return record ? this.snapshot(record) : null;
  }

  getSnapshots(): BackendMediaPeerSnapshot[] {
    return [...this.peers.values()].map((record) => this.snapshot(record));
  }

  private bindPeer(record: BackendMediaPeerRecord): void {
    record.peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.onLocalSignal?.({
        type: 'ice-candidate',
        protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
        messageId: `msg_${randomUUID()}`,
        broadcastId: record.broadcastId,
        sessionId: record.sessionId,
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision: record.revision,
        createdAt: this.now().toISOString(),
        payload: {
          targetPeerId: record.broadcasterPeerId,
          candidate: event.candidate.candidate,
          sdpMid: nonEmptyStringOrNull(event.candidate.sdpMid ?? null),
          sdpMLineIndex: validSdpMLineIndexOrNull(event.candidate.sdpMLineIndex ?? null),
          usernameFragment: nonEmptyStringOrNull(event.candidate.usernameFragment ?? null),
        },
      });
    };
    record.peer.ontrack = (event) => this.handleTrack(record, event);
    record.peer.onconnectionstatechange = () => {
      if (record.peer.connectionState === 'connected') record.state = 'connected';
      if (record.peer.connectionState === 'failed') {
        this.fail(record, new BackendMediaPeerError('ice-connection-failure', 'Backend WebRTC connection failed.'));
      }
      if (record.peer.connectionState === 'closed') record.state = 'closed';
      this.touch(record);
    };
    record.peer.oniceconnectionstatechange = () => {
      if (record.peer.iceConnectionState === 'failed') {
        this.fail(record, new BackendMediaPeerError('ice-connection-failure', 'Backend ICE connection failed.'));
      }
      this.touch(record);
    };
  }

  private handleTrack(record: BackendMediaPeerRecord, event: TrackEventLike): void {
    const track = event.track ?? event.receiver?.track ?? event.transceiver?.receiver?.track;
    if (!track) {
      this.fail(record, new BackendMediaPeerError('missing-audio-track', 'Backend received no media track.'));
      return;
    }
    if (track.kind === 'video') {
      this.handleVideoTrack(record, track);
      return;
    }
    if (track.kind !== 'audio') {
      return;
    }
    if (record.audioTrack) {
      this.fail(record, new BackendMediaPeerError('duplicate-audio-track', 'Backend rejected duplicate audio track.', false));
      return;
    }
    record.audioTrack = track;
    record.audioTrackState = 'received';
    record.bridge.attachTrack();
    logger.info('Backend WebRTC audio track received', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      audioTrackCount: 1,
      trackState: track.readyState ?? 'unknown',
    });
    track.addEventListener?.('ended', () => this.handleTrackEnded(record));
    track.onended = () => this.handleTrackEnded(record);
    try {
      const sink = this.createAudioSink(track);
      record.audioSink = sink;
      this.onTrackReady?.(audioContext(record));
      sink.ondata = (data: MediaAudioDataLike) => {
        try {
          const frame = record.bridge.recordFrame(data);
          this.onAudioFrame?.(audioContext(record), data, frame);
          record.audioTrackState = 'active';
          record.lastActivityAt = new Date(frame.receivedAtMs);
          record.state = record.peer.connectionState === 'connected' ? 'connected' : record.state;
          this.clearAudioTimer(record);
          this.touch(record);
          this.emitReadyOnce(record);
        } catch (error) {
          this.fail(record, normalizeBackendError(error, 'ingest-bridge-failure', 'Backend audio ingest bridge failed.'));
        }
      };
    } catch (error) {
      this.fail(record, normalizeBackendError(error, 'ingest-bridge-failure', 'Backend audio ingest bridge failed.'));
    }
  }

  private handleVideoTrack(record: BackendMediaPeerRecord, track: TrackLike): void {
    if (record.videoTrack) {
      this.fail(record, new BackendMediaPeerError('duplicate-video-track', 'Backend rejected duplicate video track.', false));
      return;
    }
    record.videoTrack = track;
    record.videoTrackState = 'received';
    logger.info('Backend WebRTC video track received', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      videoTrackCount: 1,
      trackState: track.readyState ?? 'unknown',
    });
    track.addEventListener?.('ended', () => this.handleVideoTrackEnded(record));
    track.onended = () => this.handleVideoTrackEnded(record);
    try {
      const sink = this.createVideoSink(track);
      record.videoSink = sink;
      this.onTrackReady?.(audioContext(record));
      sink.onframe = (event: { frame?: WebRtcVideoFrameLike } | WebRtcVideoFrameLike) => {
        const frame = 'frame' in event && event.frame ? event.frame : event as WebRtcVideoFrameLike;
        record.videoFrameCount++;
        record.videoTrackState = 'active';
        record.lastActivityAt = this.now();
        if (record.videoFrameCount === 1) {
          logger.info('Backend WebRTC video frame activity detected', {
            sessionId: record.sessionId,
            broadcastId: record.broadcastId,
            backendPeerId: record.backendPeerId,
            revision: record.revision,
            width: frame.width ?? null,
            height: frame.height ?? null,
            dataBytes: readableByteLength(frame.data),
          });
        }
        this.onVideoFrame?.(audioContext(record), frame);
        this.touch(record);
        this.emitReadyOnce(record);
      };
    } catch (error) {
      this.fail(record, normalizeBackendError(error, 'dependency-initialization-failure', 'Backend video sink failed.'));
    }
  }

  private handleTrackEnded(record: BackendMediaPeerRecord): void {
    record.audioTrackState = 'ended';
    record.bridge.endTrack();
    this.onAudioPeerClosed?.(audioContext(record), 'audio track ended');
    this.fail(record, new BackendMediaPeerError('audio-track-ended', 'Backend audio track ended.'));
  }

  private handleVideoTrackEnded(record: BackendMediaPeerRecord): void {
    record.videoTrackState = 'ended';
    // Never fan out a dataless sentinel frame: a failing synthetic video frame
    // must not be able to tear down a listener peer's audio path. Video-end is
    // reported through the dedicated onVideoEnded callback instead.
    this.onVideoEnded?.(audioContext(record), 'broadcaster video track ended');
    this.touch(record);
    logger.info('Backend WebRTC video track ended', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      revision: record.revision,
    });
  }

  private emitReadyOnce(record: BackendMediaPeerRecord): void {
    if (record.readyEmitted) return;
    if (record.bridge.snapshot().frameCount === 0) return;
    if (record.videoExpected && record.videoFrameCount === 0) {
      // Audio is already flowing; do not withhold peer-ready forever for a
      // video track that never produces frames. Grant a short grace window.
      this.startVideoGraceTimer(record);
      return;
    }
    this.emitReady(record);
  }

  private startVideoGraceTimer(record: BackendMediaPeerRecord): void {
    if (record.videoGraceTimer) return;
    record.videoGraceTimer = this.setTimer(() => {
      record.videoGraceTimer = null;
      if (record.readyEmitted) return;
      if (record.state === 'closed' || record.state === 'closing' || record.state === 'failed') return;
      if (record.bridge.snapshot().frameCount === 0) return;
      logger.warn('Backend WebRTC video frames absent after grace; emitting audio-only peer-ready', {
        sessionId: record.sessionId,
        broadcastId: record.broadcastId,
        backendPeerId: record.backendPeerId,
        revision: record.revision,
        videoExpected: record.videoExpected,
        videoTrackState: record.videoTrackState,
      });
      this.emitReady(record);
    }, this.videoReadyGraceMs);
  }

  private clearVideoGraceTimer(record: BackendMediaPeerRecord): void {
    if (!record.videoGraceTimer) return;
    this.clearTimer(record.videoGraceTimer);
    record.videoGraceTimer = null;
  }

  private emitReady(record: BackendMediaPeerRecord): void {
    record.readyEmitted = true;
    this.clearVideoGraceTimer(record);
    logger.info('Backend WebRTC audio activity detected', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      frameCount: record.bridge.snapshot().frameCount,
      audioTrackState: record.audioTrackState,
      videoExpected: record.videoExpected,
      videoFrameCount: record.videoFrameCount,
    });
    this.onPeerReady?.({
      type: 'peer-ready',
      protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
      messageId: `msg_${randomUUID()}`,
      broadcastId: record.broadcastId,
      sessionId: record.sessionId,
      peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      senderRole: 'server',
      revision: record.revision,
      createdAt: this.now().toISOString(),
      payload: {
        state: 'ready',
        audioTrackReceived: record.audioTrack !== null,
        videoTrackReceived: record.videoTrack !== null,
      },
    });
  }

  private closeRecord(record: BackendMediaPeerRecord, reason: string): void {
    if (record.state === 'closed' || record.state === 'closing') return;
    record.state = 'closing';
    this.clearOfferTimer(record);
    this.clearAudioTimer(record);
    this.clearVideoGraceTimer(record);
    try {
      record.audioSink?.stop();
      record.audioSink = null;
      record.videoSink?.stop();
      record.videoSink = null;
      record.bridge.close();
      this.onAudioPeerClosed?.(audioContext(record), reason);
      record.peer.close();
      record.queuedRemoteCandidates = [];
      record.seenRemoteCandidates.clear();
      record.state = 'closed';
      record.updatedAt = this.now();
      this.peers.delete(record.sessionId);
      logger.info('Backend WebRTC media peer closed', {
        sessionId: record.sessionId,
        broadcastId: record.broadcastId,
        backendPeerId: record.backendPeerId,
        revision: record.revision,
        reason,
        ingestBridgeState: record.bridge.snapshot().state,
        activePeerCount: this.activePeerCount(),
      });
    } catch (error) {
      this.fail(record, normalizeBackendError(error, 'cleanup-failure', `Backend WebRTC cleanup failed: ${reason}`));
    }
  }

  private requirePeer(sessionId: string | undefined): BackendMediaPeerRecord {
    if (!sessionId) {
      throw new BackendMediaPeerError('peer-not-found', 'Backend media peer session is required.', false);
    }
    const record = this.peers.get(sessionId);
    if (!record) {
      throw new BackendMediaPeerError('peer-not-found', 'Backend media peer not found.', false);
    }
    return record;
  }

  private startOfferTimer(record: BackendMediaPeerRecord): void {
    this.clearOfferTimer(record);
    record.offerTimer = this.setTimer(() => {
      this.fail(record, new BackendMediaPeerError('negotiation-timeout', 'Backend WebRTC offer handling timed out.'));
    }, this.offerToAnswerTimeoutMs);
  }

  private startAudioTimer(record: BackendMediaPeerRecord): void {
    this.clearAudioTimer(record);
    record.audioTimer = this.setTimer(() => {
      this.fail(record, new BackendMediaPeerError('missing-audio-track', 'Timed out waiting for backend audio activity.'));
    }, this.firstAudioTimeoutMs);
  }

  private clearOfferTimer(record: BackendMediaPeerRecord): void {
    if (!record.offerTimer) return;
    this.clearTimer(record.offerTimer);
    record.offerTimer = null;
  }

  private clearAudioTimer(record: BackendMediaPeerRecord): void {
    if (!record.audioTimer) return;
    this.clearTimer(record.audioTimer);
    record.audioTimer = null;
  }

  private fail(record: BackendMediaPeerRecord, error: BackendMediaPeerError): BackendMediaPeerError {
    record.state = 'failed';
    record.audioTrackState = record.audioTrackState === 'none' ? 'failed' : record.audioTrackState;
    record.videoTrackState = record.videoTrackState === 'none' ? 'none' : record.videoTrackState;
    record.bridge.fail(error.message);
    record.lastError = { code: error.code, message: error.message, retryable: error.retryable };
    this.clearOfferTimer(record);
    this.clearAudioTimer(record);
    this.clearVideoGraceTimer(record);
    try {
      record.audioSink?.stop();
      record.audioSink = null;
      record.videoSink?.stop();
      record.videoSink = null;
      record.peer.close();
      record.queuedRemoteCandidates = [];
      record.seenRemoteCandidates.clear();
    } catch {
      record.lastError = {
        code: 'cleanup-failure',
        message: 'Backend WebRTC cleanup after failure failed.',
        retryable: false,
      };
    }
    this.touch(record);
    logger.warn('Backend WebRTC media peer failed', {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      code: error.code,
      retryable: error.retryable,
      audioTrackState: record.audioTrackState,
      videoTrackState: record.videoTrackState,
      videoFrameCount: record.videoFrameCount,
      ingestBridgeState: record.bridge.snapshot().state,
    });
    return error;
  }

  private touch(record: BackendMediaPeerRecord): void {
    record.updatedAt = this.now();
  }

  private activePeerCount(): number {
    return [...this.peers.values()].filter((record) => record.state !== 'closed' && record.state !== 'failed').length;
  }

  private snapshot(record: BackendMediaPeerRecord): BackendMediaPeerSnapshot {
    const bridge = record.bridge.snapshot();
    return {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      broadcasterPeerId: record.broadcasterPeerId,
      broadcasterSocketId: record.broadcasterSocketId,
      backendPeerId: record.backendPeerId,
      revision: record.revision,
      state: record.state,
      connectionState: record.peer.connectionState,
      iceConnectionState: record.peer.iceConnectionState,
      audioTrackState: record.audioTrackState,
      videoTrackState: record.videoTrackState,
      ingestBridgeState: bridge.state,
      audioInputSampleRate: bridge.inputSampleRate,
      audioInputChannelCount: bridge.inputChannelCount,
      videoExpected: record.videoExpected,
      audioFrameCount: bridge.frameCount,
      videoFrameCount: record.videoFrameCount,
      audioActivityDetected: bridge.frameCount > 0,
      videoActivityDetected: record.videoFrameCount > 0,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      lastActivityAt: record.lastActivityAt?.toISOString() ?? null,
      lastError: record.lastError,
    };
  }
}

export function backendSignalEnvelope(
  event: WebRtcSdpAnswerEnvelope | WebRtcIceCandidateEnvelope | WebRtcPeerReadyEnvelope,
): Exclude<
  WebRtcIncomingSignallingEnvelope,
  Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
> {
  return event as unknown as Exclude<
    WebRtcIncomingSignallingEnvelope,
    Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
  >;
}

function normalizeBackendError(
  error: unknown,
  fallbackCode: BackendMediaPeerErrorCode = 'invalid-offer',
  fallbackMessage = 'Backend WebRTC media peer failed.',
): BackendMediaPeerError {
  if (error instanceof BackendMediaPeerError) return error;
  return new BackendMediaPeerError(fallbackCode, fallbackMessage);
}

function offerHasVideo(offer: WebRtcSdpOfferEnvelope): boolean {
  return /(?:^|\r?\n)m=video\s/i.test(offer.payload.sdp);
}

function readableByteLength(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  if ('byteLength' in data && typeof data.byteLength === 'number') return data.byteLength;
  if ('length' in data && typeof data.length === 'number') return data.length;
  return null;
}

function audioContext(record: BackendMediaPeerRecord): BackendMediaPeerAudioContext {
  return {
    sessionId: record.sessionId,
    broadcastId: record.broadcastId,
    broadcasterPeerId: record.broadcasterPeerId,
    revision: record.revision,
  };
}

function assertBackendRuntime(): void {
  if (!wrtc.RTCPeerConnection || !wrtc.nonstandard?.RTCAudioSink) {
    throw new BackendMediaPeerError(
      'backend-webrtc-unavailable',
      'Backend WebRTC runtime is unavailable.',
      false,
    );
  }
}

function readBackendIceServers(): BackendIceServerConfig[] {
  const raw = process.env['WEBRTC_ICE_SERVERS'];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as BackendIceServerConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const BACKEND_WEBRTC_MEDIA_SOCKET_ID = BACKEND_SOCKET_ID;

function nonEmptyStringOrNull(input: string | null): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  return trimmed ? input : null;
}

function validSdpMLineIndexOrNull(input: number | null): number | null {
  if (input === null) return null;
  return Number.isInteger(input) && input >= 0 && input <= 128 ? input : null;
}
