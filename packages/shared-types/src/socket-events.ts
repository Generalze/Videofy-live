import type { SourceLanguageMode } from './language-controls.js';

/**
 * Socket.IO event name constants shared between the gateway server and all
 * clients (listener, operator, speech worker, media ingest).
 */

// Gateway → listener
export const SOCKET_EVENTS = {
  // Server → client
  TRANSLATION_EVENT: 'translation:event',
  TRANSCRIPTION_EVENT: 'transcription:event',
  TIMESTAMPED_TRANSLATION_EVENT: 'translation:timestamped',
  GENERATED_AUDIO_READY: 'audio:generated-ready',
  MEDIA_STATE: 'media:state',
  STREAM_STATUS: 'stream:status',
  TRANSLATED_AUDIO: 'audio:translated',
  SERVICE_STATUS: 'service:status',
  AUDIO_MODE_PREFERENCES: 'audio:mode-preferences',
  CONTROL_ACK: 'operator:control_ack',
  ERROR: 'error',

  // Client → server
  JOIN_LANGUAGE: 'join:language',
  LEAVE_LANGUAGE: 'leave:language',

  // Speech worker → gateway
  WORKER_TRANSLATION: 'worker:translation',
  WORKER_HEALTH: 'worker:health',
  WORKER_TRIGGER_PHRASE: 'worker:trigger_phrase',
  WORKER_RESET_SEQUENCE: 'worker:reset_sequence',

  // Media ingest → gateway
  INGEST_STATE: 'ingest:state',
  INGEST_TRANSCRIPTION: 'ingest:transcription',
  INGEST_TRANSLATION: 'ingest:translation',
  /**
   * A platform transcript event from the LIVE path.
   *
   * Its own event rather than reusing `ingest:transcription`, which is keyed by
   * `chunkId` -- an identity the live path does not have, because there are no
   * chunks. Forcing one shape to carry both would mean inventing a chunk id for
   * audio that was never a chunk, and every consumer would then have to know
   * which ids were real.
   */
  INGEST_LIVE_TRANSCRIPT: 'ingest:live-transcript',
  /**
   * One frame of translated speech, while the sentence is still being made.
   *
   * Replaces, for the live path, the pattern of announcing a URL to a finished
   * audio file. A client plays these in `sequence` order within a
   * `(segmentId, generation)` and drops any frame whose generation is older
   * than the newest it has seen -- which is how a superseded sentence stops
   * without the client needing to know why it was superseded.
   */
  TRANSLATED_AUDIO_FRAME: 'translated-audio:frame',
  INGEST_GENERATED_AUDIO: 'ingest:generated-audio',
  INGEST_HEALTH: 'ingest:health',
  INGEST_START_STREAM: 'ingest:start_stream',
  INGEST_STOP_STREAM: 'ingest:stop_stream',

  // Operator → gateway
  OPERATOR_CONTROL: 'operator:control',
  OPERATOR_AUDIO_MODE_PREFERENCES: 'operator:audio-mode-preferences',
  OPERATOR_PROGRAMME_SESSION_CONFIG: 'operator:programme-session-config',

  // WebRTC signalling (P4.0 contracts only; no media transport)
  WEBRTC_SESSION_CREATE: 'webrtc:session:create',
  WEBRTC_SESSION_JOIN: 'webrtc:session:join',
  WEBRTC_SIGNAL: 'webrtc:signal',
  WEBRTC_SESSION_LEAVE: 'webrtc:session:leave',
  WEBRTC_SESSION_CLOSE: 'webrtc:session:close',
  WEBRTC_SESSION_EVENT: 'webrtc:session:event',
  WEBRTC_ERROR: 'webrtc:error',

  // Shared
  CONNECTED: 'connect',
  DISCONNECTED: 'disconnect',
  RECONNECT: 'reconnect',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/** Room naming convention for per-language translation channels. */
export function languageRoom(targetLanguage: string): string {
  return `lang:${targetLanguage}`;
}

/** Room for operator dashboard connections. */
export const OPERATOR_ROOM = 'operators';

/** Room for media-ingest connections. */
export const INGEST_ROOM = 'ingest';

/** Room for speech-worker connections. */
export const WORKER_ROOM = 'workers';

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

/**
 * A frame of translated speech on its way to a listener.
 *
 * `pcmBase64` is little-endian PCM16 at 16 kHz mono: the engine's own format,
 * not a vendor container. Nothing here identifies which synthesiser produced
 * it, so changing synthesiser stays a configuration change rather than a
 * client release.
 */
export interface TranslatedAudioFramePayload {
  sessionId: string;
  broadcastId: string;
  segmentId: string;
  /** Which synthesis attempt. Higher supersedes lower; platform-owned. */
  generation: number;
  /** Order within (segmentId, generation). Starts at 0 and never repeats. */
  sequence: number;
  segmentStartMs: number;
  /** The last frame of this generation. Nothing further may follow it. */
  final: boolean;
  sampleRate: 16000;
  channelCount: 1;
  pcmBase64: string;
}
