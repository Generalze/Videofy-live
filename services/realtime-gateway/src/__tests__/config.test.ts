import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  resolveProgrammeIngestStreamStatus,
  shouldUseWebRtcTranscriptionForProgrammeSource,
} from '../gateway.js';

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

  it('defaults live WebRTC transcription chunks to five seconds and accepts overrides', () => {
    delete process.env['WEBRTC_TRANSCRIPTION_CHUNK_MS'];
    expect(loadConfig().webRtcTranscriptionChunkMs).toBe(5_000);

    process.env['WEBRTC_TRANSCRIPTION_CHUNK_MS'] = '3000';
    expect(loadConfig().webRtcTranscriptionChunkMs).toBe(3_000);
  });

  it('uses file-ingest transcription for uploaded programme media only', () => {
    expect(shouldUseWebRtcTranscriptionForProgrammeSource('uploaded-video')).toBe(false);
    expect(shouldUseWebRtcTranscriptionForProgrammeSource('hls')).toBe(true);
    expect(shouldUseWebRtcTranscriptionForProgrammeSource('rtmp')).toBe(true);
    expect(shouldUseWebRtcTranscriptionForProgrammeSource(undefined)).toBe(true);
  });

  it('keeps uploaded programme preprocessing from ending viewer media early', () => {
    expect(resolveProgrammeIngestStreamStatus('uploaded-video', 'completed')).toBe('processing');
    expect(resolveProgrammeIngestStreamStatus('uploaded-video', 'failed')).toBe('failed');
    expect(resolveProgrammeIngestStreamStatus('uploaded-video', 'cancelled')).toBe('cancelled');
    expect(resolveProgrammeIngestStreamStatus('rtmp', 'completed')).toBe('completed');
    expect(resolveProgrammeIngestStreamStatus(undefined, 'completed')).toBe('completed');
  });
});
