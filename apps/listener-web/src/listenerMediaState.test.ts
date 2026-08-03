import type { MediaStateEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { preserveActiveProgrammeMedia } from './listenerMediaState';

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
