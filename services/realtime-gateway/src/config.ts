import { loadRootEnv, readCsv, readPort } from './env.js';
import { resolve } from 'node:path';

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
  mediaIngestUrl: string;
  internalWebRtcToken: string | null;
  webRtcTranscriptionChunkMs: number;
  webRtcTranscriptionStagingDir: string;
}

export function loadConfig(): GatewayConfig {
  loadRootEnv();

  return {
    port: readPort('GATEWAY_PORT', 3001),
    host: process.env['GATEWAY_HOST'] ?? 'localhost',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    corsOrigins: readCsv('CORS_ORIGINS', 'http://localhost:5173,http://localhost:5174'),
    mediaIngestUrl: process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002',
    internalWebRtcToken: process.env['INTERNAL_WEBRTC_TOKEN']?.trim() || null,
    webRtcTranscriptionChunkMs: readPositiveGatewayInt('WEBRTC_TRANSCRIPTION_CHUNK_MS', 15_000),
    webRtcTranscriptionStagingDir:
      process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ??
      resolve(process.cwd(), '../../uploads/webrtc-staging'),
  };
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
