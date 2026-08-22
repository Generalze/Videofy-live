import { ADAPTER_ROUTE_POLICY_PATH_VARIABLE } from './adapter-route-policy.js';
import { loadRootEnv, readCsv, readPort } from './env.js';
import {
  resolveAdapterServiceAuth,
  resolveInternalIngressAuth,
  resolvePublicIngestUrl,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { logger } from './logger.js';
import { resolve } from 'node:path';

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
  mediaIngestUrl: string;
  /**
   * Where live audio streams, when the live path is cut over.
   *
   * Null keeps `call/live` and `programme/live` on the chunker route. It is a
   * URL rather than a boolean because there is nothing to turn on without one:
   * a flag saying "stream live audio" with no destination would start a
   * gateway that accepts calls and quietly transcribes none of them.
   */
  realtimeIngressUrl: string | null;
  mediaIngestPublicUrl: string;
  /**
   * The SAME resolution media-ingest performs, from the same module, so the two
   * cannot disagree about whether internal calls are authenticated. They once
   * disagreed about a URL; a disagreement about authentication is worse to
   * discover in production.
   */
  internalIngressAuth: InternalIngressAuthResolution;
  /**
   * Layer 1 for transport adapters. A SEPARATE credential from the one above:
   * different pair of processes, different trust relationship, rotated on its
   * own. See `resolveAdapterServiceAuth`.
   */
  adapterServiceAuth: InternalIngressAuthResolution;
  /**
   * Path to the adapter configuration file, or null when this deployment runs
   * no transport adapters. Its presence is what turns the adapter surface on.
   */
  adapterRoutePolicyPath: string | null;
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
  /**
   * P6.5 Videofy Connect. The secret signs single-use join tokens (min 32
   * chars — validated fail-visible where it is first used, never logged);
   * null means token mint/verify is unavailable and /v1 join-token minting
   * answers 503. The projects path names the hash-only registry file; an
   * absent file disables /v1 cleanly, a malformed one fails startup (R12).
   */
  connectAuthSecret: string | null;
  connectProjectsPath: string;
}

function readOptional(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function loadConfig(): GatewayConfig {
  loadRootEnv();
  const publicIngest = resolvePublicIngestUrl(process.env, {
    defaultPort: 3002,
    serviceName: 'realtime-gateway',
  });
  for (const warning of publicIngest.warnings) logger.warn(warning);

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
    realtimeIngressUrl: process.env['MEDIA_INGEST_REALTIME_INGRESS_URL'] ?? null,
    // Resolved through the SAME contract media-ingest uses, so the two can no
    // longer disagree about what a browser will be told. They did, and the
    // disagreement was invisible on the machine that produced it.
    mediaIngestPublicUrl: publicIngest.url,
    internalIngressAuth: resolveInternalIngressAuth(),
    adapterServiceAuth: resolveAdapterServiceAuth(),
    adapterRoutePolicyPath: readOptional(ADAPTER_ROUTE_POLICY_PATH_VARIABLE),
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
    connectAuthSecret: process.env['CONNECT_AUTH_SECRET']?.trim() || null,
    connectProjectsPath:
      process.env['CONNECT_PROJECTS_PATH']?.trim() || './connect-projects.json',
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
