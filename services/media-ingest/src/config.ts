import { loadRootEnv, readCsv, readPort, readPositiveInt } from './env.js';

export interface IngestConfig {
  port: number;
  gatewayUrl: string;
  eventId: string;
  videoSource: 'mock' | 'local-file';
  mockDurationMs: number;
  mockTickMs: number;
  translatedLanguages: string[];
  logLevel: string;
}

export function loadConfig(): IngestConfig {
  loadRootEnv();
  const videoSource = process.env['VIDEO_SOURCE'] ?? 'mock';
  if (videoSource !== 'mock' && videoSource !== 'local-file') {
    throw new Error(`VIDEO_SOURCE must be "mock" or "local-file"; received "${videoSource}"`);
  }

  return {
    port: readPort('INGEST_PORT', 3002),
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'http://localhost:3001',
    eventId: process.env['EVENT_ID'] ?? 'demo-event',
    videoSource,
    mockDurationMs: readPositiveInt('MOCK_VIDEO_DURATION_MS', 300_000),
    mockTickMs: readPositiveInt('MOCK_VIDEO_TICK_MS', 1000),
    translatedLanguages: readCsv('TRANSLATED_LANGUAGES', 'fr'),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  };
}
