import { describe, expect, it } from 'vitest';
import type { MediaStateEvent } from '@videofy-live/shared-types';
import {
  createInitialProgrammeSourceSnapshot,
  type ProgrammeSourceSnapshot,
} from './programmeSourceManager';
import { buildOperatorWorkflowSummary } from './operatorWorkflow';

function source(overrides: Partial<ProgrammeSourceSnapshot> = {}): ProgrammeSourceSnapshot {
  return {
    ...createInitialProgrammeSourceSnapshot(),
    sourceType: 'uploaded-video',
    sourceIdentity: 'demo.mp4',
    status: 'preview-ready',
    previewReady: true,
    audioDetected: true,
    videoDetected: true,
    canPause: true,
    canResume: true,
    canRestart: true,
    canSeek: true,
    ...overrides,
  };
}

function mediaState(overrides: Partial<MediaStateEvent> = {}): MediaStateEvent {
  return {
    eventId: 'event_demo',
    streamId: 'broadcast_demo',
    processingSessionId: 'wrs_demo',
    streamStatus: 'processing',
    videoSource: 'webrtc',
    videoTimestampMs: 0,
    sourceAudioActive: true,
    translatedLanguages: ['es'],
    connectedListeners: 1,
    createdAt: '2026-07-31T00:00:00.000Z',
    microphoneCapture: {
      status: 'failed',
      deviceId: 'old-mic',
      deviceLabel: 'Old microphone',
      startedAt: '2026-07-31T00:00:00.000Z',
      durationMs: 0,
      chunkCount: 0,
      chunks: [],
      error: 'Old microphone failed.',
    },
    ...overrides,
  };
}

describe('operator workflow summary', () => {
  it('makes uploaded video ready after source selection only', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source(),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Ready');
    expect(summary.canStartInterpretation).toBe(true);
    expect(summary.actionableWarning).toBeNull();
  });

  it('uses the same automated start readiness for live sources', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({
        sourceType: 'camera',
        sourceIdentity: 'OBS Virtual Camera + CABLE Output',
      }),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Ready');
    expect(summary.canStartInterpretation).toBe(true);
  });

  it('ignores stale microphone failure for an active uploaded-video programme', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'broadcasting', broadcasting: true }),
      programmeMediaReady: true,
      programmeMediaError: null,
      mediaState: mediaState(),
      streamStatus: 'processing',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Live');
    expect(summary.actionableWarning).toBeNull();
  });

  it('keeps an ended uploaded video live while interpretation is finishing', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'ended', sourceEnded: true }),
      programmeMediaReady: true,
      programmeMediaError: null,
      mediaState: mediaState({ streamStatus: 'processing' }),
      streamStatus: 'processing',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Live');
    expect(summary.progressLabel).toBe('Finishing interpretation');
    expect(summary.canPause).toBe(false);
    expect(summary.canStartInterpretation).toBe(false);
    expect(summary.canEnd).toBe(true);
  });

  it('shows completed when uploaded video and interpretation are both complete', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'ended', sourceEnded: true }),
      programmeMediaReady: true,
      programmeMediaError: null,
      mediaState: mediaState({ streamStatus: 'completed' }),
      streamStatus: 'completed',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Completed');
    expect(summary.canStartInterpretation).toBe(false);
    expect(summary.canEnd).toBe(true);
  });

  it('shows completed when a direct stream URL reaches its natural end', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({
        sourceType: 'direct-url',
        sourceIdentity: 'cdn.example.com/show.mp4',
        status: 'ended',
        sourceEnded: true,
      }),
      programmeMediaReady: true,
      programmeMediaError: null,
      mediaState: mediaState({ streamStatus: 'completed' }),
      streamStatus: 'completed',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Completed');
    expect(summary.canStartInterpretation).toBe(false);
  });

  it('keeps RTMP source in starting state while the MediaMTX stream is unavailable', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({
        sourceType: 'rtmp',
        sourceIdentity: 'RTMP live/videofy-demo',
        status: 'selecting',
        previewReady: false,
        audioDetected: false,
        videoDetected: false,
        rtmpState: 'waiting-for-stream',
      }),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Starting');
    expect(summary.canStartInterpretation).toBe(false);
    expect(summary.progressLabel).toBe('Validating source');
  });

  it('starts one authoritative workflow after RTMP gateway playback is ready', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({
        sourceType: 'rtmp',
        sourceIdentity: 'MediaMTX live/videofy-demo',
        rtmpState: 'live',
        rtmpPlaybackUrl: 'http://localhost:8888/live/videofy-demo/index.m3u8',
      }),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Ready');
    expect(summary.canStartInterpretation).toBe(true);
  });

  it('exposes one actionable readiness warning for disconnected services', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: false,
      ingestHealthy: true,
      programmeSource: source(),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Needs attention');
    expect(summary.actionableWarning).toContain('Realtime gateway');
    expect(summary.canStartInterpretation).toBe(false);
  });

  it('does not report subtitle-only processing as live before programme media is ready', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'broadcasting', broadcasting: true }),
      programmeMediaReady: false,
      programmeMediaError: null,
      mediaState: mediaState({ sourceAudioActive: true }),
      streamStatus: 'processing',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Starting');
    expect(summary.progressLabel).toBe('Starting programme media');
    expect(summary.canPause).toBe(false);
  });

  it('shows one actionable media transport error instead of continuing live', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'broadcasting', broadcasting: true }),
      programmeMediaReady: false,
      programmeMediaError: 'Timed out waiting for backend programme audio and video.',
      mediaState: mediaState({ sourceAudioActive: true }),
      streamStatus: 'processing',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Needs attention');
    expect(summary.actionableWarning).toContain('backend programme audio and video');
  });
});
