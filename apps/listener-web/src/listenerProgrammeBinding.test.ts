import type { GeneratedAudioReadyEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  describeProgrammeVideoLabel,
  isPlaceholderShareableSessionId,
  shouldAcceptMediaStateForListener,
  shouldAcceptGeneratedAudioForSession,
  shouldExposeMediaStateProgrammeSession,
  shouldInitializeGeneratedAudioClock,
  shouldJoinProgrammeSession,
  shouldReplaceProgrammeSession,
  shouldTreatTransportAsSourceEnded,
} from './listenerProgrammeBinding';

function generated(sessionId: string): GeneratedAudioReadyEvent {
  return {
    sessionId,
    streamId: 'stream_listener',
    segmentId: `${sessionId}:segment:0`,
    sequence: 0,
    targetLanguage: 'es',
    translatedText: 'hola',
    startMs: 0,
    endMs: 15_000,
    voiceId: 'es-test',
    durationMs: 900,
    providerLatencyMs: 12,
    audioUrl: `http://localhost/${sessionId}.wav`,
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('listener programme binding', () => {
  it('rejects stale placeholder demo sessions in normal playback', () => {
    expect(isPlaceholderShareableSessionId('broadcast_demo/wrs_demo')).toBe(true);
    expect(shouldJoinProgrammeSession(null, 'broadcast_demo/wrs_demo')).toBe(false);
  });

  it('joins a new authoritative programme session once', () => {
    expect(shouldJoinProgrammeSession(null, 'broadcast_live/wrs_uploaded')).toBe(true);
    expect(shouldJoinProgrammeSession('broadcast_live/wrs_uploaded', 'broadcast_live/wrs_uploaded')).toBe(false);
  });

  it('replaces a stale authoritative programme session before joining a new one', () => {
    expect(shouldReplaceProgrammeSession('broadcast_old/wrs_old', 'broadcast_new/wrs_new')).toBe(true);
    expect(shouldReplaceProgrammeSession(null, 'broadcast_new/wrs_new')).toBe(false);
    expect(shouldReplaceProgrammeSession('broadcast_new/wrs_new', 'broadcast_new/wrs_new')).toBe(false);
    expect(shouldReplaceProgrammeSession('broadcast_old/wrs_old', 'broadcast_demo/wrs_demo')).toBe(false);
  });

  it('keeps generated audio bound to the active media session', () => {
    expect(shouldAcceptGeneratedAudioForSession(generated('wrs_uploaded'), 'wrs_uploaded')).toBe(true);
    expect(shouldAcceptGeneratedAudioForSession(generated('wrs_stale'), 'wrs_uploaded')).toBe(false);
  });

  it('does not auto-join stale terminal media state from an old session', () => {
    expect(
      shouldAcceptMediaStateForListener(
        { processingSessionId: 'wrs_old', streamStatus: 'completed' },
        null,
      ),
    ).toBe(false);
    expect(
      shouldExposeMediaStateProgrammeSession({
        shareableWebRtcSessionId: 'broadcast_old/wrs_old',
        streamStatus: 'completed',
      }),
    ).toBe(false);
  });

  it('rejects terminal media state from a different session after a live session is active', () => {
    expect(
      shouldAcceptMediaStateForListener(
        { processingSessionId: 'wrs_old', streamStatus: 'completed' },
        'wrs_live',
      ),
    ).toBe(false);
    expect(
      shouldAcceptMediaStateForListener(
        { processingSessionId: 'wrs_live', streamStatus: 'completed' },
        'wrs_live',
      ),
    ).toBe(true);
  });

  it('keeps the programme video label truthful after a received video track ends', () => {
    expect(
      describeProgrammeVideoLabel({
        remoteVideoTrackReceived: true,
        remoteAudioTrackReceived: true,
        mediaHasVideo: true,
        streamStatus: 'completed',
        transportState: 'source-ended',
        usesMockVideoFeed: false,
      }),
    ).toBe('Programme video ended');
    expect(
      describeProgrammeVideoLabel({
        remoteVideoTrackReceived: true,
        remoteAudioTrackReceived: true,
        mediaHasVideo: true,
        streamStatus: 'processing',
        transportState: 'playing',
        usesMockVideoFeed: false,
      }),
    ).toBe('Programme video');
    expect(
      describeProgrammeVideoLabel({
        remoteVideoTrackReceived: false,
        remoteAudioTrackReceived: false,
        mediaHasVideo: true,
        streamStatus: 'completed',
        transportState: 'closed',
        usesMockVideoFeed: false,
      }),
    ).toBe('Programme video ended');
  });

  it('drains generated audio when all received programme media tracks have ended', () => {
    expect(
      shouldTreatTransportAsSourceEnded({
        state: 'source-ended',
        remoteAudioTrackReceived: true,
        remoteAudioTrackActive: false,
        remoteVideoTrackReceived: true,
        remoteVideoTrackActive: false,
      }),
    ).toBe(true);
    expect(
      shouldTreatTransportAsSourceEnded({
        state: 'video-unavailable',
        remoteAudioTrackReceived: true,
        remoteAudioTrackActive: false,
        remoteVideoTrackReceived: true,
        remoteVideoTrackActive: false,
      }),
    ).toBe(true);
  });

  it('does not drain generated audio while any received programme track is still active', () => {
    expect(
      shouldTreatTransportAsSourceEnded({
        state: 'playing',
        remoteAudioTrackReceived: true,
        remoteAudioTrackActive: true,
        remoteVideoTrackReceived: true,
        remoteVideoTrackActive: false,
      }),
    ).toBe(false);
    expect(
      shouldTreatTransportAsSourceEnded({
        state: 'waiting-for-programme',
        remoteAudioTrackReceived: false,
        remoteAudioTrackActive: false,
        remoteVideoTrackReceived: false,
        remoteVideoTrackActive: false,
      }),
    ).toBe(false);
  });

  it('does not rewind an active programme clock when generated audio arrives', () => {
    expect(shouldInitializeGeneratedAudioClock('created')).toBe(true);
    expect(shouldInitializeGeneratedAudioClock('processing')).toBe(false);
    expect(shouldInitializeGeneratedAudioClock('completed')).toBe(false);
  });
});
