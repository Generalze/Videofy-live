import { loadRootEnv, readCsv, readPort } from './env.js';
import { resolve } from 'node:path';

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
  mediaIngestUrl: string;
  mediaIngestPublicUrl: string;
  internalWebRtcToken: string | null;
  webRtcTranscriptionChunkMs: number;
  webRtcTranscriptionRequestTimeoutMs: number;
  webRtcVadEnabled: boolean;
  webRtcVadMode: 'silero' | 'fallback';
  webRtcVadSpeechThreshold: number;
  webRtcVadEndSilenceMs: number;
  webRtcVadMinSpeechMs: number;
  webRtcVadMaxSegmentMs: number;
  webRtcTranscriptionStagingDir: string;
  /**
   * Interval, in ms, at which a native call emits INTERIM partial chunks while
   * a speaker is still talking, so captions can appear mid-sentence rather than
   * only after the pause that ends it. Programme sessions never emit partials.
   *
   * Set to 0 to switch streaming partial captions off without a code change —
   * useful if media-ingest is rolled back to a build that does not accept
   * partial chunks, since one would then take the final chunk's place.
   */
  webRtcPartialCaptionIntervalMs: number;
  /** Development call-session transcript log directory; disabled when null. */
  callTranscriptLogDir: string | null;
}

export function loadConfig(): GatewayConfig {
  loadRootEnv();

  return {
    port: readPort('GATEWAY_PORT', 3001),
    host: process.env['GATEWAY_HOST'] ?? 'localhost',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    // 5175 is the P6.1B call-web app; keep it in the default so native calls
    // work out of the box alongside the listener (5173) and operator (5174).
    corsOrigins: readCsv(
      'CORS_ORIGINS',
      'http://localhost:5173,http://localhost:5174,http://localhost:5175',
    ),
    mediaIngestUrl: process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002',
    // Blank counts as unset so a templated MEDIA_INGEST_PUBLIC_URL= line
    // still falls back to the internal URL.
    mediaIngestPublicUrl:
      process.env['MEDIA_INGEST_PUBLIC_URL']?.trim() ||
      process.env['MEDIA_INGEST_URL']?.trim() ||
      'http://localhost:3002',
    internalWebRtcToken: process.env['INTERNAL_WEBRTC_TOKEN']?.trim() || null,
    webRtcTranscriptionChunkMs: readPositiveGatewayInt('WEBRTC_TRANSCRIPTION_CHUNK_MS', 5_000),
    webRtcTranscriptionRequestTimeoutMs: readPositiveGatewayInt(
      'WEBRTC_TRANSCRIPTION_REQUEST_TIMEOUT_MS',
      180_000,
    ),
    webRtcVadEnabled: (process.env['WEBRTC_VAD_ENABLED'] ?? 'true').toLowerCase() === 'true',
    webRtcVadMode: process.env['WEBRTC_VAD_MODE'] === 'silero' ? 'silero' : 'fallback',
    webRtcVadSpeechThreshold: readPositiveGatewayFloat('WEBRTC_VAD_SPEECH_THRESHOLD', 0.012),
    webRtcVadEndSilenceMs: readPositiveGatewayInt('WEBRTC_VAD_END_SILENCE_MS', 700),
    webRtcVadMinSpeechMs: readPositiveGatewayInt('WEBRTC_VAD_MIN_SPEECH_MS', 150),
    webRtcVadMaxSegmentMs: readPositiveGatewayInt('WEBRTC_VAD_MAX_SEGMENT_MS', 8_000),
    webRtcTranscriptionStagingDir:
      process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ??
      resolve(process.cwd(), '../../uploads/webrtc-staging'),
    webRtcPartialCaptionIntervalMs: readNonNegativeGatewayInt(
      'WEBRTC_PARTIAL_CAPTION_INTERVAL_MS',
      1_500,
    ),
    callTranscriptLogDir: process.env['CALL_TRANSCRIPT_LOG_DIR']?.trim() || null,
  };
}

/** Like `readPositiveGatewayInt`, but 0 is a meaningful value (feature off). */
function readNonNegativeGatewayInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function readPositiveGatewayFloat(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function readPositiveGatewayInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
