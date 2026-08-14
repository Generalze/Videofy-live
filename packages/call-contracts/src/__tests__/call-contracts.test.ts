/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  CaptionEventSchema,
  CallSessionSchema,
  GeneratedVoiceEventSchema,
  RecipientOutputPlanSchema,
  RecipientOutputRequestSchema,
  RoutedTranslationEventSchema,
} from '../index.js';

const participant = {
  participantId: 'participant_a',
  sessionId: 'call_1',
  displayName: 'Ada',
  role: 'caller',
  sourceLanguage: 'en',
  sourceLanguageMode: 'manual',
  sourceLanguageLocked: true,
  preferredLanguage: 'es',
  captionLanguage: 'es',
  audioMode: 'translated',
  voiceMode: 'standard',
  connectionCapabilities: {
    rawAudio: true,
    video: true,
    screenShare: false,
    timestamps: true,
    codecInformation: true,
  },
  mediaRevision: 2,
  languageRevision: 3,
};

const callSession = {
  sessionId: 'call_1',
  mode: 'call',
  lifecycleState: 'active',
  participants: [participant],
  mediaPolicy: {
    mediaClock: { clockId: 'call-clock', originTimestampMs: 0, timebase: 'milliseconds' },
    sttInput: 'raw-source-only',
    generatedAudioEgress: 'generated-audio-egress-only',
    rejectStaleMediaRevision: true,
  },
  captionPolicy: {
    enabled: true,
    keepOriginalAvailable: true,
    rejectStaleLanguageRevision: true,
  },
  voicePolicy: {
    allowPersonalVoice: true,
    fallbackOrder: ['personal-voice', 'standard-tts', 'translated-text', 'original-media'],
  },
  integrationContext: {
    adapterId: 'videofy-native',
    adapterKind: 'native-sdk',
    capabilities: {
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
        inboundSynthesizedAudioInjection: true,
        perRecipientEgress: true,
        muteControl: true,
      },
      lifecycle: { reconnectHooks: true },
    },
  },
  revision: 0,
};

const caption = {
  sessionId: 'call_1',
  speakerParticipantId: 'participant_a',
  sourceRevision: 2,
  languageRevision: 3,
  sequence: 4,
  sourceLanguage: 'en',
  targetLanguage: 'es',
  originalText: 'Hello',
  translatedText: 'Hola',
  startTimestamp: 100,
  endTimestamp: 900,
  confidence: 0.99,
  isFinal: true,
};

describe('call contracts', () => {
  it('accepts session modes/lifecycle entry states and enforces feedback isolation literals', () => {
    for (const mode of ['call', 'conference', 'programme']) {
      expect(CallSessionSchema.safeParse({ ...callSession, mode }).success).toBe(true);
    }
    for (const lifecycleState of ['created', 'waiting', 'reconnecting']) {
      expect(
        CallSessionSchema.safeParse({ ...callSession, lifecycleState, participants: [] }).success,
      ).toBe(true);
    }
    expect(
      CallSessionSchema.safeParse({
        ...callSession,
        participants: [{ ...participant, sessionId: 'a-different-session' }],
      }).success,
    ).toBe(false);

    expect(
      CallSessionSchema.safeParse({
        ...callSession,
        mediaPolicy: { ...callSession.mediaPolicy, sttInput: 'mixed-audio' },
      }).success,
    ).toBe(false);
    expect(
      CallSessionSchema.safeParse({
        ...callSession,
        mediaPolicy: { ...callSession.mediaPolicy, generatedAudioEgress: 'stt-ingress' },
      }).success,
    ).toBe(false);
  });

  it('validates event revision, sequence, and media time ordering', () => {
    expect(CaptionEventSchema.safeParse(caption).success).toBe(true);
    expect(CaptionEventSchema.safeParse({ ...caption, sourceRevision: -1 }).success).toBe(false);
    expect(CaptionEventSchema.safeParse({ ...caption, languageRevision: -1 }).success).toBe(false);
    expect(CaptionEventSchema.safeParse({ ...caption, sequence: -1 }).success).toBe(false);
    expect(CaptionEventSchema.safeParse({ ...caption, endTimestamp: 100 }).success).toBe(false);

    expect(
      GeneratedVoiceEventSchema.safeParse({
        sessionId: 'call_1',
        speakerParticipantId: 'participant_a',
        mediaRevision: 2,
        languageRevision: 3,
        sourceSequence: 4,
        targetLanguage: 'es',
        voiceMode: 'standard',
        voiceId: 'es-standard-female',
        audioRef: 'https://example.test/audio.wav',
        startTimestampMs: 100,
        durationMs: 800,
        provider: 'piper',
        createdAtMs: 1_780_000_000_000,
      }).success,
    ).toBe(true);
    expect(
      GeneratedVoiceEventSchema.safeParse({
        sessionId: 'call_1',
        speakerParticipantId: 'participant_a',
        mediaRevision: 2,
        languageRevision: 3,
        sourceSequence: 4,
        targetLanguage: 'es',
        voiceMode: 'original-only',
        voiceId: 'not-generated',
        audioRef: 'https://example.test/audio.wav',
        startTimestampMs: 100,
        durationMs: 800,
        provider: 'piper',
        createdAtMs: 1_780_000_000_000,
      }).success,
    ).toBe(false);
  });

  it('keeps collision-safe routed event semantics distinct from legacy sequence naming', () => {
    const routed = {
      sessionId: 'call_1',
      participantId: 'participant_a',
      mediaRevision: 2,
      languageRevision: 3,
      sourceSequence: 4,
      targetLanguage: 'es',
      translatedText: 'Hola',
      provider: 'translation-provider',
      createdAtMs: 1_780_000_000_000,
    };

    expect(RoutedTranslationEventSchema.safeParse(routed).success).toBe(true);
    expect(RoutedTranslationEventSchema.safeParse({ ...routed, sequence: 4 }).success).toBe(false);
    expect(RoutedTranslationEventSchema.safeParse({ ...routed, sourceSequence: -1 }).success).toBe(
      false,
    );
    expect(RoutedTranslationEventSchema.safeParse({ ...routed, translatedText: '' }).success).toBe(
      false,
    );
  });

  it('allows external identifiers only inside integration metadata', () => {
    expect(
      CallSessionSchema.safeParse({ ...callSession, zoomParticipantId: 'zoom-user-1' }).success,
    ).toBe(false);
    expect(
      CallSessionSchema.safeParse({
        ...callSession,
        integrationContext: {
          ...callSession.integrationContext,
          externalIdentifiers: { remoteParticipant: 'zoom-user-1' },
        },
      }).success,
    ).toBe(true);
  });

  it('composes recipient preferences and returns egress-only recipient plans', () => {
    const request = {
      sessionId: 'call_1',
      recipientParticipantId: 'participant_b',
      speakerParticipantId: 'participant_a',
      mediaRevision: 2,
      languageRevision: 3,
      sourceSequence: 4,
      recipientPreferences: {
        language: {
          sourceLanguage: 'es',
          sourceLanguageMode: 'manual',
          sourceLanguageLocked: true,
          preferredLanguage: 'es',
          captionLanguage: 'es',
          languageRevision: 3,
        },
        caption: { enabled: true, includeOriginal: true },
        audio: { mode: 'interpretation', originalAudioLevel: 0.2, translatedAudioLevel: 1 },
        voice: { mode: 'standard', standardVoiceId: 'es-female' },
      },
    };
    expect(RecipientOutputRequestSchema.safeParse(request).success).toBe(true);
    expect(
      RecipientOutputRequestSchema.safeParse({
        ...request,
        recipientPreferences: {
          ...request.recipientPreferences,
          language: { ...request.recipientPreferences.language, languageRevision: 4 },
        },
      }).success,
    ).toBe(true);
    expect(
      RecipientOutputPlanSchema.safeParse({
        sessionId: 'call_1',
        recipientParticipantId: 'participant_b',
        speakerParticipantId: 'participant_a',
        mediaRevision: 2,
        languageRevision: 3,
        sourceSequence: 4,
        targetLanguage: 'es',
        captionLanguage: 'es',
        deliverCaption: true,
        deliverGeneratedAudio: true,
        generatedAudioEgressOnly: true,
        originalAudioTreatment: 'ducked',
        selectedVoiceMode: 'standard',
        selectedVoiceId: 'es-female',
        fallbackPath: 'standard',
      }).success,
    ).toBe(true);
  });
});
