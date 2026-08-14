/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { ProgrammeParticipantProjectionSchema, projectProgrammeParticipant } from '../index.js';
import type { ProgrammeParticipantProjectionInput } from '../index.js';

const input: ProgrammeParticipantProjectionInput = {
  sessionId: 'programme-session',
  participantId: 'programme-participant',
  mediaRevision: 6,
  languageRevision: 2,
  displayName: 'Morning Programme',
  media: {
    sessionId: 'programme-session',
    participantId: 'programme-participant',
    adapterId: 'live-ingest',
    mediaRevision: 6,
    audioTrack: {
      trackId: 'raw-programme-audio',
      kind: 'audio',
      signal: 'raw-audio',
      bus: 'stt-ingress',
      codec: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
    },
    timestamps: { clockId: 'programme-clock', originTimestampMs: 0, timebase: 'milliseconds' },
    capabilities: {
      rawAudio: true,
      video: false,
      screenShare: false,
      timestamps: true,
      codecInformation: true,
    },
  },
  languagePreference: {
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    sourceLanguageLocked: true,
    preferredLanguage: 'es',
    captionLanguage: 'es',
    languageRevision: 2,
  },
  captionPreference: { enabled: true },
  audioPreference: { mode: 'translated', originalAudioLevel: 0, translatedAudioLevel: 1 },
  voicePreference: { mode: 'standard', standardVoiceId: 'es-standard' },
  integrationMetadata: { externalIdentifiers: { broadcaster: 'platform-broadcaster-1' } },
};

describe('programme participant projection', () => {
  it('projects a programme to canonical participant/media without mutation', () => {
    const frozenInput = Object.freeze(
      structuredClone(input),
    ) as ProgrammeParticipantProjectionInput;
    const original = structuredClone(frozenInput);

    const projection = projectProgrammeParticipant(frozenInput);

    expect(frozenInput).toEqual(original);
    expect(projection.mode).toBe('programme');
    expect(projection.participant.role).toBe('programme');
    expect(projection.participant.sessionId).toBe(projection.media.sessionId);
    expect(projection.participant.participantId).toBe(projection.media.participantId);
    expect(projection.participant.mediaRevision).toBe(projection.media.mediaRevision);
    expect(projection.participant.languageRevision).toBe(frozenInput.languageRevision);
    expect(projection.media).toEqual(frozenInput.media);
    expect(projection.media.timestamps).toEqual(frozenInput.media.timestamps);
    expect(projection.integrationMetadata).toEqual(frozenInput.integrationMetadata);
  });

  it('rejects mismatched programme/media identity and invalid projected identity', () => {
    expect(() =>
      projectProgrammeParticipant({ ...input, media: { ...input.media, mediaRevision: 7 } }),
    ).toThrow('media.mediaRevision');
    expect(
      ProgrammeParticipantProjectionSchema.safeParse({
        ...projectProgrammeParticipant(input),
        participant: {
          ...projectProgrammeParticipant(input).participant,
          participantId: 'other-participant',
        },
      }).success,
    ).toBe(false);
  });
});
