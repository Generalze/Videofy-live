import { randomUUID } from 'node:crypto';
import wrtc from '@roamhq/wrtc';
import type {
  WebRtcIceCandidateEnvelope,
  WebRtcIncomingSignallingEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
} from '@videofy-live/shared-types';
import type { WebRtcPeerRecord } from './webrtc-session-registry.js';
import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import { BackendMediaPeerError } from './webrtc-media-peer-registry.js';
import type { WebRtcVideoFrameLike } from './webrtc-media-peer-registry.js';
import { logger } from './logger.js';

type ListenerPeerState = 'creating' | 'negotiating' | 'connected' | 'failed' | 'closing' | 'closed';

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
  stop?: () => void;
}

interface AudioSourceLike {
  createTrack(): TrackLike;
  onData(data: WebRtcAudioDataLike): void;
}

interface VideoSourceLike {
  createTrack(): TrackLike;
  onFrame(frame: WebRtcVideoFrameLike): void;
}

interface PeerConnectionLike {
  connectionState: string;
  iceConnectionState: string;
  localDescription?: { sdp?: string | null } | null;
  remoteDescription?: { sdp?: string | null } | null;
  onicecandidate: ((event: { candidate: CandidateLike | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  addTrack(track: TrackLike): unknown;
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>;
  setLocalDescription(description: { type: 'offer'; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(candidate: CandidateInitLike): Promise<void>;
  close(): void;
}

interface BackendListenerPeerRecord {
  key: string;
  sessionId: string;
  broadcastId: string;
  listenerPeerId: string;
  listenerSocketId: string;
  backendPeerId: string;
  revision: number;
  peer: PeerConnectionLike;
  audioSource: AudioSourceLike;
  videoSource: VideoSourceLike | null;
  audioTrack: TrackLike;
  videoTrack: TrackLike | null;
  queuedRemoteCandidates: CandidateInitLike[];
  seenRemoteCandidates: Set<string>;
  state: ListenerPeerState;
  createdAt: Date;
  updatedAt: Date;
  lastFrameAt: Date | null;
  lastVideoFrameAt: Date | null;
  offerTimer: ReturnType<typeof setTimeout> | null;
}

export interface BackendListenerPeerSnapshot {
  sessionId: string;
  broadcastId: string;
  listenerPeerId: string;
  listenerSocketId: string;
  revision: number;
  state: ListenerPeerState;
  connectionState: string;
  iceConnectionState: string;
  lastFrameAt: string | null;
  lastVideoFrameAt: string | null;
  videoTrackIncluded: boolean;
}

export interface BackendWebRtcListenerPeerRegistryOptions {
  maxActivePeers?: number;
  answerTimeoutMs?: number;
  maxQueuedCandidates?: number;
  createPeerConnection?: () => PeerConnectionLike;
  createAudioSource?: () => AudioSourceLike;
  createVideoSource?: () => VideoSourceLike;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onLocalSignal?: (
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
    >,
  ) => void;
}

const DEFAULT_MAX_ACTIVE_PEERS = 32;
const DEFAULT_ANSWER_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_QUEUED_CANDIDATES = 64;

export class BackendWebRtcListenerPeerRegistry {
  private readonly peers = new Map<string, BackendListenerPeerRecord>();
  private readonly maxActivePeers: number;
  private readonly answerTimeoutMs: number;
  private readonly maxQueuedCandidates: number;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly createAudioSource: () => AudioSourceLike;
  private readonly createVideoSource: () => VideoSourceLike;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onLocalSignal: BackendWebRtcListenerPeerRegistryOptions['onLocalSignal'];

  constructor(options: BackendWebRtcListenerPeerRegistryOptions = {}) {
    assertListenerRuntime();
    this.maxActivePeers = options.maxActivePeers ?? DEFAULT_MAX_ACTIVE_PEERS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.maxQueuedCandidates = options.maxQueuedCandidates ?? DEFAULT_MAX_QUEUED_CANDIDATES;
    this.createPeerConnection =
      options.createPeerConnection ??
      (() =>
        new wrtc.RTCPeerConnection({
          iceServers: readBackendIceServers(),
        }) as unknown as PeerConnectionLike);
    this.createAudioSource =
      options.createAudioSource ??
      (() => new wrtc.nonstandard.RTCAudioSource() as unknown as AudioSourceLike);
    this.createVideoSource =
      options.createVideoSource ??
      (() => new wrtc.nonstandard.RTCVideoSource() as unknown as VideoSourceLike);
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onLocalSignal = options.onLocalSignal;
  }

  hasActivePeer(sessionId: string, listenerPeerId: string): boolean {
    const record = this.peers.get(keyFor(sessionId, listenerPeerId));
    return Boolean(record && record.state !== 'closed' && record.state !== 'failed');
  }

  async createOffer(
    listener: WebRtcPeerRecord,
    session: WebRtcSessionSummary,
    revision: number,
    options: { includeVideo?: boolean } = {},
  ): Promise<WebRtcSdpOfferEnvelope | null> {
    if (this.hasActivePeer(session.sessionId, listener.peerId)) return null;
    if (this.activePeerCount() >= this.maxActivePeers) {
      throw new BackendMediaPeerError('backend-webrtc-unavailable', 'Backend listener media peer capacity reached.', true);
    }
    const peer = this.createPeerConnection();
    const source = this.createAudioSource();
    const track = source.createTrack();
    peer.addTrack(track);
    const videoSource = options.includeVideo ? this.createVideoSource() : null;
    const videoTrack = videoSource?.createTrack() ?? null;
    if (videoTrack) peer.addTrack(videoTrack);
    const now = this.now();
    const record: BackendListenerPeerRecord = {
      key: keyFor(session.sessionId, listener.peerId),
      sessionId: session.sessionId,
      broadcastId: session.broadcastId,
      listenerPeerId: listener.peerId,
      listenerSocketId: listener.socketId,
      backendPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
      revision,
      peer,
      audioSource: source,
      videoSource,
      audioTrack: track,
      videoTrack,
      queuedRemoteCandidates: [],
      seenRemoteCandidates: new Set(),
      state: 'creating',
      createdAt: now,
      updatedAt: now,
      lastFrameAt: null,
      lastVideoFrameAt: null,
      offerTimer: null,
    };
    this.peers.set(record.key, record);
    this.bindPeer(record);
    this.startOfferTimer(record);
    try {
      record.state = 'negotiating';
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.touch(record);
      return {
        type: 'sdp-offer',
        protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
        messageId: `msg_${randomUUID()}`,
        broadcastId: session.broadcastId,
        sessionId: session.sessionId,
        peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
        senderRole: 'server',
        revision,
        createdAt: this.now().toISOString(),
        payload: {
          targetPeerId: listener.peerId,
          sdp: peer.localDescription?.sdp ?? offer.sdp ?? '',
        },
      };
    } catch (error) {
      this.fail(record);
      throw normalizeListenerError(error);
    }
  }

  async acceptAnswer(answer: WebRtcSdpAnswerEnvelope): Promise<void> {
    const record = this.requirePeer(answer.sessionId, answer.peerId);
    if (answer.revision !== record.revision || answer.payload.targetPeerId !== record.backendPeerId) {
      throw new BackendMediaPeerError('stale-negotiation', 'Listener SDP answer is stale.', false);
    }
    await record.peer.setRemoteDescription({ type: 'answer', sdp: answer.payload.sdp }).catch((error: unknown) => {
      throw normalizeListenerError(error, 'remote-description-failure', 'Backend could not apply listener SDP answer.');
    });
    this.clearOfferTimer(record);
    record.state = record.peer.connectionState === 'connected' ? 'connected' : 'negotiating';
    while (record.queuedRemoteCandidates.length > 0) {
      const candidate = record.queuedRemoteCandidates.shift();
      if (candidate) await record.peer.addIceCandidate(candidate);
    }
    this.touch(record);
  }

  async addRemoteCandidate(envelope: WebRtcIceCandidateEnvelope): Promise<void> {
    const record = this.requirePeer(envelope.sessionId, envelope.peerId);
    if (envelope.revision !== record.revision) {
      throw new BackendMediaPeerError('stale-negotiation', 'Listener ICE candidate revision is stale.', false);
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
    if (!record.peer.remoteDescription) {
      if (record.queuedRemoteCandidates.length >= this.maxQueuedCandidates) {
        throw new BackendMediaPeerError('ice-candidate-failure', 'Too many queued listener ICE candidates.');
      }
      record.queuedRemoteCandidates.push(candidate);
      return;
    }
    await record.peer.addIceCandidate(candidate).catch((error: unknown) => {
      throw normalizeListenerError(error, 'ice-candidate-failure', 'Backend could not apply listener ICE candidate.');
    });
    this.touch(record);
  }

  fanOutAudioFrame(sessionId: string, data: WebRtcAudioDataLike): void {
    for (const record of this.peers.values()) {
      if (record.sessionId !== sessionId || record.state === 'closed' || record.state === 'failed') continue;
      try {
        record.audioSource.onData(data);
        record.lastFrameAt = this.now();
        this.touch(record);
      } catch {
        this.fail(record);
      }
    }
  }

  fanOutVideoFrame(sessionId: string, frame: WebRtcVideoFrameLike): void {
    for (const record of this.peers.values()) {
      if (record.sessionId !== sessionId || record.state === 'closed' || record.state === 'failed') continue;
      if (!record.videoSource) continue;
      try {
        record.videoSource.onFrame(frame);
        record.lastVideoFrameAt = this.now();
        this.touch(record);
      } catch {
        this.fail(record);
      }
    }
  }

  closeSession(sessionId: string | undefined, reason = 'signalling session closed'): void {
    if (!sessionId) return;
    for (const record of [...this.peers.values()]) {
      if (record.sessionId === sessionId) this.closeRecord(record, reason);
    }
  }

  closeByListenerSocket(socketId: string, reason = 'listener socket disconnected'): void {
    for (const record of [...this.peers.values()]) {
      if (record.listenerSocketId === socketId) this.closeRecord(record, reason);
    }
  }

  closeListenerPeer(sessionId: string | undefined, listenerPeerId: string | undefined, reason = 'listener left'): void {
    if (!sessionId || !listenerPeerId) return;
    const record = this.peers.get(keyFor(sessionId, listenerPeerId));
    if (record) this.closeRecord(record, reason);
  }

  getSnapshots(): BackendListenerPeerSnapshot[] {
    return [...this.peers.values()].map((record) => this.snapshot(record));
  }

  private bindPeer(record: BackendListenerPeerRecord): void {
    record.peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.onLocalSignal?.({
        type: 'ice-candidate',
        protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
        messageId: `msg_${randomUUID()}`,
        broadcastId: record.broadcastId,
        sessionId: record.sessionId,
        peerId: record.backendPeerId,
        senderRole: 'server',
        revision: record.revision,
        createdAt: this.now().toISOString(),
        payload: {
          targetPeerId: record.listenerPeerId,
          candidate: event.candidate.candidate,
          sdpMid: nonEmptyStringOrNull(event.candidate.sdpMid ?? null),
          sdpMLineIndex: validSdpMLineIndexOrNull(event.candidate.sdpMLineIndex ?? null),
          usernameFragment: nonEmptyStringOrNull(event.candidate.usernameFragment ?? null),
        },
      });
    };
    record.peer.onconnectionstatechange = () => {
      if (record.peer.connectionState === 'connected') record.state = 'connected';
      if (record.peer.connectionState === 'failed') this.fail(record);
      if (record.peer.connectionState === 'closed') record.state = 'closed';
      this.touch(record);
    };
    record.peer.oniceconnectionstatechange = () => {
      if (record.peer.iceConnectionState === 'failed') this.fail(record);
      this.touch(record);
    };
  }

  private requirePeer(sessionId: string | undefined, listenerPeerId: string): BackendListenerPeerRecord {
    if (!sessionId) {
      throw new BackendMediaPeerError('peer-not-found', 'Listener media peer session is required.', false);
    }
    const record = this.peers.get(keyFor(sessionId, listenerPeerId));
    if (!record) {
      throw new BackendMediaPeerError('peer-not-found', 'Listener media peer not found.', false);
    }
    return record;
  }

  private closeRecord(record: BackendListenerPeerRecord, reason: string): void {
    if (record.state === 'closed' || record.state === 'closing') return;
    record.state = 'closing';
    this.clearOfferTimer(record);
    try {
      record.audioTrack.stop?.();
      record.videoTrack?.stop?.();
      record.peer.close();
      record.queuedRemoteCandidates = [];
      record.seenRemoteCandidates.clear();
      record.state = 'closed';
      this.peers.delete(record.key);
      logger.info('Backend listener WebRTC media peer closed', {
        sessionId: record.sessionId,
        listenerPeerId: record.listenerPeerId,
        revision: record.revision,
        reason,
      });
    } catch {
      this.fail(record);
    }
  }

  private fail(record: BackendListenerPeerRecord): void {
    record.state = 'failed';
    this.clearOfferTimer(record);
    try {
      record.audioTrack.stop?.();
      record.videoTrack?.stop?.();
      record.peer.close();
      record.queuedRemoteCandidates = [];
      record.seenRemoteCandidates.clear();
    } catch {
      // Keep the original failed state and diagnostic record; cleanup is best effort.
    }
    this.touch(record);
    logger.warn('Backend listener WebRTC media peer failed', {
      sessionId: record.sessionId,
      listenerPeerId: record.listenerPeerId,
      revision: record.revision,
    });
  }

  private startOfferTimer(record: BackendListenerPeerRecord): void {
    this.clearOfferTimer(record);
    record.offerTimer = this.setTimer(() => this.fail(record), this.answerTimeoutMs);
  }

  private clearOfferTimer(record: BackendListenerPeerRecord): void {
    if (!record.offerTimer) return;
    this.clearTimer(record.offerTimer);
    record.offerTimer = null;
  }

  private touch(record: BackendListenerPeerRecord): void {
    record.updatedAt = this.now();
  }

  private activePeerCount(): number {
    return [...this.peers.values()].filter((record) => record.state !== 'closed' && record.state !== 'failed').length;
  }

  private snapshot(record: BackendListenerPeerRecord): BackendListenerPeerSnapshot {
    return {
      sessionId: record.sessionId,
      broadcastId: record.broadcastId,
      listenerPeerId: record.listenerPeerId,
      listenerSocketId: record.listenerSocketId,
      revision: record.revision,
      state: record.state,
      connectionState: record.peer.connectionState,
      iceConnectionState: record.peer.iceConnectionState,
      lastFrameAt: record.lastFrameAt?.toISOString() ?? null,
      lastVideoFrameAt: record.lastVideoFrameAt?.toISOString() ?? null,
      videoTrackIncluded: Boolean(record.videoTrack),
    };
  }
}

function keyFor(sessionId: string, listenerPeerId: string): string {
  return `${sessionId}:${listenerPeerId}`;
}

function assertListenerRuntime(): void {
  if (!wrtc?.RTCPeerConnection || !wrtc?.nonstandard?.RTCAudioSource) {
    throw new BackendMediaPeerError(
      'unsupported-runtime',
      'Backend WebRTC listener delivery requires RTCPeerConnection and RTCAudioSource support.',
      false,
    );
  }
}

function readBackendIceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env.WEBRTC_ICE_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { urls?: string | string[]; username?: string; credential?: string }[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry?.urls !== 'string' && !Array.isArray(entry?.urls)) return [];
      return [{ ...entry, urls: entry.urls }];
    });
  } catch {
    return [];
  }
}

function normalizeListenerError(
  error: unknown,
  code: ConstructorParameters<typeof BackendMediaPeerError>[0] = 'backend-webrtc-unavailable',
  fallback = 'Backend listener WebRTC peer failed.',
): BackendMediaPeerError {
  if (error instanceof BackendMediaPeerError) return error;
  return new BackendMediaPeerError(code, error instanceof Error ? error.message : fallback);
}

function nonEmptyStringOrNull(value: string | null): string | null {
  return value && value.trim().length > 0 ? value : null;
}

function validSdpMLineIndexOrNull(value: number | null): number | null {
  return Number.isInteger(value) && value !== null && value >= 0 ? value : null;
}
