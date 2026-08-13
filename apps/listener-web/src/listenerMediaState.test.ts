import type { MediaStateEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  preserveActiveProgrammeMedia,
  sourceEndedFromBroadcast,
  uploadedProgrammeStartGate,
  UPLOADED_PROGRAMME_AUDIO_WAIT_MS,
  type UploadedProgrammeStartGateInput,
} from './listenerMediaState';

describe('listener media-state continuity', () => {
  it('preserves uploaded programme media across partial updates for the same stream', () => {
    const previous = state({
      programmeMediaUrl: 'http://localhost/source-media',
      programmeMediaMode: 'uploaded-stems',
    });

    expect(
      preserveActiveProgrammeMedia(
        withoutMediaLocation(state()),
        previous,
      ),
    ).toMatchObject({
      programmeMediaUrl: 'http://localhost/source-media',
      programmeMediaMode: 'uploaded-stems',
    });
  });

  it('does not carry media into another stream or a failed session', () => {
    const previous = state({ programmeMediaUrl: 'http://localhost/source-media' });
    const switched = state({ streamId: 'stream_other', processingSessionId: 'ps_other' });
    const failed = state({ streamStatus: 'failed' });

    expect(preserveActiveProgrammeMedia(switched, previous).programmeMediaUrl).toBeUndefined();
    expect(preserveActiveProgrammeMedia(failed, previous).programmeMediaUrl).toBeUndefined();
  });
});

describe('source ended from broadcast', () => {
  it('completes non-uploaded programmes when the stream reports completed', () => {
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'completed',
        programmeMediaMode: 'live-webrtc',
        videoEnded: false,
      }),
    ).toBe(true);
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'processing',
        programmeMediaMode: undefined,
        videoEnded: false,
      }),
    ).toBe(false);
  });

  it('keeps the uploaded-programme end-of-video flush once the local video has ended', () => {
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'processing',
        programmeMediaMode: 'uploaded-stems',
        videoEnded: true,
      }),
    ).toBe(true);
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'completed',
        programmeMediaMode: 'uploaded-stems',
        videoEnded: true,
      }),
    ).toBe(true);
  });

  it('resets uploaded-programme source end while the local video is still playing', () => {
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'completed',
        programmeMediaMode: 'uploaded-stems',
        videoEnded: false,
      }),
    ).toBe(false);
    expect(
      sourceEndedFromBroadcast({
        streamStatus: 'processing',
        programmeMediaMode: 'uploaded-stems',
        videoEnded: false,
      }),
    ).toBe(false);
  });
});

describe('uploaded programme start gate', () => {
  it('holds initial playback while translated audio is expected but not yet delivered', () => {
    expect(uploadedProgrammeStartGate(gateInput())).toEqual({
      start: false,
      buffering: true,
    });
  });

  it('starts once the first generated-audio event for the language is enqueued', () => {
    expect(
      uploadedProgrammeStartGate(gateInput({ hasGeneratedAudioForLanguage: true })),
    ).toEqual({ start: true, buffering: false });
  });

  it('starts after the maximum wait even without generated audio', () => {
    expect(
      uploadedProgrammeStartGate(gateInput({ waitedMs: UPLOADED_PROGRAMME_AUDIO_WAIT_MS })),
    ).toEqual({ start: true, buffering: false });
    expect(
      uploadedProgrammeStartGate(
        gateInput({ waitedMs: UPLOADED_PROGRAMME_AUDIO_WAIT_MS - 1 }),
      ),
    ).toEqual({ start: false, buffering: true });
  });

  it('honours a custom maximum wait', () => {
    expect(
      uploadedProgrammeStartGate(gateInput({ waitedMs: 500, maxWaitMs: 500 })),
    ).toEqual({ start: true, buffering: false });
  });

  it('starts immediately for original and captions-only selections', () => {
    expect(
      uploadedProgrammeStartGate(gateInput({ expectsGeneratedAudio: false })),
    ).toEqual({ start: true, buffering: false });
  });

  it('never gates live programmes without uploaded media', () => {
    expect(
      uploadedProgrammeStartGate(gateInput({ hasProgrammeMedia: false })),
    ).toEqual({ start: true, buffering: false });
  });

  it('does not surface buffering before the viewer presses play', () => {
    expect(uploadedProgrammeStartGate(gateInput({ hasStarted: false }))).toEqual({
      start: false,
      buffering: false,
    });
  });
});

function gateInput(
  overrides: Partial<UploadedProgrammeStartGateInput> = {},
): UploadedProgrammeStartGateInput {
  return {
    hasStarted: true,
    hasProgrammeMedia: true,
    expectsGeneratedAudio: true,
    hasGeneratedAudioForLanguage: false,
    waitedMs: 0,
    ...overrides,
  };
}

function state(overrides: Partial<MediaStateEvent> = {}): MediaStateEvent {
  const base: MediaStateEvent = {
    eventId: 'event-test',
    streamStatus: 'processing',
    videoSource: 'local-file',
    videoTimestampMs: 1_000,
    sourceAudioActive: true,
    translatedLanguages: ['es'],
    connectedListeners: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    streamId: 'stream_test',
    processingSessionId: 'ps_test',
  };
  return Object.assign(base, overrides);
}

function withoutMediaLocation(value: MediaStateEvent): MediaStateEvent {
  const next = { ...value };
  delete next.processingSessionId;
  delete next.programmeMediaUrl;
  return next;
}
