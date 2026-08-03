import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const ORIGINAL_ENV = { ...process.env };

describe('gateway config', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('trims comma-separated CORS origins', () => {
    process.env['CORS_ORIGINS'] = ' http://localhost:5173, http://localhost:5174 ';

    expect(loadConfig().corsOrigins).toEqual([
      'http://localhost:5173',
      'http://localhost:5174',
    ]);
  });

  it('rejects invalid numeric ports with a useful error', () => {
    process.env['GATEWAY_PORT'] = 'NaN';

    expect(() => loadConfig()).toThrow(/GATEWAY_PORT/);
  });

  it('defaults WebRTC transcription submit timeout for local AI providers and accepts overrides', () => {
    delete process.env['WEBRTC_TRANSCRIPTION_REQUEST_TIMEOUT_MS'];
    expect(loadConfig().webRtcTranscriptionRequestTimeoutMs).toBe(180_000);

    process.env['WEBRTC_TRANSCRIPTION_REQUEST_TIMEOUT_MS'] = '240000';
    expect(loadConfig().webRtcTranscriptionRequestTimeoutMs).toBe(240_000);
  });
});
