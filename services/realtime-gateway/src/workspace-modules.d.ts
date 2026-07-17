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

  export type StreamStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'ended' | 'error';

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

  export interface MediaStateEvent {
    eventId: string;
    streamStatus: StreamStatus;
    videoSource: VideoSource;
    videoTimestampMs: number;
    sourceAudioActive: boolean;
    translatedLanguages: string[];
    connectedListeners: number;
    createdAt: string;
  }

  export const SOCKET_EVENTS: {
    readonly TRANSLATION_EVENT: 'translation:event';
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
  import type { MediaStateEvent, TranslationEvent } from '@videofy-live/shared-types';

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
}
