/** @owner masterzee001 */
import { randomUUID } from 'node:crypto';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
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
  ProgrammeMediaDelivery,
} from '@videofy-live/shared-types';
import {
  DEFAULT_CHANNEL_ID,
  ProgrammeChannels,
  channelIdForAccount,
  channelListenerRoom,
  channelOperatorRoom,
  channelRoom,
  type ChannelVisibility,
} from './programme-channels.js';
import { diffLiveTransitions } from './channel-live-transitions.js';
import {
  NULL_CHANNEL_IDENTITY,
  type ChannelIdentityPort,
  type ChannelProfile,
} from './channel-identity.js';
import {
  INGEST_ROOM,
  createShareableWebRtcSessionId,
  isChannelCategory,
  languageRoom,
  OPERATOR_ROOM,
  type ChannelAssignedPayload,
  type OperatorChannelSettingsPayload,
  SOCKET_EVENTS,
  type TranslatedAudioFramePayload,
  WEBRTC_BACKEND_MEDIA_PEER_ID,
  WEBRTC_SIGNALLING_LIMITS,
  WORKER_ROOM,
  realtimeRelayPermitted,
} from '@videofy-live/shared-types';
import {
  safeParseMediaStateEvent,
  safeParseProgrammeMediaDelivery,
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
import type { IngressTranslatedAudio } from '@videofy-live/media-ingress-wire';
import type { LivePathProfile } from './live-path-policy.js';
import {
  LiveTranscriptAdapter,
  isLiveTranscriptEvent,
} from './live-transcript-adapter.js';
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
import { ProgrammeContributionHost } from '@videofy-live/programme-contribution';
import {
  HttpMediaTranscriptionSubmissionClient,
  MediaTranscriptionBridge,
  type MediaTranscriptionBridgeContext,
} from './media-transcription-bridge.js';
import { CallSessionStore, type CallStatus } from '@videofy-live/call-session';
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
import {
  createOperatorAuthority,
  operatorRefusalNotice,
  type OperatorAuthority,
} from './operator-authority.js';
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
  /** The channel this client is listening to. Defaults for clients that predate channels. */
  channelId: string;
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
  private readonly translatedAudioListeners = new Set<
    (payload: TranslatedAudioFramePayload) => void
  >();
  /**
   * The current source revision per programme processing session.
   *
   * Recorded as audio flows so the media state and the translated frames name
   * the same number. Two sources for one fact would drift, and the one that
   * drifted would be the one the viewer compares against.
   */
  private readonly programmeSourceRevisions = new Map<string, number>();
  private readonly callRuntime: CallRuntime;
  /**
   * The one call store, kept in hand for GET /calls/:callId/status. The
   * runtime owns every mutation; this reference only answers whether a call
   * id is live, ended or never seen.
   */
  private readonly callSessionStore: CallSessionStore;

  /** The direct-call telephone, for the HTTP pre-join / ringing / decline routes. */
  get directCalls(): CallRuntime['directCalls'] {
    return this.callRuntime.directCalls;
  }

  /** The public conference listing, for GET /calls/public. */
  listPublicCalls(): ReturnType<CallRuntime['listPublicCalls']> {
    return this.callRuntime.listPublicCalls();
  }

  /**
   * Conference status, for GET /calls/:callId/status. Founder ruling (29 Aug
   * 2026): "An ended conference is terminal. The Recent row should show Ended
   * and must not silently recreate a room under that old code."
   */
  callStatus(callId: string): CallStatus {
    return this.callSessionStore.callStatus(callId);
  }
  private readonly mediaIngestUrl: string;
  /**
   * Whether media-ingest can genuinely translate speech.
   *
   * Starts TRUE so a probe that has not finished, or that fails, never tells
   * anybody their engine is missing when it may be fine. Claiming a fault that
   * does not exist is its own defect; the honest default is silence until the
   * answer is known.
   */
  private translationEngineReal = true;
  /** Gives every revision of one spoken utterance a single caption identity. */
  private readonly liveTranscripts = new LiveTranscriptAdapter();
  private readonly mediaIngestPublicUrl: string;
  private readonly clients = new Map<string, ClientState>();
  private readonly programmeSessionConfigs = new Map<string, OperatorProgrammeSessionConfig>();
  /**
   * Which account each operator socket belongs to.
   *
   * Not used to scope anything yet -- the gateway holds ONE programme state, so
   * two operators would overwrite each other rather than run two programmes.
   * It is recorded because it is exactly what per-operator channels will key
   * on, and because an audit of who changed a live programme is worth having
   * before there is an incident rather than after.
   */
  private readonly operatorAuthority: OperatorAuthority;
  private readonly operatorAccounts = new Map<string, string>();
  private readonly activeWorkers = new Set<string>();
  private readonly activeIngestClients = new Set<string>();
  /**
   * One programme per channel.
   *
   * The gateway used to hold a single programme state, so a second operator
   * overwrote the first mid-broadcast. State now lives here, keyed by channel.
   */
  private readonly channels = new ProgrammeChannels();
  /** Which channel each operator socket is running, for routing and teardown. */
  private readonly operatorChannels = new Map<string, string>();
  /** The channel each operator MAY move to: derived from their account, theirs alone. */
  private readonly operatorOwnChannels = new Map<string, string>();
  private readonly channelSalt: string;
  /**
   * Where channel identity persists (founder directive A, 30 Aug 2026).
   * Injected so tests run without HTTP; absent means in-memory values only,
   * which is also what an unreachable account service degrades to.
   */
  private readonly channelIdentity: ChannelIdentityPort;
  /**
   * sessionId -> which broadcast this is.
   *
   * Minted when an operator's session binds to their channel and kept for the
   * life of that session, so a source switch or a reconnect stays the SAME
   * run. A new run means a new timeline and a new set of adverts; the network
   * hiccupping is not a new programme.
   */
  private readonly programmeRuns = new Map<string, ProgrammeRunIdentity>();

  /**
   * How each run's original media reaches its audience, as the run itself says.
   *
   * Not inferred here, and not read off a delay figure. media-ingest owns the
   * delivery chain and announces the answer; this is the cache that answer
   * lives in between announcements.
   */
  private readonly programmeDelivery = new Map<string, ProgrammeMediaDelivery>();

  /**
   * Sessions whose original media must NOT be relayed in realtime.
   *
   * Derived from the announcements above and kept as a flat set because it is
   * consulted on every audio and video frame, and a per-frame map walk on the
   * media path is a cost that shows up as jitter.
   */
  private readonly realtimeRelayForbidden = new Set<string>();

  /**
   * Whether this deployment has ever announced a delayed run.
   *
   * THE FAIL-CLOSED SWITCH, and the reason it is conditional. Refusing every
   * run this gateway has not yet heard about would break every existing live
   * programme, including those media-ingest is not involved in. But once a
   * deployment has shown that it does protected broadcasts, an unknown run is
   * no longer safely assumed to be live -- an announcement can be lost, and
   * the cost of guessing wrong is the audience hearing the studio.
   */
  private sawDelayedDelivery = false;

  /**
   * Where a protected run's contribution is encoded, when this deployment does
   * protected broadcasts at all.
   *
   * Null when no spool is configured, which is the ordinary state of a
   * deployment that only does TRUE LIVE. Absent rather than inert, so nothing
   * allocates an encoder path that will never be used.
   */
  private readonly contributionHost: ProgrammeContributionHost | null;

  /*
   * THE DEFAULT CHANNEL, UNDER THE OLD NAME.
   *
   * Every call site that predates channels reads and writes the default channel
   * through this accessor, which is what lets channels land without rewriting
   * them all in one change. Channel-aware paths address this.channels directly.
   */
  private get latestProgrammeMediaState(): MediaStateEvent | null {
    return this.channels.mediaState(DEFAULT_CHANNEL_ID);
  }

  private set latestProgrammeMediaState(state: MediaStateEvent | null) {
    this.channels.setMediaState(DEFAULT_CHANNEL_ID, state);
  }
  /** The default channel's audio preferences, under the old name. See latestProgrammeMediaState. */
  private get audioModePreferences(): AudioMixPreferences {
    return this.channels.audio(DEFAULT_CHANNEL_ID);
  }

  private set audioModePreferences(preferences: AudioMixPreferences) {
    this.channels.setAudio(DEFAULT_CHANNEL_ID, preferences);
  }
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
      /** Set to cut the live path over to the realtime ingress; null keeps the chunker. */
      realtimeIngressUrl?: string | null;
      livePathProfile?: LivePathProfile;
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
      /**
       * Who may operate a programme.
       *
       * Omitted -- tests, embedders -- means the operator role is refused
       * outright rather than admitted, because the fallback for an
       * unconfigured privileged surface has to be CLOSED. A test that wants an
       * operator supplies a secret and a token, which is the same thing a real
       * client does.
       */
      /**
       * A channel went live, or stopped. Called on every transition the
       * public directory shows; the account service fans the live one out
       * to followers who asked to be told. Omitted means nobody is told.
       */
      onChannelLive?: (channelId: string, live: boolean, displayName: string) => Promise<void>;
      /**
       * The persistent channel identity source. Omitted -- tests, embedders
       * -- means channels keep in-memory names and nothing is persisted.
       */
      channelIdentity?: ChannelIdentityPort | undefined;
      /** Call-level authority. Omitted means no account may start a call. */
      call?: {
        authorizeHost?: (sessionToken: string | null) => Promise<boolean>;
        resolveDirectMode?: (
          sessionToken: string | null,
          peerAccountId: string,
        ) => Promise<'normal' | 'translated' | null>;
        recordDirectCall?: (
          record: import('./direct-call-lifecycle.js').DirectCallOutcomeRecord,
        ) => Promise<void>;
        /** Approved to translate this direction on a live call. Absent refuses. */
        callLiveRouteApproved?: (sourceLanguage: string, targetLanguage: string) => boolean;
      };
      operator?: {
        authSecret?: string | undefined;
        requireEntitlement?: boolean;
        hasEntitlement?: (accountId: string) => boolean;
        /**
         * Per-deployment salt for deriving channel ids from account ids.
         *
         * Stable across restarts, or listener links to a channel stop
         * resolving. Not a secret -- it stops an account id being recoverable
         * from a channel id that appears in URLs, which is what DP-171 asks
         * for -- so a fixed default is honest rather than a false assurance.
         */
        channelSalt?: string | undefined;
      };
    } = {},
  ) {
    this.channelLiveHook = options.onChannelLive ?? null;
    this.channelSalt = options.operator?.channelSalt ?? 'videofy-live-channel';
    this.channelIdentity = options.channelIdentity ?? NULL_CHANNEL_IDENTITY;
    this.operatorAuthority = createOperatorAuthority({
      secret: options.operator?.authSecret,
      ...(options.operator?.requireEntitlement === undefined
        ? {}
        : { requireEntitlement: options.operator.requireEntitlement }),
      ...(options.operator?.hasEntitlement
        ? { hasEntitlement: options.operator.hasEntitlement }
        : {}),
    });
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
      ...(options.livePathProfile ? { livePathProfile: options.livePathProfile } : {}),
      // THE CUTOVER SWITCH. With a destination, live audio streams as frames
      // and never becomes a WAV file on a disk both services must share.
      ...(options.realtimeIngressUrl
        ? {
            realtimeIngress: {
              url: options.realtimeIngressUrl,
              ...(options.internalWebRtcToken ? { token: options.internalWebRtcToken } : {}),
              onTranslatedAudio: (context, frame) =>
                this.deliverTranslatedAudioFrame(context, frame),
            },
          }
        : {}),
    });
    /*
     * PROTECTED CONTRIBUTION, encoded where the frames already are.
     *
     * The spool is the media service's, on the same host. Raw broadcast video
     * must not travel between two of our own services to satisfy a module
     * layout, so the encoder runs here and the segments land where the cursor,
     * the store and the egress already look for them.
     */
    const spoolRoot = process.env['PROGRAMME_MEDIA_SPOOL']?.trim();
    this.contributionHost =
      spoolRoot === undefined || spoolRoot === ''
        ? null
        : new ProgrammeContributionHost({
            spoolRoot,
            onFailed: (runId, reason) => {
              /*
               * A contribution that cannot be encoded stops the protected
               * output. It does NOT quietly become live: the delay exists for
               * the moments when something has gone wrong, which is exactly
               * when a fallback would fire.
               */
              logger.error('Protected contribution failed', { runId, reason });
            },
            onProblem: (message, detail) => logger.warn(message, detail),
            log: {
              info: (message, detail) => logger.info(message, detail),
              warn: (message, detail) => logger.warn(message, detail),
              error: (message, detail) => logger.error(message, detail),
            },
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
        /*
         * THE SAME RECEIVED MEDIA, ON ITS WAY TO THE PROTECTED ENCODER.
         *
         * One broadcaster publish serves both modes: the frames below go to
         * the realtime audience, and these same frames go to the encoder that
         * produces protected segments. Nothing is published twice and nothing
         * is encoded twice, so there is one answer to which feed is the
         * actual programme.
         */
        this.contributeToProtectedRun(context.sessionId, 'audio', data);
        try {
          // Checked per frame as well as at peer creation. A peer built
          // before the answer arrived is exactly the leak window, and this
          // is a set lookup on a path that cannot afford a map walk.
          if (this.realtimeRelayForbidden.has(context.sessionId)) return;
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
        this.contributeToProtectedRun(context.sessionId, 'video', frame);
        try {
          if (this.realtimeRelayForbidden.has(context.sessionId)) return;
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
    this.callSessionStore = new CallSessionStore();
    this.callRuntime = new CallRuntime({
      store: this.callSessionStore,
      emitToRoom: (room, event, payload) => {
        this.io.to(room).emit(event, payload);
      },
      ingestControl: new HttpMediaTranscriptionSubmissionClient({
        baseUrl: this.mediaIngestUrl,
        timeoutMs: options.webRtcTranscriptionRequestTimeoutMs ?? 30_000,
        ...(options.internalWebRtcToken ? { internalAuthToken: options.internalWebRtcToken } : {}),
      }),
      transcriptionBridge: this.webRtcTranscriptionBridge,
      // media-ingest owns the providers, so it owns this answer. Cached from
      // its /health rather than re-asked per join: providers are chosen at ITS
      // startup and cannot change while it runs, and a call must not wait on
      // an HTTP round trip to learn what the deployment already knows.
      translationEngineReal: () => this.translationEngineReal,
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
      /*
       * Who may START a call. Passed through when the composition root supplies
       * one; absent, CallRuntime refuses every host, which is the fail-closed
       * default a bare Gateway (tests, embedders) should have -- the same shape
       * as connectAuthority directly below.
       */
      ...(options.call?.authorizeHost ? { authorizeCallHost: options.call.authorizeHost } : {}),
      ...(options.call?.resolveDirectMode
        ? { resolveDirectCallMode: options.call.resolveDirectMode }
        : {}),
      /*
       * Whether a language pair may carry a live TRANSLATED call. Absent,
       * CallRuntime refuses every translated direct call -- the same
       * fail-closed default as the host gate above. A normal call is
       * unaffected: it translates nothing, so there is nothing to approve.
       */
      ...(options.call?.callLiveRouteApproved
        ? { callLiveRouteApproved: options.call.callLiveRouteApproved }
        : {}),
      ...(options.call?.recordDirectCall ? { recordDirectCall: options.call.recordDirectCall } : {}),
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
    void this.probeTranslationEngine();
  }

  /**
   * Ask media-ingest whether it can actually translate speech.
   *
   * Fire-and-forget at startup: nothing waits on it, and a failure leaves the
   * optimistic default in place. The point is not to gate anything -- it is so
   * a participant in a translated call on an engine-less deployment is TOLD,
   * instead of being shown "hearing translated voice" over silence.
   */
  private async probeTranslationEngine(): Promise<void> {
    try {
      const response = await fetch(`${this.mediaIngestUrl.replace(/\/$/, '')}/health`);
      const payload = (await response.json()) as {
        translationEngine?: { real?: unknown; stubbed?: unknown };
      };
      // Only an explicit `false` counts. An older media-ingest that does not
      // report the field must not be read as broken.
      if (payload.translationEngine?.real === false) {
        this.translationEngineReal = false;
        logger.warn('media-ingest reports no real translation engine', {
          stubbed: payload.translationEngine.stubbed,
        });
      }
    } catch (error) {
      logger.warn('Could not ask media-ingest about its translation engine', {
        message: error instanceof Error ? error.message : 'unknown failure',
      });
    }
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
      channelId: DEFAULT_CHANNEL_ID,
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
      case 'operator': {
        /*
         * THE ONLY ROLE THAT IS AUTHENTICATED HERE, and the reason is that it
         * is the only one that CONTROLS a live programme going out to an
         * audience. A listener joins and receives; an operator starts, stops,
         * retargets and mutes. Until now the difference between them was a
         * query parameter that anybody could type.
         *
         * Refused BEFORE joining the operator room, so a rejected socket never
         * receives an operator broadcast on its way out.
         */
        const admission = this.operatorAuthority.admit(socket);
        if (!admission.ok) {
          // The reason is a four-valued enum, never the token or the account.
          logger.warn('Operator refused', { socketId: socket.id, reason: admission.reason });
          /*
           * TWO MESSAGES, SPLIT AT THE SIGNATURE. Everything unverified -- no
           * token, forged, expired, or a server with no secret -- gets one
           * answer, because distinguishing "no token" from "bad token" tells
           * somebody probing which half they got right. A token that DID
           * verify for an account that is not enabled gets told so: that
           * caller already knows who they are, and "sign in" to somebody who
           * has is the console lying to its own operator.
           *
           * Emitted before the disconnect so the console can show it; the
           * notice is built from constants and cannot carry either secret.
           */
          socket.emit(SOCKET_EVENTS.ERROR, operatorRefusalNotice(admission.reason));
          socket.disconnect(true);
          return;
        }
        void socket.join(OPERATOR_ROOM);
        this.operatorAccounts.set(socket.id, admission.accountId);
        /*
         * THE OPERATOR'S OWN CHANNEL. Derived from the account, so it is the
         * same channel every time they connect and nothing has to be
         * provisioned. Claiming is idempotent, which is what makes a
         * reconnect mid-programme resume rather than collide.
         *
         * They stay in OPERATOR_ROOM as well: service status and other
         * gateway-wide operator traffic is not per-programme, and removing
         * them from it would silence those without meaning to.
         */
        const operatorChannelId = channelIdForAccount(admission.accountId, this.channelSalt);
        this.operatorOwnChannels.set(socket.id, operatorChannelId);
        /*
         * AUTO-LAND. Founder directive (A, 30 Aug 2026): "every entitled
         * operator lands automatically on their own persistent channel;
         * 'Move to my channel' leaves the normal workflow; main stays a
         * special C7/platform channel."
         *
         * This used to be opt-in, because listener clients that predated
         * channels all sat on the default channel. Every listener surface
         * now chooses a channel, so landing on the default would publish an
         * operator's programme to an audience that is not theirs. The move
         * to the platform channel remains for whoever operates it today
         * (JOIN_CHANNEL 'main'); nothing in the ordinary path needs it.
         *
         * Claimed HERE, synchronously, so ownership is enforced from the
         * first message. The persisted identity is read next, and the
         * connect-time assignment waits for it: a console that showed a
         * fallback name for two seconds and then corrected it would be
         * showing exactly what the directive forbids.
         */
        this.channels.claim(operatorChannelId, admission.accountId);
        this.operatorChannels.set(socket.id, operatorChannelId);
        void socket.join(channelOperatorRoom(operatorChannelId));
        this.handleOperatorSocket(socket);
        void this.landOperator(socket, admission.accountId, operatorChannelId);
        // PRESENCE ONLY. The account id here was read out of a verified session
        // token, and the founder ruling (29 Aug 2026) is that no "account
        // identifier derived from a token" is ever printed. An incident joins
        // on socketId; the account behind it lives in the account service.
        logger.info('Operator connected', {
          socketId: socket.id,
          authenticated: true,
        });
        break;
      }
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

    socket.on('disconnect', () => {
      this.operatorAccounts.delete(socket.id);
      /*
       * The claim OUTLIVES the socket. An operator who drops mid-programme
       * still owns their channel when they reconnect -- releasing it here
       * would hand a live programme to whoever connected next.
       */
      this.operatorChannels.delete(socket.id);
      this.operatorOwnChannels.delete(socket.id);
      this.handleDisconnect(socket);
    });
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
    /*
     * Every listener sits in a channel room, including the ones that never ask
     * for a channel. Programme traffic used to be a global broadcast, so with
     * two programmes running each listener would receive both and show
     * whichever arrived last.
     */
    void socket.join(channelListenerRoom(state.channelId));
    socket.emit(SOCKET_EVENTS.CHANNEL_DIRECTORY, this.channels.directory());
    // Lazily: a stale name is corrected by a second directory, not a delay.
    this.refreshChannelProfiles();
    socket.emit(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, this.channels.audio(state.channelId));
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

    /*
     * CHOOSING A PROGRAMME, which before this was not a choice: there was one
     * programme and every listener was on it.
     *
     * JOIN_LANGUAGE still works and means "this language on the default
     * channel", so clients that predate channels keep working and can be
     * migrated one at a time rather than all on the same deploy.
     */
    socket.on(SOCKET_EVENTS.JOIN_CHANNEL, (raw: unknown) => {
      const request = this.parseChannelJoin(raw);
      if (!request) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid channel' });
        return;
      }

      /*
       * THE LOCK ON A PRIVATE CHANNEL. Checked before any room is joined or
       * left, so a refused listener is not moved off the channel they were
       * already on -- a failed attempt to enter a private programme must not
       * cost somebody the one they were already watching.
       */
      if (!this.channels.mayJoin(request.channelId, request.code)) {
        logger.warn('Listener refused a private channel', {
          socketId: socket.id,
          channelId: request.channelId,
        });
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'This programme is locked. Check the link and code you were given.',
        });
        return;
      }

      if (state.channelId !== request.channelId) {
        void socket.leave(channelListenerRoom(state.channelId));
        if (state.targetLanguage) {
          void socket.leave(channelRoom(state.channelId, state.targetLanguage));
        }
        state.channelId = request.channelId;
        void socket.join(channelListenerRoom(request.channelId));
      }

      if (request.targetLanguage !== undefined) {
        this.joinLanguage(socket, state, request.targetLanguage);
      }

      /*
       * The new channel's programme, sent to this socket alone. A listener
       * switching channels needs the state of the one they arrived at, and
       * broadcasting it would tell every other listener about a programme
       * they did not ask for.
       */
      const programme = this.channels.mediaState(request.channelId);
      if (programme && this.isDeliverableProgramme(programme)) {
        socket.emit(SOCKET_EVENTS.MEDIA_STATE, {
          ...programme,
          connectedListeners: this.listenerCount,
        });
      }
      socket.emit(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, this.channels.audio(request.channelId));
      logger.debug('Listener joined channel', {
        socketId: socket.id,
        channelId: request.channelId,
      });
    });

    socket.on(SOCKET_EVENTS.JOIN_LANGUAGE, (targetLanguage: unknown) => {
      if (
        targetLanguage !== ORIGINAL_LANGUAGE_CHANNEL &&
        (typeof targetLanguage !== 'string' || targetLanguage.length < 2)
      ) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid targetLanguage' });
        return;
      }
      this.joinLanguage(socket, state, targetLanguage);
    });

    socket.on(SOCKET_EVENTS.LEAVE_LANGUAGE, (targetLanguage: unknown) => {
      if (typeof targetLanguage === 'string') {
        void socket.leave(languageRoom(targetLanguage));
        void socket.leave(channelRoom(state.channelId, targetLanguage));
        if (state.targetLanguage === targetLanguage) {
          state.targetLanguage = undefined;
        }
      }
    });
  }

  /**
   * Join a language, on whichever channel this listener is on.
   *
   * Shared by JOIN_LANGUAGE and JOIN_CHANNEL so the two cannot drift: a
   * listener who switches channel and language in one message must end up in
   * exactly the rooms a listener who sent two messages would.
   *
   * The listener joins BOTH the channel-scoped room and the bare language
   * room. The bare room is what every existing publisher still emits to, so
   * dropping it here would silence the default channel; channel-scoped
   * publishing replaces it a call site at a time.
   */
  private joinLanguage(socket: Socket, state: ClientState, targetLanguage: string): void {
    if (state.targetLanguage) {
      void socket.leave(languageRoom(state.targetLanguage));
      void socket.leave(channelRoom(state.channelId, state.targetLanguage));
    }
    state.targetLanguage = targetLanguage;
    void socket.join(languageRoom(targetLanguage));
    void socket.join(channelRoom(state.channelId, targetLanguage));

    const activeSessionId = this.channels.mediaState(state.channelId)?.processingSessionId;
    if (activeSessionId) {
      for (const event of this.generatedAudioStore.getSnapshot(activeSessionId, targetLanguage)) {
        socket.emit(SOCKET_EVENTS.GENERATED_AUDIO_READY, event);
      }
    }
    logger.debug('Listener joined language room', {
      socketId: socket.id,
      targetLanguage,
      channelId: state.channelId,
    });
  }

  /**
   * Whether a programme is worth sending to somebody who just arrived.
   *
   * A finished programme with a recording still is; a finished one with
   * nothing to play is not.
   */
  private isDeliverableProgramme(state: MediaStateEvent): boolean {
    return !isTerminalMediaState(state.streamStatus) || Boolean(state.programmeMediaUrl);
  }

  /**
   * A channel settings change, from a client that may have sent anything.
   *
   * Every field is optional and an absent field means "leave it alone", which
   * is what lets the console change visibility without resending a join code
   * it does not have. `code: null` is the distinct, deliberate way to clear one.
   */
  private parseChannelSettings(
    raw: unknown,
  ): { ok: true; settings: OperatorChannelSettingsPayload } | { ok: false; message: string } {
    const invalid = { ok: false, message: 'Invalid channel settings' } as const;
    if (!raw || typeof raw !== 'object') return invalid;
    const candidate = raw as {
      displayName?: unknown;
      visibility?: unknown;
      code?: unknown;
      category?: unknown;
    };
    const settings: OperatorChannelSettingsPayload = {};

    if (candidate.displayName !== undefined) {
      if (typeof candidate.displayName !== 'string') return invalid;
      const trimmed = candidate.displayName.trim();
      if (trimmed.length === 0 || trimmed.length > 80) return invalid;
      settings.displayName = trimmed;
    }

    if (candidate.visibility !== undefined) {
      if (
        candidate.visibility !== 'public' &&
        candidate.visibility !== 'private' &&
        candidate.visibility !== 'locked'
      ) {
        return invalid;
      }
      settings.visibility = candidate.visibility;
    }

    if (candidate.code !== undefined) {
      if (candidate.code === null) {
        settings.code = null;
      } else {
        /*
         * Long enough not to be guessed in a few thousand tries. A four-digit
         * code on a channel anybody can reach by link is a formality, and this
         * is the only thing standing in front of a private programme.
         */
        if (typeof candidate.code !== 'string') return invalid;
        if (candidate.code.length < 6 || candidate.code.length > 64) return invalid;
        settings.code = candidate.code;
      }
    }

    /*
     * Founder ruling (29 Aug 2026): "Add a controlled channel-side category
     * field, one primary category in v1." Controlled means the list is the
     * whole truth: a value off it is refused by name, and because the refusal
     * happens before anything is applied, the rest of the same message is
     * left unapplied too. A console cannot half-save.
     */
    if (candidate.category !== undefined) {
      const category = candidate.category;
      if (category === null) {
        settings.category = null;
      } else if (isChannelCategory(category)) {
        settings.category = category;
      } else {
        return { ok: false, message: 'Choose a category from the list.' };
      }
    }

    return { ok: true, settings };
  }

  /** A channel join request, from a client that may have sent anything. */
  private parseChannelJoin(
    raw: unknown,
  ): { channelId: string; targetLanguage?: string; code?: string } | null {
    if (raw === null || raw === undefined) return null;
    const candidate =
      typeof raw === 'string'
        ? { channelId: raw }
        : (raw as { channelId?: unknown; targetLanguage?: unknown });

    const channelId = candidate.channelId;
    /*
     * Ids are matched against a strict shape rather than sanitised. A channel
     * id becomes a room name, and a room name assembled from arbitrary client
     * text is how one listener ends up in another programme's room.
     */
    if (typeof channelId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(channelId)) {
      return null;
    }

    const rawCode = (candidate as { code?: unknown }).code;
    /*
     * A wrong-shaped code is dropped rather than refused here, so that the
     * single refusal below covers "no code", "wrong code" and "malformed
     * code" identically. Telling them apart tells somebody guessing which
     * half they got right.
     */
    const code =
      typeof rawCode === 'string' && rawCode.length > 0 && rawCode.length <= 64
        ? { code: rawCode }
        : {};

    const targetLanguage = (candidate as { targetLanguage?: unknown }).targetLanguage;
    if (targetLanguage === undefined) return { channelId, ...code };
    if (targetLanguage !== ORIGINAL_LANGUAGE_CHANNEL) {
      if (typeof targetLanguage !== 'string' || targetLanguage.length < 2) return null;
    }
    return { channelId, targetLanguage: targetLanguage as string, ...code };
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
    // After the state is cleared THROUGH the binding, the binding itself goes.
    this.channels.releaseSession(sessionId);
  }

  /**
   * Stop advertising a torn-down live session to future listeners while keeping
   * uploaded programmes (which retain a playable programmeMediaUrl) replayable.
   */
  private invalidateProgrammeMediaState(sessionId: string): void {
    /*
     * THE SESSION'S OWN CHANNEL, not the default. This used to read and write
     * `latestProgrammeMediaState` -- the DEFAULT_CHANNEL_ID accessor -- so a
     * broadcaster on their own channel could stop, disconnect, even leave for
     * the day, and their channel kept advertising `live: true` in the public
     * directory forever: the per-channel state set at config time was never
     * the state this cleanup touched. The operator's "turn my channel off" is
     * ending the broadcast; this is what makes ending actually turn it off.
     */
    const channelId = this.channels.channelForSession(sessionId);
    const state = this.channels.mediaState(channelId);
    if (!state) return;
    const referencesSession =
      state.processingSessionId === sessionId ||
      state.shareableWebRtcSessionId?.endsWith(`/${sessionId}`) === true;
    if (!referencesSession) return;
    if (state.programmeMediaUrl) {
      if (!isTerminalMediaState(state.streamStatus)) {
        this.channels.setMediaState(channelId, { ...state, streamStatus: 'completed' });
      }
      return;
    }
    this.channels.setMediaState(channelId, null);
  }

  private handleOperatorSocket(socket: Socket): void {
    this.emitServiceSnapshot(socket);

    /*
     * MOVING TO A CHANNEL, which is how one deployment runs more than one
     * programme at a time.
     *
     * Checked against ownership rather than trusted: the id arrives from a
     * client, and without the check an authenticated operator could publish
     * into a channel somebody else's audience is listening to.
     */
    socket.on(SOCKET_EVENTS.JOIN_CHANNEL, (raw: unknown) => {
      const request = this.parseChannelJoin(raw);
      const accountId = this.operatorAccounts.get(socket.id);
      if (!request || accountId === undefined) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid channel' });
        return;
      }

      const requested =
        request.channelId === 'own'
          ? (this.operatorOwnChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID)
          : request.channelId;

      if (!this.channels.mayOperate(requested, accountId)) {
        logger.warn('Operator refused a channel they do not own', {
          socketId: socket.id,
          channelId: requested,
        });
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'That channel belongs to another account.' });
        return;
      }

      const previous = this.operatorChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID;
      if (previous !== requested) {
        void socket.leave(channelOperatorRoom(previous));
        void socket.join(channelOperatorRoom(requested));
      }
      this.operatorChannels.set(socket.id, requested);
      /*
       * THE PLATFORM CHANNEL has no persisted identity to read: it is a
       * special C7 channel (founder directive A, 30 Aug 2026), operable by
       * whoever operates it today and widened to nobody. Any other channel
       * is claimed and its profile read, exactly as at connect.
       */
      if (requested === DEFAULT_CHANNEL_ID) {
        this.emitChannelAssigned(socket, requested);
        this.broadcastChannelDirectory();
      } else {
        this.channels.claim(requested, accountId);
        void this.landOperator(socket, accountId, requested);
      }
      logger.info('Operator moved channel', { socketId: socket.id, channelId: requested });
    });

    /*
     * NAMING AND GATING A CHANNEL: how a programme becomes public, private or
     * private.
     *
     * Applied to the channel the operator is CURRENTLY ON, and only if they
     * own it. Taking a channel id from the payload instead would let an
     * authenticated operator make somebody else's public programme private,
     * which is a denial of service dressed as a settings change.
     */
    socket.on(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, (raw: unknown) => {
      const parsed = this.parseChannelSettings(raw);
      const accountId = this.operatorAccounts.get(socket.id);
      if (!parsed.ok || accountId === undefined) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: parsed.ok ? 'Invalid channel settings' : parsed.message,
        });
        return;
      }
      const settings = parsed.settings;

      const channelId = this.operatorChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID;
      if (channelId === DEFAULT_CHANNEL_ID || !this.channels.mayOperate(channelId, accountId)) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Move to your own channel before changing its settings.',
        });
        return;
      }

      if (settings.displayName !== undefined) {
        this.channels.claim(channelId, accountId, settings.displayName);
      }
      if (settings.visibility !== undefined) {
        this.channels.setVisibility(channelId, settings.visibility);
      }
      if (settings.code !== undefined) {
        this.channels.setAccessCode(channelId, settings.code);
      }
      if (settings.category !== undefined) {
        this.channels.setCategory(channelId, settings.category);
      }

      /*
       * MIRROR, THEN RE-READ. Founder directive (A, 30 Aug 2026): identity
       * persists outside gateway memory. Visibility is written to the
       * account from here; name and category are accepted here too, but the
       * console saves those to the account directly (lane A3), so the ack
       * re-reads the profile and answers with what the account now holds.
       * An empty settings message is therefore a legitimate "re-read".
       */
      void this.acknowledgeChannelSettings(socket, channelId, settings);
      logger.info('Operator updated channel settings', {
        socketId: socket.id,
        channelId,
        visibility: settings.visibility,
        category: settings.category,
      });
    });

    socket.on(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, (raw: unknown) => {
      const preferences = this.parseAudioModePreferences(raw);
      if (!preferences) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid audio mode preferences' });
        return;
      }

      /*
       * Scoped to the operator's own channel. This used to be one global
       * setting, so an operator changing audio mode changed it for every
       * listener of every programme.
       */
      const channelId = this.operatorChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID;
      this.channels.setAudio(channelId, preferences);
      this.io
        .to(channelListenerRoom(channelId))
        .emit(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, preferences);
      logger.info('Operator audio mode preferences updated', {
        originalVolume: preferences.originalVolume,
        translatedVolume: preferences.translatedVolume,
        subtitlesEnabled: preferences.subtitlesEnabled,
      });
    });

    socket.on(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, (raw: unknown) => {
      const config = this.parseProgrammeSessionConfig(raw);
      /*
       * A session already running on somebody else's channel is not this
       * operator's to reconfigure. Without this an authenticated operator
       * could still retarget a stranger's live programme by naming its
       * session id -- which is most of the door the authentication gate was
       * meant to close.
       */
      if (config) {
        const ownChannel = this.operatorChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID;
        const boundChannel = this.channels.channelForSession(config.sessionId);
        if (boundChannel !== ownChannel && boundChannel !== DEFAULT_CHANNEL_ID) {
          logger.warn('Operator refused a session on another channel', {
            socketId: socket.id,
            sessionId: config.sessionId,
          });
          socket.emit(SOCKET_EVENTS.ERROR, {
            message: 'That programme belongs to another channel.',
          });
          return;
        }
      }
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
      /*
       * BIND THE SESSION TO THE CHANNEL that configured it. Everything
       * downstream -- media state, translated audio, teardown -- finds its
       * channel by session id, because that is the only identifier the ingest
       * and worker paths carry.
       */
      const channelId = this.operatorChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID;
      this.channels.bindSession(config.sessionId, channelId);
      /*
       * AND MINT THE RUN, from server state rather than the operator's payload.
       *
       * The channel comes from the socket's admission, not from anything the
       * console sent, so a client cannot nominate whose programme it is
       * broadcasting. The programme is the channel's configuration today and
       * carried separately so it can stop being that without a protocol
       * change. The run is minted fresh here because THIS airing is not the
       * last one: its timeline, telemetry and adverts must not inherit them.
       */
      if (!this.programmeRuns.has(config.sessionId)) {
        this.programmeRuns.set(config.sessionId, {
          channelId,
          programmeId: channelId,
          runId: `run_${randomUUID().replace(/-/gu, '').slice(0, 24)}`,
        });
      }
      // The broadcast's name, for the directory while it is on air; null
      // when the operator gave none, never a stand-in.
      this.channels.setProgrammeTitle(channelId, config.programmeTitle ?? null);
      this.broadcastProgrammeSessionConfig(config, channelId);
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

    /*
     * THE ANSWER THAT DECIDES WHETHER THIS GATEWAY MAY RELAY.
     *
     * Validated rather than trusted: a malformed message that fell through to
     * a default would decide it in the permissive direction, and the
     * permissive direction is an audience hearing a protected studio. An
     * invalid announcement leaves the previous answer standing, which for a
     * protected run means it stays refused.
     */
    /*
     * An advert C7 decided and the cursor released, forwarded to the channel
     * that is airing that run. The gateway chooses nothing here -- it does not
     * know what a campaign is, and a gateway that could pick would be a second
     * place adverts come from.
     */
    socket.on(SOCKET_EVENTS.INGEST_PROGRAMME_ADVERT, (raw: unknown) => {
      const advert = raw as {
        runId?: unknown;
        decisionId?: unknown;
        creativeId?: unknown;
        programmeTimeMs?: unknown;
        durationMs?: unknown;
      };
      if (
        typeof advert.runId !== 'string' ||
        typeof advert.decisionId !== 'string' ||
        typeof advert.creativeId !== 'string' ||
        typeof advert.programmeTimeMs !== 'number' ||
        typeof advert.durationMs !== 'number'
      ) {
        logger.warn('Ingest sent an invalid programme advert', { socketId: socket.id });
        return;
      }
      const channelId = this.channelForRun(advert.runId);
      if (channelId === null) return;
      this.io.to(channelListenerRoom(channelId)).emit(SOCKET_EVENTS.PROGRAMME_ADVERT, {
        runId: advert.runId,
        decisionId: advert.decisionId,
        creativeId: advert.creativeId,
        programmeTimeMs: advert.programmeTimeMs,
        durationMs: advert.durationMs,
      });
    });

    socket.on(SOCKET_EVENTS.INGEST_PROGRAMME_DELIVERY, (raw: unknown) => {
      const parsed = safeParseProgrammeMediaDelivery(raw);
      if (!parsed.success) {
        logger.warn('Ingest sent an invalid programme delivery announcement', {
          socketId: socket.id,
        });
        return;
      }
      this.noteProgrammeDelivery(parsed.data as ProgrammeMediaDelivery);
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
              // The SAME number progressive frames carry, so a viewer can
              // compare rather than guess.
              sourceRevision: this.programmeSourceRevisions.get(programmeConfig.sessionId) ?? 1,
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
      /*
       * The channel is found by session id, which is the only identifier this
       * path carries. An unbound session resolves to the default channel, so
       * ingest that predates channels behaves exactly as it did.
       */
      const ingestChannelId = this.channels.channelForSession(
        enriched.processingSessionId ?? programmeConfig?.sessionId ?? '',
      );
      if (programmeConfig && !isTerminalMediaState(enriched.streamStatus)) {
        this.channels.setMediaState(ingestChannelId, enriched);
      }
      if (programmeConfig && isTerminalMediaState(enriched.streamStatus)) {
        this.channels.setMediaState(
          ingestChannelId,
          enriched.programmeMediaUrl ? enriched : null,
        );
      }

      this.publishMediaState(ingestChannelId, enriched);
      this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
      logger.debug('Media state broadcast', { streamStatus: enriched.streamStatus });
    });

    /**
     * The REALTIME caption path.
     *
     * media-ingest's live pipeline recognises speech, commits a segment and
     * emits it here. Nothing subscribed to this event, so on a translated call
     * the recogniser worked, segments committed, and every word was dropped
     * between the two services -- which reads from outside as a broken
     * translation engine.
     *
     * Converted into the batch path's shape and routed through the SAME
     * interception, so delivery, dedup and language settling have one
     * implementation rather than two that drift.
     */
    socket.on(SOCKET_EVENTS.INGEST_LIVE_TRANSCRIPT, (raw: unknown) => {
      if (!isLiveTranscriptEvent(raw)) {
        logger.warn('Ingest sent a malformed live transcript', { socketId: socket.id });
        return;
      }
      const event = this.liveTranscripts.toTranscriptionEvent(raw);
      // Null means the segment carried no words. Committing an empty caption
      // would put a blank line on everybody's screen.
      if (!event) return;
      if (this.callRuntime.interceptTranscriptionEvent(event)) return;
      // Not a call: the live path is call-only today, so anything else is a
      // session id that does not belong here rather than programme audio.
      logger.debug('Live transcript for a non-call session; ignored', {
        sessionId: event.sessionId,
      });
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
        this.channels.channelForSession(event.sessionId),
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

  /**
   * Record a run's delivery answer and act on it immediately.
   *
   * Acting immediately matters: a run that becomes delayed while listeners are
   * already attached has an audience receiving realtime media right now, and
   * waiting for the next join would leave them there.
   */
  private noteProgrammeDelivery(delivery: ProgrammeMediaDelivery): void {
    this.programmeDelivery.set(delivery.programmeRunId, delivery);
    if (delivery.mode === 'delayed') this.sawDelayedDelivery = true;

    for (const [sessionId, run] of this.programmeRuns) {
      if (run.runId !== delivery.programmeRunId) continue;
      if (realtimeRelayPermitted(delivery)) {
        this.realtimeRelayForbidden.delete(sessionId);
        continue;
      }
      const wasPermitted = !this.realtimeRelayForbidden.has(sessionId);
      this.realtimeRelayForbidden.add(sessionId);
      if (wasPermitted) {
        /*
         * Torn down rather than left silent. A peer that exists and is
         * expected not to carry frames is one bug away from carrying them,
         * and the bug would be invisible until an audience heard the studio.
         */
        this.listenerMediaPeers.closeSession(
          sessionId,
          'this programme is delivered through the delayed public media path',
        );
        logger.info('Realtime relay withdrawn for a protected programme', {
          runId: delivery.programmeRunId,
          readiness: delivery.readiness,
        });
      }
    }
  }

  /**
   * May this session's original media go out over the realtime audience path?
   *
   * The single question, asked in one place. A session with no programme run
   * is not a programme and is permitted; a run whose answer says delayed is
   * refused in every readiness, including `preparing` -- relaying while a
   * buffer fills would deliver the studio for exactly the window the delay was
   * configured to cover.
   */
  /**
   * Hand one frame to the protected encoder, if this run has one.
   *
   * ONLY FOR A RUN THAT IS ACTUALLY PROTECTED. A live-delivery broadcast has
   * no use for segments, and encoding them would spend a core per broadcast
   * producing material nothing reads.
   *
   * Nothing here may throw and nothing here may block. This is the gateway's
   * media callback, and the TRUE LIVE audience is on it: a protected encoder
   * under pressure must never become a realtime audience's problem.
   */
  private contributeToProtectedRun(
    sessionId: string,
    kind: 'audio' | 'video',
    payload: unknown,
  ): void {
    const host = this.contributionHost;
    if (host === null) return;
    const run = this.programmeRuns.get(sessionId);
    if (run === undefined) return;
    const delivery = this.programmeDelivery.get(run.runId);
    if (delivery === undefined || delivery.mode !== 'delayed') return;
    try {
      if (kind === 'audio') host.pushAudio(run.runId, payload as never);
      else host.pushVideo(run.runId, payload as never);
    } catch (error) {
      logger.warn('Protected contribution frame could not be accepted', {
        runId: run.runId,
        message: error instanceof Error ? error.message : 'unknown contribution failure',
      });
    }
  }

  /** Which channel is airing a run, or null when this gateway is not. */
  private channelForRun(runId: string): string | null {
    for (const run of this.programmeRuns.values()) {
      if (run.runId === runId) return run.channelId;
    }
    return null;
  }

  private mayRelayRealtime(sessionId: string): boolean {
    const run = this.programmeRuns.get(sessionId);
    if (run === undefined) return true;
    const delivery = this.programmeDelivery.get(run.runId);
    if (delivery !== undefined) return realtimeRelayPermitted(delivery);
    // Unknown. Safe to permit only on a deployment that has never shown it
    // does protected broadcasts at all.
    return !this.sawDelayedDelivery;
  }

  private async startListenerDeliveryForSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    if (!this.mayRelayRealtime(sessionId)) {
      /*
       * NOT MUTED, NOT PAUSED: no peer is built. The protected audience
       * receives this programme through the delayed public media path, and a
       * listener whose client cannot play that path does not watch -- which is
       * the correct outcome, because the alternative is delivering the very
       * material the delay withholds.
       */
      logger.info('Refused a realtime listener peer for a protected programme', { sessionId });
      return;
    }
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
  /**
   * The media pipeline every producer shares.
   *
   * Exposed for the adapter ingress binding (P6.9 Step 8), which composes onto
   * the SAME bridge the browser and native call paths use. A second bridge for
   * adapters would be a second pipeline, which is the thing this milestone
   * exists to avoid.
   */
  getMediaTranscriptionBridge(): MediaTranscriptionBridge {
    return this.webRtcTranscriptionBridge;
  }

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
      /*
       * Scoped by the session on the event. An event without one resolves to
       * the default channel, which is the safe direction: a phrase that cannot
       * be attributed to a channel is delivered narrowly rather than to every
       * listener of that language -- otherwise a private programme’s source
       * text reaches somebody who never had the code.
       */
      this.emitToLegacyProgrammeAudiences(
        selectLegacyProgrammeAudiences({ kind: 'translation', event: readyEvent }),
        SOCKET_EVENTS.TRANSLATION_EVENT,
        readyEvent,
        this.channels.channelForSession(readyEvent.sessionId ?? ''),
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
        this.channels.channelForSession(event.sessionId),
      );
      logger.info('Generated audio ready event broadcast', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        sequence: event.sequence,
        targetLanguage: event.targetLanguage,
      });
    }
  }

  /**
   * @param channelId - The channel this event belongs to, when it can be known.
   *
   * OMITTED MEANS THE BARE LANGUAGE ROOM: every listener of that language,
   * across every channel. No caller omits it any more, and none should -- the
   * parameter stays optional only so that adding a new event type cannot
   * silently acquire the wrong channel by defaulting to one.
   *
   * All three programme events now carry a sessionId, so all three resolve.
   * An event whose session is unknown resolves to the DEFAULT channel, which
   * is the safe direction: it narrows delivery rather than widening it. The
   * cost is a supplementary source-text line going missing on other channels,
   * which the viewer already renders as empty; the alternative was one
   * programme’s text reaching every listener of that language, including a
   * private programme’s text reaching somebody who never had the code.
   */
  private emitToLegacyProgrammeAudiences(
    audiences: readonly LegacyProgrammeAudience[],
    eventName: string,
    payload: unknown,
    channelId?: string,
  ): void {
    for (const audience of audiences) {
      const room =
        audience.kind === 'operator'
          ? OPERATOR_ROOM
          : channelId === undefined
            ? languageRoom(audience.language)
            : channelRoom(channelId, audience.language);
      this.io.to(room).emit(eventName, payload);
    }
  }

  /**
   * Translated speech arriving back from media-ingest, on its way to a listener.
   *
   * This is the seam the whole progressive-audio effort exists for. What used
   * to happen here was that a URL to a FINISHED file was emitted, so nobody
   * could hear the first half of a sentence until the second half had been
   * synthesised. A frame arrives here while the rest of the sentence is still
   * being made, and goes straight out.
   *
   * Nothing vendor-shaped crosses this line: the frame carries the platform's
   * segment id, its own generation and sequence, and PCM in the engine format.
   * A listener could not tell which synthesiser produced it, which is what
   * makes changing synthesiser a configuration change rather than a client
   * release.
   */
  private deliverTranslatedAudioFrame(
    context: MediaTranscriptionBridgeContext,
    frame: IngressTranslatedAudio,
  ): void {
    // Base64 because socket.io payloads are JSON. The samples are the
    // platform's own little-endian PCM16; no vendor container is involved.
    const pcmBase64 = Buffer.from(
      frame.samples.buffer,
      frame.samples.byteOffset,
      frame.samples.byteLength,
    ).toString('base64');

    // A CALL AND A PROGRAMME ARE ROUTED BY DIFFERENT AUTHORITIES, and the split
    // is here rather than inside either of them.
    //
    // A call has private recipients: who may hear a given speaker in a given
    // language is a decision the call session layer already owns, and a
    // language room would deliver one participant's translated voice to every
    // other call sharing that language. A programme has an AUDIENCE that
    // joined a language on purpose, so a language room is exactly right.
    if (
      this.callRuntime?.interceptTranslatedAudioFrame({
        sessionId: context.sessionId,
        targetLanguage: frame.targetLanguage,
        segmentId: frame.segmentId,
        generation: frame.generation,
        sequence: frame.sequence,
        segmentStartMs: frame.segmentStartMs,
        final: frame.final,
        pcmBase64,
      }) === true
    ) {
      return;
    }

    // PROGRAMME. The Viewer is told what it can actually check: which
    // broadcast, which source revision, which language. It has never seen a
    // media-ingest processing-session id and must not need one -- that is
    // server knowledge, and requiring it would make the next internal rename a
    // frontend breaking change.
    this.programmeSourceRevisions.set(context.sessionId, context.revision);
    const programme = this.programmeSessionConfigs.get(context.sessionId);
    const payload: TranslatedAudioFramePayload = {
      broadcastId: programme?.broadcastId ?? context.broadcastId,
      // A source switch bumps this. Late frames from revision N must not become
      // audible once N+1 is authoritative, and the Viewer is the only place
      // that knows which revision it is currently rendering.
      sourceRevision: context.revision,
      targetLanguage: frame.targetLanguage,
      segmentId: frame.segmentId,
      generation: frame.generation,
      sequence: frame.sequence,
      segmentStartMs: frame.segmentStartMs,
      final: frame.final,
      sampleRate: 16000,
      channelCount: 1,
      pcmBase64,
    };
    this.translatedAudioListeners.forEach((listener) => listener(payload));
    // Named from the FRAME, not from the session's first configured target:
    // one utterance produces a stream per language and they share a socket.
    /*
     * Scoped to the channel this session belongs to. A bare language room
     * holds every listener of that language across every programme, so two
     * programmes translating into French would have been mixed into one
     * another's audio.
     */
    this.io
      .to(channelRoom(this.channels.channelForSession(context.sessionId), frame.targetLanguage))
      .emit(SOCKET_EVENTS.TRANSLATED_AUDIO_FRAME, payload);
  }

  /** Test and adapter seam: observe progressive frames without a socket client. */
  onTranslatedAudioFrame(listener: (payload: TranslatedAudioFramePayload) => void): () => void {
    this.translatedAudioListeners.add(listener);
    return () => this.translatedAudioListeners.delete(listener);
  }

  private applyProgrammeSessionConfig(
    context: BackendMediaPeerAudioContext,
  ): MediaTranscriptionBridgeContext {
    // A programme timeline must stay COMPLETE: when the pipeline falls behind,
    // the new chunk is refused rather than the recorded backlog being dropped.
    // Stated here because this is the programme path, rather than left to be
    // deduced from what the session happens to be called.
    const programmeMode = { mediaSessionMode: 'programme' as const };
    // Resolved, never inferred: absent means the stream will be refused rather
    // than opened under a channel that did not ask for it.
    const run = this.programmeRuns.get(context.sessionId);
    const identity = run === undefined ? {} : { programme: run };
    const config = this.programmeSessionConfigs.get(context.sessionId);
    if (!config) return { ...context, ...programmeMode, ...identity };
    return {
      ...context,
      ...programmeMode,
      ...identity,
      ...(config.programmeSourceType === 'rtmp' && config.rtmpPlaybackUrl
        ? { externalAudioSource: 'rtmp-hls' as const, externalAudioUrl: config.rtmpPlaybackUrl }
        : {}),
      targetLanguage: config.targetLanguage,
      targetLanguages: config.targetLanguages,
      sourceLanguage: config.sourceLanguage,
      sourceLanguageMode: config.sourceLanguageMode,
    };
  }

  private broadcastProgrammeSessionConfig(
    config: OperatorProgrammeSessionConfig,
    channelId: string = DEFAULT_CHANNEL_ID,
  ): void {
    const shareableWebRtcSessionId = createShareableWebRtcSessionId(
      config.broadcastId,
      config.sessionId,
    );
    const retained = this.channels.mediaState(channelId);
    const videoTimestampMs =
      retained && retained.processingSessionId === config.sessionId
        ? retained.videoTimestampMs
        : 0;
    const run = this.programmeRuns.get(config.sessionId);
    const delivery = run === undefined ? undefined : this.programmeDelivery.get(run.runId);
    const state: MediaStateEvent = {
      eventId: 'Videofy Live Demo Event',
      // So the console can ask what THIS airing is doing.
      ...(run === undefined ? {} : { programmeRunId: run.runId }),
      /*
       * The run's own delivery answer, carried to every client rather than
       * left for each to work out. A listener uses it to decide whether to
       * play the realtime tracks or the cursor-governed segments, and it must
       * be the SAME answer this gateway is acting on -- otherwise a client
       * waits for realtime media a gateway has already decided not to send.
       */
      ...(delivery === undefined ? {} : { mediaDelivery: delivery }),
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
    this.channels.setMediaState(channelId, state);
    this.publishMediaState(channelId, state);
  }

  /**
   * Send a programme's state to the people it concerns.
   *
   * This used to be `io.emit`, which reached every connected socket. With one
   * programme that was merely wasteful; with two it is wrong, because each
   * listener would receive both programmes and display whichever landed last.
   *
   * Operators keep receiving every programme's state: the console shows what
   * is on air across the deployment, and OPERATOR_ROOM is already restricted
   * to authenticated operators.
   */
  /**
   * Tell listeners what is on air.
   *
   * Sent to listeners only. Operators have their own view of the deployment
   * and do not choose a channel from this list.
   */
  private broadcastChannelDirectory(): void {
    const directory = this.channels.directory();
    this.io.to('listeners').emit(SOCKET_EVENTS.CHANNEL_DIRECTORY, directory);
    this.reportLiveTransitions(directory);
    this.refreshChannelProfiles();
  }

  /**
   * HYDRATE LAZILY. Every known channel's profile is read through the
   * identity port, which answers from its cache for a minute at a time, so
   * this costs one request per minute per gateway rather than one per
   * broadcast. Only when a read CHANGES something shown is the directory
   * sent again -- and that second broadcast finds everything cached and
   * unchanged, so it cannot loop.
   *
   * Founder directive (A, 30 Aug 2026): "C7 Streams discovery uses persisted
   * identity (name, avatar, handle, category, live status, current
   * programme)." This is how a directory row comes to carry it.
   */
  private refreshChannelProfiles(): void {
    void this.hydrateChannels(this.channels.knownChannelIds()).then((changed) => {
      if (changed) this.broadcastChannelDirectory();
    });
  }

  /**
   * Land an operator on a channel: read its persisted identity, then tell
   * the console where it is and what the channel is called, then tell
   * listeners. In that order, so nobody is shown a fallback name for a
   * channel that has a real one.
   */
  private async landOperator(socket: Socket, accountId: string, channelId: string): Promise<void> {
    this.channels.beginHydration(channelId);
    const profile = await this.channelIdentity.claim(channelId, accountId).catch(() => null);
    if (profile) this.channels.applyProfile(channelId, profile);
    this.channels.endHydration(channelId);
    // The socket may have gone, or moved, while the account service answered.
    if (this.operatorAccounts.get(socket.id) !== accountId) return;
    if (this.operatorChannels.get(socket.id) !== channelId) return;
    this.emitChannelAssigned(socket, channelId);
    this.broadcastChannelDirectory();
  }

  private emitChannelAssigned(socket: Socket, active: string): void {
    const payload: ChannelAssignedPayload = {
      channelId: this.operatorOwnChannels.get(socket.id) ?? DEFAULT_CHANNEL_ID,
      active,
      /*
       * Whether a code is SET, never the code. The operator's own client
       * already has whatever they just typed; echoing it back would put a
       * live join code into logs and transcripts for no gain.
       */
      hasCode: this.channels.hasAccessCode(active),
      // The category is server truth (founder ruling, 29 Aug 2026), so a
      // console arriving after a reload learns it here rather than guessing.
      category: this.channels.category(active),
      // The persisted identity, or null; never a fallback name.
      profile: this.channels.profileFor(active),
    };
    socket.emit(SOCKET_EVENTS.CHANNEL_ASSIGNED, payload);
  }

  /**
   * Mirror a visibility change to the account, re-read the profile, and
   * only then acknowledge -- so the ack carries what is persisted, not what
   * was hoped. A failed mirror leaves the in-memory value in force and the
   * account behind; the next successful settings ack catches it up.
   */
  private async acknowledgeChannelSettings(
    socket: Socket,
    channelId: string,
    settings: OperatorChannelSettingsPayload,
  ): Promise<void> {
    let profile: ChannelProfile | null = null;
    if (settings.visibility !== undefined) {
      profile = await this.channelIdentity
        .setVisibility(channelId, settings.visibility)
        .catch(() => null);
    }
    if (profile === null) {
      this.channelIdentity.invalidate(channelId);
      const read = await this.channelIdentity
        .profiles([channelId])
        .catch(() => new Map<string, ChannelProfile>());
      profile = read.get(channelId) ?? null;
    }
    if (profile) this.channels.applyProfile(channelId, profile);
    if (this.operatorChannels.get(socket.id) !== channelId) return;
    this.emitChannelAssigned(socket, channelId);
    this.broadcastChannelDirectory();
  }

  /** Apply whatever profiles the port knows for these channels; true if anything shown changed. */
  private async hydrateChannels(channelIds: readonly string[]): Promise<boolean> {
    // The platform channel has no persisted identity; asking would be noise.
    const wanted = channelIds.filter((channelId) => channelId !== DEFAULT_CHANNEL_ID);
    if (wanted.length === 0) return false;
    const profiles = await this.channelIdentity
      .profiles(wanted)
      .catch(() => new Map<string, ChannelProfile>());
    let changed = false;
    for (const [channelId, profile] of profiles) {
      if (this.channels.applyProfile(channelId, profile)) changed = true;
    }
    return changed;
  }

  private readonly channelLiveHook: ((channelId: string, live: boolean, displayName: string) => Promise<void>) | null;
  private readonly lastLiveByChannel = new Map<string, boolean>();

  /**
   * Followers are told when a channel GOES live, once per transition (see
   * channel-live-transitions.ts). The hook's failure is logged and never
   * reaches the broadcast.
   */
  private reportLiveTransitions(directory: readonly { channelId: string; live: boolean; displayName: string }[]): void {
    const hook = this.channelLiveHook;
    for (const channel of diffLiveTransitions(this.lastLiveByChannel, directory)) {
      if (hook === null) continue;
      void hook(channel.channelId, channel.live, channel.displayName).catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            service: 'realtime-gateway',
            level: 'warn',
            message: 'channel-live hook failed',
            channelId: channel.channelId,
            live: channel.live,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
  }

  private publishMediaState(channelId: string, state: MediaStateEvent): void {
    this.io
      .to(channelListenerRoom(channelId))
      .to(OPERATOR_ROOM)
      .emit(SOCKET_EVENTS.MEDIA_STATE, state);
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
    /*
     * A title is decoration, so a bad one is dropped rather than refusing the
     * whole configuration: a programme must never fail to start over its
     * name. Trimmed, bounded and free of control characters, because it is
     * shown to every listener in the directory.
     */
    const programmeTitle =
      typeof candidate.programmeTitle === 'string'
        ? sanitiseProgrammeTitle(candidate.programmeTitle)
        : null;
    return {
      sessionId: candidate.sessionId,
      broadcastId: candidate.broadcastId,
      sourceRevision,
      ...(programmeTitle ? { programmeTitle } : {}),
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

/** A programme title fit for a directory row, or null when nothing is left. */
function sanitiseProgrammeTitle(value: string): string | null {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : null;
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
