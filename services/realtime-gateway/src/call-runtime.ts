/** @owner masterzee001 */
import { randomUUID } from 'node:crypto';
import {
  CallSessionStore,
  type CallCaptionSourceEvent,
  type CallGeneratedAudioSourceEvent,
  type CallIngestPlan,
  type CallJoinFailure,
  type CallJoinInput,
  type CallLanguage,
  type CallSnapshot,
} from '@videofy-live/call-session';
import type {
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcIceCandidateEnvelope,
  WebRtcIncomingSignallingEnvelope,
  WebRtcSdpAnswerEnvelope,
  WebRtcSdpOfferEnvelope,
  WebRtcSessionSummary,
} from '@videofy-live/shared-types';
import {
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_LIMITS,
  WEBRTC_SIGNALLING_PROTOCOL_VERSION,
} from '@videofy-live/shared-types';
import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import type { BackendMediaPeerAudioContext } from './webrtc-media-peer-registry.js';
import type { WebRtcTranscriptionBridgeContext } from './webrtc-transcription-bridge.js';
import type { CallReceivePeersLike, CallReceivePeerHandlers } from './call-receive-peers.js';
import { logger } from './logger.js';

/**
 * P6.1B native call runtime, gateway side. `@videofy-live/call-session` owns
 * call/participant state, revisions, and routing decisions; this module owns
 * every transport concern for `call:*` sockets: rooms, publish/receive WebRTC
 * peers, per-participant media-ingest sessions, and the interception of
 * media-ingest events for `call_` sessions so nothing call-scoped ever reaches
 * programme/operator/language rooms (design note point 5).
 *
 * Post-review hardening (see the design note's hardening section):
 * - Ingest identity is revision-scoped (`call_..._r{mediaRevision}`) and every
 *   membership change bumps ALL connected participants, so this runtime
 *   retires superseded ingest sessions explicitly and keys its registry by the
 *   revision-scoped id; stale ids are unknown and swallowed, never stamped.
 * - Publish peers are keyed by a participant-STABLE key; the ingest context is
 *   resolved at frame time, so a membership change never forces the browser to
 *   renegotiate its microphone peer.
 * - Resume requires a private token, disconnected seats are auto-left after a
 *   grace period, and every socket handler is guarded against unexpected
 *   throws.
 */

/** Media-ingest processing-session ids for calls always carry this prefix. */
export const CALL_INGEST_SESSION_PREFIX = 'call_';

export const CALL_EVENTS = {
  JOIN: 'call:join',
  LEAVE: 'call:leave',
  PUBLISH_OFFER: 'call:publish:offer',
  PUBLISH_ICE: 'call:publish:ice',
  RECEIVE_OFFER: 'call:receive:offer',
  RECEIVE_ICE: 'call:receive:ice',
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  ERROR: 'call:error',
} as const;

/** Socket.IO handshake query role used by apps/call-web. */
export const CALL_PARTICIPANT_ROLE = 'call-participant';

/** Seats not resumed within this window are auto-left (design note hardening). */
export const DEFAULT_CALL_DISCONNECT_GRACE_MS = 120_000;

export function callRoom(callId: string): string {
  return `call:${callId}`;
}

export function callParticipantRoom(callId: string, participantId: string): string {
  return `call:${callId}:participant:${participantId}`;
}

/** Minimal socket surface so unit tests can drive the runtime without Socket.IO. */
export interface CallSocketLike {
  id: string;
  join(room: string): void | Promise<void>;
  leave(room: string): void | Promise<void>;
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (...args: never[]) => void): void;
}

export interface CallMediaPeerHandlers {
  onLocalSignal(
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
    >,
  ): void;
  onAudioFrame(context: BackendMediaPeerAudioContext, data: WebRtcAudioDataLike): void;
  onAudioPeerClosed(context: BackendMediaPeerAudioContext, reason: string): void;
}

/** The subset of BackendWebRtcMediaPeerRegistry the call runtime drives. */
export interface CallMediaPeersLike {
  acceptOffer(
    socketId: string,
    offer: WebRtcSdpOfferEnvelope,
    session: WebRtcSessionSummary,
  ): Promise<WebRtcSdpAnswerEnvelope>;
  addRemoteCandidate(envelope: WebRtcIceCandidateEnvelope): Promise<void>;
  closeSession(sessionId: string | undefined, reason?: string): void;
  getSnapshots(): unknown[];
}

/** Create/stop/delete media-ingest WebRTC sessions (HttpWebRtcTranscriptionSubmissionClient subset). */
export interface CallIngestControlClient {
  createSession(input: WebRtcTranscriptionBridgeContext): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/** The subset of WebRtcTranscriptionBridge the call runtime drives. */
export interface CallTranscriptionBridgeLike {
  handleFrame(context: WebRtcTranscriptionBridgeContext, data: WebRtcAudioDataLike): void;
  endSession(context: WebRtcTranscriptionBridgeContext, reason: string): void;
  cleanupClosedSessions(): number;
}

export interface CallRuntimeDependencies {
  store: CallSessionStore;
  emitToRoom(room: string, event: string, payload: unknown): void;
  ingestControl: CallIngestControlClient;
  transcriptionBridge: CallTranscriptionBridgeLike;
  createMediaPeers(handlers: CallMediaPeerHandlers): CallMediaPeersLike;
  createReceivePeers(handlers: CallReceivePeerHandlers): CallReceivePeersLike;
  /** Grace window before a disconnected seat is auto-left. Default 120 s. */
  disconnectGraceMs?: number;
  /** Injectable scheduler so tests can drive the disconnect reaper. */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Wire shape of `call:state` per the design note: sanitized, `joined` flag, no internals. */
export interface CallStateWirePayload {
  callId: string;
  state: string;
  participants: {
    participantId: string;
    displayName: string;
    speakLanguage: CallLanguage;
    hearLanguage: CallLanguage;
    joined: boolean;
  }[];
}

export type CallJoinAck =
  | { ok: true; participantId: string; resumeToken: string; snapshot: CallStateWirePayload }
  /** `code` is machine-readable; `error` stays the human-facing string. */
  | { ok: false; code: CallJoinFailure['code']; error: string };

export interface CallSdpAck {
  ok: boolean;
  sdp?: string;
  error?: string;
}

interface CallSocketBinding {
  callId: string;
  participantId: string;
}

interface CallParticipantRuntimeState {
  callId: string;
  participantId: string;
  socketId: string | null;
  connected: boolean;
  mediaRevision: number;
  languageRevision: number;
  /** Revision-scoped id of the participant's CURRENT ingest session (or null). */
  currentIngestSessionId: string | null;
  /**
   * Monotonic per-participant publish negotiation serial. It is the `revision`
   * of the synthetic envelopes exchanged with the media peer registry, so ICE
   * for a superseded publish peer is rejected as stale while the peer key
   * stays participant-stable across ingest rekeys.
   */
  publishSerial: number;
  reapTimer: ReturnType<typeof setTimeout> | null;
}

interface CallIngestRegistryEntry {
  callId: string;
  participantId: string;
  plan: CallIngestPlan;
  /**
   * Targets actually sent to media-ingest. For a same-language pair the plan's
   * targetLanguages is empty, but media-ingest rejects sessions whose resolved
   * target equals the source, so the OTHER supported call language is used as
   * a synthetic target purely to keep the session valid; captions for
   * same-language recipients come from the transcription (original) events and
   * the unused translation/TTS output routes to nobody.
   */
  effectiveTargetLanguages: CallLanguage[];
  languageRevision: number;
  /** True while the media-ingest session for this revision-scoped id is running. */
  active: boolean;
  /** True once the media-ingest session was EVER created; gates the retire-time delete. */
  everCreated: boolean;
  /** In-flight stop request, so the retire-time delete can sequence after it. */
  pendingStop: Promise<void> | null;
}

const USER_FACING_ERRORS = {
  join: 'This call could not be joined right now.',
  notInCall: 'You are not part of this call.',
  publish: 'Your microphone could not be connected. Please try again.',
  receive: 'The other caller’s audio could not be connected. Please try again.',
  captions: 'Live captions and translated audio are temporarily unavailable.',
} as const;

/** Guard-level failure shape (review finding 9): identical for ack and call:error. */
const INTERNAL_ERROR = {
  code: 'internal',
  message: 'Something went wrong; please rejoin.',
} as const;

export class CallRuntime {
  private readonly store: CallSessionStore;
  private readonly emitToRoom: CallRuntimeDependencies['emitToRoom'];
  private readonly ingestControl: CallIngestControlClient;
  private readonly transcriptionBridge: CallTranscriptionBridgeLike;
  private readonly mediaPeers: CallMediaPeersLike;
  private readonly receivePeers: CallReceivePeersLike;
  private readonly disconnectGraceMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  private readonly socketBindings = new Map<string, CallSocketBinding>();
  private readonly participants = new Map<string, CallParticipantRuntimeState>();
  /** Keyed by REVISION-SCOPED ingestSessionId; superseded entries are retired. */
  private readonly ingestRegistry = new Map<string, CallIngestRegistryEntry>();
  /** Stable publish-peer key -> participant identity, for frame-time resolution. */
  private readonly publishPeerIndex = new Map<string, CallSocketBinding>();

  constructor(dependencies: CallRuntimeDependencies) {
    this.store = dependencies.store;
    this.emitToRoom = dependencies.emitToRoom;
    this.ingestControl = dependencies.ingestControl;
    this.transcriptionBridge = dependencies.transcriptionBridge;
    this.disconnectGraceMs = dependencies.disconnectGraceMs ?? DEFAULT_CALL_DISCONNECT_GRACE_MS;
    this.setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
    this.mediaPeers = dependencies.createMediaPeers({
      onLocalSignal: (envelope) => this.handleMediaLocalSignal(envelope),
      onAudioFrame: (context, data) => this.handleMediaAudioFrame(context, data),
      onAudioPeerClosed: (context, reason) => this.handleMediaAudioPeerClosed(context, reason),
    });
    this.receivePeers = dependencies.createReceivePeers({
      onLocalIceCandidate: (callId, participantId, candidate) => {
        this.emitToRoom(callParticipantRoom(callId, participantId), CALL_EVENTS.RECEIVE_ICE, {
          callId,
          participantId,
          candidate,
        });
      },
    });
  }

  /** Attach guarded `call:*` handlers to a freshly connected call-participant socket. */
  registerSocket(socket: CallSocketLike): void {
    this.onGuarded(socket, CALL_EVENTS.JOIN, async (raw, ack) => {
      this.deliverAck(ack, await this.handleJoin(socket, raw));
    });
    this.onGuarded(socket, CALL_EVENTS.LEAVE, (raw, ack) => {
      this.deliverAck(ack, this.handleLeave(socket, raw));
    });
    this.onGuarded(socket, CALL_EVENTS.PUBLISH_OFFER, async (raw, ack) => {
      this.deliverAck(ack, await this.handlePublishOffer(socket, raw));
    });
    this.onGuarded(socket, CALL_EVENTS.PUBLISH_ICE, (raw) => this.handlePublishIce(socket, raw));
    this.onGuarded(socket, CALL_EVENTS.RECEIVE_OFFER, async (raw, ack) => {
      this.deliverAck(ack, await this.handleReceiveOffer(socket, raw));
    });
    this.onGuarded(socket, CALL_EVENTS.RECEIVE_ICE, (raw) => this.handleReceiveIce(socket, raw));
  }

  async handleJoin(socket: CallSocketLike, raw: unknown): Promise<CallJoinAck> {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'invalid-input', error: USER_FACING_ERRORS.join };
    }
    // The store is the single validation/auth authority for join and resume
    // (including resumeToken checks); the raw payload is never logged because
    // it may carry the private resume token.
    const result = this.store.createOrJoin(raw as CallJoinInput);
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.message };
    }
    const callId = (raw as { callId: string }).callId;
    const participantId = result.participantId;

    const previous = this.socketBindings.get(socket.id);
    if (previous && (previous.callId !== callId || previous.participantId !== participantId)) {
      // One call identity per socket in this wave; the abandoned seat follows
      // the normal disconnect path (kept for resume, reaped after grace).
      this.detachParticipantTransport(previous.callId, previous.participantId, 'rejoined with a different identity');
      this.store.markDisconnected(previous.callId, previous.participantId);
      const previousState = this.participants.get(participantKey(previous.callId, previous.participantId));
      if (previousState) {
        previousState.connected = false;
        previousState.socketId = null;
        this.scheduleReap(previousState);
      }
    }
    const key = participantKey(callId, participantId);
    const existingState = this.participants.get(key);
    if (existingState) {
      // A successful resume cancels the pending disconnect reaper.
      this.cancelReap(existingState);
      if (existingState.socketId && existingState.socketId !== socket.id) {
        // Resume from a new socket: the replaced socket's later disconnect
        // must not tear the resumed participant down again.
        this.socketBindings.delete(existingState.socketId);
      }
    }
    this.socketBindings.set(socket.id, { callId, participantId });
    this.participants.set(key, {
      callId,
      participantId,
      socketId: socket.id,
      connected: true,
      mediaRevision: result.mediaRevision,
      languageRevision: result.languageRevision,
      // Carried over so the superseded revision-scoped session can be retired.
      currentIngestSessionId: existingState?.currentIngestSessionId ?? null,
      publishSerial: existingState?.publishSerial ?? 0,
      reapTimer: null,
    });

    void socket.join(callRoom(callId));
    void socket.join(callParticipantRoom(callId, participantId));

    const wireSnapshot = toWireCallState(result.snapshot);
    this.emitToRoom(callRoom(callId), CALL_EVENTS.STATE, wireSnapshot);

    await this.applyIngestPlans(callId, result.snapshot, result.ingestPlans);

    // resumeToken travels ONLY in this private ack, never in call:state/logs.
    return { ok: true, participantId, resumeToken: result.resumeToken, snapshot: wireSnapshot };
  }

  handleLeave(socket: CallSocketLike, raw: unknown): { ok: boolean } {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return { ok: false };
    return this.finalizeLeave(binding.callId, binding.participantId, socket, 'participant left the call');
  }

  /** Socket-level disconnect: keep the seat for resume, stop all transport, arm the reaper. */
  handleSocketDisconnect(socketId: string): void {
    const binding = this.socketBindings.get(socketId);
    if (!binding) return;
    this.socketBindings.delete(socketId);
    const { callId, participantId } = binding;
    this.store.markDisconnected(callId, participantId);
    const state = this.participants.get(participantKey(callId, participantId));
    if (state) {
      state.connected = false;
      state.socketId = null;
      this.scheduleReap(state);
    }
    this.detachParticipantTransport(callId, participantId, 'participant socket disconnected');
    const snapshot = this.store.snapshot(callId);
    if (snapshot) {
      this.emitToRoom(callRoom(callId), CALL_EVENTS.STATE, toWireCallState(snapshot));
    }
  }

  async handlePublishOffer(socket: CallSocketLike, raw: unknown): Promise<CallSdpAck> {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return { ok: false, error: USER_FACING_ERRORS.notInCall };
    const sdp = readSdp(raw);
    if (!sdp) return { ok: false, error: USER_FACING_ERRORS.publish };
    const { callId, participantId } = binding;
    const state = this.participants.get(participantKey(callId, participantId));
    if (!state) return { ok: false, error: USER_FACING_ERRORS.notInCall };
    // The peer key is participant-stable: ingest rekeys (membership changes)
    // never require the browser to renegotiate its microphone peer.
    const peerKey = callPublishPeerKey(callId, participantId);
    state.publishSerial += 1;
    const serial = state.publishSerial;
    this.publishPeerIndex.set(peerKey, { callId, participantId });
    const broadcastId = this.currentEntryFor(state)?.plan.broadcastId ?? `callcast_${callId}_${participantId}`;
    // A republish (reconnect, renegotiation) replaces the previous backend peer.
    this.mediaPeers.closeSession(peerKey, 'superseded by a new call publish offer');
    try {
      const answer = await this.mediaPeers.acceptOffer(
        socket.id,
        {
          type: 'sdp-offer',
          protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
          messageId: `msg_${randomUUID()}`,
          broadcastId,
          sessionId: peerKey,
          peerId: callPublisherPeerId(participantId),
          senderRole: 'broadcaster',
          revision: serial,
          createdAt: new Date().toISOString(),
          payload: { targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID, sdp },
        },
        callPeerSessionSummary(peerKey, broadcastId, participantId, serial),
      );
      return { ok: true, sdp: answer.payload.sdp };
    } catch (error) {
      logger.warn('Call publish offer failed', {
        callId,
        participantId,
        message: error instanceof Error ? error.message : 'unknown publish failure',
      });
      return { ok: false, error: USER_FACING_ERRORS.publish };
    }
  }

  async handlePublishIce(socket: CallSocketLike, raw: unknown): Promise<void> {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return;
    const candidate = readCandidate(raw);
    if (!candidate) return;
    const { callId, participantId } = binding;
    const state = this.participants.get(participantKey(callId, participantId));
    if (!state) return;
    const peerKey = callPublishPeerKey(callId, participantId);
    try {
      await this.mediaPeers.addRemoteCandidate({
        type: 'ice-candidate',
        protocolVersion: WEBRTC_SIGNALLING_PROTOCOL_VERSION,
        messageId: `msg_${randomUUID()}`,
        broadcastId: this.currentEntryFor(state)?.plan.broadcastId ?? `callcast_${callId}_${participantId}`,
        sessionId: peerKey,
        peerId: callPublisherPeerId(participantId),
        senderRole: 'broadcaster',
        revision: state.publishSerial,
        createdAt: new Date().toISOString(),
        payload: {
          targetPeerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          ...(candidate.usernameFragment !== undefined
            ? { usernameFragment: candidate.usernameFragment }
            : {}),
        },
      });
    } catch (error) {
      logger.warn('Call publish ICE candidate rejected', {
        callId,
        participantId,
        message: error instanceof Error ? error.message : 'unknown ICE failure',
      });
    }
  }

  async handleReceiveOffer(socket: CallSocketLike, raw: unknown): Promise<CallSdpAck> {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return { ok: false, error: USER_FACING_ERRORS.notInCall };
    const sdp = readSdp(raw);
    if (!sdp) return { ok: false, error: USER_FACING_ERRORS.receive };
    try {
      const answerSdp = await this.receivePeers.acceptOffer(binding.callId, binding.participantId, sdp);
      return { ok: true, sdp: answerSdp };
    } catch (error) {
      logger.warn('Call receive offer failed', {
        callId: binding.callId,
        participantId: binding.participantId,
        message: error instanceof Error ? error.message : 'unknown receive failure',
      });
      return { ok: false, error: USER_FACING_ERRORS.receive };
    }
  }

  async handleReceiveIce(socket: CallSocketLike, raw: unknown): Promise<void> {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return;
    const candidate = readCandidate(raw);
    if (!candidate) return;
    await this.receivePeers.addRemoteCandidate(binding.callId, binding.participantId, candidate);
  }

  /**
   * Intercept a media-ingest transcription event. Returns true when the event
   * belongs to a call session (the caller must NOT forward it to programme
   * rooms); unknown/stale revision-scoped call ids are swallowed — they are
   * never stamped and never routed.
   */
  interceptTranscriptionEvent(event: TranscriptionEvent): boolean {
    if (!isCallIngestSessionId(event.sessionId)) return false;
    const entry = this.ingestRegistry.get(event.sessionId);
    if (!entry || event.status !== 'transcribed' || event.sourceText.trim().length === 0) {
      return true;
    }
    // Original transcript: the store delivers it as the caption for
    // same-language recipients; translated captions ride the translation events.
    const source: CallCaptionSourceEvent = {
      sourceLanguage: entry.plan.sourceLanguage,
      targetLanguage: null,
      originalText: event.sourceText,
      translatedText: null,
      sequence: event.sequence,
      mediaRevision: entry.plan.mediaRevision,
      languageRevision: entry.languageRevision,
      startMs: event.startMs,
      endMs: event.endMs,
      isFinal: true,
    };
    this.deliverCaptions(entry, source);
    return true;
  }

  /** Intercept a media-ingest timestamped translation event for call sessions. */
  interceptTimestampedTranslationEvent(event: TimestampedTranslationEvent): boolean {
    if (!isCallIngestSessionId(event.sessionId)) return false;
    const entry = this.ingestRegistry.get(event.sessionId);
    if (!entry || event.status !== 'translated') return true;
    const source: CallCaptionSourceEvent = {
      sourceLanguage: event.sourceLanguage || entry.plan.sourceLanguage,
      targetLanguage: event.targetLanguage,
      originalText: event.sourceText,
      translatedText: event.translatedText,
      sequence: event.sequence,
      mediaRevision: entry.plan.mediaRevision,
      languageRevision: entry.languageRevision,
      startMs: event.startMs,
      endMs: event.endMs,
      isFinal: true,
    };
    this.deliverCaptions(entry, source);
    return true;
  }

  /** Intercept a media-ingest generated-audio-ready event for call sessions. */
  interceptGeneratedAudioEvent(event: GeneratedAudioReadyEvent): boolean {
    if (!isCallIngestSessionId(event.sessionId)) return false;
    const entry = this.ingestRegistry.get(event.sessionId);
    if (!entry) return true;
    // audioUrl is forwarded exactly as media-ingest published it (the same
    // publicly reachable URL programme listeners receive today).
    const source: CallGeneratedAudioSourceEvent = {
      targetLanguage: event.targetLanguage,
      voiceId: event.voiceId,
      audioUrl: event.audioUrl,
      sequence: event.sequence,
      startMs: event.startMs,
      durationMs: event.durationMs,
      mediaRevision: entry.plan.mediaRevision,
      languageRevision: entry.languageRevision,
    };
    for (const delivery of this.store.routeGeneratedAudio(entry.callId, entry.participantId, source)) {
      this.emitToRoom(
        callParticipantRoom(entry.callId, delivery.recipientParticipantId),
        CALL_EVENTS.GENERATED_AUDIO,
        delivery.payload,
      );
    }
    return true;
  }

  /** Call sessions never surface on the programme `media:state` broadcast. */
  interceptMediaStateEvent(event: MediaStateEvent): boolean {
    if (!event.processingSessionId || !isCallIngestSessionId(event.processingSessionId)) {
      return false;
    }
    logger.debug('Call media state event swallowed', {
      processingSessionId: event.processingSessionId,
      streamStatus: event.streamStatus,
    });
    return true;
  }

  /** Cleanup evidence for tests and diagnostics. */
  getDiagnostics(): {
    activeCallCount: number;
    participantCount: number;
    ingestSessionCount: number;
    socketBindingCount: number;
    publishPeerBindingCount: number;
    receivePeerCount: number;
    publishPeerCount: number;
  } {
    return {
      activeCallCount: this.store.activeCallCount(),
      participantCount: this.participants.size,
      ingestSessionCount: this.ingestRegistry.size,
      socketBindingCount: this.socketBindings.size,
      publishPeerBindingCount: this.publishPeerIndex.size,
      receivePeerCount: this.receivePeers.count(),
      publishPeerCount: this.mediaPeers.getSnapshots().length,
    };
  }

  /**
   * Create the media-ingest session for every recomputed ingest plan, retiring
   * each participant's superseded revision-scoped session first (its id
   * changed, so the old bridge and media-ingest sessions are stopped by their
   * OLD ids and can never touch the replacement).
   *
   * Session creation stays DEFERRED while a speaker has no connected
   * recipients: transcription/translation would serve nobody, and the next
   * membership change mints a fresh revision-scoped session anyway.
   */
  private async applyIngestPlans(
    callId: string,
    snapshot: CallSnapshot,
    plans: CallIngestPlan[],
  ): Promise<void> {
    for (const plan of plans) {
      const participantId = participantIdFromPlan(plan, callId);
      if (!participantId) {
        logger.warn('Call ingest plan with unexpected session id skipped', {
          callId,
          ingestSessionId: plan.ingestSessionId,
        });
        continue;
      }
      const state = this.participants.get(participantKey(callId, participantId));
      if (state?.currentIngestSessionId && state.currentIngestSessionId !== plan.ingestSessionId) {
        this.retireIngestEntry(state.currentIngestSessionId, 'superseded by membership change');
      }
      if (state) {
        state.currentIngestSessionId = plan.ingestSessionId;
        state.mediaRevision = plan.mediaRevision;
      }
      const sameIdEntry = this.ingestRegistry.get(plan.ingestSessionId);
      const entry: CallIngestRegistryEntry = {
        callId,
        participantId,
        plan,
        effectiveTargetLanguages: effectiveIngestTargets(plan),
        languageRevision: state?.languageRevision ?? 1,
        active: sameIdEntry?.active ?? false,
        everCreated: sameIdEntry?.everCreated ?? false,
        pendingStop: sameIdEntry?.pendingStop ?? null,
      };
      this.ingestRegistry.set(plan.ingestSessionId, entry);

      const hasRecipients = snapshot.participants.some(
        (participant) => participant.participantId !== participantId && participant.connected,
      );
      if (!hasRecipients || entry.active) {
        continue;
      }
      try {
        await this.ingestControl.createSession(bridgeContextFor(entry));
        entry.active = true;
        entry.everCreated = true;
      } catch (error) {
        logger.warn('Call ingest session create failed', {
          callId,
          ingestSessionId: plan.ingestSessionId,
          revision: plan.mediaRevision,
          message: error instanceof Error ? error.message : 'unknown create failure',
        });
        this.emitToRoom(callRoom(callId), CALL_EVENTS.ERROR, {
          code: 'call-captions-unavailable',
          message: USER_FACING_ERRORS.captions,
        });
      }
    }
  }

  private deliverCaptions(entry: CallIngestRegistryEntry, source: CallCaptionSourceEvent): void {
    for (const delivery of this.store.routeCaption(entry.callId, entry.participantId, source)) {
      this.emitToRoom(
        callParticipantRoom(entry.callId, delivery.recipientParticipantId),
        CALL_EVENTS.CAPTION,
        delivery.payload,
      );
    }
  }

  /** Backend media peer ICE for the publish leg, relayed as `call:publish:ice`. */
  private handleMediaLocalSignal(
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
    >,
  ): void {
    if (envelope.type !== 'ice-candidate') return;
    const identity = envelope.sessionId ? this.publishPeerIndex.get(envelope.sessionId) : undefined;
    if (!identity) return;
    this.emitToRoom(
      callParticipantRoom(identity.callId, identity.participantId),
      CALL_EVENTS.PUBLISH_ICE,
      {
        callId: identity.callId,
        participantId: identity.participantId,
        candidate: {
          candidate: envelope.payload.candidate,
          sdpMid: envelope.payload.sdpMid ?? null,
          sdpMLineIndex: envelope.payload.sdpMLineIndex ?? null,
          usernameFragment: envelope.payload.usernameFragment ?? null,
        },
      },
    );
  }

  /**
   * One decoded mic frame from a call publisher. The peer is keyed by the
   * participant-STABLE key, so the participant's CURRENT ingest context is
   * resolved here at frame time: after a membership change bumps revisions and
   * rekeys the ingest session, the very next frame from the same long-lived
   * peer flows into the NEW revision's bridge session with no renegotiation.
   * The raw audio is also piped to the OTHER participant's receive peer.
   */
  private handleMediaAudioFrame(
    context: BackendMediaPeerAudioContext,
    data: WebRtcAudioDataLike,
  ): void {
    const identity = this.publishPeerIndex.get(context.sessionId);
    if (!identity) return;
    const state = this.participants.get(participantKey(identity.callId, identity.participantId));
    const entry = state ? this.currentEntryFor(state) : undefined;
    if (entry?.active) {
      try {
        this.transcriptionBridge.handleFrame(bridgeContextFor(entry), data);
      } catch (error) {
        logger.warn('Call transcription bridge frame handling failed', {
          ingestSessionId: entry.plan.ingestSessionId,
          revision: entry.plan.mediaRevision,
          message: error instanceof Error ? error.message : 'unknown transcription failure',
        });
      }
    }
    try {
      this.receivePeers.fanOut(identity.callId, identity.participantId, data);
    } catch (error) {
      logger.warn('Call original-audio fanout failed', {
        callId: identity.callId,
        participantId: identity.participantId,
        message: error instanceof Error ? error.message : 'unknown fanout failure',
      });
    }
  }

  private handleMediaAudioPeerClosed(context: BackendMediaPeerAudioContext, reason: string): void {
    // Intentionally do NOT end the transcription bridge session here: a
    // republish reuses the current bridge session, and an ended bridge session
    // would silently drop all further frames for that revision. Bridge +
    // ingest teardown happens on retire/disconnect/leave.
    logger.debug('Call publish media peer closed', {
      publishPeerKey: context.sessionId,
      revision: context.revision,
      reason,
    });
  }

  /** Stop the participant's publish peer, current bridge/ingest session, and receive peer. */
  private detachParticipantTransport(callId: string, participantId: string, reason: string): void {
    const peerKey = callPublishPeerKey(callId, participantId);
    this.mediaPeers.closeSession(peerKey, reason);
    this.publishPeerIndex.delete(peerKey);
    const state = this.participants.get(participantKey(callId, participantId));
    const entry = state ? this.currentEntryFor(state) : undefined;
    if (entry?.active) {
      entry.active = false;
      this.endBridgeSessionSafely(entry, reason);
      this.stopIngestSessionSafely(entry);
    }
    this.receivePeers.closePeer(callId, participantId, reason);
  }

  /**
   * Remove a superseded/finished revision-scoped registry entry, stop its
   * bridge + media-ingest sessions when they are still running, and DELETE the
   * media-ingest session when it was ever created (review item N1) so retired
   * call sessions do not accumulate in media-ingest. Stop and delete both
   * target the OLD id, so they can never affect a replacement session.
   */
  private retireIngestEntry(ingestSessionId: string, reason: string): void {
    const entry = this.ingestRegistry.get(ingestSessionId);
    if (!entry) return;
    this.ingestRegistry.delete(ingestSessionId);
    if (entry.active) {
      entry.active = false;
      this.endBridgeSessionSafely(entry, reason);
      this.stopIngestSessionSafely(entry);
    }
    if (entry.everCreated) {
      this.deleteIngestSessionSafely(entry);
    }
  }

  private endBridgeSessionSafely(entry: CallIngestRegistryEntry, reason: string): void {
    try {
      this.transcriptionBridge.endSession(bridgeContextFor(entry), reason);
    } catch (error) {
      logger.warn('Call transcription bridge end failed', {
        ingestSessionId: entry.plan.ingestSessionId,
        message: error instanceof Error ? error.message : 'unknown bridge end failure',
      });
    }
  }

  private stopIngestSessionSafely(entry: CallIngestRegistryEntry): void {
    const ingestSessionId = entry.plan.ingestSessionId;
    entry.pendingStop = this.ingestControl.stopSession(ingestSessionId).catch((error: unknown) => {
      logger.warn('Call ingest session stop failed', {
        ingestSessionId,
        message: error instanceof Error ? error.message : 'unknown stop failure',
      });
    });
    // Bridge hygiene (review finding 7): sweep closed call sessions so the
    // shared bridge map does not accumulate them.
    try {
      this.transcriptionBridge.cleanupClosedSessions();
    } catch (error) {
      logger.warn('Call transcription bridge cleanup failed', {
        message: error instanceof Error ? error.message : 'unknown cleanup failure',
      });
    }
  }

  /**
   * Review item N1: fully remove a retired call session from media-ingest.
   * Sequenced after any in-flight stop for the same id; fire-and-forget with
   * logged failure. Guarded so a programme session id could never be deleted
   * from here (the runtime only ever holds `call_` ids to begin with).
   */
  private deleteIngestSessionSafely(entry: CallIngestRegistryEntry): void {
    const ingestSessionId = entry.plan.ingestSessionId;
    if (!isCallIngestSessionId(ingestSessionId)) return;
    const afterStop = entry.pendingStop ?? Promise.resolve();
    void afterStop
      .then(() => this.ingestControl.deleteSession(ingestSessionId))
      .catch((error: unknown) => {
        logger.warn('Call ingest session delete failed', {
          ingestSessionId,
          message: error instanceof Error ? error.message : 'unknown delete failure',
        });
      });
  }

  /** Shared leave path for explicit call:leave and the disconnect reaper. */
  private finalizeLeave(
    callId: string,
    participantId: string,
    socket: CallSocketLike | null,
    reason: string,
  ): { ok: boolean } {
    const key = participantKey(callId, participantId);
    const state = this.participants.get(key);
    if (state) this.cancelReap(state);
    const result = this.store.leave(callId, participantId);
    this.detachParticipantTransport(callId, participantId, reason);
    for (const [ingestSessionId, entry] of [...this.ingestRegistry]) {
      if (entry.callId === callId && entry.participantId === participantId) {
        this.retireIngestEntry(ingestSessionId, reason);
      }
    }
    this.participants.delete(key);
    if (state?.socketId) this.socketBindings.delete(state.socketId);
    if (socket) {
      this.socketBindings.delete(socket.id);
      void socket.leave(callRoom(callId));
      void socket.leave(callParticipantRoom(callId, participantId));
    }
    if (result.callEnded) {
      this.teardownCall(callId, 'call ended');
    } else if (result.snapshot) {
      this.emitToRoom(callRoom(callId), CALL_EVENTS.STATE, toWireCallState(result.snapshot));
    }
    return { ok: result.ok };
  }

  private teardownCall(callId: string, reason: string): void {
    for (const [key, state] of [...this.participants]) {
      if (state.callId !== callId) continue;
      this.cancelReap(state);
      this.detachParticipantTransport(callId, state.participantId, reason);
      this.participants.delete(key);
      if (state.socketId) this.socketBindings.delete(state.socketId);
    }
    for (const [ingestSessionId, entry] of [...this.ingestRegistry]) {
      if (entry.callId === callId) this.retireIngestEntry(ingestSessionId, reason);
    }
    this.receivePeers.closeCall(callId, reason);
    logger.info('Call torn down', { callId, reason });
  }

  /** Arm (or re-arm) the disconnect grace reaper for a disconnected seat. */
  private scheduleReap(state: CallParticipantRuntimeState): void {
    this.cancelReap(state);
    state.reapTimer = this.setTimer(() => {
      state.reapTimer = null;
      try {
        this.reapSeat(state.callId, state.participantId);
      } catch (error) {
        logger.error('Call disconnect reaper failed', {
          callId: state.callId,
          participantId: state.participantId,
          message: error instanceof Error ? error.message : 'unknown reaper failure',
        });
      }
    }, this.disconnectGraceMs);
  }

  private cancelReap(state: CallParticipantRuntimeState): void {
    if (!state.reapTimer) return;
    this.clearTimer(state.reapTimer);
    state.reapTimer = null;
  }

  /** Grace expired without a resume: the seat is auto-left and fully cleaned. */
  private reapSeat(callId: string, participantId: string): void {
    const state = this.participants.get(participantKey(callId, participantId));
    if (!state || state.connected) return;
    logger.info('Call seat auto-left after disconnect grace', {
      callId,
      participantId,
      graceMs: this.disconnectGraceMs,
    });
    this.finalizeLeave(callId, participantId, null, 'disconnect grace expired');
  }

  private currentEntryFor(state: CallParticipantRuntimeState): CallIngestRegistryEntry | undefined {
    return state.currentIngestSessionId
      ? this.ingestRegistry.get(state.currentIngestSessionId)
      : undefined;
  }

  /**
   * A socket may only signal for the identity it joined with; payloads naming
   * another call/participant are rejected before touching any peer state.
   */
  private requireBinding(socket: CallSocketLike, raw: unknown): CallSocketBinding | null {
    const binding = this.socketBindings.get(socket.id);
    if (!binding) return null;
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as { callId?: unknown; participantId?: unknown };
    if (candidate.callId !== binding.callId || candidate.participantId !== binding.participantId) {
      return null;
    }
    return binding;
  }

  /**
   * Async rejection guard (review finding 9): an unexpected throw from any
   * call handler is logged (never with the payload — join payloads carry
   * private resume tokens), acked with the internal-error shape when an ack
   * callback exists, and emitted as `call:error` otherwise.
   */
  private onGuarded(
    socket: CallSocketLike,
    event: string,
    handler: (raw: unknown, ack?: unknown) => void | Promise<void>,
  ): void {
    socket.on(event, (raw: unknown, ack?: unknown) => {
      try {
        const result = handler(raw, ack);
        if (result instanceof Promise) {
          return result.catch((error: unknown) =>
            this.reportInternalFailure(socket, event, ack, error),
          );
        }
        return result;
      } catch (error) {
        this.reportInternalFailure(socket, event, ack, error);
        return undefined;
      }
    });
  }

  private deliverAck(ack: unknown, payload: unknown): void {
    if (typeof ack === 'function') {
      (ack as (payload: unknown) => void)(payload);
    }
  }

  private reportInternalFailure(
    socket: CallSocketLike,
    event: string,
    ack: unknown,
    error: unknown,
  ): void {
    logger.error('Call socket handler failed', {
      event,
      socketId: socket.id,
      message: error instanceof Error ? error.message : 'unknown call handler failure',
    });
    if (typeof ack === 'function') {
      (ack as (payload: unknown) => void)({ ok: false, error: { ...INTERNAL_ERROR } });
      return;
    }
    socket.emit(CALL_EVENTS.ERROR, { ...INTERNAL_ERROR });
  }
}

export function isCallIngestSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CALL_INGEST_SESSION_PREFIX);
}

/** Participant-stable backend publish peer key; never a media-ingest session id. */
export function callPublishPeerKey(callId: string, participantId: string): string {
  return `callpeer_${callId}_${participantId}`;
}

function callPublisherPeerId(participantId: string): string {
  return `peer_call_${participantId}`;
}

function participantKey(callId: string, participantId: string): string {
  return `${callId}:${participantId}`;
}

/**
 * Ingest plan ids are `call_<callId>_<participantId>_r<mediaRevision>`; the
 * callId and revision are known, so the slice is exact.
 */
function participantIdFromPlan(plan: CallIngestPlan, callId: string): string | null {
  const prefix = `${CALL_INGEST_SESSION_PREFIX}${callId}_`;
  const suffix = `_r${plan.mediaRevision}`;
  if (!plan.ingestSessionId.startsWith(prefix) || !plan.ingestSessionId.endsWith(suffix)) return null;
  const participantId = plan.ingestSessionId.slice(prefix.length, plan.ingestSessionId.length - suffix.length);
  return participantId.length > 0 ? participantId : null;
}

/**
 * Media-ingest rejects a session whose resolved target equals its source, and
 * an empty target list resolves to the configured default target (which may
 * equal the source). For a same-language pair the plan therefore carries a
 * synthetic target: the OTHER supported call language. Transcription (and so
 * original-language captions) flows; the unused translation output routes to
 * no recipient.
 */
function effectiveIngestTargets(plan: CallIngestPlan): CallLanguage[] {
  if (plan.targetLanguages.length > 0) return [...plan.targetLanguages];
  return [plan.sourceLanguage === 'en' ? 'es' : 'en'];
}

function bridgeContextFor(entry: CallIngestRegistryEntry): WebRtcTranscriptionBridgeContext {
  const targetLanguage = entry.effectiveTargetLanguages[0];
  return {
    sessionId: entry.plan.ingestSessionId,
    broadcastId: entry.plan.broadcastId,
    broadcasterPeerId: callPublisherPeerId(entry.participantId),
    revision: entry.plan.mediaRevision,
    sourceLanguage: entry.plan.sourceLanguage,
    sourceLanguageMode: entry.plan.sourceLanguageMode,
    targetLanguages: [...entry.effectiveTargetLanguages],
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(Object.keys(entry.plan.voiceIdsByLanguage).length > 0
      ? { voiceIdsByLanguage: { ...entry.plan.voiceIdsByLanguage } }
      : {}),
    // Calls play translations at the voice's own pace; the programme
    // window-fit compressed them into the source segment and clipped speech.
    generatedAudioPacing: 'natural',
  };
}

function callPeerSessionSummary(
  peerKey: string,
  broadcastId: string,
  participantId: string,
  revision: number,
): WebRtcSessionSummary {
  const now = new Date().toISOString();
  return {
    sessionId: peerKey,
    broadcastId,
    state: 'ready',
    revision,
    broadcasterPeerId: callPublisherPeerId(participantId),
    peerCount: 1,
    peers: [
      {
        peerId: callPublisherPeerId(participantId),
        role: 'broadcaster',
        state: 'joined',
        revision,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function toWireCallState(snapshot: CallSnapshot): CallStateWirePayload {
  // Sanitized projection: no ingest ids, revisions, voice ids, resume tokens.
  return {
    callId: snapshot.callId,
    state: snapshot.lifecycleState,
    participants: snapshot.participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      speakLanguage: participant.speakLanguage,
      hearLanguage: participant.hearLanguage,
      joined: participant.connected,
    })),
  };
}

function readSdp(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const sdp = (raw as { sdp?: unknown }).sdp;
  if (typeof sdp !== 'string' || sdp.length === 0) return null;
  if (sdp.length > WEBRTC_SIGNALLING_LIMITS.sdpMaxLength) return null;
  return sdp;
}

function readCandidate(raw: unknown): {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = (raw as { candidate?: unknown }).candidate;
  if (!candidate || typeof candidate !== 'object') return null;
  const init = candidate as {
    candidate?: unknown;
    sdpMid?: unknown;
    sdpMLineIndex?: unknown;
    usernameFragment?: unknown;
  };
  if (typeof init.candidate !== 'string' || init.candidate.length === 0) return null;
  if (init.candidate.length > WEBRTC_SIGNALLING_LIMITS.iceCandidateMaxLength) return null;
  return {
    candidate: init.candidate,
    sdpMid: typeof init.sdpMid === 'string' ? init.sdpMid : null,
    sdpMLineIndex: typeof init.sdpMLineIndex === 'number' ? init.sdpMLineIndex : null,
    ...(typeof init.usernameFragment === 'string'
      ? { usernameFragment: init.usernameFragment }
      : {}),
  };
}
