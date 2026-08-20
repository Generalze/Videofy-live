/** @owner masterzee001 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import {
  selectLegacyProgrammeAudiences,
  type LegacyProgrammeAudience,
} from '@videofy-live/language-router';
import type {
  AudioMixPreferences,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  OperatorProgrammeSessionConfig,
  StreamStatus,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  TranslationEvent,
  WebRtcIncomingSignallingEnvelope,
} from '@videofy-live/shared-types';
import {
  INGEST_ROOM,
  createShareableWebRtcSessionId,
  languageRoom,
  OPERATOR_ROOM,
  SOCKET_EVENTS,
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_LIMITS,
  WORKER_ROOM,
} from '@videofy-live/shared-types';
import {
  safeParseMediaStateEvent,
  safeParseGeneratedAudioReadyEvent,
  safeParseTimestampedTranslationEvent,
  safeParseTranscriptionEvent,
  safeParseTranslationEvent,
  safeParseWebRtcSignallingEnvelope,
  isUnsupportedWebRtcProtocolVersion,
} from '@videofy-live/media-contracts';
import { createCallVoiceIdentityVerifier } from './call-voice-identity.js';
import { EventStore } from './event-store.js';
import { GeneratedAudioStore } from './generated-audio-store.js';
import { logger } from './logger.js';
import {
  WebRtcSessionRegistry,
  WebRtcSignallingError,
  signallingErrorEnvelope,
  type WebRtcRouteResult,
} from './webrtc-session-registry.js';
import {
  BackendMediaPeerError,
  BackendWebRtcMediaPeerRegistry,
  BACKEND_WEBRTC_MEDIA_SOCKET_ID,
  backendSignalEnvelope,
  type BackendMediaPeerAudioContext,
} from './webrtc-media-peer-registry.js';
import { BackendWebRtcListenerPeerRegistry } from './webrtc-listener-peer-registry.js';
import {
  HttpMediaTranscriptionSubmissionClient,
  MediaTranscriptionBridge,
  type MediaTranscriptionBridgeContext,
} from './media-transcription-bridge.js';
import { CallSessionStore } from '@videofy-live/call-session';
import type { Router } from 'express';
import {
  ConnectJoinGate,
  ConnectJtiRegistry,
  ConnectLiveCallRegistry,
  createConnectV1Router,
  loadConnectProjectRegistry,
  requireConnectAuthSecret,
  type ConnectCallFacade,
  type ConnectProjectRegistry,
} from '@videofy-live/connect-control';
import { CallRuntime, CALL_PARTICIPANT_ROLE } from './call-runtime.js';
import { CallReceivePeerManager } from './call-receive-peers.js';
import { CallTranscriptLog } from './call-transcript-log.js';

/** Pseudo-language channel for listeners following the untranslated programme captions. */
const ORIGINAL_LANGUAGE_CHANNEL = 'original';

/** Client role determined by query parameter on connect. */
type ClientRole = 'listener' | 'operator' | 'worker' | 'ingest' | 'broadcaster' | 'server' | 'call';

interface ClientState {
  role: ClientRole;
  socketId: string;
  connectedAt: string;
  targetLanguage: string | undefined;
  signallingWindowStartedAt: number;
  signallingMessageCount: number;
}

type ServiceName = 'gateway' | 'media-ingest' | 'speech-worker';
type HealthStatus = 'healthy' | 'unhealthy';
type OperatorControlAction =
  'start-mock-stream' | 'stop-mock-stream' | 'trigger-mock-phrase' | 'reset-mock-sequence';

interface ServiceStatusEvent {
  service: ServiceName;
  status: HealthStatus;
  socketId?: string;
  timestamp: string;
}

interface OperatorControlEvent {
  action: OperatorControlAction;
  eventId?: string;
  targetLanguage?: string;
}

export class Gateway {
  private readonly io: SocketServer;
  private readonly store = new EventStore({
    onReady: (events) => this.broadcastTranslationEvents(events),
  });
  private readonly generatedAudioStore = new GeneratedAudioStore();
  private readonly webrtcSessions = new WebRtcSessionRegistry();
  private readonly webRtcTranscriptionBridge: MediaTranscriptionBridge;
  private readonly backendMediaPeers: BackendWebRtcMediaPeerRegistry;
  private readonly listenerMediaPeers: BackendWebRtcListenerPeerRegistry;
  private readonly callRuntime: CallRuntime;
  private readonly mediaIngestUrl: string;
  private readonly mediaIngestPublicUrl: string;
  private readonly clients = new Map<string, ClientState>();
  private readonly programmeSessionConfigs = new Map<string, OperatorProgrammeSessionConfig>();
  private readonly activeWorkers = new Set<string>();
  private readonly activeIngestClients = new Set<string>();
  private latestProgrammeMediaState: MediaStateEvent | null = null;
  private audioModePreferences: AudioMixPreferences = {
    mode: 'interpretation',
    originalVolume: 0.2,
    translatedVolume: 1,
    subtitlesEnabled: true,
  };
  private listenerCount = 0;

  // ---- P6.5 Connect control plane (FE3) --------------------------------
  /** Null when connect-projects.json is absent or Connect is unconfigured: /v1 fails closed. */
  private readonly connectRegistry: ConnectProjectRegistry | null;
  /** Null when CONNECT_AUTH_SECRET is unusable: token mint/verify unavailable, visibly. */
  private readonly connectSecret: Buffer | null;
  /** In-memory on purpose (R13): a restart voids Connect calls and outstanding tokens with it. */
  private readonly connectLiveCalls = new ConnectLiveCallRegistry();
  private readonly connectJti = new ConnectJtiRegistry();
  private connectV1Router: Router | null = null;

  constructor(
    httpServer: HttpServer,
    corsOrigins: string[],
    options: {
      mediaIngestUrl?: string;
      mediaIngestPublicUrl?: string;
      internalWebRtcToken?: string | null;
      webRtcTranscriptionChunkMs?: number;
      webRtcTranscriptionRequestTimeoutMs?: number;
      webRtcTranscriptionStagingDir?: string;
      /**
       * Interim partial-chunk interval for call sessions; 0 turns streaming
       * partial captions off. Omitted here means off, so a Gateway built
       * without config (tests, embedders) keeps today's emission exactly.
       */
      webRtcPartialCaptionIntervalMs?: number;
      callTranscriptLogDir?: string | null;
      vad?: ConstructorParameters<typeof MediaTranscriptionBridge>[0]['vad'];
      /**
       * P6.5 Videofy Connect. Omitted (tests, embedders), Connect is cleanly
       * off: /v1 answers 503 and every connectToken join is refused.
       */
      connect?: {
        authSecret?: string | null;
        projectsPath?: string | null;
      };
    } = {},
  ) {
    // P6.5: Connect state comes FIRST — a malformed registry must fail the
    // gateway at startup (R12), before any socket machinery exists to serve.
    const connectOptions = options.connect;
    if (connectOptions?.projectsPath) {
      const registryState = loadConnectProjectRegistry(connectOptions.projectsPath);
      if (registryState.status === 'active') {
        this.connectRegistry = registryState.registry;
        logger.info('Connect project registry loaded', { path: connectOptions.projectsPath });
      } else {
        this.connectRegistry = null;
        logger.warn(`Videofy Connect /v1 is disabled: ${registryState.reason}`);
      }
    } else {
      this.connectRegistry = null;
      if (connectOptions) {
        logger.warn('Videofy Connect /v1 is disabled: no CONNECT_PROJECTS_PATH configured');
      }
    }
    if (connectOptions?.authSecret) {
      let secret: Buffer | null = null;
      try {
        secret = requireConnectAuthSecret(connectOptions.authSecret, 'CONNECT_AUTH_SECRET');
      } catch (error) {
        // Visible (R12), and never the value itself.
        logger.warn('CONNECT_AUTH_SECRET is unusable; Connect join tokens cannot be issued or verified', {
          message: error instanceof Error ? error.message : 'invalid secret',
        });
      }
      this.connectSecret = secret;
    } else {
      this.connectSecret = null;
      if (connectOptions) {
        logger.warn(
          'CONNECT_AUTH_SECRET is not set; Connect join tokens cannot be issued or verified',
        );
      }
    }
    this.mediaIngestUrl = options.mediaIngestUrl ?? 'http://localhost:3002';
    this.mediaIngestPublicUrl = options.mediaIngestPublicUrl ?? this.mediaIngestUrl;
    this.webRtcTranscriptionBridge = new MediaTranscriptionBridge({
      ...(options.mediaIngestUrl ? { mediaIngestUrl: options.mediaIngestUrl } : {}),
      ...(options.internalWebRtcToken ? { internalAuthToken: options.internalWebRtcToken } : {}),
      ...(options.webRtcTranscriptionRequestTimeoutMs
        ? { requestTimeoutMs: options.webRtcTranscriptionRequestTimeoutMs }
        : {}),
      stagingDir: options.webRtcTranscriptionStagingDir ?? '../../uploads/webrtc-staging',
      ...(options.webRtcTranscriptionChunkMs
        ? { chunkDurationMs: options.webRtcTranscriptionChunkMs }
        : {}),
      ...(options.vad ? { vad: options.vad } : {}),
      // Explicit, not defaulted: the bridge's own default would enable partials
      // for every embedder, and the gateway is where real call traffic opts in.
      partialIntervalMs: options.webRtcPartialCaptionIntervalMs ?? 0,
    });
    this.listenerMediaPeers = new BackendWebRtcListenerPeerRegistry({
      onLocalSignal: (envelope) => this.routeBackendWebRtcSignal(envelope),
    });
    this.backendMediaPeers = new BackendWebRtcMediaPeerRegistry({
      onLocalSignal: (envelope) => this.routeBackendWebRtcSignal(envelope),
      onPeerReady: (envelope) => {
        this.routeBackendWebRtcSignal(backendSignalEnvelope(envelope));
        void this.startListenerDeliveryForSession(envelope.sessionId);
      },
      onTrackReady: (context) => {
        void this.startListenerDeliveryForSession(context.sessionId);
      },
      onAudioFrame: (context, data) => {
        const programmeConfig = this.programmeSessionConfigs.get(context.sessionId);
        if (shouldUseMediaTranscriptionForProgrammeSource(programmeConfig?.programmeSourceType)) {
          try {
            this.webRtcTranscriptionBridge.handleFrame(
              this.applyProgrammeSessionConfig(context),
              data,
            );
          } catch (error) {
            logger.warn('WebRTC transcription bridge frame handling failed', {
              sessionId: context.sessionId,
              broadcastId: context.broadcastId,
              revision: context.revision,
              message: error instanceof Error ? error.message : 'unknown transcription bridge failure',
            });
          }
        }
        try {
          this.listenerMediaPeers.fanOutAudioFrame(context.sessionId, data);
        } catch (error) {
          logger.warn('WebRTC listener programme-audio fanout failed', {
            sessionId: context.sessionId,
            broadcastId: context.broadcastId,
            revision: context.revision,
            message: error instanceof Error ? error.message : 'unknown listener fanout failure',
          });
        }
      },
      onVideoFrame: (context, frame) => {
        try {
          this.listenerMediaPeers.fanOutVideoFrame(context.sessionId, frame);
        } catch (error) {
          logger.warn('WebRTC listener programme-video fanout failed', {
            sessionId: context.sessionId,
            broadcastId: context.broadcastId,
            revision: context.revision,
            message: error instanceof Error ? error.message : 'unknown listener video fanout failure',
          });
        }
      },
      onVideoEnded: (context, reason) => {
        this.listenerMediaPeers.endSessionVideo(context.sessionId, reason);
      },
      onAudioPeerClosed: (context, reason) => {
        const programmeConfig = this.programmeSessionConfigs.get(context.sessionId);
        if (shouldUseMediaTranscriptionForProgrammeSource(programmeConfig?.programmeSourceType)) {
          this.webRtcTranscriptionBridge.endSession(this.applyProgrammeSessionConfig(context), reason);
        }
        this.listenerMediaPeers.closeSession(context.sessionId, reason);
      },
    });
    // P6.1B call runtime: reuses the backend media peer machinery and the
    // transcription bridge with call-scoped contexts; owns its own peer
    // registry so call publish peers never mix with programme callbacks.
    const callVoiceIdentityVerifier = createCallVoiceIdentityVerifier();
    this.callRuntime = new CallRuntime({
      store: new CallSessionStore(),
      emitToRoom: (room, event, payload) => {
        this.io.to(room).emit(event, payload);
      },
      ingestControl: new HttpMediaTranscriptionSubmissionClient({
        baseUrl: this.mediaIngestUrl,
        timeoutMs: options.webRtcTranscriptionRequestTimeoutMs ?? 30_000,
        ...(options.internalWebRtcToken ? { internalAuthToken: options.internalWebRtcToken } : {}),
      }),
      transcriptionBridge: this.webRtcTranscriptionBridge,
      createMediaPeers: (handlers) => new BackendWebRtcMediaPeerRegistry(handlers),
      createReceivePeers: (handlers) => new CallReceivePeerManager(handlers),
      transcriptLog: new CallTranscriptLog(options.callTranscriptLogDir ?? null),
      // WHO is speaking, derived from a signature rather than accepted from the
      // join payload. Absent when no secret is configured, in which case nobody
      // gets a personal voice and every call still works — the correct failure
      // direction for an optional feature.
      ...(callVoiceIdentityVerifier
        ? { verifyVoiceIdentity: callVoiceIdentityVerifier }
        : {}),
      // P6.5: the synchronous connect-join gate (jti claim, verify, project,
      // origin, live-registry). Always constructed — with a missing secret or
      // registry it refuses every connect join, which is the fail-closed
      // default a bare Gateway (tests, embedders) should have.
      connectAuthority: new ConnectJoinGate({
        secret: this.connectSecret,
        registry: this.connectRegistry,
        liveCalls: this.connectLiveCalls,
        jti: this.connectJti,
      }),
    });
    this.io = new SocketServer(httpServer, {
      cors: {
        // P6.5 (R7): dev origins ∪ ACTIVE projects' origins, resolved per
        // handshake. Reaching the transport is necessary but never
        // sufficient — connect joins still authorize Origin per token.
        origin: createSocketOriginPolicy(corsOrigins, () =>
          this.connectRegistry ? this.connectRegistry.activeOrigins() : [],
        ),
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket: Socket) => this.handleConnection(socket));
    logger.info('Gateway socket server initialised');
  }

  /**
   * P6.5 (FE3): the NARROW Connect facade — exactly what connect-control's
   * /v1 router needs, and nothing else (R1). Mode changes and call ends go
   * through the CallRuntime's authority entry points so the STATE broadcast
   * and ingest-plan consequences ride the same path an in-call owner uses;
   * the store is never handed out.
   */
  createConnectFacade(): ConnectCallFacade {
    return {
      preregisterCall: (internalCallId, input) =>
        this.callRuntime.preregisterConnectCall(internalCallId, input),
      snapshot: (internalCallId) => {
        const snapshot = this.callRuntime.getCallSnapshot(internalCallId);
        if (!snapshot) return null;
        return {
          callType: snapshot.callType,
          callMode: snapshot.callMode,
          participants: snapshot.participants.map((participant) => ({
            participantId: participant.participantId,
            displayName: participant.displayName,
            speakLanguage: participant.speakLanguage,
            hearLanguage: participant.hearLanguage,
            connected: participant.connected,
            ...(participant.subject === undefined ? {} : { subject: participant.subject }),
          })),
        };
      },
      applyAuthorityModeChange: async (internalCallId, mode) => {
        const result = await this.callRuntime.applyAuthorityModeChange(internalCallId, mode);
        if (result.ok) return { ok: true, changed: result.changed };
        return {
          ok: false,
          reason: result.reason === 'invalid-mode' ? 'invalid-mode' : 'unknown-call',
        };
      },
      endCallByAuthority: async (internalCallId) => {
        const result = await this.callRuntime.endCallByAuthority(internalCallId);
        return result.ok ? { ok: true } : { ok: false, reason: 'unknown-call' };
      },
    };
  }

  /**
   * The /v1 router, built once on first use. index.ts hands createApp a lazy
   * closure over this method (the diagnostics pattern — the app is built
   * before the Gateway exists), so the router materializes on the first /v1
   * request, after this Gateway is fully constructed.
   */
  getConnectV1Router(): Router {
    if (!this.connectV1Router) {
      this.connectV1Router = createConnectV1Router({
        registry: this.connectRegistry,
        liveCalls: this.connectLiveCalls,
        facade: this.createConnectFacade(),
        tokenSecret: this.connectSecret,
        logger,
      });
    }
    return this.connectV1Router;
  }

  private handleConnection(socket: Socket): void {
    const role = this.resolveRole(socket);
    const state: ClientState = {
      role,
      socketId: socket.id,
      connectedAt: new Date().toISOString(),
      targetLanguage: undefined,
      signallingWindowStartedAt: Date.now(),
      signallingMessageCount: 0,
    };
    this.clients.set(socket.id, state);

    switch (role) {
      case 'listener':
        this.listenerCount++;
        void socket.join('listeners');
        this.handleListenerSocket(socket, state);
        logger.info('Listener connected', {
          socketId: socket.id,
          listenerCount: this.listenerCount,
        });
        break;
      case 'operator':
        void socket.join(OPERATOR_ROOM);
        this.handleOperatorSocket(socket);
        logger.info('Operator connected', { socketId: socket.id });
        break;
      case 'worker':
        void socket.join(WORKER_ROOM);
        this.activeWorkers.add(socket.id);
        this.handleWorkerSocket(socket);
        this.broadcastServiceStatus('speech-worker', 'healthy', socket.id);
        logger.info('Speech worker connected', { socketId: socket.id });
        break;
      case 'ingest':
        void socket.join(INGEST_ROOM);
        this.activeIngestClients.add(socket.id);
        this.handleIngestSocket(socket);
        this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
        logger.info('Media ingest connected', { socketId: socket.id });
        break;
      case 'broadcaster':
        this.handleWebRtcSocket(socket, role);
        logger.info('WebRTC broadcaster signalling socket connected', { socketId: socket.id });
        break;
      case 'server':
        this.handleWebRtcSocket(socket, role);
        logger.info('WebRTC server signalling socket connected', { socketId: socket.id });
        break;
      case 'call':
        this.callRuntime.registerSocket(socket);
        logger.info('Call participant socket connected', { socketId: socket.id });
        break;
    }

    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  private resolveRole(socket: Socket): ClientRole {
    const role = socket.handshake.query['role'];
    if (role === 'operator') return 'operator';
    if (role === 'worker') return 'worker';
    if (role === 'ingest') return 'ingest';
    if (role === 'broadcaster') return 'broadcaster';
    if (role === 'server') return 'server';
    if (role === CALL_PARTICIPANT_ROLE) return 'call';
    return 'listener';
  }

  private handleListenerSocket(socket: Socket, state: ClientState): void {
    this.handleWebRtcSocket(socket, 'listener');
    socket.emit(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, this.audioModePreferences);
    if (
      this.latestProgrammeMediaState &&
      (!isTerminalMediaState(this.latestProgrammeMediaState.streamStatus) ||
        Boolean(this.latestProgrammeMediaState.programmeMediaUrl))
    ) {
      socket.emit(SOCKET_EVENTS.MEDIA_STATE, {
        ...this.latestProgrammeMediaState,
        connectedListeners: this.listenerCount,
      });
    }

    socket.on(SOCKET_EVENTS.JOIN_LANGUAGE, (targetLanguage: unknown) => {
      if (
        targetLanguage !== ORIGINAL_LANGUAGE_CHANNEL &&
        (typeof targetLanguage !== 'string' || targetLanguage.length < 2)
      ) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid targetLanguage' });
        return;
      }
      if (state.targetLanguage) {
        void socket.leave(languageRoom(state.targetLanguage));
      }
      state.targetLanguage = targetLanguage;
      void socket.join(languageRoom(targetLanguage));
      const activeSessionId = this.latestProgrammeMediaState?.processingSessionId;
      if (activeSessionId) {
        for (const event of this.generatedAudioStore.getSnapshot(activeSessionId, targetLanguage)) {
          socket.emit(SOCKET_EVENTS.GENERATED_AUDIO_READY, event);
        }
      }
      logger.debug('Listener joined language room', { socketId: socket.id, targetLanguage });
    });

    socket.on(SOCKET_EVENTS.LEAVE_LANGUAGE, (targetLanguage: unknown) => {
      if (typeof targetLanguage === 'string') {
        void socket.leave(languageRoom(targetLanguage));
        if (state.targetLanguage === targetLanguage) {
          state.targetLanguage = undefined;
        }
      }
    });
  }

  private handleWebRtcSocket(socket: Socket, role: 'broadcaster' | 'listener' | 'server'): void {
    socket.on(SOCKET_EVENTS.WEBRTC_SESSION_CREATE, (raw: unknown) => {
      const parsed = this.parseWebRtcEnvelope(raw, socket);
      if (!parsed) return;
      if (parsed.type !== 'session-create') {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected WebRTC session-create message.',
          false,
        ));
        return;
      }
      if (!this.assertWebRtcSocketRole(socket, role, parsed)) return;
      // `call_` ids are reserved for native call ingest sessions; programme
      // signalling must never be able to squat on (or collide with) them.
      const requestedSessionId = parsed.payload.requestedSessionId;
      if (requestedSessionId !== undefined && /^call_/i.test(requestedSessionId)) {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'WebRTC session ids beginning with "call_" are reserved for native call sessions.',
          false,
        ));
        return;
      }
      const result = this.tryWebRtc(socket, parsed, () =>
        this.webrtcSessions.createSession(socket.id, parsed),
      );
      if (result?.outgoing.sessionId) void socket.join(this.webrtcRoom(result.outgoing.sessionId));
      this.applyWebRtcRoute(socket, result);
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SESSION_JOIN, (raw: unknown) => {
      const parsed = this.parseWebRtcEnvelope(raw, socket);
      if (!parsed) return;
      if (parsed.type !== 'session-join') {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected WebRTC session-join message.',
          false,
        ));
        return;
      }
      if (!this.assertWebRtcSocketRole(socket, role, parsed)) return;
      const result = this.tryWebRtc(socket, parsed, () =>
        this.webrtcSessions.joinSession(socket.id, parsed),
      );
      if (result && parsed.sessionId) void socket.join(this.webrtcRoom(parsed.sessionId));
      this.applyWebRtcRoute(socket, result);
      if (result && parsed.sessionId && role === 'listener') {
        void this.startListenerDeliveryForSession(parsed.sessionId);
      }
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SIGNAL, (raw: unknown) => {
      const parsed = this.parseWebRtcEnvelope(raw, socket);
      if (!parsed) return;
      if (
        parsed.type === 'session-create' ||
        parsed.type === 'session-join' ||
        parsed.type === 'session-close'
      ) {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected WebRTC signal message.',
          false,
        ));
        return;
      }
      if (!this.assertWebRtcSocketRole(socket, role, parsed)) return;
      if (this.isBackendMediaOffer(parsed)) {
        this.handleBackendMediaOffer(socket, parsed);
        return;
      }
      if (this.isBackendMediaIce(parsed)) {
        this.handleBackendMediaIce(socket, parsed);
        return;
      }
      if (this.isBackendListenerAnswer(parsed)) {
        this.handleBackendListenerAnswer(socket, parsed);
        return;
      }
      if (parsed.type === 'peer-disconnect') {
        if (parsed.payload.targetPeerId === WEBRTC_BACKEND_MEDIA_PEER_ID) {
          this.handleBackendMediaDisconnect(socket, parsed);
          return;
        }
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected backend-targeted WebRTC peer-disconnect signal.',
          false,
        ));
        return;
      }
      this.applyWebRtcRoute(socket, this.tryWebRtc(socket, parsed, () =>
        this.webrtcSessions.signal(socket.id, parsed),
      ));
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SESSION_LEAVE, (raw: unknown) => {
      const parsed = this.parseWebRtcEnvelope(raw, socket);
      if (!parsed) return;
      if (parsed.type !== 'peer-disconnect') {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected WebRTC peer-disconnect message.',
          false,
        ));
        return;
      }
      if (!this.assertWebRtcSocketRole(socket, role, parsed)) return;
      const result = this.tryWebRtc(socket, parsed, () =>
        this.webrtcSessions.signal(socket.id, parsed),
      );
      this.applyWebRtcRoute(socket, result);
      if (result && parsed.sessionId && role === 'listener') {
        this.listenerMediaPeers.closeListenerPeer(parsed.sessionId, parsed.peerId, 'listener left signalling session');
      }
      if (result && parsed.sessionId) void socket.leave(this.webrtcRoom(parsed.sessionId));
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SESSION_CLOSE, (raw: unknown) => {
      const parsed = this.parseWebRtcEnvelope(raw, socket);
      if (!parsed) return;
      if (parsed.type !== 'session-close') {
        this.emitWebRtcError(socket, parsed, new WebRtcSignallingError(
          'invalid-payload',
          'Expected WebRTC session-close message.',
          false,
        ));
        return;
      }
      if (!this.assertWebRtcSocketRole(socket, role, parsed)) return;
      const result = this.tryWebRtc(socket, parsed, () =>
        this.webrtcSessions.signal(socket.id, parsed),
      );
      if (result?.outgoing.sessionId) {
        this.teardownProgrammeSession(result.outgoing.sessionId, 'broadcaster closed signalling session');
      }
      this.applyWebRtcRoute(socket, result);
    });
  }

  /**
   * Tear down every programme resource attached to a broadcaster session:
   * media peers, listener delivery, transcription bridging, generated-audio
   * history, operator config and any live media state advertising the session.
   */
  private teardownProgrammeSession(sessionId: string | undefined, reason: string): void {
    if (!sessionId) return;
    this.backendMediaPeers.closeSession(sessionId, reason);
    this.listenerMediaPeers.closeSession(sessionId, reason);
    this.webRtcTranscriptionBridge.endSessionsForSessionId(sessionId, reason);
    this.programmeSessionConfigs.delete(sessionId);
    this.generatedAudioStore.resetSession(sessionId);
    this.invalidateProgrammeMediaState(sessionId);
  }

  /**
   * Stop advertising a torn-down live session to future listeners while keeping
   * uploaded programmes (which retain a playable programmeMediaUrl) replayable.
   */
  private invalidateProgrammeMediaState(sessionId: string): void {
    const state = this.latestProgrammeMediaState;
    if (!state) return;
    const referencesSession =
      state.processingSessionId === sessionId ||
      state.shareableWebRtcSessionId?.endsWith(`/${sessionId}`) === true;
    if (!referencesSession) return;
    if (state.programmeMediaUrl) {
      if (!isTerminalMediaState(state.streamStatus)) {
        this.latestProgrammeMediaState = { ...state, streamStatus: 'completed' };
      }
      return;
    }
    this.latestProgrammeMediaState = null;
  }

  private handleOperatorSocket(socket: Socket): void {
    this.emitServiceSnapshot(socket);

    socket.on(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, (raw: unknown) => {
      const preferences = this.parseAudioModePreferences(raw);
      if (!preferences) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid audio mode preferences' });
        return;
      }

      this.audioModePreferences = preferences;
      this.io.to('listeners').emit(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, preferences);
      logger.info('Operator audio mode preferences updated', {
        originalVolume: preferences.originalVolume,
        translatedVolume: preferences.translatedVolume,
        subtitlesEnabled: preferences.subtitlesEnabled,
      });
    });

    socket.on(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, (raw: unknown) => {
      const config = this.parseProgrammeSessionConfig(raw);
      if (!config) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid programme session configuration' });
        return;
      }
      this.programmeSessionConfigs.set(config.sessionId, config);
      socket.emit(SOCKET_EVENTS.CONTROL_ACK, {
        action: 'programme-session-config',
        accepted: true,
        timestamp: new Date().toISOString(),
      });
      logger.info('Operator programme session configuration accepted', {
        sessionId: config.sessionId,
        broadcastId: config.broadcastId,
        sourceRevision: config.sourceRevision,
        targetLanguage: config.targetLanguage,
        targetLanguageCount: config.targetLanguages.length,
        sourceLanguage: config.sourceLanguage,
        sourceLanguageMode: config.sourceLanguageMode,
      });
      this.broadcastProgrammeSessionConfig(config);
    });

    socket.on(SOCKET_EVENTS.OPERATOR_CONTROL, (raw: unknown) => {
      const control = this.parseOperatorControl(raw);
      if (!control) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid operator control' });
        return;
      }

      switch (control.action) {
        case 'start-mock-stream':
          this.io.to(INGEST_ROOM).emit(SOCKET_EVENTS.INGEST_START_STREAM);
          break;
        case 'stop-mock-stream':
          this.io.to(INGEST_ROOM).emit(SOCKET_EVENTS.INGEST_STOP_STREAM);
          break;
        case 'trigger-mock-phrase':
          this.io.to(WORKER_ROOM).emit(SOCKET_EVENTS.WORKER_TRIGGER_PHRASE);
          break;
        case 'reset-mock-sequence':
          this.store.reset(control.eventId, control.targetLanguage);
          this.io.to(WORKER_ROOM).emit(SOCKET_EVENTS.WORKER_RESET_SEQUENCE, {
            eventId: control.eventId,
            targetLanguage: control.targetLanguage,
          });
          break;
      }

      socket.emit(SOCKET_EVENTS.CONTROL_ACK, {
        action: control.action,
        accepted: true,
        timestamp: new Date().toISOString(),
      });
      logger.info('Operator control accepted', { action: control.action });
    });
  }

  private handleWorkerSocket(socket: Socket): void {
    socket.on(SOCKET_EVENTS.WORKER_HEALTH, () => {
      this.broadcastServiceStatus('speech-worker', 'healthy', socket.id);
    });

    socket.on(SOCKET_EVENTS.WORKER_TRANSLATION, (raw: unknown) => {
      const result = safeParseTranslationEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid translation event',
          issues: result.error.issues,
        });
        logger.warn('Worker sent invalid translation event', { socketId: socket.id });
        return;
      }

      const event = result.data as TranslationEvent;

      const accepted = this.store.offer(event);
      if (!accepted.accepted) {
        return;
      }

      this.broadcastTranslationEvents(accepted.ready);
    });
  }

  private handleIngestSocket(socket: Socket): void {
    socket.on(SOCKET_EVENTS.INGEST_HEALTH, () => {
      this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
    });

    socket.on(SOCKET_EVENTS.INGEST_STATE, (raw: unknown) => {
      const result = safeParseMediaStateEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid media state event',
          issues: result.error.issues,
        });
        logger.warn('Ingest sent invalid media state event', { socketId: socket.id });
        return;
      }

      const stateEvent = result.data as MediaStateEvent;
      // Call sessions never surface on programme media-state broadcasts.
      if (this.callRuntime.interceptMediaStateEvent(stateEvent)) {
        this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
        return;
      }
      const programmeConfig = stateEvent.processingSessionId
        ? this.programmeSessionConfigs.get(stateEvent.processingSessionId)
        : undefined;
      const programmeStreamStatus = resolveProgrammeIngestStreamStatus(
        programmeConfig?.programmeSourceType,
        stateEvent.streamStatus,
      );
      const enriched: MediaStateEvent = {
        ...stateEvent,
        ...(programmeConfig
          ? {
              streamId: programmeConfig.broadcastId,
              streamStatus: programmeStreamStatus,
              videoSource: 'webrtc' as const,
              ...(programmeConfig.programmeSourceType === 'uploaded-video' &&
              canDeliverUploadedStems(stateEvent)
                ? {
                    programmeMediaUrl: this.sourceMediaUrl(programmeConfig.sessionId),
                    programmeMediaMode: 'uploaded-stems' as const,
                  }
                : {}),
              shareableWebRtcSessionId: createShareableWebRtcSessionId(
                programmeConfig.broadcastId,
                programmeConfig.sessionId,
              ),
            }
          : {}),
        connectedListeners: this.listenerCount,
      };
      if (programmeConfig && !isTerminalMediaState(enriched.streamStatus)) {
        this.latestProgrammeMediaState = enriched;
      }
      if (programmeConfig && isTerminalMediaState(enriched.streamStatus)) {
        this.latestProgrammeMediaState = enriched.programmeMediaUrl ? enriched : null;
      }

      this.io.emit(SOCKET_EVENTS.MEDIA_STATE, enriched);
      this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
      logger.debug('Media state broadcast', { streamStatus: enriched.streamStatus });
    });

    socket.on(SOCKET_EVENTS.INGEST_TRANSCRIPTION, (raw: unknown) => {
      const result = safeParseTranscriptionEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid transcription event',
          issues: result.error.issues,
        });
        logger.warn('Ingest sent invalid transcription event', { socketId: socket.id });
        return;
      }

      const event = result.data as TranscriptionEvent;
      // Call transcription events are routed as recipient-scoped `call:caption`
      // deliveries and must never reach programme/operator rooms.
      if (this.callRuntime.interceptTranscriptionEvent(event)) return;
      this.io.to(OPERATOR_ROOM).emit(SOCKET_EVENTS.TRANSCRIPTION_EVENT, event);
      logger.info('Transcription event broadcast', {
        sessionId: event.sessionId,
        chunkId: event.chunkId,
        status: event.status,
      });
    });

    socket.on(SOCKET_EVENTS.INGEST_TRANSLATION, (raw: unknown) => {
      const result = safeParseTimestampedTranslationEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid timestamped translation event',
          issues: result.error.issues,
        });
        logger.warn('Ingest sent invalid timestamped translation event', { socketId: socket.id });
        return;
      }

      const event = result.data as TimestampedTranslationEvent;
      // Call translation events become recipient-scoped `call:caption` deliveries.
      if (this.callRuntime.interceptTimestampedTranslationEvent(event)) return;
      this.emitToLegacyProgrammeAudiences(
        selectLegacyProgrammeAudiences({ kind: 'timestamped-translation', event }),
        SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
        event,
      );
      logger.info('Timestamped translation event broadcast', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        status: event.status,
      });
    });

    socket.on(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, (raw: unknown) => {
      const result = safeParseGeneratedAudioReadyEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid generated-audio ready event',
          issues: result.error.issues,
        });
        logger.warn('Ingest sent invalid generated-audio ready event', { socketId: socket.id });
        return;
      }

      const event = result.data as GeneratedAudioReadyEvent;
      // Call generated audio is recipient-scoped and never enters the
      // programme generated-audio store or language rooms.
      if (this.callRuntime.interceptGeneratedAudioEvent(event)) return;
      const accepted = this.generatedAudioStore.offer(event);
      if (!accepted.accepted) return;
      this.broadcastGeneratedAudioReadyEvents(accepted.ready);
    });
  }

  private handleDisconnect(socket: Socket): void {
    this.callRuntime.handleSocketDisconnect(socket.id);
    this.backendMediaPeers.closeByBroadcasterSocket(socket.id);
    this.listenerMediaPeers.closeByListenerSocket(socket.id);
    for (const result of this.webrtcSessions.cleanupSocket(socket.id)) {
      if (result.outgoing.sessionId) {
        if (result.outgoing.senderRole === 'broadcaster') {
          this.teardownProgrammeSession(result.outgoing.sessionId, 'broadcaster socket disconnected');
        } else if (result.outgoing.senderRole === 'listener') {
          this.listenerMediaPeers.closeListenerPeer(
            result.outgoing.sessionId,
            result.outgoing.peerId,
            'listener socket disconnected',
          );
        }
      }
      this.applyWebRtcRoute(socket, result);
    }
    const state = this.clients.get(socket.id);
    if (state?.role === 'listener') {
      this.listenerCount = Math.max(0, this.listenerCount - 1);
    } else if (state?.role === 'worker') {
      this.activeWorkers.delete(socket.id);
      if (this.activeWorkers.size === 0) {
        this.broadcastServiceStatus('speech-worker', 'unhealthy', socket.id);
      }
    } else if (state?.role === 'ingest') {
      this.activeIngestClients.delete(socket.id);
      if (this.activeIngestClients.size === 0) {
        this.broadcastServiceStatus('media-ingest', 'unhealthy', socket.id);
        // Session state lives in ingest memory; once ingest is gone the retained
        // programme media URL would 404 for every newly joining listener.
        this.latestProgrammeMediaState = null;
      }
    }
    this.clients.delete(socket.id);
    logger.info('Client disconnected', { socketId: socket.id, role: state?.role });
  }

  private parseWebRtcEnvelope(
    raw: unknown,
    socket: Socket,
  ): WebRtcIncomingSignallingEnvelope | null {
    if (!this.consumeWebRtcRateLimit(socket)) {
      this.emitWebRtcError(socket, raw, new WebRtcSignallingError(
        'invalid-state-transition',
        'WebRTC signalling rate limit exceeded. Retry after a short backoff.',
        true,
      ));
      return null;
    }
    if (estimateJsonBytes(raw) > WEBRTC_SIGNALLING_LIMITS.rawPayloadMaxBytes) {
      this.emitWebRtcError(socket, raw, new WebRtcSignallingError(
        'payload-too-large',
        'WebRTC signalling payload is too large.',
        false,
      ));
      logger.warn('Oversized WebRTC signalling payload rejected', { socketId: socket.id });
      return null;
    }
    if (isUnsupportedWebRtcProtocolVersion(raw)) {
      this.emitWebRtcError(socket, raw, new WebRtcSignallingError(
        'unsupported-protocol-version',
        'Unsupported WebRTC signalling protocol version.',
        false,
      ));
      return null;
    }
    const result = safeParseWebRtcSignallingEnvelope(raw);
    if (!result.success) {
      this.emitWebRtcError(socket, raw, new WebRtcSignallingError(
        'invalid-payload',
        'Invalid WebRTC signalling payload.',
        false,
      ));
      logger.warn('Invalid WebRTC signalling payload rejected', { socketId: socket.id });
      return null;
    }
    return result.data as WebRtcIncomingSignallingEnvelope;
  }

  private consumeWebRtcRateLimit(socket: Socket): boolean {
    const state = this.clients.get(socket.id);
    if (!state) return false;
    const now = Date.now();
    if (now - state.signallingWindowStartedAt >= WEBRTC_SIGNALLING_LIMITS.rateLimitWindowMs) {
      state.signallingWindowStartedAt = now;
      state.signallingMessageCount = 0;
    }
    state.signallingMessageCount++;
    return state.signallingMessageCount <= WEBRTC_SIGNALLING_LIMITS.maxMessagesPerSocketWindow;
  }

  private assertWebRtcSocketRole(
    socket: Socket,
    socketRole: 'broadcaster' | 'listener' | 'server',
    envelope: WebRtcIncomingSignallingEnvelope,
  ): boolean {
    if (socketRole !== envelope.senderRole) {
      this.emitWebRtcError(socket, envelope, new WebRtcSignallingError(
        'forbidden-role',
        'Socket role cannot send WebRTC signalling for another role.',
        false,
      ));
      return false;
    }
    return true;
  }

  private tryWebRtc(
    socket: Socket,
    envelope: WebRtcIncomingSignallingEnvelope,
    action: () => WebRtcRouteResult,
  ): WebRtcRouteResult | null {
    try {
      const result = action();
      logger.info('WebRTC signalling accepted', {
        type: envelope.type,
        sessionId: envelope.sessionId,
        peerId: envelope.peerId,
        role: envelope.senderRole,
        revision: envelope.revision,
      });
      return result;
    } catch (error) {
      this.emitWebRtcError(socket, envelope, error);
      return null;
    }
  }

  private isBackendMediaOffer(
    envelope: WebRtcIncomingSignallingEnvelope,
  ): envelope is Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-offer' }> {
    return envelope.type === 'sdp-offer' && envelope.payload.targetPeerId === WEBRTC_BACKEND_MEDIA_PEER_ID;
  }

  private isBackendMediaIce(
    envelope: WebRtcIncomingSignallingEnvelope,
  ): envelope is Extract<WebRtcIncomingSignallingEnvelope, { type: 'ice-candidate' | 'ice-complete' }> {
    return (
      (envelope.type === 'ice-candidate' || envelope.type === 'ice-complete') &&
      envelope.payload.targetPeerId === WEBRTC_BACKEND_MEDIA_PEER_ID
    );
  }

  private isBackendListenerAnswer(
    envelope: WebRtcIncomingSignallingEnvelope,
  ): envelope is Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-answer' }> {
    return (
      envelope.type === 'sdp-answer' &&
      envelope.senderRole === 'listener' &&
      envelope.payload.targetPeerId === WEBRTC_BACKEND_MEDIA_PEER_ID
    );
  }

  private handleBackendMediaOffer(
    socket: Socket,
    parsed: Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-offer' }>,
  ): void {
    void this.completeBackendMediaOffer(socket, parsed).catch((error: unknown) => {
      this.emitWebRtcError(socket, parsed, normalizeBackendGatewayError(error));
    });
  }

  private async completeBackendMediaOffer(
    socket: Socket,
    parsed: Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-offer' }>,
  ): Promise<void> {
    this.webrtcSessions.ensureBackendMediaPeer(
      parsed.sessionId,
      BACKEND_WEBRTC_MEDIA_SOCKET_ID,
      WEBRTC_BACKEND_MEDIA_PEER_ID,
    );
    const offerRoute = this.tryWebRtc(socket, parsed, () =>
      this.webrtcSessions.signal(socket.id, parsed),
    );
    if (!offerRoute) return;
    const sessionId = parsed.sessionId;
    if (!sessionId) {
      throw new BackendMediaPeerError('peer-not-found', 'Backend media signalling session was not found.', false);
    }
    const summary = this.webrtcSessions.getSessionSummary(sessionId);
    if (!summary) {
      throw new BackendMediaPeerError('peer-not-found', 'Backend media signalling session was not found.', false);
    }
    const answer = await this.backendMediaPeers.acceptOffer(socket.id, parsed, summary);
    this.routeBackendWebRtcSignal(backendSignalEnvelope(answer));
  }

  private handleBackendMediaIce(
    socket: Socket,
    parsed: Extract<WebRtcIncomingSignallingEnvelope, { type: 'ice-candidate' | 'ice-complete' }>,
  ): void {
    let route: WebRtcRouteResult;
    try {
      route = this.webrtcSessions.signal(socket.id, parsed);
      logger.info('WebRTC signalling accepted', {
        type: parsed.type,
        sessionId: parsed.sessionId,
        peerId: parsed.peerId,
        role: parsed.senderRole,
        revision: parsed.revision,
      });
    } catch (error) {
      if (isIgnorableLateIce(error)) {
        logger.info('Late WebRTC ICE ignored', {
          type: parsed.type,
          sessionId: parsed.sessionId,
          peerId: parsed.peerId,
          role: parsed.senderRole,
          revision: parsed.revision,
        });
        return;
      }
      this.emitWebRtcError(socket, parsed, error);
      return;
    }
    if (!route) return;
    if (parsed.type === 'ice-candidate') {
      const registry =
        parsed.senderRole === 'listener' ? this.listenerMediaPeers : this.backendMediaPeers;
      void registry.addRemoteCandidate(parsed).catch((error: unknown) => {
        this.emitWebRtcError(socket, parsed, normalizeBackendGatewayError(error));
      });
    }
  }

  private handleBackendListenerAnswer(
    socket: Socket,
    parsed: Extract<WebRtcIncomingSignallingEnvelope, { type: 'sdp-answer' }>,
  ): void {
    const route = this.tryWebRtc(socket, parsed, () => this.webrtcSessions.signal(socket.id, parsed));
    if (!route) return;
    void this.listenerMediaPeers.acceptAnswer(parsed).catch((error: unknown) => {
      this.emitWebRtcError(socket, parsed, normalizeBackendGatewayError(error));
    });
  }

  private handleBackendMediaDisconnect(
    socket: Socket,
    parsed: Extract<WebRtcIncomingSignallingEnvelope, { type: 'peer-disconnect' }>,
  ): void {
    const result = this.tryWebRtc(socket, parsed, () => {
      this.webrtcSessions.disconnectBackendMediaPeer(socket.id, parsed);
      this.teardownProgrammeSession(parsed.sessionId, parsed.payload.reason ?? 'backend media peer disconnected');
      return {
        outgoing: {
          ...parsed,
          peerId: WEBRTC_BACKEND_MEDIA_PEER_ID,
          senderRole: 'server',
        },
      };
    });
    this.applyWebRtcRoute(socket, result);
  }

  private routeBackendWebRtcSignal(
    envelope: Exclude<
      WebRtcIncomingSignallingEnvelope,
      Extract<WebRtcIncomingSignallingEnvelope, { type: 'session-create' | 'session-join' }>
    >,
  ): void {
    try {
      const route = this.webrtcSessions.signal(BACKEND_WEBRTC_MEDIA_SOCKET_ID, envelope);
      this.applyBackendWebRtcRoute(route);
    } catch (error) {
      logger.warn('Backend WebRTC signalling rejected', {
        code: error instanceof WebRtcSignallingError ? error.code : 'internal-signalling-error',
        sessionId: envelope.sessionId,
        peerId: envelope.peerId,
      });
    }
  }

  private async startListenerDeliveryForSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const broadcaster = this.backendMediaPeers.getSnapshot(sessionId);
    if (
      !broadcaster ||
      (broadcaster.audioTrackState !== 'received' && broadcaster.audioTrackState !== 'active')
    ) {
      return;
    }
    const includeVideo =
      broadcaster.videoExpected ||
      broadcaster.videoTrackState === 'received' ||
      broadcaster.videoTrackState === 'active';
    const summary = this.webrtcSessions.getSessionSummary(sessionId);
    if (!summary) return;
    const listeners = this.webrtcSessions.getListenerPeers(sessionId);
    for (const listener of listeners) {
      if (this.listenerMediaPeers.hasActivePeer(sessionId, listener.peerId)) continue;
      try {
        this.webrtcSessions.ensureBackendMediaPeer(
          sessionId,
          BACKEND_WEBRTC_MEDIA_SOCKET_ID,
          WEBRTC_BACKEND_MEDIA_PEER_ID,
        );
        const current = this.webrtcSessions.getSessionSummary(sessionId);
        if (!current) return;
        const offer = await this.listenerMediaPeers.createOffer(listener, current, current.revision + 1, {
          includeVideo,
        });
        if (offer) this.routeBackendWebRtcSignal(offer);
      } catch (error) {
        logger.warn('Backend listener WebRTC offer failed', {
          code: error instanceof BackendMediaPeerError ? error.code : 'internal-signalling-error',
          sessionId,
          listenerPeerId: listener.peerId,
        });
      }
    }
  }

  private applyBackendWebRtcRoute(result: WebRtcRouteResult | null): void {
    if (!result) return;
    if (result.targetSocketId) {
      this.io.to(result.targetSocketId).emit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, result.outgoing);
      return;
    }
    if (result.broadcastSessionId) {
      this.io
        .to(this.webrtcRoom(result.broadcastSessionId))
        .emit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, result.outgoing);
    }
  }

  private applyWebRtcRoute(sourceSocket: Socket, result: WebRtcRouteResult | null): void {
    if (!result) return;
    if (result.targetSocketId) {
      this.io.to(result.targetSocketId).emit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, result.outgoing);
      return;
    }
    if (result.broadcastSessionId) {
      this.io
        .to(this.webrtcRoom(result.broadcastSessionId))
        .emit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, result.outgoing);
      return;
    }
    sourceSocket.emit(SOCKET_EVENTS.WEBRTC_SESSION_EVENT, result.outgoing);
  }

  private emitWebRtcError(socket: Socket, raw: unknown, error: unknown): void {
    const envelope = raw && typeof raw === 'object'
      ? signallingErrorEnvelope(raw as Partial<WebRtcIncomingSignallingEnvelope>, error)
      : signallingErrorEnvelope({}, error);
    socket.emit(SOCKET_EVENTS.WEBRTC_ERROR, envelope);
    logger.warn('WebRTC signalling rejected', {
      code: envelope.payload.code,
      correlationId: envelope.correlationId,
      sessionId: envelope.sessionId,
      peerId: envelope.peerId,
      retryable: envelope.payload.retryable,
    });
  }

  private webrtcRoom(sessionId: string): string {
    return `webrtc:${sessionId}`;
  }

  /** Broadcast a stream-status change to all connected clients. */
  broadcastStreamStatus(status: string): void {
    this.io.emit(SOCKET_EVENTS.STREAM_STATUS, { status, timestamp: new Date().toISOString() });
  }

  getListenerCount(): number {
    return this.listenerCount;
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  getWebRtcDiagnostics(): {
    clientCount: number;
    listenerCount: number;
    activeSignallingSessions: number;
    broadcasterPeerCount: number;
    listenerPeerCount: number;
    transcriptionBridgeSessionCount: number;
    callRuntime: ReturnType<CallRuntime['getDiagnostics']>;
    transcriptionBridgeSessions: unknown[];
  } {
    const signalling = this.webrtcSessions.getDiagnostics();
    const transcriptionBridge = this.webRtcTranscriptionBridge.getDiagnostics();
    return {
      clientCount: this.clients.size,
      listenerCount: this.listenerCount,
      activeSignallingSessions: signalling.activeSessionCount,
      broadcasterPeerCount: this.backendMediaPeers.getSnapshots().length,
      listenerPeerCount: this.listenerMediaPeers.getSnapshots().length,
      transcriptionBridgeSessionCount: transcriptionBridge.sessionCount,
      callRuntime: this.callRuntime.getDiagnostics(),
      transcriptionBridgeSessions: this.webRtcTranscriptionBridge.getSessionDiagnostics(),
    };
  }

  private broadcastServiceStatus(
    service: ServiceName,
    status: HealthStatus,
    socketId?: string,
  ): void {
    this.io.to(OPERATOR_ROOM).emit(SOCKET_EVENTS.SERVICE_STATUS, {
      ...this.serviceStatus(service, status),
      socketId,
    });
  }

  private emitServiceSnapshot(socket: Socket): void {
    const snapshot: ServiceStatusEvent[] = [
      this.serviceStatus('gateway', 'healthy'),
      this.serviceStatus(
        'media-ingest',
        this.activeIngestClients.size > 0 ? 'healthy' : 'unhealthy',
      ),
      this.serviceStatus('speech-worker', this.activeWorkers.size > 0 ? 'healthy' : 'unhealthy'),
    ];

    for (const status of snapshot) {
      socket.emit(SOCKET_EVENTS.SERVICE_STATUS, status);
    }
  }

  private serviceStatus(service: ServiceName, status: HealthStatus): ServiceStatusEvent {
    return {
      service,
      status,
      timestamp: new Date().toISOString(),
    };
  }

  private broadcastTranslationEvents(events: TranslationEvent[]): void {
    for (const readyEvent of events) {
      this.emitToLegacyProgrammeAudiences(
        selectLegacyProgrammeAudiences({ kind: 'translation', event: readyEvent }),
        SOCKET_EVENTS.TRANSLATION_EVENT,
        readyEvent,
      );

      logger.info('Translation event broadcast', {
        eventId: readyEvent.eventId,
        sequence: readyEvent.sequence,
        targetLanguage: readyEvent.targetLanguage,
        final: readyEvent.final,
      });
    }
  }

  private broadcastGeneratedAudioReadyEvents(events: GeneratedAudioReadyEvent[]): void {
    for (const event of events) {
      this.emitToLegacyProgrammeAudiences(
        selectLegacyProgrammeAudiences({ kind: 'generated-audio-ready', event }),
        SOCKET_EVENTS.GENERATED_AUDIO_READY,
        event,
      );
      logger.info('Generated audio ready event broadcast', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        sequence: event.sequence,
        targetLanguage: event.targetLanguage,
      });
    }
  }

  private emitToLegacyProgrammeAudiences(
    audiences: readonly LegacyProgrammeAudience[],
    eventName: string,
    payload: unknown,
  ): void {
    for (const audience of audiences) {
      const room = audience.kind === 'operator' ? OPERATOR_ROOM : languageRoom(audience.language);
      this.io.to(room).emit(eventName, payload);
    }
  }

  private applyProgrammeSessionConfig(
    context: BackendMediaPeerAudioContext,
  ): MediaTranscriptionBridgeContext {
    // A programme timeline must stay COMPLETE: when the pipeline falls behind,
    // the new chunk is refused rather than the recorded backlog being dropped.
    // Stated here because this is the programme path, rather than left to be
    // deduced from what the session happens to be called.
    const programmeMode = { mediaSessionMode: 'programme' as const };
    const config = this.programmeSessionConfigs.get(context.sessionId);
    if (!config) return { ...context, ...programmeMode };
    return {
      ...context,
      ...programmeMode,
      ...(config.programmeSourceType === 'rtmp' && config.rtmpPlaybackUrl
        ? { externalAudioSource: 'rtmp-hls' as const, externalAudioUrl: config.rtmpPlaybackUrl }
        : {}),
      targetLanguage: config.targetLanguage,
      targetLanguages: config.targetLanguages,
      sourceLanguage: config.sourceLanguage,
      sourceLanguageMode: config.sourceLanguageMode,
    };
  }

  private broadcastProgrammeSessionConfig(config: OperatorProgrammeSessionConfig): void {
    const shareableWebRtcSessionId = createShareableWebRtcSessionId(
      config.broadcastId,
      config.sessionId,
    );
    const retained = this.latestProgrammeMediaState;
    const videoTimestampMs =
      retained && retained.processingSessionId === config.sessionId
        ? retained.videoTimestampMs
        : 0;
    const state: MediaStateEvent = {
      eventId: 'Videofy Live Demo Event',
      streamId: config.broadcastId,
      processingSessionId: config.sessionId,
      shareableWebRtcSessionId,
      streamStatus: 'processing',
      videoSource: 'webrtc',
      videoTimestampMs,
      sourceAudioActive: false,
      translatedLanguages: config.targetLanguages,
      connectedListeners: this.listenerCount,
      createdAt: new Date().toISOString(),
    };
    this.latestProgrammeMediaState = state;
    this.io.emit(SOCKET_EVENTS.MEDIA_STATE, state);
  }

  private sourceMediaUrl(sessionId: string): string {
    return `${this.mediaIngestPublicUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/source-media`;
  }

  private parseProgrammeSessionConfig(raw: unknown): OperatorProgrammeSessionConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<OperatorProgrammeSessionConfig>;
    if (!isSafeIdentifier(candidate.sessionId)) return null;
    if (!isSafeIdentifier(candidate.broadcastId)) return null;
    const sourceRevision = candidate.sourceRevision;
    if (
      typeof sourceRevision !== 'number' ||
      !Number.isInteger(sourceRevision) ||
      sourceRevision < 0
    ) {
      return null;
    }
    if (!isLanguageTag(candidate.targetLanguage)) return null;
    if (!Array.isArray(candidate.targetLanguages)) return null;
    const targetLanguages = [...new Set(candidate.targetLanguages.filter(isLanguageTag))];
    if (targetLanguages.length === 0 || !targetLanguages.includes(candidate.targetLanguage)) return null;
    if (!isLanguageTag(candidate.sourceLanguage)) return null;
    if (
      candidate.sourceLanguageMode !== 'manual' &&
      candidate.sourceLanguageMode !== 'auto-detect'
    ) {
      return null;
    }
    const programmeSourceType =
      typeof candidate.programmeSourceType === 'string'
        ? candidate.programmeSourceType
        : undefined;
    const rtmpPlaybackUrl =
      programmeSourceType === 'rtmp' && isSafeLocalHttpUrl(candidate.rtmpPlaybackUrl)
        ? candidate.rtmpPlaybackUrl
        : undefined;
    if (programmeSourceType === 'rtmp' && !rtmpPlaybackUrl) return null;
    return {
      sessionId: candidate.sessionId,
      broadcastId: candidate.broadcastId,
      sourceRevision,
      ...(programmeSourceType ? { programmeSourceType } : {}),
      ...(rtmpPlaybackUrl ? { rtmpPlaybackUrl } : {}),
      targetLanguage: candidate.targetLanguage,
      targetLanguages,
      sourceLanguage: candidate.sourceLanguage,
      sourceLanguageMode: candidate.sourceLanguageMode,
    };
  }

  private parseOperatorControl(raw: unknown): OperatorControlEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const action = (raw as { action?: unknown }).action;
    if (
      action !== 'start-mock-stream' &&
      action !== 'stop-mock-stream' &&
      action !== 'trigger-mock-phrase' &&
      action !== 'reset-mock-sequence'
    ) {
      return null;
    }

    const eventId = (raw as { eventId?: unknown }).eventId;
    const targetLanguage = (raw as { targetLanguage?: unknown }).targetLanguage;

    if (eventId !== undefined && typeof eventId !== 'string') return null;
    if (targetLanguage !== undefined && typeof targetLanguage !== 'string') return null;

    const control: OperatorControlEvent = { action };
    if (eventId !== undefined) control.eventId = eventId;
    if (targetLanguage !== undefined) control.targetLanguage = targetLanguage;
    return control;
  }

  private parseAudioModePreferences(raw: unknown): AudioMixPreferences | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<AudioMixPreferences>;
    if (candidate.mode !== 'interpretation' && candidate.mode !== 'replacement') return null;
    if (!isAudioLevel(candidate.originalVolume) || !isAudioLevel(candidate.translatedVolume)) {
      return null;
    }
    if (typeof candidate.subtitlesEnabled !== 'boolean') return null;
    return {
      mode: candidate.mode,
      originalVolume: candidate.originalVolume,
      translatedVolume: candidate.translatedVolume,
      subtitlesEnabled: candidate.subtitlesEnabled,
    };
  }
}

/**
 * P6.5 (R7): the Socket.IO CORS origin callback — dev origins ∪ whatever the
 * project-origin provider answers at handshake time (so registry changes need
 * no socket-server rebuild). A missing Origin passes the TRANSPORT layer —
 * non-browser clients and native tests have none, and CORS cannot authenticate
 * anybody — because reaching the handshake is never sufficient: connect joins
 * authorize the Origin against the token's own project afterwards.
 */
export function createSocketOriginPolicy(
  devOrigins: readonly string[],
  projectOrigins: () => readonly string[],
): (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    if (origin === undefined) {
      callback(null, true);
      return;
    }
    if (devOrigins.includes(origin) || projectOrigins().includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}

function normalizeBackendGatewayError(error: unknown): WebRtcSignallingError {
  if (error instanceof WebRtcSignallingError) return error;
  if (error instanceof BackendMediaPeerError) {
    return new WebRtcSignallingError(error.code, error.message, error.retryable);
  }
  return new WebRtcSignallingError(
    'internal-signalling-error',
    'Backend WebRTC media transport failed.',
    true,
  );
}

function isIgnorableLateIce(error: unknown): boolean {
  return (
    error instanceof WebRtcSignallingError &&
    (error.code === 'stale-negotiation' || error.code === 'offer-required')
  );
}

function estimateJsonBytes(raw: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return WEBRTC_SIGNALLING_LIMITS.rawPayloadMaxBytes + 1;
  }
}

function isAudioLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTerminalMediaState(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export function shouldUseMediaTranscriptionForProgrammeSource(
  programmeSourceType: string | undefined,
): boolean {
  return programmeSourceType !== 'uploaded-video';
}

export function resolveProgrammeIngestStreamStatus(
  programmeSourceType: string | undefined,
  streamStatus: StreamStatus,
): StreamStatus {
  return programmeSourceType === 'uploaded-video' && streamStatus === 'completed'
    ? 'processing'
    : streamStatus;
}

function canDeliverUploadedStems(state: MediaStateEvent): boolean {
  if (state.streamStatus === 'completed') return true;
  return (
    state.streamStatus === 'failed' &&
    (state.targetLanguageOutputs?.some(
      (output) => output.captionsAvailable || output.audioAvailable,
    ) ?? false)
  );
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_/-]{1,128}$/.test(value);
}

function isSafeLocalHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
    if (!url.pathname.endsWith('/index.m3u8')) return false;
    return true;
  } catch {
    return false;
  }
}

function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value);
}
