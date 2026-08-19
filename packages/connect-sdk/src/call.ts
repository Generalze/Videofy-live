/** @owner masterzee001 */
/**
 * VideofyCall: the public call object.
 *
 * This is the call-web App.tsx orchestration (join, resume with retry and
 * single-flight, peer establishment, lifecycle nudges, camera toggle,
 * teardown) ported onto the relocated @videofy-live/call-client-core modules
 * and re-expressed through the public Connect state model. Everything wire-
 * shaped stays private; integrators see CallSnapshot and the ten events.
 *
 * Privacy: the join token, resume token, subject and wire callId are held in
 * private fields, never logged, and never placed on the public snapshot
 * beyond what the contract deliberately exposes (subject).
 */
import {
  CALL_EVENTS,
  CALL_REMOTE_SLOT_COUNT,
  CallAudioOutputController,
  CallGeneratedAudioQueueController,
  CallLifecycleObserver,
  CallPeer,
  CallRemoteSlotBinder,
  CallRemoteSpeakerAudioController,
  CallVideoMesh,
  CallWakeLock,
  DEFAULT_TRANSLATED_LEVEL,
  ackErrorMessage,
  anyRemoteTranslationExpected,
  buildCallAudioModePayload,
  buildCallCaptionLanguagePayload,
  buildCallIcePayload,
  buildCallLeavePayload,
  buildCallSdpPayload,
  buildTranscriptFileContent,
  callCaptionEntryId,
  captionEntryFromEvent,
  detectAudioOutputCapability,
  failedResumeAckHandling,
  generatedClipEligibility,
  hdCameraVideoConstraints,
  listAudioOutputs,
  mergeCallCaption,
  resolveCallAudioMix,
  resolveSpeakerAudioMixes,
  stopMediaStreamTracks,
} from '@videofy-live/call-client-core';
import type {
  CallAudioMixDecision,
  CallCaptionEntry,
  CallCaptionEvent,
  CallErrorEvent,
  CallEventName,
  CallGeneratedAudioEvent,
  CallIcePayload,
  CallJoinAck,
  CallResumeCredentials,
  CallSdpAck,
  CallSdpPayload,
  CallSetModeAck,
  CallStateSnapshot,
  CallVideoIcePayload,
  CallVideoSdpPayload,
  CallReceiveTrackMapping,
  RemoteSpeakerAudio,
  SpeakerAudioMixDecision,
} from '@videofy-live/call-client-core';
import type { CallJoinPayload } from '@videofy-live/call-wire';
import type {
  AudioMode,
  CallCaptionView,
  CallMode,
  CallParticipantView,
  CallSnapshot,
  ConnectErrorCode,
  ConnectionState,
  LanguageTag,
  PublicCallId,
} from '@videofy-live/connect-contracts';
import type { ConnectSdkDeps, ConnectSocketLike } from './deps';
import { ConnectEventEmitter } from './emitter';
import {
  VideofyConnectError,
  asConnectError,
  connectErrorFromJoinFailure,
  publicErrorCode,
} from './errors';
import { clearConnectResume, loadConnectResume, saveConnectResume } from './resumePersistence';
import { deepFreeze, deliveryStateFromGain } from './snapshot';
import type { ConnectTokenClaims } from './tokenClaims';
import type {
  AudioOutputCapabilities,
  ConnectLogger,
  JoinMediaOptions,
  VideoElementSurface,
  VideofyCall,
  VideofyClientConfig,
} from './publicTypes';

const ACK_TIMEOUT_MS = 8_000;
const SDP_ACK_TIMEOUT_MS = 10_000;
const RESUME_RETRY_MS = 4_000;

/**
 * Resume-refusal codes that mean the credential in hand can never work again
 * (R13): reaped seat, restarted gateway, refused registry membership. The
 * legacy 'unknown-participant' is today's spelling; the public codes are what
 * the Connect gateway wave may answer with.
 */
const TERMINAL_RESUME_CODES: ReadonlySet<string> = new Set([
  'unknown-participant',
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED_TOKEN',
  'AUTH_TOKEN_USED',
  'CALL_NOT_FOUND',
  'CALL_ENDED',
  'FORBIDDEN_ORIGIN',
  'FORBIDDEN_PROJECT',
]);

interface CaptionMeta {
  language: LanguageTag;
  receivedAt: number;
}

export class VideofyCallEngine implements VideofyCall {
  private readonly emitter = new ConnectEventEmitter();
  private readonly logger: ConnectLogger | undefined;

  /** Private credential material. Never logged, never surfaced. */
  private readonly token: string;
  private resumeToken: string | null = null;

  private readonly publicCallId: PublicCallId;
  /**
   * The id used on wire payloads. Starts as the token's public call id (the
   * only address the client holds); adopts the gateway's ack-snapshot callId
   * so bound payloads always match the seat binding. Never public.
   */
  private wireCallId: string;

  private socket: ConnectSocketLike | null = null;
  private session: { participantId: string } | null = null;
  private wireState: CallStateSnapshot | null = null;
  /**
   * Proven defect, found by the Connect Reference App's end-to-end runs: a
   * join/resume ack can carry a snapshot CAPTURED
   * BEFORE a STATE broadcast that this socket has already processed (the
   * gateway broadcasts on join completion, then awaits ingest planning
   * before acking). Socket delivery is in-order, so any broadcast seen
   * after the request was emitted is at least as fresh as the ack —
   * adopting the ack over it regresses the roster (observed as a one-tile
   * room until the next broadcast). This flag marks that a fresher
   * broadcast landed while the request was in flight.
   */
  private wireStateSupersedesAck = false;

  private localAudioMode: AudioMode;
  private captionsEnabled: boolean;
  private localHearLanguage: LanguageTag;
  private micMuted = false;
  private micRequested: boolean;
  private readonly cameraRequested: boolean;
  private micStream: MediaStream | null = null;

  private captionsRing: readonly CallCaptionEntry[] = [];
  private readonly captionMeta = new Map<string, CaptionMeta>();
  private readonly transcript: CallCaptionEntry[] = [];

  private readonly output: CallAudioOutputController;
  private readonly outputCapabilityKind: 'selectable' | 'system-only';
  private readonly binder: CallRemoteSlotBinder;
  private readonly speakerAudio: CallRemoteSpeakerAudioController;
  private readonly queue: CallGeneratedAudioQueueController;
  private readonly wakeLock: CallWakeLock;
  private lifecycle: CallLifecycleObserver | null = null;

  private publishPeer: CallPeer | null = null;
  private receivePeer: CallPeer | null = null;
  private peerStates: { publish: RTCPeerConnectionState; receive: RTCPeerConnectionState } = {
    publish: 'new',
    receive: 'new',
  };
  private mesh: CallVideoMesh | null = null;
  private cameraStream: MediaStream | null = null;
  private cameraBusy = false;

  private readonly remoteVideo = new Map<string, MediaStream>();
  private readonly videoElements = new Map<string, VideoElementSurface>();

  private speakersState: readonly RemoteSpeakerAudio[] = [];
  private currentDecisions: ReadonlyMap<string, SpeakerAudioMixDecision> = new Map();
  private lastMix: CallAudioMixDecision = {
    originalVolume: 1,
    translatedVolume: DEFAULT_TRANSLATED_LEVEL,
    playGenerated: true,
  };
  private playbackBlocked = false;
  private translatedUnavailable = false;

  private resumeInFlight = false;
  private joinInFlight = false;
  private resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private establishInFlight = false;

  private connection: ConnectionState = 'connecting';
  private ended = false;
  private disposed = false;
  private toreDown = false;

  private currentSnapshot: CallSnapshot;
  private inPublish = false;
  private pendingPublish = false;

  constructor(
    private readonly config: VideofyClientConfig,
    private readonly deps: ConnectSdkDeps,
    private readonly claims: ConnectTokenClaims,
    token: string,
    media: JoinMediaOptions | undefined,
  ) {
    this.logger = config.logger;
    this.token = token;
    this.publicCallId = claims.call;
    this.wireCallId = claims.call;
    this.localAudioMode = claims.prefs.audioMode;
    this.captionsEnabled = claims.prefs.captions;
    this.localHearLanguage = claims.prefs.hear;
    this.micRequested = media?.microphone !== false;
    this.cameraRequested = media?.camera === true;

    this.output = new CallAudioOutputController({
      onError: () =>
        this.emitPublicError('MEDIA_UNAVAILABLE', 'That audio output could not be applied.'),
    });
    this.outputCapabilityKind = detectAudioOutputCapability(deps.audioOutputPlatform).kind;

    const binder = new CallRemoteSlotBinder();
    const speakerAudio = new CallRemoteSpeakerAudioController({
      outputController: this.output,
      ...(deps.createSpeakerElement ? { createElement: deps.createSpeakerElement } : {}),
      onStateChange: (speakers) => {
        this.speakersState = speakers;
        this.publish();
      },
      onPlaybackBlocked: (blocked) => this.audioBlockedEdge(blocked),
    });
    // The binder decides WHO; the controller decides how it is heard. An
    // unresolved track produces no speaker: attribution fails closed without
    // silencing everybody.
    binder.onChange((bindings) => speakerAudio.applyBindings(bindings));
    this.binder = binder;
    this.speakerAudio = speakerAudio;

    // ONE queue and ONE player for the call's lifetime: reconnects rebuild
    // peers, never the queue, so translated audio can never double up and the
    // gesture unlock survives reconnection.
    this.queue = new CallGeneratedAudioQueueController({
      player: deps.createGeneratedAudioPlayer(this.output),
      onStateChange: (state) => {
        this.audioBlockedEdge(state.status === 'blocked');
        const unavailable = state.status === 'source-error' || state.status === 'error';
        if (unavailable && !this.translatedUnavailable) {
          this.emitPublicError(
            'GENERATED_AUDIO_UNAVAILABLE',
            state.error ?? 'Translated audio could not be played.',
          );
        }
        this.translatedUnavailable = unavailable;
      },
    });

    this.wakeLock = new CallWakeLock({});
    this.currentSnapshot = deepFreeze(this.buildSnapshot());
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.joinInFlight = true;
    try {
      if (this.micRequested) {
        await this.ensureMicStream();
      }
      const socket = this.deps.createSocket(this.config.baseUrl);
      this.socket = socket;
      this.attachSocketHandlers(socket);
      await waitForSocketConnect(socket, ACK_TIMEOUT_MS);

      const storage = this.deps.resumeStorage;
      // A reload can resume the previous seat for this call: the stored
      // credentials — not a second consumption of the single-use token — are
      // what prove the seat is ours. The record carries the id the seat is
      // registered under, because a resume is a TOKENLESS join (the gateway's
      // resume carve-out) and must name that id itself.
      const stored = loadConnectResume(storage, this.claims.call);
      let payload: CallJoinPayload;
      if (stored) {
        this.wireCallId = stored.wireCallId;
        payload = this.buildJoinPayload({
          participantId: stored.participantId,
          resumeToken: stored.resumeToken,
        });
      } else {
        payload = this.buildJoinPayload();
      }
      this.wireStateSupersedesAck = false;
      let ack = await emitJoinRequest(socket, payload);
      if (!ack.ok && stored) {
        const handling = failedResumeAckHandling(ack.code);
        if (handling.clearStoredCredentials) {
          clearConnectResume(storage);
        }
        if (handling.retryFreshJoin) {
          // The seat is truly gone: fall back to a fresh token-bearing join,
          // addressed by the token again.
          this.wireCallId = this.claims.call;
          payload = this.buildJoinPayload();
          this.wireStateSupersedesAck = false;
          ack = await emitJoinRequest(socket, payload);
        }
      }
      if (!ack.ok) {
        this.logger?.warn?.('join refused');
        throw connectErrorFromJoinFailure(ack.code, ackErrorMessage(ack.error));
      }

      this.session = { participantId: ack.participantId };
      this.adoptAckSnapshot(ack);
      this.resumeToken = this.persistResume(ack);
      this.connection = 'connected';
      this.startLifecycleObserver();
      // W7 enhancement only: nothing may depend on the lock being granted.
      void this.wakeLock.request();
      // Start inside the join gesture so browsers allow audio playback. Not
      // awaited: the join must not wait on an unlock; a refusal surfaces as
      // an audioBlocked event instead.
      void this.queue.start();
      this.publish();
      try {
        await this.establishPeers();
      } catch {
        // Audio still connecting; the lifecycle nudge and reconnects retry.
        this.logger?.debug?.('peer establishment deferred');
      }
      if (this.cameraRequested) {
        void this.setCamera(true).catch(() => undefined);
      }
    } catch (error) {
      this.ended = true;
      this.connection = 'ended';
      this.teardownResources();
      throw asConnectError(error);
    } finally {
      this.joinInFlight = false;
    }
  }

  // -------------------------------------------------------------------------
  // Socket handlers (ported from call-web ensureSocket)
  // -------------------------------------------------------------------------

  private attachSocketHandlers(socket: ConnectSocketLike): void {
    socket.on('connect', () => this.handleSocketReconnect());
    socket.on('disconnect', () => {
      if (this.session && !this.ended && !this.disposed) {
        this.connection = 'reconnecting';
        this.publish();
      }
    });
    socket.on(CALL_EVENTS.STATE, (snapshot: CallStateSnapshot | null) => {
      this.handleWireState(snapshot ?? null);
    });
    socket.on(CALL_EVENTS.CAPTION, (event: CallCaptionEvent) => this.handleCaption(event));
    socket.on(CALL_EVENTS.GENERATED_AUDIO, (event: CallGeneratedAudioEvent) => {
      this.handleGeneratedAudio(event);
    });
    socket.on(CALL_EVENTS.ERROR, (event: CallErrorEvent) => {
      this.emitPublicError(
        publicErrorCode(event?.code),
        event?.message ?? 'Something went wrong with the call.',
      );
    });
    socket.on(CALL_EVENTS.PUBLISH_ICE, (payload: CallIcePayload) => {
      void this.publishPeer?.addRemoteCandidate(payload?.candidate);
    });
    socket.on(CALL_EVENTS.RECEIVE_ICE, (payload: CallIcePayload) => {
      void this.receivePeer?.addRemoteCandidate(payload?.candidate);
    });
    socket.on(
      CALL_EVENTS.RECEIVE_TRACKS,
      (payload: { tracks?: CallReceiveTrackMapping[] } | null) => {
        // Authoritative: which remote speaker each receive slot is carrying.
        this.binder.acceptMapping(payload?.tracks ?? []);
      },
    );
    // Video mesh signalling: the gateway relays with the SENDER's id
    // preserved; unknown senders are dropped inside the mesh.
    socket.on(CALL_EVENTS.VIDEO_OFFER, (payload: CallVideoSdpPayload) => {
      void this.mesh?.handleOffer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ANSWER, (payload: CallVideoSdpPayload) => {
      void this.mesh?.handleAnswer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ICE, (payload: CallVideoIcePayload) => {
      void this.mesh?.handleIce(payload.participantId, payload);
    });
  }

  private handleWireState(snapshot: CallStateSnapshot | null): void {
    if (this.ended || this.disposed) return;
    this.wireStateSupersedesAck = true;
    this.wireState = snapshot;
    if (snapshot?.state === 'ended') {
      // Server-authority end (Connect project or gateway). Terminal for the
      // call, not for the partnership: a NEW token joins a NEW call.
      this.emitPublicError('CALL_ENDED', 'This call has ended.');
      this.endInternal();
      return;
    }
    this.mesh?.syncParticipants(
      (snapshot?.participants ?? [])
        .filter((participant) => participant.joined)
        .map((participant) => participant.participantId),
    );
    this.publish();
  }

  private handleCaption(event: CallCaptionEvent): void {
    if (this.ended || this.disposed) return;
    if (!event || typeof event !== 'object') return;
    const merged = mergeCallCaption(this.captionsRing, event);
    this.captionsRing = merged;
    const id = callCaptionEntryId(event);
    const existing = this.captionMeta.get(id);
    this.captionMeta.set(id, {
      language: (event.targetLanguage ?? event.sourceLanguage) as LanguageTag,
      receivedAt: existing?.receivedAt ?? this.deps.now(),
    });
    // Bound: the meta map follows the ring, so neither can grow without limit.
    const live = new Set(merged.map((entry) => entry.id));
    for (const key of [...this.captionMeta.keys()]) {
      if (!live.has(key)) this.captionMeta.delete(key);
    }
    if (event.isFinal) {
      const entry = captionEntryFromEvent(event);
      const index = this.transcript.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) this.transcript[index] = entry;
      else this.transcript.push(entry);
    }
    this.publish();
    const settled = merged.find((entry) => entry.id === id);
    if (settled) {
      this.emitter.emit('caption', this.captionView(settled));
    }
  }

  private handleGeneratedAudio(event: CallGeneratedAudioEvent): void {
    if (this.ended || this.disposed) return;
    // W4: a clip is only eligible when this speaker/listener pair actually
    // requires generated delivery right now; an unresolved speaker fails
    // CLOSED — synthetic audio must never play on a guess.
    const verdict = generatedClipEligibility(
      this.currentDecisions.get(event.speakerParticipantId),
      this.lastMix.playGenerated,
    );
    if (verdict === 'eligible') {
      this.queue.enqueue(event);
    }
  }

  // -------------------------------------------------------------------------
  // Resume (ported from call-web handleSocketReconnect)
  // -------------------------------------------------------------------------

  private handleSocketReconnect(): void {
    const socket = this.socket;
    if (
      !socket ||
      !this.session ||
      this.resumeInFlight ||
      this.joinInFlight ||
      this.ended ||
      this.disposed
    ) {
      return;
    }
    this.resumeInFlight = true;
    this.connection = 'restoring';
    this.publish();
    const token = this.resumeToken;
    const payload = this.buildJoinPayload(
      token !== null
        ? { participantId: this.session.participantId, resumeToken: token }
        : undefined,
    );
    void (async () => {
      try {
        this.wireStateSupersedesAck = false;
        const ack = await emitJoinRequest(socket, payload);
        if (!ack.ok) {
          if (isTerminalResumeCode(ack.code)) {
            // R13: the seat is gone (reaped, restarted, refused). No retry
            // with this credential can succeed; the partner must mint a new
            // token before this person can rejoin.
            clearConnectResume(this.deps.resumeStorage);
            this.resumeToken = null;
            this.logger?.warn?.('resume refused; a new join token is required');
            this.endWithNeedsNewJoinToken();
          } else {
            // Transient failure: keep the credentials and actually retry —
            // with the socket still connected no connect event will re-fire
            // this path on its own. The gateway's grace window bounds how
            // long these retries can matter.
            this.logger?.debug?.('resume deferred; retrying shortly');
            if (this.resumeRetryTimer !== null) clearTimeout(this.resumeRetryTimer);
            this.resumeRetryTimer = setTimeout(() => {
              this.resumeRetryTimer = null;
              if (this.socket?.connected && this.session) this.handleSocketReconnect();
            }, RESUME_RETRY_MS);
          }
          return;
        }
        this.session = { participantId: ack.participantId };
        this.adoptAckSnapshot(ack);
        this.resumeToken = this.persistResume(ack);
        if (this.micRequested) {
          // Media re-establishment is best-effort here, exactly as on the
          // initial join: the SEAT is restored by the ack, and a peer that
          // fails to negotiate is retried by the lifecycle nudge rather than
          // pinning the whole call in 'restoring'.
          try {
            await this.ensureMicStream();
            await this.establishPeers();
          } catch {
            this.logger?.debug?.('peer establishment deferred');
          }
        }
        this.connection = 'connected';
        this.publish();
      } catch {
        // Reconnection is taking longer than expected; the next connect
        // event or lifecycle nudge retries.
        this.logger?.debug?.('resume attempt did not settle');
      } finally {
        this.resumeInFlight = false;
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Peers and video mesh (ported from call-web establishPeers)
  // -------------------------------------------------------------------------

  private async establishPeers(): Promise<void> {
    const socket = this.socket;
    const session = this.session;
    if (!socket || !session) return;
    // Single-flight: a lifecycle nudge must never race an in-flight rebuild
    // from reconnect — the loser would tear down the winner's live peers.
    if (this.establishInFlight) return;
    this.establishInFlight = true;
    this.peerStates = { publish: 'new', receive: 'new' };

    // Rebuilds always close the previous peers first so a reconnect can never
    // leave a duplicate audio path behind. Both binder and controller halves
    // describe transports that no longer exist.
    this.publishPeer?.close();
    this.receivePeer?.close();
    this.publishPeer = null;
    this.receivePeer = null;
    this.binder.reset();
    this.speakerAudio.reset();

    const iceServers = this.config.iceServers ?? [];
    const peerFactory = this.deps.createPeerConnection;
    const connects: Promise<void>[] = [];
    try {
      const mic = this.micStream;
      if (mic) {
        const publish = new CallPeer({
          direction: 'publish',
          stream: mic,
          iceServers,
          ...(peerFactory ? { createPeerConnection: peerFactory } : {}),
          onConnectionStateChange: (state) => {
            this.peerStates.publish = state;
          },
          sendOffer: (sdp) =>
            emitSdpOffer(
              socket,
              CALL_EVENTS.PUBLISH_OFFER,
              buildCallSdpPayload(this.wireCallId, session.participantId, sdp),
            ),
          onLocalIceCandidate: (candidate) =>
            socket.emit(
              CALL_EVENTS.PUBLISH_ICE,
              buildCallIcePayload(this.wireCallId, session.participantId, candidate),
            ),
        });
        this.publishPeer = publish;
        connects.push(publish.connect());
      } else {
        this.peerStates.publish = 'closed';
      }

      const receive = new CallPeer({
        direction: 'receive',
        iceServers,
        ...(peerFactory ? { createPeerConnection: peerFactory } : {}),
        onConnectionStateChange: (state) => {
          this.peerStates.receive = state;
        },
        sendOffer: (sdp) =>
          emitSdpOffer(
            socket,
            CALL_EVENTS.RECEIVE_OFFER,
            buildCallSdpPayload(this.wireCallId, session.participantId, sdp),
          ),
        onLocalIceCandidate: (candidate) =>
          socket.emit(
            CALL_EVENTS.RECEIVE_ICE,
            buildCallIcePayload(this.wireCallId, session.participantId, candidate),
          ),
        remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
        onRemoteTrack: (mid, track) => this.binder.acceptTrack(mid, track),
      });
      this.receivePeer = receive;
      connects.push(receive.connect());

      this.rebuildMesh(socket, session.participantId, iceServers);
      await Promise.all(connects);
    } catch (error) {
      // 'new' is not dead: without this, a failed INITIAL negotiation would
      // never qualify for the lifecycle rebuild and the call stays silent.
      this.peerStates = { publish: 'failed', receive: 'failed' };
      throw error;
    } finally {
      this.establishInFlight = false;
    }
  }

  private rebuildMesh(
    socket: ConnectSocketLike,
    selfParticipantId: string,
    iceServers: RTCIceServer[],
  ): void {
    // The video mesh shares the peers' lifetime — a rebuilt transport gets a
    // NEW mesh, never a reused one.
    this.mesh?.dispose();
    this.mesh = null;
    this.clearRemoteVideo();
    const peerFactory = this.deps.createPeerConnection;
    try {
      const mesh = new CallVideoMesh({
        callId: this.wireCallId,
        selfParticipantId,
        iceServers,
        ...(peerFactory ? { createPeerConnection: () => peerFactory() } : {}),
        sendOffer: (payload) => socket.emit(CALL_EVENTS.VIDEO_OFFER, payload),
        sendAnswer: (payload) => socket.emit(CALL_EVENTS.VIDEO_ANSWER, payload),
        sendIce: (payload) => socket.emit(CALL_EVENTS.VIDEO_ICE, payload),
        onRemoteStream: (participantId, stream) => {
          if (stream) this.remoteVideo.set(participantId, stream);
          else this.remoteVideo.delete(participantId);
          const element = this.videoElements.get(participantId);
          if (element) element.srcObject = stream;
          this.publish();
        },
        onPeerState: () => {},
      });
      this.mesh = mesh;
      mesh.syncParticipants(
        (this.wireState?.participants ?? [])
          .filter((participant) => participant.joined)
          .map((participant) => participant.participantId),
      );
      if (this.cameraStream) mesh.setLocalStream(this.cameraStream);
    } catch {
      // No RTCPeerConnection here (old browser / tests): the call proceeds
      // audio-only. Honest absence, not a fake video surface.
      this.mesh = null;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle observation (ported nudge; W7)
  // -------------------------------------------------------------------------

  private startLifecycleObserver(): void {
    if (this.lifecycle) return;
    this.lifecycle = new CallLifecycleObserver({
      onEvent: (event) => {
        if (this.ended || this.disposed || !this.session) return;
        if (event.kind === 'suspended') {
          this.connection = 'suspended';
          this.publish();
          return;
        }
        if (event.kind !== 'resumed' && event.kind !== 'visible' && event.kind !== 'online') {
          return;
        }
        const socket = this.socket;
        if (!socket) return;
        if (this.connection === 'suspended') {
          this.connection = socket.connected ? 'connected' : 'reconnecting';
          this.publish();
        }
        // A pocketed phone is NOT a network failure: nudge the existing
        // recovery paths. handleSocketReconnect stays the single rejoin
        // authority; audio unlock state is never touched from here.
        if (!socket.connected) {
          socket.connect();
          return;
        }
        const dead = (state: RTCPeerConnectionState): boolean =>
          state === 'failed' || state === 'disconnected' || state === 'closed';
        if (
          !this.establishInFlight &&
          (dead(this.peerStates.publish) || dead(this.peerStates.receive)) &&
          this.micStream
        ) {
          void this.establishPeers().catch(() => {
            this.logger?.debug?.('peer rebuild will retry');
          });
        }
      },
      ...(this.deps.lifecycleDocument !== undefined
        ? { documentLike: this.deps.lifecycleDocument }
        : {}),
      ...(this.deps.lifecycleWindow !== undefined
        ? { windowLike: this.deps.lifecycleWindow }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  on: VideofyCall['on'] = (event, listener) => {
    this.emitter.on(event, listener);
  };

  off: VideofyCall['off'] = (event, listener) => {
    this.emitter.off(event, listener);
  };

  getSnapshot(): CallSnapshot {
    return this.currentSnapshot;
  }

  async enableAudio(): Promise<void> {
    // Unlocks BOTH playback families in the one gesture: the translated-clip
    // player and every per-speaker original element.
    const generated = this.queue.unlock();
    const speakers = this.speakerAudio.unlock();
    await Promise.allSettled([generated, speakers]);
    this.audioBlockedEdge(this.queue.getState().status === 'blocked');
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    this.assertActive();
    if (!enabled) {
      this.micMuted = true;
      this.micStream?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      this.publish();
      return;
    }
    this.micMuted = false;
    const existing = this.micStream;
    if (existing && existing.getAudioTracks().some((track) => track.readyState === 'live')) {
      existing.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      this.publish();
      return;
    }
    await this.ensureMicStream();
    this.micRequested = true;
    try {
      await this.establishPeers();
    } catch {
      this.logger?.debug?.('peer establishment deferred');
    }
    this.publish();
  }

  async setCamera(enabled: boolean): Promise<void> {
    this.assertActive();
    if (!enabled) {
      const current = this.cameraStream;
      if (!current) return;
      for (const track of current.getTracks()) track.stop();
      this.cameraStream = null;
      this.mesh?.setLocalStream(null);
      this.updateSelfVideoElement();
      this.publish();
      return;
    }
    if (this.cameraStream || this.cameraBusy) return;
    const getUserMedia = this.deps.getUserMedia;
    if (!getUserMedia) {
      throw new VideofyConnectError('MEDIA_UNAVAILABLE', 'This platform cannot capture video.');
    }
    this.cameraBusy = true;
    try {
      const stream = await getUserMedia({ video: hdCameraVideoConstraints() });
      // Talking heads: keep motion smooth, shed resolution first under
      // pressure. A hint to the encoder, never a requirement.
      for (const track of stream.getVideoTracks()) track.contentHint = 'motion';
      if (!this.session || this.ended || this.disposed) {
        // The call ended while permission was pending: the light must not
        // survive the call it was granted for.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.cameraStream = stream;
      this.mesh?.setLocalStream(stream);
      this.updateSelfVideoElement();
      this.publish();
    } catch (error) {
      if (error instanceof VideofyConnectError) throw error;
      throw new VideofyConnectError('MEDIA_PERMISSION_DENIED', 'Camera access was refused.');
    } finally {
      this.cameraBusy = false;
    }
  }

  setAudioMode(mode: AudioMode): void {
    if (!this.active()) return;
    // Local mix flips immediately — these are this listener's own ears. The
    // change must also reach the server NOW so planning follows without a
    // reconnect; an ack failure means server-side PLANNING lagged, reported
    // as an error event rather than pretending the click failed.
    this.localAudioMode = mode;
    this.publish();
    const socket = this.socket;
    const session = this.session;
    if (!socket || !session) return;
    socket.emit(
      CALL_EVENTS.SET_AUDIO_MODE,
      buildCallAudioModePayload(this.wireCallId, session.participantId, mode),
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          this.emitPublicError(
            'INTERNAL',
            ack.error ?? 'The call could not update its audio planning yet.',
          );
        }
      },
    );
  }

  setHearLanguage(language: LanguageTag): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      const session = this.session;
      if (!this.active() || !socket || !session) {
        reject(new VideofyConnectError('CALL_ENDED', 'This call has ended.'));
        return;
      }
      // Not applied optimistically: the server is the authority on whether
      // the call can produce this language, and the broadcast snapshot is
      // what moves the public state.
      socket.timeout(ACK_TIMEOUT_MS).emit(
        CALL_EVENTS.SET_CAPTION_LANGUAGE,
        buildCallCaptionLanguagePayload(this.wireCallId, session.participantId, language),
        (error: unknown, ack?: { ok: boolean; error?: string }) => {
          if (error) {
            reject(
              new VideofyConnectError('CONNECTION_LOST', 'The call service did not respond.'),
            );
            return;
          }
          if (!ack?.ok) {
            reject(
              new VideofyConnectError(
                'INVALID_LANGUAGE',
                ackErrorMessage(ack?.error) ?? 'That language could not be applied.',
              ),
            );
            return;
          }
          // The store's preference moved; every future RESUME must carry it
          // or be refused as a language change.
          this.localHearLanguage = language;
          this.publish();
          resolve();
        },
      );
    });
  }

  setCaptions(enabled: boolean): void {
    if (!this.active()) return;
    this.captionsEnabled = enabled;
    this.publish();
  }

  async setAudioOutput(deviceId: string | null): Promise<void> {
    // Local output routing only — nothing renegotiates, nobody else moves.
    await this.output.setOutput(deviceId, deviceId ? 'selected-output' : 'system-default');
  }

  async getAudioOutputCapabilities(): Promise<AudioOutputCapabilities> {
    if (this.outputCapabilityKind !== 'selectable') {
      return { audioOutput: 'system-only', outputs: [] };
    }
    try {
      const outputs = await listAudioOutputs(this.deps.audioOutputPlatform);
      return { audioOutput: 'selectable', outputs };
    } catch {
      return { audioOutput: 'selectable', outputs: [] };
    }
  }

  setCallMode(mode: CallMode): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      const session = this.session;
      if (!this.active() || !socket || !session) {
        reject(new VideofyConnectError('CALL_ENDED', 'This call has ended.'));
        return;
      }
      socket.timeout(ACK_TIMEOUT_MS).emit(
        CALL_EVENTS.SET_MODE,
        { callId: this.wireCallId, participantId: session.participantId, mode },
        (error: unknown, ack?: CallSetModeAck) => {
          if (error) {
            reject(
              new VideofyConnectError('CONNECTION_LOST', 'The call service did not respond.'),
            );
            return;
          }
          if (ack?.ok) {
            // Deliberately no local state change here: the room broadcast
            // that follows every real change is the ordered source of truth,
            // and applying the ack could roll a newer broadcast back.
            resolve();
            return;
          }
          const code: ConnectErrorCode =
            ack?.error === 'not-owner'
              ? 'OWNER_REQUIRED'
              : ack?.error === 'invalid-mode'
                ? 'INVALID_MODE'
                : 'INTERNAL';
          reject(
            new VideofyConnectError(
              code,
              code === 'OWNER_REQUIRED'
                ? 'Only the call owner can change the call mode.'
                : 'The call mode could not be changed.',
            ),
          );
        },
      );
    });
  }

  getTranscript(): string {
    if (this.wireState?.transcriptDownloadAllowed === false) {
      throw new VideofyConnectError(
        'UNSUPPORTED_CAPABILITY',
        'The call owner has disabled transcript download.',
      );
    }
    return buildTranscriptFileContent(this.publicCallId, this.transcript);
  }

  attachVideo(participantId: string, element: VideoElementSurface): void {
    this.videoElements.set(participantId, element);
    if (participantId === this.session?.participantId) {
      element.srcObject = this.cameraStream;
      return;
    }
    element.srcObject = this.remoteVideo.get(participantId) ?? null;
  }

  detachVideo(participantId: string): void {
    const element = this.videoElements.get(participantId);
    if (element) element.srcObject = null;
    this.videoElements.delete(participantId);
  }

  leave(): void {
    if (this.disposed || this.ended) return;
    const socket = this.socket;
    const session = this.session;
    if (socket && session) {
      try {
        socket.emit(
          CALL_EVENTS.LEAVE,
          buildCallLeavePayload(this.wireCallId, session.participantId),
        );
      } catch {
        // Leaving must always succeed locally.
      }
    }
    // An explicit leave surrenders the seat: the resume entry must not
    // outlive it.
    clearConnectResume(this.deps.resumeStorage);
    this.resumeToken = null;
    this.endInternal();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownResources();
    this.emitter.removeAll();
  }

  // -------------------------------------------------------------------------
  // Snapshot construction and event emission
  // -------------------------------------------------------------------------

  private publish(): void {
    if (this.disposed) return;
    if (this.inPublish) {
      this.pendingPublish = true;
      return;
    }
    this.inPublish = true;
    try {
      do {
        this.pendingPublish = false;
        this.applyAudioPolicy();
        const previous = this.currentSnapshot;
        const next = deepFreeze(this.buildSnapshot());
        this.currentSnapshot = next;
        this.emitDiffs(previous, next);
      } while (this.pendingPublish && !this.disposed);
    } finally {
      this.inPublish = false;
    }
  }

  private emitDiffs(previous: CallSnapshot, next: CallSnapshot): void {
    this.emitter.emit('state', next);
    if (previous.connection !== next.connection) {
      this.emitter.emit('connectionChanged', { connection: next.connection });
    }
    if (previous.call.mode !== next.call.mode) {
      this.emitter.emit('callModeChanged', { mode: next.call.mode });
    }
    const previousById = new Map(previous.participants.map((p) => [p.participantId, p]));
    const nextById = new Map(next.participants.map((p) => [p.participantId, p]));
    for (const participant of next.participants) {
      const before = previousById.get(participant.participantId);
      if (!before) {
        this.emitter.emit('participantJoined', participant);
      } else if (JSON.stringify(before) !== JSON.stringify(participant)) {
        this.emitter.emit('participantUpdated', participant);
      }
    }
    for (const participant of previous.participants) {
      if (!nextById.has(participant.participantId)) {
        this.emitter.emit('participantLeft', participant);
      }
    }
  }

  /**
   * The listener-side audio policy, recomputed on every mutation (the ported
   * React effects). The per-speaker gains it applies are the SOURCE of the
   * public deliveryState — the numbers themselves stay in here.
   */
  private applyAudioPolicy(): void {
    const wireParticipants = this.wireState?.participants ?? [];
    const selfId = this.session?.participantId ?? '';
    const selfHear = this.selfHearLanguage();
    const effectiveMode = this.effectiveAudioMode();
    this.currentDecisions = resolveSpeakerAudioMixes(
      wireParticipants,
      selfId,
      selfHear,
      effectiveMode,
    );
    const mix = resolveCallAudioMix({
      audioMode: effectiveMode,
      originalVolume: 1,
      translatedVolume: DEFAULT_TRANSLATED_LEVEL,
      remoteTranslationExpected: anyRemoteTranslationExpected(wireParticipants, selfId, selfHear),
    });
    this.lastMix = mix;
    this.speakerAudio.setMasterVolume(mix.originalVolume);
    for (const speaker of this.speakersState) {
      this.speakerAudio.setModeGain(
        speaker.speakerParticipantId,
        this.currentDecisions.get(speaker.speakerParticipantId)?.originalGain ?? 1,
      );
    }
    this.queue.setVolume(mix.translatedVolume);
    this.queue.setEnabled(mix.playGenerated);
  }

  private buildSnapshot(): CallSnapshot {
    const wire = this.wireState;
    const selfId = this.session?.participantId ?? '';
    const wireParticipants = wire?.participants ?? [];
    const selfWire = wireParticipants.find((p) => p.participantId === selfId);
    const speakerPrefs = new Map(this.speakersState.map((s) => [s.speakerParticipantId, s]));
    const participants: CallParticipantView[] = wireParticipants
      .filter((p) => p.participantId !== selfId)
      .map((p) => {
        const prefs = speakerPrefs.get(p.participantId);
        return {
          participantId: p.participantId,
          subject: readWireSubject(p),
          displayName: p.displayName,
          speakLanguage: p.speakLanguage,
          hearLanguage: p.hearLanguage,
          connected: p.joined,
          deliveryState: deliveryStateFromGain(
            this.currentDecisions.get(p.participantId)?.originalGain ?? 1,
          ),
          video: { enabled: this.remoteVideo.has(p.participantId) },
          audio: { muted: prefs?.muted ?? false, volume: prefs?.volume ?? 1 },
        };
      });
    const captions: CallCaptionView[] = this.captionsRing.map((entry) => this.captionView(entry));
    return {
      connection: this.connection,
      call: {
        id: this.publicCallId,
        type: wire?.callType ?? 'conference',
        mode: wire?.callMode ?? 'translated',
      },
      self: {
        participantId: selfId,
        subject: this.claims.sub,
        displayName: selfWire?.displayName ?? this.claims.name,
        speakLanguage: selfWire?.speakLanguage ?? this.claims.prefs.speak,
        hearLanguage: this.selfHearLanguage(),
        audioMode: this.localAudioMode,
        captionsEnabled: this.captionsEnabled,
      },
      participants,
      captions,
      capabilities: { audioOutput: this.outputCapabilityKind },
    };
  }

  /**
   * Public caption ids are OPAQUE. The internal entry id embeds the
   * mediaRevision counter as a value (review finding), and a documented
   * stable public id must not teach partners internal vocabulary. Stable per
   * entry for replace-in-place; meaningless otherwise.
   */
  private readonly captionIdMap = new Map<string, string>();
  private captionIdSerial = 0;
  private publicCaptionId(internalId: string): string {
    const existing = this.captionIdMap.get(internalId);
    if (existing) return existing;
    const minted = `cap_${++this.captionIdSerial}`;
    this.captionIdMap.set(internalId, minted);
    return minted;
  }

  private captionView(entry: CallCaptionEntry): CallCaptionView {
    const meta = this.captionMeta.get(entry.id);
    return {
      captionId: this.publicCaptionId(entry.id),
      participantId: entry.speakerParticipantId,
      displayName: entry.speakerDisplayName,
      language: meta?.language ?? 'en',
      text: entry.primaryText,
      final: entry.isFinal,
      receivedAt: meta?.receivedAt ?? 0,
    };
  }

  /**
   * The listener's hear language: authoritative from the snapshot once
   * joined (a mid-call change routes by the live value); the token pref is
   * only the pre-join seed.
   */
  private selfHearLanguage(): LanguageTag {
    const selfId = this.session?.participantId;
    if (selfId) {
      const selfWire = this.wireState?.participants?.find((p) => p.participantId === selfId);
      if (selfWire?.hearLanguage) return selfWire.hearLanguage;
    }
    return this.localHearLanguage;
  }

  /**
   * In a NORMAL call the translation engine is off and originals are the only
   * delivery, so the listener's audio mode reads as 'original' everywhere
   * downstream — a cross-language speaker must never be suppressed when no
   * generated voice will replace them.
   */
  private effectiveAudioMode(): AudioMode {
    return (this.wireState?.callMode ?? 'translated') === 'normal'
      ? 'original'
      : this.localAudioMode;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildJoinPayload(resume?: CallResumeCredentials): CallJoinPayload {
    // FRESH join: the gateway derives the authoritative identity and
    // preferences from the TOKEN (strip-and-rederive) and burns the jti. The
    // legacy-required fields are filled from the same token claims, so
    // nothing here is invented — the server's derivation wins wherever they
    // disagree. speak/hear are narrowed to the wire's primary-subtag
    // vocabulary; unsupported tags fall back to 'en' as a documented
    // placeholder the gateway overrides.
    //
    // RESUME: TOKENLESS by contract — the single-use token's jti is already
    // claimed, and presenting it again would read as reuse. The private
    // resumeToken proves the seat; the payload names the id the seat is
    // registered under (the gateway's connect-prefix rule carves out exactly
    // this shape).
    const payload: CallJoinPayload = {
      callId: this.wireCallId,
      displayName: this.claims.name,
      speakLanguage: wireLanguage(this.claims.prefs.speak),
      hearLanguage: wireLanguage(this.localHearLanguage),
      captionsEnabled: this.captionsEnabled,
      voiceGender: this.claims.prefs.voiceGender,
      audioMode: this.localAudioMode,
    };
    if (resume !== undefined) {
      payload.resumeParticipantId = resume.participantId;
      payload.resumeToken = resume.resumeToken;
    } else {
      // R12: never alongside sessionToken — this SDK has no sessionToken
      // path at all, so the exclusive pair cannot be sent from here.
      payload.connectToken = this.token;
    }
    return payload;
  }

  private adoptAckSnapshot(ack: Extract<CallJoinAck, { ok: true }>): void {
    // Never regress: a broadcast processed since this request was emitted
    // already reflects everything the ack's snapshot knew, and more.
    if (!this.wireStateSupersedesAck || this.wireState === null) {
      this.wireState = ack.snapshot ?? null;
    }
    const callId = ack.snapshot?.callId;
    if (typeof callId === 'string' && callId.length > 0) {
      // Bound payloads must name the id the seat is registered under.
      this.wireCallId = callId;
    }
  }

  private persistResume(ack: Extract<CallJoinAck, { ok: true }>): string | null {
    if (typeof ack.resumeToken === 'string' && ack.resumeToken.length > 0) {
      // Keyed by the PUBLIC id — the only address a reloaded page (which
      // starts again from the token) can look up — and carrying the
      // registered wire id a tokenless resume must name.
      saveConnectResume(this.deps.resumeStorage, {
        publicCallId: this.claims.call,
        wireCallId: this.wireCallId,
        participantId: ack.participantId,
        resumeToken: ack.resumeToken,
      });
      return ack.resumeToken;
    }
    return null;
  }

  private async ensureMicStream(): Promise<MediaStream> {
    const existing = this.micStream;
    if (existing && existing.getAudioTracks().some((track) => track.readyState === 'live')) {
      return existing;
    }
    const getUserMedia = this.deps.getUserMedia;
    if (!getUserMedia) {
      throw new VideofyConnectError(
        'MEDIA_UNAVAILABLE',
        'This platform cannot capture microphone audio.',
      );
    }
    try {
      const stream = await getUserMedia({ audio: true });
      for (const track of stream.getAudioTracks()) {
        track.enabled = !this.micMuted;
      }
      this.micStream = stream;
      return stream;
    } catch {
      throw new VideofyConnectError(
        'MEDIA_PERMISSION_DENIED',
        'Microphone access is needed to join the call.',
      );
    }
  }

  private updateSelfVideoElement(): void {
    const selfId = this.session?.participantId;
    if (!selfId) return;
    const element = this.videoElements.get(selfId);
    if (element) element.srcObject = this.cameraStream;
  }

  private clearRemoteVideo(): void {
    for (const [participantId] of this.remoteVideo) {
      const element = this.videoElements.get(participantId);
      if (element) element.srcObject = null;
    }
    this.remoteVideo.clear();
  }

  private audioBlockedEdge(blocked: boolean): void {
    if (blocked && !this.playbackBlocked) {
      this.playbackBlocked = true;
      this.emitter.emit('audioBlocked', undefined);
      return;
    }
    if (!blocked) this.playbackBlocked = false;
  }

  private emitPublicError(code: ConnectErrorCode, message: string): void {
    if (this.disposed) return;
    this.emitter.emit('error', new VideofyConnectError(code, message).toPublicError());
  }

  private endInternal(): void {
    if (this.ended && this.toreDown) return;
    this.ended = true;
    this.connection = 'ended';
    this.publish();
    this.teardownResources();
  }

  private endWithNeedsNewJoinToken(): void {
    if (this.ended) return;
    this.ended = true;
    this.connection = 'ended';
    this.publish();
    // TERMINAL for the credential in hand (R13): the partner server must mint
    // a fresh token before this person can join again.
    this.emitter.emit('needsNewJoinToken', undefined);
    this.teardownResources();
  }

  private teardownResources(): void {
    if (this.toreDown) return;
    this.toreDown = true;
    if (this.resumeRetryTimer !== null) {
      clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = null;
    }
    this.lifecycle?.dispose();
    this.lifecycle = null;
    this.publishPeer?.close();
    this.publishPeer = null;
    this.receivePeer?.close();
    this.receivePeer = null;
    stopMediaStreamTracks(this.micStream);
    this.micStream = null;
    this.queue.dispose();
    this.speakerAudio.dispose();
    this.binder.reset();
    this.mesh?.dispose();
    this.mesh = null;
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) track.stop();
      this.cameraStream = null;
    }
    for (const [, element] of this.videoElements) {
      element.srcObject = null;
    }
    this.remoteVideo.clear();
    this.wakeLock.dispose();
    this.session = null;
    this.resumeInFlight = false;
    const socket = this.socket;
    this.socket = null;
    socket?.disconnect();
  }

  private active(): boolean {
    return !this.ended && !this.disposed && this.session !== null;
  }

  private assertActive(): void {
    if (!this.active()) {
      throw new VideofyConnectError('CALL_ENDED', 'This call has ended.');
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers (ported from call-web App.tsx)
// ---------------------------------------------------------------------------

function isTerminalResumeCode(code: string | undefined): boolean {
  return code !== undefined && TERMINAL_RESUME_CODES.has(code);
}

/**
 * Narrow a BCP-47 tag to the wire's language vocabulary. A tag outside it is
 * sent as 'en' purely to satisfy the legacy-required field — the gateway
 * rederives the real preference from the token.
 */
function wireLanguage(tag: string): 'en' | 'es' | 'fr' {
  const primary = tag.trim().toLowerCase().split('-')[0];
  return primary === 'es' || primary === 'fr' ? primary : 'en';
}

function readWireSubject(participant: object): string {
  const subject = (participant as { subject?: unknown }).subject;
  return typeof subject === 'string' ? subject : '';
}

function waitForSocketConnect(socket: ConnectSocketLike, timeoutMs: number): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new VideofyConnectError(
          'CONNECTION_LOST',
          'The call service could not be reached. Please try again.',
        ),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
    };
    socket.on('connect', onConnect);
  });
}

function emitJoinRequest(
  socket: ConnectSocketLike,
  payload: CallJoinPayload,
): Promise<CallJoinAck> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit(CALL_EVENTS.JOIN, payload, (error: unknown, ack?: CallJoinAck) => {
        if (error) {
          reject(
            new VideofyConnectError(
              'CONNECTION_LOST',
              'The call service did not respond. Please try again.',
            ),
          );
          return;
        }
        resolve(ack ?? { ok: false, error: 'The call service returned an unexpected reply.' });
      });
  });
}

function emitSdpOffer(
  socket: ConnectSocketLike,
  event: CallEventName,
  payload: CallSdpPayload,
): Promise<string> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(SDP_ACK_TIMEOUT_MS)
      .emit(event, payload, (error: unknown, ack?: CallSdpAck) => {
        if (error || !ack?.ok || typeof ack.sdp !== 'string') {
          reject(new Error('Call audio could not be negotiated.'));
          return;
        }
        resolve(ack.sdp);
      });
  });
}
