import { describe, it, expect } from 'vitest';
import { parseMediaStateEvent, safeParseMediaStateEvent } from '../media-state-schema.js';

const validState = {
  eventId: 'demo-event',
  streamStatus: 'processing',
  videoSource: 'mock',
  videoTimestampMs: 5000,
  sourceAudioActive: true,
  translatedLanguages: ['fr'],
  connectedListeners: 1,
  createdAt: '2026-07-17T00:00:00.000Z',
};

describe('MediaStateEventSchema validation', () => {
  it('parses a valid media state event', () => {
    const result = parseMediaStateEvent(validState);
    expect(result.streamStatus).toBe('processing');
    expect(result.videoSource).toBe('mock');
  });

  it('accepts an authoritative listener WebRTC session binding', () => {
    const result = parseMediaStateEvent({
      ...validState,
      processingSessionId: 'wrs_uploaded',
      shareableWebRtcSessionId: 'broadcast_uploaded/wrs_uploaded',
    });

    expect(result.shareableWebRtcSessionId).toBe('broadcast_uploaded/wrs_uploaded');
  });

  it('accepts a session-bound uploaded programme media URL', () => {
    const result = parseMediaStateEvent({
      ...validState,
      processingSessionId: 'wrs_uploaded',
      programmeMediaUrl: 'http://localhost:3002/sessions/wrs_uploaded/source-media',
      programmeMediaMode: 'uploaded-stems',
      targetLanguageOutputs: [
        {
          language: 'es',
          status: 'ready',
          translationProgressPct: 100,
          audioProgressPct: 100,
          captionsAvailable: true,
          audioAvailable: true,
          error: null,
        },
      ],
    });

    expect(result.programmeMediaUrl).toBe('http://localhost:3002/sessions/wrs_uploaded/source-media');
    expect(result.programmeMediaMode).toBe('uploaded-stems');
    expect(result.targetLanguageOutputs?.[0]?.status).toBe('ready');
  });

  it('rejects invalid streamStatus', () => {
    const result = safeParseMediaStateEvent({ ...validState, streamStatus: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid videoSource', () => {
    const result = safeParseMediaStateEvent({ ...validState, videoSource: 'youtube' });
    expect(result.success).toBe(false);
  });

  it('rejects negative connectedListeners', () => {
    const result = safeParseMediaStateEvent({ ...validState, connectedListeners: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts all valid stream statuses', () => {
    for (const status of [
      'created',
      'validating',
      'ready',
      'processing',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]) {
      const result = safeParseMediaStateEvent({ ...validState, streamStatus: status });
      expect(result.success).toBe(true);
    }
  });

  it('accepts P2.1 local media metadata', () => {
    const result = safeParseMediaStateEvent({
      ...validState,
      streamId: 'stream_123',
      processingSessionId: 'ps_123',
      videoSource: 'local-file',
      media: {
        filename: 'clip.mp4',
        fileSizeBytes: 1024,
        mimeType: 'video/mp4',
        durationMs: 1200,
        hasAudio: true,
        hasVideo: true,
        codecs: [
          { type: 'video', codecName: 'h264' },
          { type: 'audio', codecName: 'aac' },
        ],
      },
      audioExtraction: {
        status: 'completed',
        progressPct: 100,
        chunkCount: 1,
        chunkDurationMs: 15_000,
        outputFormat: {
          container: 'wav',
          codec: 'pcm_s16le',
          sampleRateHz: 16000,
          channels: 1,
        },
        chunks: [
          {
            chunkId: 'ps_123:chunk:0',
            index: 0,
            filename: 'chunk-000000.wav',
            startMs: 0,
            endMs: 1200,
            durationMs: 1200,
            status: 'ready',
          },
        ],
      },
      transcription: {
        status: 'transcribed',
        progressPct: 100,
        totalChunks: 1,
        transcribedChunks: 1,
        failedChunks: 0,
        detectedLanguage: 'en',
        events: [
          {
            sessionId: 'ps_123',
            streamId: 'stream_123',
            chunkId: 'ps_123:chunk:0',
            sequence: 0,
            sourceText: 'hello',
            detectedLanguage: 'en',
            startMs: 0,
            endMs: 1200,
            confidence: 0.98,
            providerLatencyMs: 42,
            status: 'transcribed',
            createdAt: '2026-07-17T00:00:00.000Z',
          },
        ],
      },
      translation: {
        status: 'translated',
        providerName: 'argos',
        providerStatus: 'ready',
        progressPct: 100,
        totalSegments: 1,
        translatedSegments: 1,
        failedSegments: 0,
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        events: [
          {
            sessionId: 'ps_123',
            streamId: 'stream_123',
            segmentId: 'ps_123:chunk:0',
            sequence: 0,
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            sourceText: 'hello',
            translatedText: '[fr] hello',
            startMs: 0,
            endMs: 1200,
            status: 'translated',
            latency: {
              queuedMs: 0,
              providerMs: 2,
              totalMs: 2,
            },
            createdAt: '2026-07-17T00:00:00.000Z',
          },
        ],
      },
      monitoring: {
        currentStage: 'completed',
        overallProgressPct: 100,
        failedSegmentCount: 0,
        averageLatencyMs: 2,
        latestLatencyMs: 2,
        lastError: null,
        events: [
          {
            id: 'recovery_123',
            kind: 'operator-action',
            action: 'resume',
            status: 'accepted',
            message: 'Processing resumed by operator.',
            createdAt: '2026-07-17T00:00:00.000Z',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts P2.6 browser microphone capture metadata', () => {
    const result = safeParseMediaStateEvent({
      ...validState,
      streamId: 'stream_mic',
      processingSessionId: 'ps_mic',
      videoSource: 'microphone',
      microphoneCapture: {
        status: 'capturing',
        deviceId: 'device-1',
        deviceLabel: 'USB microphone',
        durationMs: 15_000,
        chunkCount: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
        chunks: [
          {
            chunkId: 'ps_mic:mic:0',
            index: 0,
            filename: 'mic-chunk-000000.webm',
            startMs: 0,
            endMs: 15_000,
            durationMs: 15_000,
            status: 'ready',
            receivedAt: '2026-07-17T00:00:15.000Z',
            mimeType: 'audio/webm',
            sizeBytes: 4096,
          },
        ],
      },
      monitoring: {
        currentStage: 'microphone-capture',
        overallProgressPct: 50,
        failedSegmentCount: 0,
        averageLatencyMs: null,
        latestLatencyMs: null,
        lastError: null,
        events: [],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts P4.4 WebRTC transcription bridge metadata', () => {
    const result = safeParseMediaStateEvent({
      ...validState,
      streamId: 'broadcast_demo',
      processingSessionId: 'wrs_demo',
      videoSource: 'webrtc',
      webrtcTranscriptionBridge: {
        status: 'processing',
        broadcastId: 'broadcast_demo',
        webRtcSessionId: 'wrs_demo',
        broadcasterPeerId: 'peer_broadcaster',
        revision: 1,
        chunkCount: 2,
        processingChunks: 1,
        transcribedChunks: 1,
        failedChunks: 0,
        latestTranscript: 'hello',
        lastError: null,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts P3.1 generated-audio metadata', () => {
    const result = safeParseMediaStateEvent({
      ...validState,
      streamId: 'stream_tts',
      processingSessionId: 'ps_tts',
      videoSource: 'local-file',
      monitoring: {
        currentStage: 'text-to-speech',
        overallProgressPct: 80,
        failedSegmentCount: 0,
        averageLatencyMs: 42,
        latestLatencyMs: 42,
        lastError: null,
        events: [
          {
            id: 'recovery_tts',
            kind: 'recovery-event',
            action: 'retry-tts',
            status: 'succeeded',
            message: 'Generated-audio retry succeeded.',
            segmentId: 'segment-0',
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ],
      },
      generatedAudio: {
        status: 'generated',
        providerName: 'piper',
        providerStatus: 'ready',
        progressPct: 100,
        totalSegments: 1,
        generatedSegments: 1,
        failedSegments: 0,
        targetLanguage: 'es',
        voiceId: 'es-test',
        outputFormat: {
          container: 'wav',
          codec: 'pcm_s16le',
        },
        events: [
          {
            sessionId: 'ps_tts',
            streamId: 'stream_tts',
            segmentId: 'segment-0',
            sequence: 0,
            targetLanguage: 'es',
            translatedText: 'hola',
            startMs: 0,
            endMs: 1200,
            voiceId: 'es-test',
            audioFilename: 'tts-000000.wav',
            durationMs: 1200,
            providerLatencyMs: 42,
            status: 'generated',
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});
