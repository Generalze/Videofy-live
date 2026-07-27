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
    readonly CONNECTED: 'connect';
    readonly DISCONNECTED: 'disconnect';
    readonly RECONNECT: 'reconnect';
  };

  export function languageRoom(targetLanguage: string): string;

  export const OPERATOR_ROOM: 'operators';
  export const INGEST_ROOM: 'ingest';
  export const WORKER_ROOM: 'workers';
}

declare module '@videofy-live/media-contracts' {
  import type {
    MediaStateEvent,
    GeneratedAudioReadyEvent,
    TranscriptionEvent,
    TimestampedTranslationEvent,
    TranslationEvent,
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
}
