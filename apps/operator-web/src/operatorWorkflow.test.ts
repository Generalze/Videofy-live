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
      mediaState: mediaState(),
      streamStatus: 'processing',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Live');
    expect(summary.actionableWarning).toBeNull();
  });

  it('shows completed when uploaded video reaches its natural end', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: true,
      ingestHealthy: true,
      programmeSource: source({ status: 'ended', sourceEnded: true }),
      mediaState: mediaState({ streamStatus: 'processing' }),
      streamStatus: 'processing',
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
      mediaState: mediaState({ streamStatus: 'completed' }),
      streamStatus: 'completed',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Completed');
    expect(summary.canStartInterpretation).toBe(false);
  });

  it('exposes one actionable readiness warning for disconnected services', () => {
    const summary = buildOperatorWorkflowSummary({
      connected: false,
      ingestHealthy: true,
      programmeSource: source(),
      mediaState: null,
      streamStatus: 'created',
      starting: false,
      mediaError: null,
    });

    expect(summary.status).toBe('Needs attention');
    expect(summary.actionableWarning).toContain('Realtime gateway');
    expect(summary.canStartInterpretation).toBe(false);
  });
});
