/** @author masterzee001 */
import { describe, expect, it } from 'vitest';

import {
  AdapterCapabilitiesSchema,
  GeneratedAudioEgressSchema,
  LanguagePreferenceSchema,
  ParticipantMediaSchema,
  ParticipantSchema,
  parseParticipantMedia,
} from '../index.js';

const clock = {
  clockId: 'session-clock',
  timebase: 'milliseconds' as const,
  originTimestampMs: 0,
};

const mediaCapabilities = {
  rawAudio: true,
  video: true,
  screenShare: false,
  timestamps: true,
  codecInformation: true,
};

function participantMedia() {
  return {
    sessionId: 'call-1',
    participantId: 'participant-1',
    adapterId: 'adapter-1',
    mediaRevision: 0,
    audioTrack: {
      trackId: 'microphone-1',
      kind: 'audio' as const,
      signal: 'raw-audio' as const,
      bus: 'stt-ingress' as const,
      codec: 'pcm_s16le',
      sampleRateHz: 16_000,
      channels: 1,
    },
    videoTrack: {
      trackId: 'camera-1',
      kind: 'video' as const,
      codec: 'h264',
      width: 1280,
      height: 720,
      frameRate: 30,
    },
    timestamps: clock,
    capabilities: mediaCapabilities,
  };
}

describe('participant contracts', () => {
  it('parses a programme participant without platform identity authority', () => {
    const parsed = ParticipantSchema.parse({
      participantId: 'programme-source',
      sessionId: 'programme-session',
      displayName: 'Programme',
      role: 'programme',
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      sourceLanguageLocked: true,
      preferredLanguage: 'en',
      captionLanguage: 'en',
      audioMode: 'original',
      voiceMode: 'original-only',
      connectionCapabilities: mediaCapabilities,
      mediaRevision: 0,
      languageRevision: 0,
    });

    expect(parsed.role).toBe('programme');
  });

  it('rejects invalid media and language revisions', () => {
    expect(
      ParticipantMediaSchema.safeParse({ ...participantMedia(), mediaRevision: -1 }).success,
    ).toBe(false);
    expect(
      ParticipantMediaSchema.safeParse({ ...participantMedia(), mediaRevision: 1.5 }).success,
    ).toBe(false);
    expect(
      LanguagePreferenceSchema.safeParse({
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        sourceLanguageLocked: true,
        preferredLanguage: 'es',
        captionLanguage: 'es',
        languageRevision: -1,
      }).success,
    ).toBe(false);
  });

  it('allows manual or confirmed-auto origins to be locked independently', () => {
    const preference = {
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual' as const,
      sourceLanguageLocked: false,
      preferredLanguage: 'es',
      captionLanguage: 'es',
      languageRevision: 2,
    };

    expect(LanguagePreferenceSchema.safeParse(preference).success).toBe(true);
    expect(
      LanguagePreferenceSchema.safeParse({
        ...preference,
        sourceLanguageMode: 'confirmed-auto',
        sourceLanguageLocked: true,
      }).success,
    ).toBe(true);
    expect(
      LanguagePreferenceSchema.safeParse({
        ...preference,
        sourceLanguageMode: 'auto',
        sourceLanguage: null,
        sourceLanguageLocked: true,
      }).success,
    ).toBe(false);
    expect(
      LanguagePreferenceSchema.safeParse({ ...preference, sourceLanguage: null }).success,
    ).toBe(false);
  });

  it('declares adapter ingress and egress independently', () => {
    const parsed = AdapterCapabilitiesSchema.parse({
      ingress: {
        participantSeparatedAudio: true,
        mergedAudio: false,
        video: true,
        screenShare: false,
        participantIds: true,
        timestamps: true,
        transcriptEvents: false,
        codecInformation: true,
      },
      egress: {
        inboundSynthesizedAudioInjection: false,
        perRecipientEgress: false,
        muteControl: true,
      },
      lifecycle: { reconnectHooks: true },
    });

    expect(parsed.ingress.participantSeparatedAudio).toBe(true);
    expect(parsed.egress.inboundSynthesizedAudioInjection).toBe(false);
    expect(
      AdapterCapabilitiesSchema.safeParse({ ...parsed, participantSeparatedAudio: true }).success,
    ).toBe(false);
  });

  it('keeps raw STT ingress and generated-audio egress structurally separate', () => {
    const rawMedia = participantMedia();
    const generatedEgress = {
      recipientParticipantId: 'recipient-1',
      kind: 'audio' as const,
      signal: 'generated-audio' as const,
      bus: 'recipient-egress' as const,
      audioRef: 'generated-audio-1',
      timestamps: clock,
    };

    expect(ParticipantMediaSchema.safeParse(rawMedia).success).toBe(true);
    expect(GeneratedAudioEgressSchema.safeParse(generatedEgress).success).toBe(true);
    expect(
      ParticipantMediaSchema.safeParse({
        ...rawMedia,
        audioTrack: { ...generatedEgress, trackId: 'must-not-enter-stt' },
      }).success,
    ).toBe(false);
  });

  it('does not mutate caller-owned media input while parsing', () => {
    const input = participantMedia();
    const before = structuredClone(input);

    const parsed = parseParticipantMedia(input);

    expect(input).toEqual(before);
    expect(parsed).not.toBe(input);
    expect(parsed.audioTrack).not.toBe(input.audioTrack);
  });
});
