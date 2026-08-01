import { describe, expect, it } from 'vitest';
import type {
  MediaStateEvent,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import { createInitialProgrammeSourceSnapshot } from './programmeSourceManager';
import {
  buildOperatorProgrammeSessionConfig,
  createActiveProgrammeSessionBinding,
  createPendingProgrammeSessionBinding,
  shouldAcceptMediaStateForProgrammeBinding,
  shouldAcceptProcessingEventForProgrammeBinding,
} from './programmeSessionBinding';

function uploadedSource() {
  return {
    ...createInitialProgrammeSourceSnapshot(),
    sourceType: 'uploaded-video' as const,
    sourceIdentity: 'demo.mp4',
    status: 'broadcasting' as const,
    revision: 3,
    previewReady: true,
    broadcasting: true,
    audioDetected: true,
    videoDetected: true,
  };
}

function signalling(): WebRtcSignallingClientSnapshot {
  return {
    state: 'joined',
    role: 'broadcaster',
    broadcastId: 'broadcast_demo',
    sessionId: 'wrs_uploaded',
    shareableSessionId: 'broadcast_demo/wrs_uploaded',
    peerId: 'peer_broadcaster',
    connectionGeneration: 1,
    revision: 2,
    connected: true,
    peers: [],
    listenerCount: 0,
    pendingRequestCount: 0,
    lastEventType: 'session-created',
    lastError: null,
    mediaTransportStarted: false,
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

function mediaState(processingSessionId: string): MediaStateEvent {
  return {
    eventId: 'event_demo',
    streamId: 'broadcast_demo',
    processingSessionId,
    streamStatus: 'processing',
    videoSource: 'webrtc',
    videoTimestampMs: 0,
    sourceAudioActive: true,
    translatedLanguages: ['es'],
    connectedListeners: 1,
    createdAt: '2026-07-30T00:00:00.000Z',
  };
}

function transcription(sessionId: string): TranscriptionEvent {
  return {
    sessionId,
    streamId: 'broadcast_demo',
    chunkId: `${sessionId}:chunk:0`,
    sequence: 0,
    sourceText: 'hello',
    detectedLanguage: 'en',
    startMs: 0,
    endMs: 15_000,
    confidence: 0.9,
    status: 'transcribed',
    createdAt: '2026-07-30T00:00:00.000Z',
  };
}

function translation(sessionId: string): TimestampedTranslationEvent {
  return {
    sessionId,
    streamId: 'broadcast_demo',
    segmentId: `${sessionId}:chunk:0`,
    sequence: 0,
    sourceLanguage: 'en',
    targetLanguage: 'es',
    sourceText: 'hello',
    translatedText: 'hola',
    startMs: 0,
    endMs: 15_000,
    status: 'translated',
    latency: { queuedMs: 0, providerMs: 1, totalMs: 1 },
    createdAt: '2026-07-30T00:00:00.000Z',
  };
}

describe('programme session binding', () => {
  it('blocks stale microphone state while uploaded programme binding is pending', () => {
    const binding = createPendingProgrammeSessionBinding(uploadedSource());

    expect(shouldAcceptMediaStateForProgrammeBinding(mediaState('ps_failed_microphone'), binding)).toBe(false);
  });

  it('accepts only the active uploaded programme processing session', () => {
    const binding = createActiveProgrammeSessionBinding(signalling(), uploadedSource());

    expect(shouldAcceptMediaStateForProgrammeBinding(mediaState('wrs_uploaded'), binding)).toBe(true);
    expect(shouldAcceptMediaStateForProgrammeBinding(mediaState('ps_manual_upload'), binding)).toBe(false);
    expect(shouldAcceptProcessingEventForProgrammeBinding(transcription('wrs_uploaded'), binding)).toBe(true);
    expect(shouldAcceptProcessingEventForProgrammeBinding(translation('wrs_uploaded'), binding)).toBe(true);
    expect(shouldAcceptProcessingEventForProgrammeBinding(transcription('ps_stale'), binding)).toBe(false);
  });

  it('builds the configured language contract for the authoritative programme session', () => {
    const binding = createActiveProgrammeSessionBinding(signalling(), uploadedSource());

    expect(
      buildOperatorProgrammeSessionConfig(binding, {
        targetLanguage: 'es',
        targetLanguages: ['es'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'auto-detect',
      }),
    ).toEqual({
      sessionId: 'wrs_uploaded',
      broadcastId: 'broadcast_demo',
      sourceRevision: 3,
      programmeSourceType: 'uploaded-video',
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
    });
  });

  it('includes RTMP playback URL for gateway-side audio extraction', () => {
    const source = {
      ...uploadedSource(),
      sourceType: 'rtmp' as const,
      sourceIdentity: 'MediaMTX live/videofy-demo',
      rtmpPlaybackUrl: 'http://127.0.0.1:8888/live/videofy-demo/index.m3u8',
    };
    const binding = createActiveProgrammeSessionBinding(signalling(), source);

    expect(
      buildOperatorProgrammeSessionConfig(binding, {
        targetLanguage: 'es',
        targetLanguages: ['es'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      }),
    ).toMatchObject({
      programmeSourceType: 'rtmp',
      rtmpPlaybackUrl: 'http://127.0.0.1:8888/live/videofy-demo/index.m3u8',
    });
  });
});
