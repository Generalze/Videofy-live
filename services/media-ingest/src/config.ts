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
  return {
    port: Number(process.env['INGEST_PORT'] ?? 3002),
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'http://localhost:3001',
    eventId: process.env['EVENT_ID'] ?? 'demo-event',
    videoSource: (process.env['VIDEO_SOURCE'] as IngestConfig['videoSource']) ?? 'mock',
    mockDurationMs: Number(process.env['MOCK_VIDEO_DURATION_MS'] ?? 300_000),
    mockTickMs: Number(process.env['MOCK_VIDEO_TICK_MS'] ?? 1000),
    translatedLanguages: (process.env['TRANSLATED_LANGUAGES'] ?? 'fr').split(','),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  };
}
