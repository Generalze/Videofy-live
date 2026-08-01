declare module '@videofy-live/shared-types' {
  export interface LatencyBreakdown {
    audioCaptureMs: number;
    transcriptionMs: number;
    translationMs: number;
    speechGenerationMs: number;
    deliveryMs: number;
    synchronizationOffsetMs: number;
  }

  export type AudioFormat = 'mp3' | 'ogg' | 'wav' | 'webm' | null;

  export interface AudioMixPreferences {
    mode: 'interpretation' | 'replacement';
    originalVolume: number;
    translatedVolume: number;
    subtitlesEnabled: boolean;
  }

  export type SourceLanguageMode = 'manual' | 'auto-detect';

  export interface OperatorProgrammeSessionConfig {
    sessionId: string;
    broadcastId: string;
    sourceRevision: number;
    programmeSourceType?: string;
    rtmpPlaybackUrl?: string;
    targetLanguage: string;
    targetLanguages: string[];
    sourceLanguage: string;
    sourceLanguageMode: SourceLanguageMode;
  }

  export type StreamStatus =
    | 'created'
    | 'validating'
    | 'ready'
    | 'processing'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

  export type VideoSource =
    | 'mock'
    | 'local-file'
    | 'webcam'
    | 'zoom'
    | 'teams'
    | 'meet'
    | 'obs'
    | 'rtmp'
    | 'webrtc'
    | 'hls';

  export interface TranslationEvent {
    eventId: string;
    sequence: number;
    sourceLanguage: string;
    targetLanguage: string;
    sourceText: string;
    translatedText: string;
    audioUrl: string | null;
    audioFormat: AudioFormat;
    audioDurationMs: number | null;
    final: boolean;
    videoTimestampMs: number;
    createdAt: string;
    latency: LatencyBreakdown;
  }

  export type TranscriptionStatus =
    'queued' | 'transcribing' | 'transcribed' | 'failed' | 'retrying';

  export interface TranscriptionEvent {
    sessionId: string;
    streamId: string;
    chunkId: string;
    sequence: number;
    sourceText: string;
    detectedLanguage: string;
    startMs: number;
    endMs: number;
    confidence: number | null;
    status: TranscriptionStatus;
    error?: string;
    createdAt: string;
  }

  export type TimestampedTranslationStatus =
    'queued' | 'translating' | 'translated' | 'failed' | 'retrying';

  export interface TimestampedTranslationLatency {
    queuedMs: number;
    providerMs: number;
    totalMs: number;
  }

  export interface TimestampedTranslationEvent {
    sessionId: string;
    streamId: string;
    segmentId: string;
    sequence: number;
    sourceLanguage: string;
    targetLanguage: string;
    sourceText: string;
    translatedText: string;
    startMs: number;
    endMs: number;
    status: TimestampedTranslationStatus;
    latency: TimestampedTranslationLatency;
    error?: string;
    createdAt: string;
  }

  export interface GeneratedAudioReadyEvent {
    sessionId: string;
    streamId: string;
    segmentId: string;
    sequence: number;
    targetLanguage: string;
    translatedText: string;
    startMs: number;
    endMs: number;
    voiceId: string;
    durationMs: number;
    providerLatencyMs: number | null;
    audioUrl: string;
    createdAt: string;
  }

  export type SessionProcessingStage =
    | 'created'
    | 'validating'
    | 'audio-extraction'
    | 'transcription'
    | 'translation'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

  export interface SessionMonitoringMetadata {
    currentStage: SessionProcessingStage;
    overallProgressPct: number;
    failedSegmentCount: number;
    averageLatencyMs: number | null;
    latestLatencyMs: number | null;
    lastError: string | null;
    events: Array<{
      id: string;
      kind: 'operator-action' | 'recovery-event';
      action: 'pause' | 'resume' | 'cancel' | 'retry-transcription' | 'retry-translation';
      status: 'accepted' | 'rejected' | 'succeeded' | 'failed';
      message: string;
      segmentId?: string;
      createdAt: string;
    }>;
  }

  export interface MediaStateEvent {
    eventId: string;
    streamId?: string;
    processingSessionId?: string;
    streamStatus: StreamStatus;
    videoSource: VideoSource;
    media?: {
      filename: string;
      fileSizeBytes: number;
      mimeType: string;
      durationMs: number;
      hasAudio: boolean;
      hasVideo: boolean;
      codecs: Array<{
        type: 'audio' | 'video';
        codecName: string;
        codecLongName?: string;
        profile?: string;
      }>;
    };
    audioExtraction?: {
      status:
        'pending' | 'extracting' | 'chunking' | 'validating' | 'completed' | 'failed' | 'cleaned';
      progressPct: number;
      chunkCount: number;
      chunkDurationMs: number;
      outputFormat: {
        container: 'wav';
        codec: 'pcm_s16le';
        sampleRateHz: 16000;
        channels: 1;
      };
      chunks: Array<{
        chunkId: string;
        index: number;
        filename: string;
        startMs: number;
        endMs: number;
        durationMs: number;
        status: 'ready' | 'failed';
      }>;
      startedAt?: string;
      completedAt?: string;
      error?: string;
    };
    transcription?: {
      status: TranscriptionStatus;
      progressPct: number;
      totalChunks: number;
      transcribedChunks: number;
      failedChunks: number;
      detectedLanguage: string | null;
      events: TranscriptionEvent[];
      error?: string;
    };
    translation?: {
      status: TimestampedTranslationStatus;
      progressPct: number;
      totalSegments: number;
      translatedSegments: number;
      failedSegments: number;
      sourceLanguage: string | null;
      targetLanguage: string;
      events: TimestampedTranslationEvent[];
      error?: string;
    };
    monitoring?: SessionMonitoringMetadata;
    videoTimestampMs: number;
    sourceAudioActive: boolean;
    translatedLanguages: string[];
    connectedListeners: number;
    createdAt: string;
  }

  export const SOCKET_EVENTS: {
    readonly TRANSLATION_EVENT: 'translation:event';
    readonly TRANSCRIPTION_EVENT: 'transcription:event';
    readonly TIMESTAMPED_TRANSLATION_EVENT: 'translation:timestamped';
    readonly GENERATED_AUDIO_READY: 'audio:generated-ready';
    readonly MEDIA_STATE: 'media:state';
    readonly STREAM_STATUS: 'stream:status';
    readonly TRANSLATED_AUDIO: 'audio:translated';
    readonly SERVICE_STATUS: 'service:status';
    readonly AUDIO_MODE_PREFERENCES: 'audio:mode-preferences';
    readonly CONTROL_ACK: 'operator:control_ack';
    readonly ERROR: 'error';
    readonly JOIN_LANGUAGE: 'join:language';
    readonly LEAVE_LANGUAGE: 'leave:language';
    readonly WORKER_TRANSLATION: 'worker:translation';
    readonly WORKER_HEALTH: 'worker:health';
    readonly WORKER_TRIGGER_PHRASE: 'worker:trigger_phrase';
    readonly WORKER_RESET_SEQUENCE: 'worker:reset_sequence';
    readonly INGEST_STATE: 'ingest:state';
    readonly INGEST_TRANSCRIPTION: 'ingest:transcription';
    readonly INGEST_TRANSLATION: 'ingest:translation';
    readonly INGEST_GENERATED_AUDIO: 'ingest:generated-audio';
    readonly INGEST_HEALTH: 'ingest:health';
    readonly INGEST_START_STREAM: 'ingest:start_stream';
    readonly INGEST_STOP_STREAM: 'ingest:stop_stream';
    readonly OPERATOR_CONTROL: 'operator:control';
    readonly OPERATOR_AUDIO_MODE_PREFERENCES: 'operator:audio-mode-preferences';
    readonly OPERATOR_PROGRAMME_SESSION_CONFIG: 'operator:programme-session-config';
    readonly WEBRTC_SESSION_CREATE: 'webrtc:session:create';
    readonly WEBRTC_SESSION_JOIN: 'webrtc:session:join';
    readonly WEBRTC_SIGNAL: 'webrtc:signal';
    readonly WEBRTC_SESSION_LEAVE: 'webrtc:session:leave';
    readonly WEBRTC_SESSION_CLOSE: 'webrtc:session:close';
    readonly WEBRTC_SESSION_EVENT: 'webrtc:session:event';
    readonly WEBRTC_ERROR: 'webrtc:error';
    readonly CONNECTED: 'connect';
    readonly DISCONNECTED: 'disconnect';
    readonly RECONNECT: 'reconnect';
  };

  export function languageRoom(targetLanguage: string): string;

  export const OPERATOR_ROOM: 'operators';
  export const INGEST_ROOM: 'ingest';
  export const WORKER_ROOM: 'workers';

  export const WEBRTC_SIGNALLING_PROTOCOL_VERSION: 1;
  export const WEBRTC_BACKEND_MEDIA_PEER_ID: 'peer_backend_media';
  export const WEBRTC_SIGNALLING_LIMITS: {
    readonly identifierMaxLength: 128;
    readonly rawPayloadMaxBytes: 131072;
    readonly sdpMaxLength: 65536;
    readonly iceCandidateMaxLength: 4096;
    readonly reasonMaxLength: 512;
    readonly messageCacheSize: 512;
    readonly maxPeersPerSession: 64;
    readonly maxActiveSessions: 100;
    readonly maxMessagesPerSocketWindow: 120;
    readonly rateLimitWindowMs: 10000;
  };

  export type WebRtcSignallingRole = 'broadcaster' | 'listener' | 'server';
  export type WebRtcSessionState =
    | 'created'
    | 'waiting'
    | 'negotiating'
    | 'ready'
    | 'closing'
    | 'closed'
    | 'failed';
  export type WebRtcPeerState =
    | 'registered'
    | 'joined'
    | 'negotiating'
    | 'ready'
    | 'disconnected'
    | 'closed';
  export type WebRtcSignallingMessageType =
    | 'session-create'
    | 'session-created'
    | 'session-join'
    | 'session-joined'
    | 'sdp-offer'
    | 'sdp-answer'
    | 'ice-candidate'
    | 'ice-complete'
    | 'peer-ready'
    | 'peer-disconnect'
    | 'session-close'
    | 'signalling-error'
    | 'heartbeat-ack';
  export type WebRtcSignallingErrorCode =
    | 'invalid-payload'
    | 'unsupported-protocol-version'
    | 'unauthorized'
    | 'forbidden-role'
    | 'session-not-found'
    | 'session-already-exists'
    | 'peer-not-found'
    | 'duplicate-peer'
    | 'duplicate-broadcaster'
    | 'duplicate-message'
    | 'stale-session'
    | 'stale-negotiation'
    | 'invalid-state-transition'
    | 'offer-required'
    | 'session-closed'
    | 'payload-too-large'
    | 'backend-webrtc-unavailable'
    | 'dependency-initialization-failure'
    | 'peer-already-exists'
    | 'missing-audio-track'
    | 'duplicate-audio-track'
    | 'missing-video-track'
    | 'duplicate-video-track'
    | 'unexpected-video-track'
    | 'invalid-offer'
    | 'answer-creation-failure'
    | 'invalid-answer'
    | 'remote-description-failure'
    | 'local-description-failure'
    | 'ice-candidate-failure'
    | 'ice-connection-failure'
    | 'negotiation-timeout'
    | 'connection-closed'
    | 'audio-track-ended'
    | 'video-track-ended'
    | 'ingest-bridge-failure'
    | 'cleanup-failure'
    | 'unsupported-runtime'
    | 'internal-signalling-error';

  export interface WebRtcSignallingEnvelopeBase<TType extends WebRtcSignallingMessageType, TPayload> {
    type: TType;
    protocolVersion: 1;
    messageId: string;
    correlationId?: string;
    broadcastId: string;
    sessionId?: string;
    peerId: string;
    senderRole: WebRtcSignallingRole;
    revision: number;
    createdAt: string;
    payload: TPayload;
  }

  export interface WebRtcPeerSummary {
    peerId: string;
    role: WebRtcSignallingRole;
    state: WebRtcPeerState;
    revision: number;
  }

  export interface WebRtcSessionSummary {
    sessionId: string;
    broadcastId: string;
    state: WebRtcSessionState;
    revision: number;
    broadcasterPeerId: string;
    peerCount: number;
    peers: WebRtcPeerSummary[];
    createdAt: string;
    updatedAt: string;
  }

  export type WebRtcSessionCreateEnvelope = WebRtcSignallingEnvelopeBase<
    'session-create',
    { requestedSessionId?: string }
  >;
  export type WebRtcSessionCreatedEnvelope = WebRtcSignallingEnvelopeBase<
    'session-created',
    { sessionState: WebRtcSessionState; peerState: WebRtcPeerState; expiresAt?: string }
  >;
  export type WebRtcSessionJoinEnvelope = WebRtcSignallingEnvelopeBase<
    'session-join',
    { requestedRole: WebRtcSignallingRole }
  >;
  export type WebRtcSessionJoinedEnvelope = WebRtcSignallingEnvelopeBase<
    'session-joined',
    { sessionState: WebRtcSessionState; peerState: WebRtcPeerState; peers: WebRtcPeerSummary[] }
  >;
  export type WebRtcSdpOfferEnvelope = WebRtcSignallingEnvelopeBase<
    'sdp-offer',
    { targetPeerId: string; sdp: string }
  >;
  export type WebRtcSdpAnswerEnvelope = WebRtcSignallingEnvelopeBase<
    'sdp-answer',
    { targetPeerId: string; sdp: string }
  >;
  export type WebRtcIceCandidateEnvelope = WebRtcSignallingEnvelopeBase<
    'ice-candidate',
    {
      targetPeerId: string;
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
      usernameFragment?: string | null;
    }
  >;
  export type WebRtcIceCompleteEnvelope = WebRtcSignallingEnvelopeBase<
    'ice-complete',
    { targetPeerId: string }
  >;
  export type WebRtcPeerReadyEnvelope = WebRtcSignallingEnvelopeBase<
    'peer-ready',
    { state: WebRtcPeerState }
  >;
  export type WebRtcPeerDisconnectEnvelope = WebRtcSignallingEnvelopeBase<
    'peer-disconnect',
    { reason?: string; targetPeerId?: string }
  >;
  export type WebRtcSessionCloseEnvelope = WebRtcSignallingEnvelopeBase<
    'session-close',
    { reason?: string }
  >;
  export type WebRtcHeartbeatAckEnvelope = WebRtcSignallingEnvelopeBase<
    'heartbeat-ack',
    { observedAt: string }
  >;
  export type WebRtcSignallingErrorEnvelope = WebRtcSignallingEnvelopeBase<
    'signalling-error',
    {
      code: WebRtcSignallingErrorCode;
      message: string;
      retryable: boolean;
      currentState?: WebRtcSessionState | WebRtcPeerState;
    }
  >;

  export type WebRtcIncomingSignallingEnvelope =
    | WebRtcSessionCreateEnvelope
    | WebRtcSessionJoinEnvelope
    | WebRtcSdpOfferEnvelope
    | WebRtcSdpAnswerEnvelope
    | WebRtcIceCandidateEnvelope
    | WebRtcIceCompleteEnvelope
    | WebRtcPeerReadyEnvelope
    | WebRtcPeerDisconnectEnvelope
    | WebRtcSessionCloseEnvelope
    | WebRtcHeartbeatAckEnvelope;

  export type WebRtcOutgoingSignallingEnvelope =
    | WebRtcSessionCreatedEnvelope
    | WebRtcSessionJoinedEnvelope
    | WebRtcSdpOfferEnvelope
    | WebRtcSdpAnswerEnvelope
    | WebRtcIceCandidateEnvelope
    | WebRtcIceCompleteEnvelope
    | WebRtcPeerReadyEnvelope
    | WebRtcPeerDisconnectEnvelope
    | WebRtcSessionCloseEnvelope
    | WebRtcHeartbeatAckEnvelope
    | WebRtcSignallingErrorEnvelope;

  export type WebRtcClientLifecycleState =
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'creating-session'
    | 'joining-session'
    | 'joined'
    | 'ready'
    | 'reconnecting'
    | 'recovering-session'
    | 'leaving'
    | 'closing'
    | 'disconnected'
    | 'closed'
    | 'failed';

  export type WebRtcClientErrorCode =
    | 'gateway-unavailable'
    | 'connection-timeout'
    | 'acknowledgement-timeout'
    | 'malformed-acknowledgement'
    | 'unsupported-protocol-version'
    | 'unauthorized'
    | 'forbidden-role'
    | 'session-not-found'
    | 'session-already-exists'
    | 'duplicate-broadcaster'
    | 'duplicate-peer'
    | 'stale-session'
    | 'stale-connection-generation'
    | 'invalid-transition'
    | 'session-closed'
    | 'payload-too-large'
    | 'reconnect-failed'
    | 'cleanup-failed'
    | 'internal-client-signalling-failure';

  export interface WebRtcClientErrorDetails {
    code: WebRtcClientErrorCode;
    message: string;
    retryable: boolean;
  }

  export class WebRtcClientSignallingError extends Error {
    readonly code: WebRtcClientErrorCode;
    readonly retryable: boolean;
    constructor(code: WebRtcClientErrorCode, message: string, retryable?: boolean);
  }

  export interface WebRtcSignallingTransport {
    connected?: boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
    emit(event: string, payload: unknown): void;
  }

  export interface WebRtcSignallingClientSnapshot {
    state: WebRtcClientLifecycleState;
    role: WebRtcSignallingRole;
    broadcastId: string;
    sessionId: string | null;
    shareableSessionId: string | null;
    peerId: string;
    connectionGeneration: number;
    revision: number;
    connected: boolean;
    peers: WebRtcPeerSummary[];
    listenerCount: number;
    pendingRequestCount: number;
    lastEventType: WebRtcOutgoingSignallingEnvelope['type'] | null;
    lastError: WebRtcClientErrorDetails | null;
    mediaTransportStarted: false;
    updatedAt: string;
  }

  export interface WebRtcSignallingClientOptions {
    role: 'broadcaster' | 'listener';
    broadcastId?: string;
    sessionId?: string;
    peerId?: string;
    ackTimeoutMs?: number;
    createId?: () => string;
    now?: () => string;
    onStateChange?: (snapshot: WebRtcSignallingClientSnapshot) => void;
    onSignalEvent?: (
      event:
        | WebRtcSdpAnswerEnvelope
        | WebRtcSdpOfferEnvelope
        | WebRtcIceCandidateEnvelope
        | WebRtcIceCompleteEnvelope
        | WebRtcPeerReadyEnvelope,
    ) => void;
    onSafeLog?: (
      event: string,
      metadata: Record<string, string | number | boolean | null>,
    ) => void;
  }

  export function parseShareableWebRtcSessionId(
    input: string,
  ): { broadcastId: string; sessionId: string } | null;

  export function createShareableWebRtcSessionId(broadcastId: string, sessionId: string): string;

  export class WebRtcSignallingClient {
    constructor(options: WebRtcSignallingClientOptions);
    attach(transport: WebRtcSignallingTransport): WebRtcSignallingClientSnapshot;
    detach(): void;
    getSnapshot(): WebRtcSignallingClientSnapshot;
    setTargetSession(input: {
      broadcastId: string;
      sessionId: string;
    }): WebRtcSignallingClientSnapshot;
    createSession(requestedSessionId?: string): Promise<WebRtcSignallingClientSnapshot>;
    joinSession(input?: {
      broadcastId: string;
      sessionId: string;
    }): Promise<WebRtcSignallingClientSnapshot>;
    leaveSession(reason?: string): Promise<WebRtcSignallingClientSnapshot>;
    closeSession(reason?: string): Promise<WebRtcSignallingClientSnapshot>;
    recoverSession(): Promise<WebRtcSignallingClientSnapshot>;
    recoverSessionWithBackoff(options?: {
      maxAttempts?: number;
      initialDelayMs?: number;
    }): Promise<WebRtcSignallingClientSnapshot>;
    sendSdpOffer(input: {
      targetPeerId: string;
      sdp: string;
      revision?: number;
    }): WebRtcSdpOfferEnvelope;
    sendIceCandidate(input: {
      targetPeerId: string;
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
      usernameFragment?: string | null;
      revision?: number;
    }): WebRtcIceCandidateEnvelope;
    sendIceComplete(input: {
      targetPeerId: string;
      revision?: number;
    }): WebRtcIceCompleteEnvelope;
    sendSdpAnswer(input: {
      targetPeerId: string;
      sdp: string;
      revision?: number;
    }): WebRtcSdpAnswerEnvelope;
    sendPeerDisconnect(input: {
      targetPeerId: string;
      reason?: string;
      revision?: number;
    }): WebRtcPeerDisconnectEnvelope;
    dispose(): void;
  }
}

declare module '@videofy-live/media-contracts' {
  import type {
    MediaStateEvent,
    GeneratedAudioReadyEvent,
    TranscriptionEvent,
    TimestampedTranslationEvent,
    TranslationEvent,
    WebRtcIncomingSignallingEnvelope,
  } from '@videofy-live/shared-types';

  type SafeParseSuccess<T> = {
    success: true;
    data: T;
  };

  type SafeParseFailure = {
    success: false;
    error: {
      issues: unknown[];
    };
  };

  export function safeParseTranslationEvent(
    raw: unknown,
  ): SafeParseSuccess<TranslationEvent> | SafeParseFailure;

  export function safeParseMediaStateEvent(
    raw: unknown,
  ): SafeParseSuccess<MediaStateEvent> | SafeParseFailure;

  export function safeParseTranscriptionEvent(
    raw: unknown,
  ): SafeParseSuccess<TranscriptionEvent> | SafeParseFailure;

  export function safeParseTimestampedTranslationEvent(
    raw: unknown,
  ): SafeParseSuccess<TimestampedTranslationEvent> | SafeParseFailure;

  export function safeParseGeneratedAudioReadyEvent(
    raw: unknown,
  ): SafeParseSuccess<GeneratedAudioReadyEvent> | SafeParseFailure;

  export function safeParseWebRtcSignallingEnvelope(
    raw: unknown,
  ): SafeParseSuccess<WebRtcIncomingSignallingEnvelope> | SafeParseFailure;

  export function isUnsupportedWebRtcProtocolVersion(raw: unknown): boolean;
}
