/** @owner masterzee001 */
import wrtc from '@roamhq/wrtc';
import { logger } from './logger.js';
import type { MediaAudioDataLike } from './media-transcription-chunker.js';

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
 * into the RECIPIENT's RTCAudioSource here, so each participant hears only the
 * OTHER participants' original audio and never their own (§30.4 feedback
 * isolation).
 *
 * P6.4-W2 — ONE SLOT PER REMOTE SPEAKER.
 *
 * This used to hold a single RTCAudioSource per listener and push every remote
 * speaker's PCM into it. With two participants exactly one speaker ever fed it,
 * so it worked. With three or more, two people talking at once interleave 10 ms
 * frames into the same source — which is not a mix, it is frame-level
 * corruption, and it degrades to unintelligible audio rather than failing
 * visibly.
 *
 * So each listener now gets `remoteSlotCount` preallocated sources and tracks,
 * and each remote speaker is bound to exactly one of them.
 *
 * THE SLOT IS THE STABLE TRANSPORT RESOURCE. THE SPEAKER BINDING IS MUTABLE
 * METADATA. That separation is what lets somebody join or leave without
 * adding or removing a WebRTC track, and therefore without renegotiation,
 * while still keeping every speaker's PCM physically separate.
 *
 * There is deliberately NO mixing here: no summing, no gain, no clipping
 * protection. Server-side mixing would need per-recipient jitter alignment and
 * real DSP; separate tracks let the browser do it natively and are what make
 * per-speaker mute, volume and ducking possible at all (W3/W4).
 */

export interface CallIceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/**
 * Which speaker each of a listener's receive slots is currently carrying.
 *
 * `slot` is the stable identity: it exists for the life of the receive peer
 * whether or not anybody is bound to it. `mid` is the transport handle the
 * browser sees on its `track` event, and is what lets the client attribute a
 * track WITHOUT parsing SDP. `speakerParticipantId` is null for a free slot.
 */
export interface CallReceiveTrackMapping {
  slot: number;
  mid: string | null;
  speakerParticipantId: string | null;
}

export interface CallReceivePeerHandlers {
  onLocalIceCandidate(callId: string, participantId: string, candidate: CallIceCandidateInit): void;
  /**
   * Slot bindings changed for ONE listener, and only that listener is told.
   *
   * Emitted on negotiation and on every membership change. Broadcasting it
   * call-wide would hand every participant a map of everyone else's transport
   * state for no reason.
   */
  onTrackMapping?(
    callId: string,
    participantId: string,
    tracks: readonly CallReceiveTrackMapping[],
  ): void;
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
  onData(data: MediaAudioDataLike): void;
}

interface TransceiverLike {
  mid?: string | null;
  sender?: { track?: TrackLike | null } | null;
}

interface PeerConnectionLike {
  connectionState: string;
  localDescription?: { sdp?: string | null } | null;
  remoteDescription?: { sdp?: string | null } | null;
  /**
   * Optional: used to read each slot's `mid` after negotiation.
   *
   * Absent on a minimal test double, in which case `mid` is reported as null
   * and the client leaves that slot UNBOUND. Reported honestly rather than
   * inventing a plausible mid: a wrong mid attributes one person's voice to
   * another, which is worse than a silent track.
   */
  getTransceivers?(): TransceiverLike[];
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
  fanOut(callId: string, speakerParticipantId: string, data: MediaAudioDataLike): void;
  /**
   * Reconcile slot bindings against current membership.
   *
   * Idempotent, and STABLE: a speaker already bound keeps their slot, a
   * departed speaker's slot is freed for reuse, and a new speaker takes the
   * lowest free one. No track is added or removed, so this never triggers
   * renegotiation.
   */
  syncSpeakers(callId: string, participantIds: readonly string[]): void;
  /** Current bindings for one listener; the mapping the client is sent. */
  trackMapping(callId: string, participantId: string): readonly CallReceiveTrackMapping[];
  closePeer(callId: string, participantId: string, reason: string): void;
  closeCall(callId: string, reason: string): void;
  count(): number;
}

export interface CallReceivePeerManagerOptions {
  createPeerConnection?: () => PeerConnectionLike;
  createAudioSource?: () => AudioSourceLike;
  maxQueuedCandidates?: number;
  /**
   * Preallocated remote slots per listener. Defaults to
   * DEFAULT_REMOTE_SLOT_COUNT — one fewer than the conference cap, because a
   * participant never receives themselves.
   */
  remoteSlotCount?: number;
}

interface CallReceiveSlot {
  slot: number;
  source: AudioSourceLike;
  track: TrackLike;
  mid: string | null;
  /** Null while free. Mutable: rebinding does NOT replace the track. */
  speakerParticipantId: string | null;
}

interface CallReceivePeerRecord {
  key: string;
  callId: string;
  participantId: string;
  peer: PeerConnectionLike;
  slots: CallReceiveSlot[];
  /** Frames actually written into a bound slot for this listener. Proof of routing. */
  routedFrames: number;
  answered: boolean;
  closed: boolean;
  queuedRemoteCandidates: CandidateLike[];
}

const DEFAULT_MAX_QUEUED_CANDIDATES = 64;

/**
 * One fewer than the P6.4 development-demo cap of 4: a participant is never
 * their own remote. Preallocated so membership changes rebind metadata instead
 * of renegotiating transport.
 */
export const DEFAULT_REMOTE_SLOT_COUNT = 3;

export class CallReceivePeerManager implements CallReceivePeersLike {
  private readonly peers = new Map<string, CallReceivePeerRecord>();
  private readonly handlers: CallReceivePeerHandlers;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly createAudioSource: () => AudioSourceLike;
  private readonly maxQueuedCandidates: number;
  private readonly remoteSlotCount: number;
  /** Frames for a speaker with no slot on that listener. Should stay zero. */
  private unboundFrameCount = 0;
  /**
   * Speakers who could not be given a NEGOTIATED slot.
   *
   * Non-zero means the client offered fewer recvonly m-lines than the gateway
   * has slots, and somebody is inaudible. Counted because that failure is
   * otherwise completely silent.
   */
  private unplaceableSpeakerCount = 0;

  constructor(handlers: CallReceivePeerHandlers, options: CallReceivePeerManagerOptions = {}) {
    this.handlers = handlers;
    this.remoteSlotCount = Math.max(1, options.remoteSlotCount ?? DEFAULT_REMOTE_SLOT_COUNT);
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
    // Every slot is created up front, bound or not. Adding tracks later would
    // mean renegotiating whenever somebody joined, which is exactly what the
    // preallocation exists to avoid.
    const slots: CallReceiveSlot[] = [];
    for (let slot = 0; slot < this.remoteSlotCount; slot += 1) {
      const source = this.createAudioSource();
      const track = source.createTrack();
      peer.addTrack(track);
      slots.push({ slot, source, track, mid: null, speakerParticipantId: null });
    }
    const record: CallReceivePeerRecord = {
      key,
      callId,
      participantId,
      peer,
      slots,
      routedFrames: 0,
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
      // mids exist only after setLocalDescription, so this is the first moment
      // a slot can be given the handle the browser will see on its track event.
      this.resolveMids(record);
      while (record.queuedRemoteCandidates.length > 0) {
        const queued = record.queuedRemoteCandidates.shift();
        if (queued) await peer.addIceCandidate(queued).catch(() => undefined);
      }
      // Re-issued after every (re)negotiation, so a rebuilt peer never leaves
      // the client holding a mapping for tracks that no longer exist.
      this.emitMapping(record);
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

  /**
   * Push one decoded frame from the speaker into THAT SPEAKER'S SLOT on every
   * other participant's receive peer.
   *
   * The frame goes to exactly one source per listener. Two people speaking at
   * once therefore reach two different sources, which is the whole point: the
   * previous single-source version interleaved their frames.
   */
  fanOut(callId: string, speakerParticipantId: string, data: MediaAudioDataLike): void {
    for (const record of [...this.peers.values()]) {
      if (record.callId !== callId || record.participantId === speakerParticipantId) continue;
      if (record.closed) continue;
      const slot = record.slots.find((entry) => entry.speakerParticipantId === speakerParticipantId);
      if (!slot) {
        // No slot means the runtime has not reconciled membership yet. Dropping
        // is deliberate: writing into an arbitrary free slot would reintroduce
        // nondeterministic attribution, which is the defect being removed.
        this.unboundFrameCount += 1;
        continue;
      }
      try {
        slot.source.onData(data);
        record.routedFrames += 1;
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

  /**
   * Reconcile every listener's slot bindings against current membership.
   *
   * Stability is the contract: a speaker already bound KEEPS their slot, so a
   * fourth person joining cannot silently move the person you were already
   * listening to onto a different track.
   */
  syncSpeakers(callId: string, participantIds: readonly string[]): void {
    const present = new Set(participantIds);
    for (const record of this.peers.values()) {
      if (record.callId !== callId || record.closed) continue;
      const wanted = participantIds.filter((id) => id !== record.participantId);
      let changed = false;

      // 1. Release slots whose speaker has gone. The track and source stay:
      //    only the binding is metadata.
      for (const slot of record.slots) {
        if (slot.speakerParticipantId === null) continue;
        if (present.has(slot.speakerParticipantId) && slot.speakerParticipantId !== record.participantId) {
          continue;
        }
        slot.speakerParticipantId = null;
        changed = true;
      }

      // 2. Bind anyone unbound to the lowest free slot, in a deterministic
      //    order so two listeners agree about nothing — they need not — but a
      //    single listener is reproducible across reconnects.
      // A slot with no mid was never negotiated — the client's offer did not
      // carry an m-line for it — so audio written there goes nowhere. Binding a
      // speaker to one silently discards them, which is exactly how W3 came to
      // look like it was working. Prefer negotiated slots; fall back only when
      // no slot has a mid at all, which is the case for a peer double that
      // cannot report transceivers.
      const anyNegotiated = record.slots.some((slot) => slot.mid !== null);
      for (const speakerId of wanted) {
        if (record.slots.some((slot) => slot.speakerParticipantId === speakerId)) continue;
        const free =
          record.slots.find(
            (slot) => slot.speakerParticipantId === null && (!anyNegotiated || slot.mid !== null),
          ) ?? null;
        if (!free) {
          // More speakers than slots: the conference cap is meant to prevent
          // this, so it is a configuration error rather than a routine state.
          this.unplaceableSpeakerCount += 1;
          logger.warn('Call receive peer has no usable slot for a speaker', {
            callId,
            participantId: record.participantId,
            slotCount: record.slots.length,
            negotiatedSlotCount: record.slots.filter((slot) => slot.mid !== null).length,
          });
          break;
        }
        free.speakerParticipantId = speakerId;
        changed = true;
      }

      if (changed) this.emitMapping(record);
    }
  }

  trackMapping(callId: string, participantId: string): readonly CallReceiveTrackMapping[] {
    const record = this.peers.get(keyFor(callId, participantId));
    return record && !record.closed ? mappingOf(record) : [];
  }

  /** Diagnostics: frames arriving for a speaker with no slot. Expected zero. */
  unboundFrames(): number {
    return this.unboundFrameCount;
  }

  /** Diagnostics: speakers with no negotiated slot, i.e. inaudible. Expected zero. */
  unplaceableSpeakers(): number {
    return this.unplaceableSpeakerCount;
  }

  /**
   * Frames written into THIS listener's bound slots so far -- the routing
   * proof for a one-way-audio investigation: a caller who "hears nothing"
   * with a non-zero count here was sent the voice, and the fault is on the
   * receiving device; zero means the gateway never routed it.
   */
  routedFrames(callId: string, participantId: string): number {
    return this.peers.get(keyFor(callId, participantId))?.routedFrames ?? 0;
  }

  /** How many of a listener's slots the client actually negotiated. */
  negotiatedSlotCount(callId: string, participantId: string): number {
    const record = this.peers.get(keyFor(callId, participantId));
    return record ? record.slots.filter((slot) => slot.mid !== null).length : 0;
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

  /**
   * Read each slot's `mid` from the negotiated transceivers.
   *
   * Matched by sender track identity rather than by index: transceiver order is
   * not promised to match the order tracks were added, and guessing would give
   * the client a mapping that is confidently wrong.
   */
  private resolveMids(record: CallReceivePeerRecord): void {
    const transceivers = record.peer.getTransceivers?.();
    if (!transceivers) return;
    for (const slot of record.slots) {
      const match = transceivers.find((transceiver) => transceiver.sender?.track === slot.track);
      slot.mid = match?.mid ?? null;
    }
  }

  private emitMapping(record: CallReceivePeerRecord): void {
    if (record.closed) return;
    try {
      this.handlers.onTrackMapping?.(record.callId, record.participantId, mappingOf(record));
    } catch (error) {
      logger.warn('Call receive track mapping delivery failed', {
        callId: record.callId,
        participantId: record.participantId,
        message: error instanceof Error ? error.message : 'unknown mapping failure',
      });
    }
  }

  private closeRecord(record: CallReceivePeerRecord, reason: string): void {
    if (record.closed) return;
    record.closed = true;
    // Metadata only. The one line that says whether THIS listener was ever
    // sent anybody's voice -- the B in "callee publish -> gateway -> caller".
    logger.info('Call receive peer routing summary', {
      callId: record.callId,
      participantId: record.participantId,
      routedFrames: record.routedFrames,
      boundSpeakers: record.slots.filter((slot) => slot.speakerParticipantId !== null).length,
      reason,
    });
    for (const slot of record.slots) {
      try {
        slot.track.stop?.();
      } catch {
        // Best effort; the peer close below is what releases transport resources.
      }
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

/**
 * The mapping as the client receives it: EVERY slot, including free ones.
 *
 * Free slots are reported rather than omitted so the client can distinguish
 * "this track carries nobody" from "I have not been told about this track yet".
 * A shorter list would make those two states identical, and they need different
 * handling.
 */
function mappingOf(record: CallReceivePeerRecord): CallReceiveTrackMapping[] {
  return record.slots.map((slot) => ({
    slot: slot.slot,
    mid: slot.mid,
    speakerParticipantId: slot.speakerParticipantId,
  }));
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
