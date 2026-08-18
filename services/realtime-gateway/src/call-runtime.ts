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
import { CallTranscriptLog } from './call-transcript-log.js';
import { CallPlaybackLedger, generatedClipId } from './call-playback-ledger.js';
import { CallAcousticRoomObserver } from './call-acoustic-rooms.js';
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
  /**
   * P6.4-W2: which remote speaker each of this listener's receive slots is
   * carrying. Sent to the one listener it describes, never broadcast — a
   * call-wide mapping would hand everybody a map of everyone else's transport
   * state for no reason.
   */
  RECEIVE_TRACKS: 'call:receive:tracks',
  SET_CAPTION_LANGUAGE: 'call:caption-language',
  /**
   * W1: the capture settings the browser actually granted. A preference asked
   * for is not a fact; this is the fact, and every acoustic measurement taken
   * later has to be read against it.
   */
  CAPTURE_SETTINGS: 'call:capture-settings',
  /**
   * W4: a participant's own loudspeaker started or stopped being audible.
   *
   * Reported by the client because only the client knows when its audio element
   * really began, and aggregated HERE because the consequence belongs to a
   * DIFFERENT participant's microphone — which is precisely the thing a
   * client-local "am I playing audio" signal cannot see (NG6).
   */
  PLAYBACK: 'call:playback',
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
  /**
   * @param frame Metadata the registry already stamps — receive wall clock and
   * true input format. Both existed before W2/W3; this signature simply stopped
   * discarding them.
   */
  onAudioFrame(
    context: BackendMediaPeerAudioContext,
    data: WebRtcAudioDataLike,
    frame?: { receivedAtMs: number; sampleRate: number | null; channelCount: number | null },
  ): void;
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
  handleFrame(
    context: WebRtcTranscriptionBridgeContext,
    data: WebRtcAudioDataLike,
    receivedAtMs?: number,
  ): void;
  endSession(context: WebRtcTranscriptionBridgeContext, reason: string): void;
  cleanupClosedSessions(): number;
  /**
   * Wall-clock anchors for the chunk a media-ingest event came from. Optional
   * so a bridge without latency instrumentation still satisfies the contract;
   * latency is then reported as null rather than guessed.
   */
  lookupChunkTiming?(
    sessionId: string,
    revision: number,
    mediaMs: number,
  ): { sequence: number; startMs: number; endMs: number; capturedAtMs: number; submittedAtMs: number | null } | null;
  /** Backpressure/failure counters harvested into the call summary at teardown. */
  getSessionCounters?(
    sessionId: string,
    revision: number,
  ): { evictedChunkCount: number; skippedFrameCount: number; submissionFailureCount: number } | null;
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
  /** Development call-session transcript log; disabled when omitted. */
  transcriptLog?: CallTranscriptLog;
  /** Injectable wall clock for the latency measurement; defaults to Date.now. */
  now?: () => number;
  /**
   * Establishes WHO is speaking from a signed session token, or returns null.
   *
   * The gateway derives voice ownership here and nowhere else. The join payload
   * has no field for naming an account precisely because a client that could
   * name one could name somebody else's, and be spoken in their voice.
   *
   * Omitted, nobody gets a personal voice and every call still works — which is
   * the correct failure direction for an optional feature.
   */
  verifyVoiceIdentity?: (sessionToken: string) => string | null;
  /** W4. Injectable so tests can drive it with a fake clock. */
  playbackLedger?: CallPlaybackLedger;
  /** W5A. Observation only — it has no consumer, by design. */
  acousticObserver?: CallAcousticRoomObserver;
}

/**
 * THE latency number this runtime reports, defined once so the log field, the
 * summary, and any acceptance report all mean the same thing.
 *
 * `deliveryLatencyMs` = (wall clock when the gateway emitted this caption /
 * generated-audio payload into the recipient participant rooms) − (wall clock
 * when the gateway finished capturing the speech segment that produced it,
 * i.e. when the last audio sample of that VAD segment arrived from the
 * speaker's microphone peer).
 *
 * It therefore INCLUDES: gateway chunk staging, time waiting in the gateway
 * submission queue, the media-ingest HTTP hop, STT, translation, TTS, and the
 * gateway's own routing. It EXCLUDES only the browser-to-gateway WebRTC
 * transport of the final frame (tens of ms on a LAN) and any client-side
 * render/playback delay. It is null when the originating chunk is no longer in
 * the bridge's bounded timing history — never estimated.
 */
export const CALL_DELIVERY_LATENCY_DEFINITION =
  'deliveryLatencyMs = wall-clock ms from the end of the captured speech segment (last audio sample of the VAD chunk reaching the gateway) to the moment the gateway emitted the caption or generated-audio payload to the recipient participant rooms; includes staging, gateway queue wait, media-ingest STT/translation/TTS and routing; excludes browser-to-gateway transport and client playback.';

/** Bounded latency sample pool per call, so a long call cannot grow without limit. */
const CALL_LATENCY_SAMPLE_LIMIT = 2_000;

/** Per-call delivery/backpressure accounting behind the `call-summary` record. */
interface CallStatsAccumulator {
  startedAtMs: number;
  participantIds: Set<string>;
  captionsDeliveredByRecipient: Map<string, number>;
  generatedAudioDeliveredByRecipient: Map<string, number>;
  captionEventCount: number;
  generatedAudioEventCount: number;
  latenciesMs: number[];
  latencySampleCount: number;
  ingestFaultCount: number;
  evictedChunkCount: number;
  skippedFrameCount: number;
  submissionFailureCount: number;
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
  | {
      ok: true;
      participantId: string;
      resumeToken: string;
      snapshot: CallStateWirePayload;
      /**
       * Present only when a session token was offered and did not verify. The
       * join itself succeeded — an expired sign-in must not stop somebody
       * joining a conversation — and the call will use a standard voice.
       *
       * A bare flag on purpose. Naming the account, the reason or the expiry
       * would hand a prober precisely what the single rejection path withholds.
       */
      voiceIdentityRejected?: true;
    }
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
  /** De-duplicates repeated ingest-fault log lines for the same condition. */
  lastLoggedFault?: string;
  /**
   * Bridge counters are read once, just before this entry's bridge session is
   * ended (the bridge sweeps closed sessions away right after), so the call
   * summary can never double-count or miss a revision.
   */
  countersHarvested: boolean;
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
  private readonly verifyVoiceIdentity: ((sessionToken: string) => string | null) | undefined;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly transcriptLog: CallTranscriptLog;
  private readonly now: () => number;
  /** W4: when each participant's loudspeaker was actually audible. */
  private readonly playbackLedger: CallPlaybackLedger;
  /**
   * W5A: co-location FEATURES, observed and logged.
   *
   * Nothing in this runtime reads back from it. It produces no room id, and no
   * branch anywhere consults it — that absence is the acceptance criterion, not
   * an oversight.
   */
  private readonly acousticObserver: CallAcousticRoomObserver;
  /** W3: input formats already reported per participant, so it is logged once. */
  private readonly loggedInputFormats = new Set<string>();
  /** Per-call delivery/latency accounting, emitted as `call-summary` on teardown. */
  private readonly callStats = new Map<string, CallStatsAccumulator>();

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
    this.transcriptLog = dependencies.transcriptLog ?? new CallTranscriptLog(null);
    this.now = dependencies.now ?? (() => Date.now());
    this.verifyVoiceIdentity = dependencies.verifyVoiceIdentity;
    this.playbackLedger = dependencies.playbackLedger ?? new CallPlaybackLedger({ nowMs: this.now });
    this.acousticObserver =
      dependencies.acousticObserver ??
      new CallAcousticRoomObserver({
        nowMs: this.now,
        onObservation: (observation) => this.logAcousticObservation(observation),
      });
    this.acousticObserver.start();
    this.mediaPeers = dependencies.createMediaPeers({
      onLocalSignal: (envelope) => this.handleMediaLocalSignal(envelope),
      onAudioFrame: (context, data, frame) => this.handleMediaAudioFrame(context, data, frame),
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
      onTrackMapping: (callId, participantId, tracks) => {
        const state = this.participants.get(participantKey(callId, participantId));
        this.emitToRoom(callParticipantRoom(callId, participantId), CALL_EVENTS.RECEIVE_TRACKS, {
          callId,
          participantId,
          // Carried so a client can discard a mapping that arrived after it
          // had already moved on, using the revision rules that already exist.
          mediaRevision: state?.mediaRevision ?? null,
          tracks,
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
    this.onGuarded(socket, CALL_EVENTS.SET_CAPTION_LANGUAGE, async (raw, ack) => {
      this.deliverAck(ack, await this.handleSetCaptionLanguage(socket, raw));
    });
    // Both are instrumentation reports: no ack, nothing to fail, and both are
    // bound to the socket's own identity before anything is recorded.
    this.onGuarded(socket, CALL_EVENTS.CAPTURE_SETTINGS, (raw) =>
      this.handleCaptureSettings(socket, raw),
    );
    this.onGuarded(socket, CALL_EVENTS.PLAYBACK, (raw) => this.handlePlayback(socket, raw));
  }

  /**
   * A reader changing the language they read captions in, mid-call.
   *
   * Only this participant's captions move. The binding check is what keeps it
   * that way: a socket may only change its OWN preference, so one participant
   * can never re-language another's call.
   */
  async handleSetCaptionLanguage(
    socket: CallSocketLike,
    raw: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return { ok: false, error: USER_FACING_ERRORS.notInCall };
    const language = (raw as { hearLanguage?: unknown }).hearLanguage;
    if (typeof language !== 'string') {
      return { ok: false, error: 'Choose a language to read captions in.' };
    }

    const result = this.store.setCaptionLanguage(binding.callId, binding.participantId, language);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === 'unsupported-language'
            ? 'That language is not available on this call yet.'
            : USER_FACING_ERRORS.notInCall,
      };
    }
    if (!result.changed) return { ok: true };

    logger.info('Call caption language changed', {
      callId: binding.callId,
      participantId: binding.participantId,
      hearLanguage: language,
      languageRevision: result.languageRevision,
    });
    this.emitToRoom(callRoom(binding.callId), CALL_EVENTS.STATE, toWireCallState(result.snapshot));
    // The speakers now owe this reader a language they were not producing, so
    // work orders are reapplied through the same path a join uses.
    await this.applyIngestPlans(binding.callId, result.snapshot, result.ingestPlans);
    return { ok: true };
  }

  async handleJoin(socket: CallSocketLike, raw: unknown): Promise<CallJoinAck> {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'invalid-input', error: USER_FACING_ERRORS.join };
    }
    // The store is the single validation/auth authority for join and resume
    // (including resumeToken checks); the raw payload is never logged because
    // it carries the private resume token and may carry a session token.
    //
    // Voice ownership is the one thing the store must NOT take from the wire.
    // `voiceOwnerId` is stripped from the client payload unconditionally and
    // re-supplied only from a verified signature, so a caller naming somebody
    // else's account gets exactly what a caller naming nobody gets.
    const { voiceOwnerId: _discarded, sessionToken, ...clientInput } = raw as CallJoinInput & {
      sessionToken?: unknown;
    };
    const verifiedOwnerId =
      typeof sessionToken === 'string' && sessionToken.length > 0
        ? (this.verifyVoiceIdentity?.(sessionToken) ?? null)
        : null;
    // A token that was presented and did not verify is reported back, so the
    // browser can say "personal voice is not active" instead of leaving someone
    // wondering why they sound like a stranger. It never says WHY.
    const voiceIdentityRejected =
      typeof sessionToken === 'string' && sessionToken.length > 0 && verifiedOwnerId === null;

    const result = this.store.createOrJoin({
      ...(clientInput as CallJoinInput),
      // Always present, never conditional. Passing the key only when a token
      // verified would let a resume keep whichever account was attached to that
      // seat before — the shared-browser defect, rebuilt on top of real
      // accounts. `null` means "nobody", and the store must hear it said.
      voiceOwnerId: verifiedOwnerId,
    });
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

    this.statsFor(callId).participantIds.add(participantId);
    const wireSnapshot = toWireCallState(result.snapshot);
    this.emitToRoom(callRoom(callId), CALL_EVENTS.STATE, wireSnapshot);
    const joined = result.snapshot.participants.find(
      (participant) => participant.participantId === participantId,
    );
    this.transcriptLog.append({
      kind: 'join',
      callId,
      participantId,
      displayName: joined?.displayName ?? '',
      speakLanguage: joined?.speakLanguage ?? '',
      hearLanguage: joined?.hearLanguage ?? '',
    });

    await this.applyIngestPlans(callId, result.snapshot, result.ingestPlans);

    // resumeToken travels ONLY in this private ack, never in call:state/logs.
    return {
      ok: true,
      participantId,
      resumeToken: result.resumeToken,
      snapshot: wireSnapshot,
      // Only ever `true`, and only in this private ack. A field that named the
      // account, the reason, or the expiry would be handing a prober exactly
      // the information the single rejection path exists to withhold.
      ...(voiceIdentityRejected ? { voiceIdentityRejected: true as const } : {}),
    };
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
      // A freshly negotiated peer has empty slots. Binding here is what makes a
      // reconnect recover its speakers without waiting for the next membership
      // change, which might never come in a settled call.
      this.syncReceiveSlots(binding.callId, this.store.snapshot(binding.callId));
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
    // A participant who joined under auto-detect gets their language settled by
    // the first real utterance. Done before the caption is routed so this
    // caption is already addressed with the corrected language and revision,
    // rather than being delivered against a language we now know was wrong.
    if (!isInterimEvent(event)) {
      this.settleDetectedLanguage(entry, event.detectedLanguage);
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
      // Streaming captions: media-ingest marks interim results `isFinal: false`
      // and omits the flag entirely on finals.
      isFinal: !isInterimEvent(event),
    };
    this.deliverCaptions(entry, source);
    return true;
  }

  /**
   * Settles the language of a participant who joined under auto-detect.
   *
   * The call core decides whether the change is allowed — a stated language is
   * never overridden, and a settled one never moves again — so this only feeds
   * it what the recogniser heard and reacts to the answer. When the language
   * really did change, the speaker's ingest session is now planned for the
   * wrong pair: it is retired so the next chunk starts a session that
   * translates from what they are actually speaking.
   */
  private settleDetectedLanguage(entry: CallIngestRegistryEntry, detectedLanguage: string): void {
    if (entry.plan.sourceLanguageMode !== 'auto') return;

    // The core decides whether this is allowed and what it means; the gateway
    // only reports what was heard and carries out the consequences.
    const result = this.store.applyDetectedLanguage(
      entry.callId,
      entry.participantId,
      detectedLanguage,
    );
    if (!result.ok || !result.changed) return;

    logger.info('Call source language settled by detection', {
      callId: entry.callId,
      participantId: entry.participantId,
      from: entry.plan.sourceLanguage,
      to: detectedLanguage,
      languageRevision: result.languageRevision,
    });
    this.emitToRoom(callRoom(entry.callId), CALL_EVENTS.STATE, toWireCallState(result.snapshot));
    // Every participant's work order changed, not just the speaker's: the
    // others' translation target for this speaker moved with it. Applied
    // through the same path a join uses, so the two cannot drift apart.
    void this.applyIngestPlans(entry.callId, result.snapshot, result.ingestPlans);
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
      isFinal: !isInterimEvent(event),
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
    const deliveries = this.store.routeGeneratedAudio(entry.callId, entry.participantId, source);
    // W4 Path A: register the clip against its recipients BEFORE emitting, so a
    // client that reports playback immediately still finds its interval waiting.
    const clipId = generatedClipId({
      speakerParticipantId: entry.participantId,
      targetLanguage: source.targetLanguage,
      mediaRevision: source.mediaRevision,
      languageRevision: source.languageRevision,
      sequence: source.sequence,
    });
    this.playbackLedger.registerGeneratedClip({
      callId: entry.callId,
      clipId,
      recipientParticipantIds: deliveries.map((delivery) => delivery.recipientParticipantId),
      durationMs: source.durationMs,
    });
    for (const delivery of deliveries) {
      this.emitToRoom(
        callParticipantRoom(entry.callId, delivery.recipientParticipantId),
        CALL_EVENTS.GENERATED_AUDIO,
        delivery.payload,
      );
    }
    // Measured AFTER the emits, exactly as for captions.
    const latency = this.measureDeliveryLatency(entry, event.startMs);
    const stats = this.statsFor(entry.callId);
    stats.generatedAudioEventCount += 1;
    for (const delivery of deliveries) {
      bump(stats.generatedAudioDeliveredByRecipient, delivery.recipientParticipantId);
    }
    if (deliveries.length > 0) this.recordLatencySample(stats, latency.deliveryLatencyMs);
    this.transcriptLog.append({
      kind: 'generated-audio',
      callId: entry.callId,
      speakerParticipantId: entry.participantId,
      targetLanguage: source.targetLanguage,
      voiceId: source.voiceId,
      durationMs: source.durationMs,
      sequence: source.sequence,
      audioUrl: source.audioUrl,
      deliveredTo: deliveries.length,
      /**
       * Media-timeline end of the SOURCE speech segment (not of the generated
       * clip: with natural pacing the clip's own length differs).
       */
      segmentEndMs: event.endMs,
      /** See CALL_DELIVERY_LATENCY_DEFINITION. Null when the chunk timing is unknown. */
      deliveryLatencyMs: latency.deliveryLatencyMs,
      /** Delivery minus the moment media-ingest accepted the chunk (no gateway queue wait). */
      sinceChunkSubmittedMs: latency.sinceChunkSubmittedMs,
      /** Provider-reported synthesis time for this clip, for stage breakdown. */
      ttsProviderMs: event.providerLatencyMs ?? null,
    });
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
    // Surface ingest faults (dropped chunks, provider errors) into the call log
    // so a stalled conversation can be explained after the fact.
    const entry = this.ingestRegistry.get(event.processingSessionId);
    const fault = event.transcription?.error ?? event.monitoring?.lastError ?? null;
    if (entry && (fault || event.streamStatus === 'failed')) {
      const signature = `${event.streamStatus}:${fault ?? ''}`;
      if (entry.lastLoggedFault !== signature) {
        entry.lastLoggedFault = signature;
        this.statsFor(entry.callId).ingestFaultCount += 1;
        this.transcriptLog.append({
          kind: 'ingest-fault',
          callId: entry.callId,
          speakerParticipantId: entry.participantId,
          ingestSessionId: event.processingSessionId,
          streamStatus: event.streamStatus,
          error: fault,
        });
      }
    }
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
  /**
   * Reconcile receive-slot bindings against the authoritative snapshot.
   *
   * Driven from the store's snapshot rather than from the runtime's own maps,
   * so the transport can never bind somebody the session layer does not
   * consider present.
   */
  private syncReceiveSlots(callId: string, snapshot: CallSnapshot | null): void {
    if (!snapshot) return;
    try {
      this.receivePeers.syncSpeakers(
        callId,
        snapshot.participants.map((participant) => participant.participantId),
      );
    } catch (error) {
      logger.warn('Call receive slot reconciliation failed', {
        callId,
        message: error instanceof Error ? error.message : 'unknown slot sync failure',
      });
    }
  }

  private async applyIngestPlans(
    callId: string,
    snapshot: CallSnapshot,
    plans: CallIngestPlan[],
  ): Promise<void> {
    // Membership just changed, so every listener's slot bindings are reconciled
    // here. Rebinding is metadata only — no track is added or removed — so this
    // costs no renegotiation, which is the whole reason slots are preallocated.
    this.syncReceiveSlots(callId, snapshot);
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
        // The plan is the authority for BOTH revisions, and this line was
        // missing while its sibling above was correct. Without it the registry
        // kept a stale languageRevision, routableSpeaker refused every event as
        // out-of-date, and one "Read captions in" change silenced captions AND
        // generated audio for every participant, permanently, with no error
        // anywhere. Reproduced: deliveries drop to zero and never recover.
        state.languageRevision = plan.languageRevision;
      }
      const sameIdEntry = this.ingestRegistry.get(plan.ingestSessionId);
      const entry: CallIngestRegistryEntry = {
        callId,
        participantId,
        plan,
        effectiveTargetLanguages: effectiveIngestTargets(plan),
        // From the plan, not from possibly-stale participant state.
        languageRevision: plan.languageRevision,
        active: sameIdEntry?.active ?? false,
        everCreated: sameIdEntry?.everCreated ?? false,
        pendingStop: sameIdEntry?.pendingStop ?? null,
        countersHarvested: sameIdEntry?.countersHarvested ?? false,
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
    const deliveries = this.store.routeCaption(entry.callId, entry.participantId, source);
    for (const delivery of deliveries) {
      this.emitToRoom(
        callParticipantRoom(entry.callId, delivery.recipientParticipantId),
        CALL_EVENTS.CAPTION,
        delivery.payload,
      );
    }
    // Measured AFTER the emits: the number is the moment of delivery, not the
    // moment the runtime decided to deliver.
    const latency = this.measureDeliveryLatency(entry, source.startMs);
    const stats = this.statsFor(entry.callId);
    stats.captionEventCount += 1;
    for (const delivery of deliveries) {
      bump(stats.captionsDeliveredByRecipient, delivery.recipientParticipantId);
    }
    // Only a delivered payload can have a delivery latency: an event routed to
    // nobody is counted, never timed. Interim (partial) captions are excluded
    // so the summary keeps meaning "time to deliver a COMPLETED utterance";
    // partials are faster by construction and would flatter the median.
    if (deliveries.length > 0 && source.isFinal) {
      this.recordLatencySample(stats, latency.deliveryLatencyMs);
    }
    this.transcriptLog.append({
      kind: 'caption',
      callId: entry.callId,
      speakerParticipantId: entry.participantId,
      sourceLanguage: source.sourceLanguage,
      targetLanguage: source.targetLanguage,
      originalText: source.originalText,
      translatedText: source.translatedText,
      sequence: source.sequence,
      mediaRevision: source.mediaRevision,
      isFinal: source.isFinal,
      deliveredTo: deliveries.length,
      /** Media-timeline end of the spoken segment this caption came from. */
      segmentEndMs: source.endMs,
      /** See CALL_DELIVERY_LATENCY_DEFINITION. Null when the chunk timing is unknown. */
      deliveryLatencyMs: latency.deliveryLatencyMs,
      /** Delivery minus the moment media-ingest accepted the chunk (no gateway queue wait). */
      sinceChunkSubmittedMs: latency.sinceChunkSubmittedMs,
    });
  }

  /**
   * Turn a media-ingest event's media-timeline position into wall-clock
   * latency, using the bridge's record of when that chunk's audio finished
   * arriving. Returns nulls (never an estimate) when the chunk is unknown.
   */
  private measureDeliveryLatency(
    entry: CallIngestRegistryEntry,
    mediaMs: number,
  ): { deliveryLatencyMs: number | null; sinceChunkSubmittedMs: number | null } {
    const timing = this.transcriptionBridge.lookupChunkTiming?.(
      entry.plan.ingestSessionId,
      entry.plan.mediaRevision,
      mediaMs,
    );
    if (!timing) return { deliveryLatencyMs: null, sinceChunkSubmittedMs: null };
    const deliveredAtMs = this.now();
    return {
      deliveryLatencyMs: Math.max(0, deliveredAtMs - timing.capturedAtMs),
      sinceChunkSubmittedMs:
        timing.submittedAtMs === null ? null : Math.max(0, deliveredAtMs - timing.submittedAtMs),
    };
  }

  private recordLatencySample(stats: CallStatsAccumulator, latencyMs: number | null): void {
    if (latencyMs === null) return;
    stats.latencySampleCount += 1;
    // Bounded pool: percentiles come from the first N samples of a call and
    // the summary reports how many were actually kept.
    if (stats.latenciesMs.length < CALL_LATENCY_SAMPLE_LIMIT) stats.latenciesMs.push(latencyMs);
  }

  private statsFor(callId: string): CallStatsAccumulator {
    const existing = this.callStats.get(callId);
    if (existing) return existing;
    const created: CallStatsAccumulator = {
      startedAtMs: this.now(),
      participantIds: new Set<string>(),
      captionsDeliveredByRecipient: new Map<string, number>(),
      generatedAudioDeliveredByRecipient: new Map<string, number>(),
      captionEventCount: 0,
      generatedAudioEventCount: 0,
      latenciesMs: [],
      latencySampleCount: 0,
      ingestFaultCount: 0,
      evictedChunkCount: 0,
      skippedFrameCount: 0,
      submissionFailureCount: 0,
    };
    this.callStats.set(callId, created);
    return created;
  }

  /**
   * Read this entry's bridge backpressure counters exactly once, before its
   * bridge session is ended and swept away, so the call summary can report how
   * much speech the pipeline actually dropped.
   */
  private harvestBridgeCounters(entry: CallIngestRegistryEntry): void {
    if (entry.countersHarvested) return;
    entry.countersHarvested = true;
    const counters = this.transcriptionBridge.getSessionCounters?.(
      entry.plan.ingestSessionId,
      entry.plan.mediaRevision,
    );
    if (!counters) return;
    const stats = this.statsFor(entry.callId);
    stats.evictedChunkCount += counters.evictedChunkCount;
    stats.skippedFrameCount += counters.skippedFrameCount;
    stats.submissionFailureCount += counters.submissionFailureCount;
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
    frame?: { receivedAtMs: number; sampleRate: number | null; channelCount: number | null },
  ): void {
    const identity = this.publishPeerIndex.get(context.sessionId);
    if (!identity) return;
    const state = this.participants.get(participantKey(identity.callId, identity.participantId));
    const entry = state ? this.currentEntryFor(state) : undefined;
    const receivedAtMs = frame?.receivedAtMs ?? this.now();
    if (entry?.active) {
      try {
        this.transcriptionBridge.handleFrame(bridgeContextFor(entry), data, receivedAtMs);
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
    // INSTRUMENTATION RUNS LAST, AND CANNOT THROW PAST HERE.
    //
    // Both of these originally sat above the bridge and the fan-out, unguarded.
    // Nothing in them throws today — which is exactly why it was easy to miss
    // that a throw would have silently stopped the frame reaching either. That
    // is the road by which "observation only" stops being true, and it is worth
    // more as an ordering guarantee than as a promise about today's code.
    try {
      // W3: stamped once per participant, so a corpus recording carries the
      // rate its acoustic measurements were taken at.
      this.recordInputFormat(identity.callId, identity.participantId, frame);
      // W5A: envelope extraction only. No correlation runs here — that is on a
      // timer — and nothing this call does is conditioned on the result.
      if (data.samples) {
        this.acousticObserver.observeFrame(
          identity.callId,
          identity.participantId,
          data.samples,
          frame?.sampleRate ?? data.sampleRate ?? 0,
          receivedAtMs,
        );
      }
    } catch (error) {
      logger.debug('Call acoustic instrumentation failed for one frame', {
        callId: identity.callId,
        message: error instanceof Error ? error.message : 'unknown instrumentation failure',
      });
    }
  }

  /**
   * W3 — write the true input format down once per participant.
   *
   * Once, not per frame: it does not change mid-track, and a per-frame record
   * would bury the log in the one fact it is trying to make findable.
   */
  private recordInputFormat(
    callId: string,
    participantId: string,
    frame?: { sampleRate: number | null; channelCount: number | null },
  ): void {
    const sampleRate = frame?.sampleRate ?? null;
    if (sampleRate === null) return;
    const key = `${callId}:${participantId}:${sampleRate}`;
    if (this.loggedInputFormats.has(key)) return;
    this.loggedInputFormats.add(key);
    this.acousticObserver.setProvenance(callId, participantId, { inputSampleRate: sampleRate });
    this.transcriptLog.append({
      kind: 'input-format',
      callId,
      participantId,
      inputSampleRate: sampleRate,
      inputChannelCount: frame?.channelCount ?? null,
    });
  }

  /**
   * W5A — record an observed feature row. This is its ONLY destination.
   *
   * Deliberately written to the development transcript log and nowhere else:
   * no room id is produced, no state is updated, and nothing in this runtime
   * reads it back.
   */
  private logAcousticObservation(observation: {
    callId: string;
    pairKey: string;
    correlation: number;
    lagMs: number;
    lowBandCoherence: number;
    midBandCoherence: number;
    highBandCoherence: number;
    concurrentVoicedMs: number;
    comparedMs: number;
    hypothesis: string;
    provenanceA: unknown;
    provenanceB: unknown;
  }): void {
    this.transcriptLog.append({
      kind: 'acoustic-observation',
      callId: observation.callId,
      pairKey: observation.pairKey,
      correlation: observation.correlation,
      lagMs: observation.lagMs,
      lowBandCoherence: observation.lowBandCoherence,
      midBandCoherence: observation.midBandCoherence,
      highBandCoherence: observation.highBandCoherence,
      concurrentVoicedMs: observation.concurrentVoicedMs,
      comparedMs: observation.comparedMs,
      /** An unconsumed hypothesis for M5 to score. Never an authority. */
      hypothesis: observation.hypothesis,
      provenanceA: observation.provenanceA,
      provenanceB: observation.provenanceB,
    });
  }

  /** W1 — the capture settings the browser granted this participant. */
  private handleCaptureSettings(socket: CallSocketLike, raw: unknown): void {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return;
    const payload = raw as {
      settings?: Record<string, unknown>;
      reason?: unknown;
      requestedCaptureProfile?: unknown;
    };
    const settings = payload.settings;
    if (!settings || typeof settings !== 'object') return;
    // Recorded as reported and NOT validated against an allow-list here: an
    // unrecognised profile name is a corpus provenance question, and silently
    // rewriting it to a known value would destroy the evidence that a run was
    // collected under something nobody expected.
    const requestedCaptureProfile =
      typeof payload.requestedCaptureProfile === 'string' ? payload.requestedCaptureProfile : null;
    const echoCancellation = settings['echoCancellation'];
    this.acousticObserver.setProvenance(binding.callId, binding.participantId, {
      echoCancellation:
        typeof echoCancellation === 'boolean' || typeof echoCancellation === 'string'
          ? (echoCancellation as boolean | 'all' | 'remote-only')
          : null,
      noiseSuppression: typeof settings['noiseSuppression'] === 'boolean' ? settings['noiseSuppression'] : null,
      autoGainControl: typeof settings['autoGainControl'] === 'boolean' ? settings['autoGainControl'] : null,
      deviceLabel: typeof settings['deviceLabel'] === 'string' ? settings['deviceLabel'] : null,
    });
    this.transcriptLog.append({
      kind: 'capture-settings',
      callId: binding.callId,
      participantId: binding.participantId,
      reason: payload.reason === 'device-change' ? 'device-change' : 'join',
      /** What was asked for. `settings` below is what was granted. */
      requestedCaptureProfile,
      settings,
    });
  }

  /**
   * W4 — a client reporting its OWN loudspeaker.
   *
   * Behind `requireBinding`, so a socket can only ever speak for the identity it
   * joined with. That matters more here than elsewhere: a playback report is a
   * claim about a loudspeaker, and an unbound socket claiming somebody else's
   * would corrupt the one measurement this wave exists to establish.
   */
  private handlePlayback(socket: CallSocketLike, raw: unknown): void {
    const binding = this.requireBinding(socket, raw);
    if (!binding) return;
    const payload = raw as { stream?: unknown; clipId?: unknown; phase?: unknown; atMs?: unknown };
    const stream = payload.stream === 'remote-original' ? 'remote-original' : 'generated';
    const phase = payload.phase === 'end' ? 'end' : 'start';
    this.playbackLedger.reportPlayback({
      callId: binding.callId,
      participantId: binding.participantId,
      stream,
      clipId: typeof payload.clipId === 'string' ? payload.clipId : null,
      phase,
      clientAtMs: typeof payload.atMs === 'number' && Number.isFinite(payload.atMs) ? payload.atMs : null,
    });
    this.transcriptLog.append({
      kind: 'playback',
      callId: binding.callId,
      participantId: binding.participantId,
      stream,
      clipId: typeof payload.clipId === 'string' ? payload.clipId : null,
      phase,
      /** The client's own clock, kept SEPARATE from the gateway's so skew is measurable. */
      clientAtMs: typeof payload.atMs === 'number' ? payload.atMs : null,
      gatewayAtMs: this.now(),
    });
  }

  /** W4 diagnostics: both interval streams plus what was never reported at all. */
  getPlaybackLedger(): CallPlaybackLedger {
    return this.playbackLedger;
  }

  /** W5A diagnostics: the frame-path cost a call actually pays. */
  getAcousticObserverCost(): ReturnType<CallAcousticRoomObserver['costSnapshot']> {
    return this.acousticObserver.costSnapshot();
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
    // W5A holds ~12 s of envelope per participant; release it with the transport.
    this.acousticObserver.dropParticipant(callId, participantId);
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
    // Read counters first: ending the session lets the bridge sweep it away.
    this.harvestBridgeCounters(entry);
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
    // Free the departed speaker's slot on everyone still here. The track stays;
    // only the binding is released, so nobody renegotiates because somebody
    // else hung up.
    this.syncReceiveSlots(callId, result.snapshot);
    if (state?.socketId) this.socketBindings.delete(state.socketId);
    if (socket) {
      this.socketBindings.delete(socket.id);
      void socket.leave(callRoom(callId));
      void socket.leave(callParticipantRoom(callId, participantId));
    }
    this.transcriptLog.append({ kind: 'leave', callId, participantId, reason });
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
    // Emitted last: every entry has been retired, so all bridge counters for
    // every revision of this call have been harvested.
    this.appendCallSummary(callId, reason);
    logger.info('Call torn down', { callId, reason });
  }

  /**
   * §30.4 acceptance evidence: one record per call stating what was actually
   * delivered, what was dropped, and how long delivery took. Percentiles use
   * the nearest-rank method over the kept latency samples.
   */
  private appendCallSummary(callId: string, reason: string): void {
    const stats = this.callStats.get(callId);
    if (!stats) return;
    this.callStats.delete(callId);
    const captionsByRecipient = Object.fromEntries(stats.captionsDeliveredByRecipient);
    const audioByRecipient = Object.fromEntries(stats.generatedAudioDeliveredByRecipient);
    const playback = this.playbackLedger.statsFor(callId);
    const acoustic = this.acousticObserver.costSnapshot();
    this.transcriptLog.append({
      kind: 'call-summary',
      callId,
      reason,
      durationMs: Math.max(0, this.now() - stats.startedAtMs),
      participantCount: stats.participantIds.size,
      captionsDelivered: sumValues(captionsByRecipient),
      captionsDeliveredByRecipient: captionsByRecipient,
      captionEvents: stats.captionEventCount,
      generatedAudioDelivered: sumValues(audioByRecipient),
      generatedAudioDeliveredByRecipient: audioByRecipient,
      generatedAudioEvents: stats.generatedAudioEventCount,
      /** Stale queued speech dropped so the newest speech could be transcribed. */
      droppedChunksEvicted: stats.evictedChunkCount,
      /** Frames the chunker refused (queue/buffer limits, malformed audio). */
      droppedFramesSkipped: stats.skippedFrameCount,
      chunkSubmissionFailures: stats.submissionFailureCount,
      ingestFaults: stats.ingestFaultCount,
      latencyField: 'deliveryLatencyMs',
      latencyDefinition: CALL_DELIVERY_LATENCY_DEFINITION,
      latencySampleCount: stats.latencySampleCount,
      latencySamplesKept: stats.latenciesMs.length,
      latencyMedianMs: nearestRankPercentile(stats.latenciesMs, 0.5),
      latencyP90Ms: nearestRankPercentile(stats.latenciesMs, 0.9),
      /**
       * W4. `playbackClipsUnreported` is the load-bearing one: those are clips
       * this gateway emitted and no client ever confirmed playing. They are
       * reported as MISSING rather than backfilled from emit time, because a
       * clip nobody confirmed is not evidence that anything was audible.
       */
      playbackClipsRegistered: playback.registeredClipCount,
      playbackClipsStarted: playback.startedClipCount,
      playbackClipsUnreported: playback.unreportedClipCount,
      playbackUnknownClipReports: playback.unknownClipReportCount,
      playbackRemoteOriginalIntervals: playback.remoteOriginalIntervalCount,
      /** M3: distribution of (client-reported start − gateway emit). */
      playbackStartSkewMedianMs: nearestRankPercentile([...playback.startSkewSamples], 0.5),
      playbackStartSkewP90Ms: nearestRankPercentile([...playback.startSkewSamples], 0.9),
      /** W5A cost, so "it is only observation" is a measured claim. */
      acousticFrameCostP50Ms: acoustic.frameCostP50Ms,
      acousticFrameCostP99Ms: acoustic.frameCostP99Ms,
      acousticObservationCount: acoustic.observationCount,
    });
    this.playbackLedger.dropCall(callId);
    this.acousticObserver.dropCall(callId);
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

/**
 * Streaming captions (§22.1): media-ingest marks an interim result for an
 * utterance still being spoken with `isFinal: false`, and omits the flag on
 * finals. Read structurally so the gateway does not couple to the producer's
 * exact event type; the media-contracts schemas are what guarantee the flag
 * survives validation instead of being stripped in transit.
 */
function isInterimEvent(event: unknown): boolean {
  return (event as { isFinal?: unknown }).isFinal === false;
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

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sumValues(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/**
 * Nearest-rank percentile: the smallest observed sample at or above the given
 * rank. No interpolation, so every reported number is a value that was really
 * measured. Null for an empty sample set — never 0, which would read as fast.
 */
function nearestRankPercentile(samples: number[], percentile: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index] ?? null;
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
    // The call core and media-ingest name this the same thing differently:
    // a plan's `auto` is ingest's `auto-detect`. Translated here rather than
    // widening either contract to carry the other's spelling.
    sourceLanguageMode: entry.plan.sourceLanguageMode === 'auto' ? 'auto-detect' : 'manual',
    targetLanguages: [...entry.effectiveTargetLanguages],
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(Object.keys(entry.plan.voiceIdsByLanguage).length > 0
      ? { voiceIdsByLanguage: { ...entry.plan.voiceIdsByLanguage } }
      : {}),
    // The speaker's voice owner, when they have one. Kept separate from
    // voiceIdsByLanguage on purpose: those are the standard fallbacks, planned
    // once per media revision, and a personal voice must never be planned
    // ahead — only resolved at the moment of speaking.
    ...(entry.plan.voiceOwnerId ? { voiceOwnerId: entry.plan.voiceOwnerId } : {}),
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
