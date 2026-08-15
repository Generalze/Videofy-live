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

  it('falls back listener-facing media URLs to MEDIA_INGEST_URL and accepts a public override', () => {
    // Empty string (not delete): the root .env loader only fills unset keys, so
    // this shields the test from a real MEDIA_INGEST_PUBLIC_URL in .env.
    process.env['MEDIA_INGEST_PUBLIC_URL'] = '';
    process.env['MEDIA_INGEST_URL'] = '';
    expect(loadConfig().mediaIngestPublicUrl).toBe('http://localhost:3002');

    process.env['MEDIA_INGEST_URL'] = 'http://internal-ingest:3002';
    expect(loadConfig().mediaIngestPublicUrl).toBe('http://internal-ingest:3002');

    process.env['MEDIA_INGEST_PUBLIC_URL'] = 'https://media.example.com';
    const config = loadConfig();
    expect(config.mediaIngestPublicUrl).toBe('https://media.example.com');
    expect(config.mediaIngestUrl).toBe('http://internal-ingest:3002');
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

  it('defaults live WebRTC VAD to pause-aligned segmenting and accepts overrides', () => {
    delete process.env['WEBRTC_VAD_ENABLED'];
    delete process.env['WEBRTC_VAD_MODE'];
    delete process.env['WEBRTC_VAD_END_SILENCE_MS'];
    delete process.env['WEBRTC_VAD_MAX_SEGMENT_MS'];
    const defaults = loadConfig();
    expect(defaults.webRtcVadEnabled).toBe(true);
    expect(defaults.webRtcVadMode).toBe('fallback');
    expect(defaults.webRtcVadEndSilenceMs).toBe(700);
    expect(defaults.webRtcVadMaxSegmentMs).toBe(8_000);

    process.env['WEBRTC_VAD_ENABLED'] = 'false';
    process.env['WEBRTC_VAD_MODE'] = 'silero';
    process.env['WEBRTC_VAD_END_SILENCE_MS'] = '900';
    process.env['WEBRTC_VAD_MAX_SEGMENT_MS'] = '10000';
    const overridden = loadConfig();
    expect(overridden.webRtcVadEnabled).toBe(false);
    expect(overridden.webRtcVadMode).toBe('silero');
    expect(overridden.webRtcVadEndSilenceMs).toBe(900);
    expect(overridden.webRtcVadMaxSegmentMs).toBe(10_000);
  });

  it('defaults streaming partial captions to 1.5 s and can switch them off', () => {
    delete process.env['WEBRTC_PARTIAL_CAPTION_INTERVAL_MS'];
    expect(loadConfig().webRtcPartialCaptionIntervalMs).toBe(1_500);

    process.env['WEBRTC_PARTIAL_CAPTION_INTERVAL_MS'] = '900';
    expect(loadConfig().webRtcPartialCaptionIntervalMs).toBe(900);

    // 0 is a meaningful value here (feature off), unlike the positive-only keys.
    process.env['WEBRTC_PARTIAL_CAPTION_INTERVAL_MS'] = '0';
    expect(loadConfig().webRtcPartialCaptionIntervalMs).toBe(0);

    process.env['WEBRTC_PARTIAL_CAPTION_INTERVAL_MS'] = '-1';
    expect(() => loadConfig()).toThrow(/WEBRTC_PARTIAL_CAPTION_INTERVAL_MS/);
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
