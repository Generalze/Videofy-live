/** @owner masterzee001 */
import wrtc from '@roamhq/wrtc';
import { logger } from './logger.js';
import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';

/**
 * P6.1B per-call remote-original-audio delivery.
 *
 * The programme listener pipe (BackendWebRtcListenerPeerRegistry) is built
 * around server-created offers for listeners registered in the programme
 * signalling registry, keyed to a single broadcaster session. The call
 * contract is the other way around: the browser sends a recvonly
 * `call:receive:offer` and expects the answer in the ack. This manager is the
 * small per-call equivalent of that pipe using the same wrtc primitives:
 * the speaking participant's backend media peer RTCAudioSink frames are pushed
 * into the RECIPIENT's RTCAudioSource here (A's decoded mic -> B's receive
 * peer, and vice versa), so each participant hears only the OTHER
 * participant's original audio and never their own (§30.4 feedback isolation).
 */

export interface CallIceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export interface CallReceivePeerHandlers {
  onLocalIceCandidate(callId: string, participantId: string, candidate: CallIceCandidateInit): void;
}

interface CandidateLike {
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

interface PeerConnectionLike {
  connectionState: string;
  localDescription?: { sdp?: string | null } | null;
  remoteDescription?: { sdp?: string | null } | null;
  onicecandidate: ((event: { candidate: CandidateLike | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: TrackLike): unknown;
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>;
  setLocalDescription(description: { type: 'answer'; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: CandidateLike): Promise<void>;
  close(): void;
}

export interface CallReceivePeersLike {
  acceptOffer(callId: string, participantId: string, sdp: string): Promise<string>;
  addRemoteCandidate(
    callId: string,
    participantId: string,
    candidate: CandidateLike,
  ): Promise<void>;
  fanOut(callId: string, speakerParticipantId: string, data: WebRtcAudioDataLike): void;
  closePeer(callId: string, participantId: string, reason: string): void;
  closeCall(callId: string, reason: string): void;
  count(): number;
}

export interface CallReceivePeerManagerOptions {
  createPeerConnection?: () => PeerConnectionLike;
  createAudioSource?: () => AudioSourceLike;
  maxQueuedCandidates?: number;
}

interface CallReceivePeerRecord {
  key: string;
  callId: string;
  participantId: string;
  peer: PeerConnectionLike;
  source: AudioSourceLike;
  track: TrackLike;
  answered: boolean;
  closed: boolean;
  queuedRemoteCandidates: CandidateLike[];
}

const DEFAULT_MAX_QUEUED_CANDIDATES = 64;

export class CallReceivePeerManager implements CallReceivePeersLike {
  private readonly peers = new Map<string, CallReceivePeerRecord>();
  private readonly handlers: CallReceivePeerHandlers;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly createAudioSource: () => AudioSourceLike;
  private readonly maxQueuedCandidates: number;

  constructor(handlers: CallReceivePeerHandlers, options: CallReceivePeerManagerOptions = {}) {
    this.handlers = handlers;
    this.createPeerConnection =
      options.createPeerConnection ??
      (() =>
        new wrtc.RTCPeerConnection({
          iceServers: readCallIceServers(),
        }) as unknown as PeerConnectionLike);
    this.createAudioSource =
      options.createAudioSource ??
      (() => new wrtc.nonstandard.RTCAudioSource() as unknown as AudioSourceLike);
    this.maxQueuedCandidates = options.maxQueuedCandidates ?? DEFAULT_MAX_QUEUED_CANDIDATES;
  }

  /** Answer the participant's recvonly offer with a backend peer that sends the remote original audio. */
  async acceptOffer(callId: string, participantId: string, sdp: string): Promise<string> {
    const key = keyFor(callId, participantId);
    // A renegotiation (e.g. after a transient network drop) replaces the peer.
    const existing = this.peers.get(key);
    if (existing) this.closeRecord(existing, 'superseded by a new receive offer');

    const peer = this.createPeerConnection();
    const source = this.createAudioSource();
    const track = source.createTrack();
    peer.addTrack(track);
    const record: CallReceivePeerRecord = {
      key,
      callId,
      participantId,
      peer,
      source,
      track,
      answered: false,
      closed: false,
      queuedRemoteCandidates: [],
    };
    this.peers.set(key, record);
    peer.onicecandidate = (event) => {
      if (record.closed || !event.candidate) return;
      this.handlers.onLocalIceCandidate(callId, participantId, {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        usernameFragment: event.candidate.usernameFragment ?? null,
      });
    };
    peer.onconnectionstatechange = () => {
      if (record.closed) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        this.closeRecord(record, `receive peer connection ${peer.connectionState}`);
      }
    };
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      record.answered = true;
      while (record.queuedRemoteCandidates.length > 0) {
        const queued = record.queuedRemoteCandidates.shift();
        if (queued) await peer.addIceCandidate(queued).catch(() => undefined);
      }
      return peer.localDescription?.sdp ?? answer.sdp ?? '';
    } catch (error) {
      this.closeRecord(record, 'receive peer negotiation failed');
      throw error instanceof Error ? error : new Error('Call receive peer negotiation failed.');
    }
  }

  async addRemoteCandidate(
    callId: string,
    participantId: string,
    candidate: CandidateLike,
  ): Promise<void> {
    const record = this.peers.get(keyFor(callId, participantId));
    if (!record || record.closed) return;
    if (!record.answered) {
      if (record.queuedRemoteCandidates.length >= this.maxQueuedCandidates) return;
      record.queuedRemoteCandidates.push(candidate);
      return;
    }
    await record.peer.addIceCandidate(candidate).catch(() => undefined);
  }

  /** Push one decoded audio frame from the speaker to every OTHER participant's receive peer. */
  fanOut(callId: string, speakerParticipantId: string, data: WebRtcAudioDataLike): void {
    for (const record of [...this.peers.values()]) {
      if (record.callId !== callId || record.participantId === speakerParticipantId) continue;
      if (record.closed) continue;
      try {
        record.source.onData(data);
      } catch (error) {
        logger.warn('Call receive peer audio push failed', {
          callId: record.callId,
          participantId: record.participantId,
          message: error instanceof Error ? error.message : 'unknown audio push failure',
        });
        this.closeRecord(record, 'receive peer audio push failed');
      }
    }
  }

  closePeer(callId: string, participantId: string, reason: string): void {
    const record = this.peers.get(keyFor(callId, participantId));
    if (record) this.closeRecord(record, reason);
  }

  closeCall(callId: string, reason: string): void {
    for (const record of [...this.peers.values()]) {
      if (record.callId === callId) this.closeRecord(record, reason);
    }
  }

  count(): number {
    return this.peers.size;
  }

  private closeRecord(record: CallReceivePeerRecord, reason: string): void {
    if (record.closed) return;
    record.closed = true;
    try {
      record.track.stop?.();
    } catch {
      // Best effort; the peer close below is what releases transport resources.
    }
    try {
      record.peer.close();
    } catch {
      // Best effort cleanup; the record is dropped either way.
    }
    record.queuedRemoteCandidates = [];
    this.peers.delete(record.key);
    logger.info('Call receive peer closed', {
      callId: record.callId,
      participantId: record.participantId,
      reason,
    });
  }
}

function keyFor(callId: string, participantId: string): string {
  return `${callId}:${participantId}`;
}

function readCallIceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env['WEBRTC_ICE_SERVERS'];
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
