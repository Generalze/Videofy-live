/** @owner masterzee001 */
import {
  RecipientOutputRequestSchema,
  type RecipientOutputRequest,
} from '@videofy-live/call-contracts';
import { describe, expect, it } from 'vitest';

import {
  resolveRecipientOutputPolicy,
  type RecipientOutputAvailability,
  type RecipientOutputPolicyInput,
} from './recipient-output-policy.js';

function input(overrides: Partial<RecipientOutputPolicyInput> = {}): RecipientOutputPolicyInput {
  return {
    sourceLanguage: 'en-US',
    request: RecipientOutputRequestSchema.parse({
      sessionId: 'call-1',
      recipientParticipantId: 'recipient-1',
      speakerParticipantId: 'speaker-1',
      mediaRevision: 2,
      languageRevision: 4,
      sourceSequence: 9,
      recipientPreferences: {
        language: {
          sourceLanguage: 'en-US',
          sourceLanguageMode: 'manual',
          sourceLanguageLocked: true,
          preferredLanguage: 'es',
          captionLanguage: 'es-MX',
          languageRevision: 4,
        },
        caption: { enabled: true, includeOriginal: false },
        audio: { mode: 'translated', originalAudioLevel: 1, translatedAudioLevel: 0.8 },
        voice: {
          mode: 'personal',
          voiceProfileId: 'profile-zoe',
          fallbackVoiceId: 'voice-es-standard',
        },
      },
    }),
    availability: {
      originalMediaAvailable: true,
      originalCaptionsAvailable: true,
      translatedTextAvailable: true,
      generatedAudioEgressAvailable: true,
      personalVoice: { available: true, voiceId: 'voice-zoe-es' },
      standardVoice: { available: true, voiceId: 'voice-es-standard' },
    },
    ...overrides,
  };
}

function withAvailability(
  source: RecipientOutputPolicyInput,
  availability: Partial<RecipientOutputAvailability>,
): RecipientOutputPolicyInput {
  return { ...source, availability: { ...source.availability, ...availability } };
}

describe('resolveRecipientOutputPolicy', () => {
  it('creates independent per-recipient plans and does not mutate either contract input', () => {
    const spanish = input();
    const french = input({
      request: RecipientOutputRequestSchema.parse({
        ...spanish.request,
        recipientParticipantId: 'recipient-2',
        recipientPreferences: {
          ...spanish.request.recipientPreferences,
          language: {
            ...spanish.request.recipientPreferences.language,
            preferredLanguage: 'fr',
            captionLanguage: 'fr',
          },
          audio: { mode: 'interpretation', originalAudioLevel: 0.2, translatedAudioLevel: 0.4 },
          voice: { mode: 'standard', standardVoiceId: 'voice-fr-standard' },
        },
      }),
      availability: {
        ...spanish.availability,
        standardVoice: { available: true, voiceId: 'voice-fr-standard' },
      },
    });
    const spanishBefore = structuredClone(spanish);
    const frenchBefore = structuredClone(french);

    const plans = [resolveRecipientOutputPolicy(spanish), resolveRecipientOutputPolicy(french)];

    expect(plans[0]).toMatchObject({
      recipientParticipantId: 'recipient-1',
      fallbackPath: 'personal',
      selectedVoiceId: 'voice-zoe-es',
      originalAudioTreatment: 'suppressed',
      generatedAudioEgressOnly: true,
      audio: {
        original: { volume: 0 },
        generated: { volume: 0.8, egressOnly: true, voice: 'personal' },
      },
    });
    expect(plans[1]).toMatchObject({
      recipientParticipantId: 'recipient-2',
      fallbackPath: 'standard',
      selectedVoiceId: 'voice-fr-standard',
      originalAudioTreatment: 'ducked',
      audio: {
        original: { volume: 0.2 },
        generated: { volume: 0.4, egressOnly: true, voice: 'standard' },
      },
    });
    expect(spanish).toEqual(spanishBefore);
    expect(french).toEqual(frenchBefore);
  });

  it('uses same-language original media and source captions when they are requested and available', () => {
    const source = input();
    const plan = resolveRecipientOutputPolicy({
      ...source,
      request: RecipientOutputRequestSchema.parse({
        ...source.request,
        recipientPreferences: {
          ...source.request.recipientPreferences,
          language: {
            ...source.request.recipientPreferences.language,
            preferredLanguage: 'EN-gb',
            captionLanguage: 'en',
          },
        },
      }),
    });

    expect(plan).toMatchObject({
      fallbackPath: 'same-language-original',
      deliverGeneratedAudio: false,
      originalAudioTreatment: 'primary',
      captions: { language: 'en-US', content: 'original' },
    });
  });

  it('does not label a same-language original path when original output is absent', () => {
    const source = input();
    const sameLanguage = {
      ...source,
      request: RecipientOutputRequestSchema.parse({
        ...source.request,
        recipientPreferences: {
          ...source.request.recipientPreferences,
          language: {
            ...source.request.recipientPreferences.language,
            preferredLanguage: 'en',
            captionLanguage: 'es',
          },
        },
      }),
    };
    const translatedCaption = resolveRecipientOutputPolicy(
      withAvailability(sameLanguage, {
        originalMediaAvailable: false,
        originalCaptionsAvailable: false,
      }),
    );
    const unavailable = resolveRecipientOutputPolicy(
      withAvailability(sameLanguage, {
        originalMediaAvailable: false,
        originalCaptionsAvailable: false,
        translatedTextAvailable: false,
      }),
    );

    expect(translatedCaption).toMatchObject({
      fallbackPath: 'translated-text',
      deliverCaption: true,
      captions: { language: 'es', content: 'translated' },
    });
    expect(unavailable).toMatchObject({
      fallbackPath: 'unavailable',
      deliverCaption: false,
      deliverGeneratedAudio: false,
      audio: { original: { enabled: false, volume: 0 } },
    });
  });

  it('uses the documented personal -> standard -> translated text -> original media degradation chain', () => {
    const source = input();
    const personal = resolveRecipientOutputPolicy(source);
    const standard = resolveRecipientOutputPolicy(
      withAvailability(source, { personalVoice: { available: false } }),
    );
    const text = resolveRecipientOutputPolicy(
      withAvailability(source, {
        personalVoice: { available: false },
        standardVoice: { available: false },
      }),
    );
    const original = resolveRecipientOutputPolicy(
      withAvailability(source, {
        personalVoice: { available: false },
        standardVoice: { available: false },
        translatedTextAvailable: false,
      }),
    );

    expect(personal.fallbackPath).toBe('personal');
    expect(standard.fallbackPath).toBe('standard');
    expect(text).toMatchObject({
      fallbackPath: 'translated-text',
      deliverGeneratedAudio: false,
      deliverCaption: true,
      originalAudioTreatment: 'primary',
    });
    expect(original).toMatchObject({
      fallbackPath: 'original-media',
      deliverGeneratedAudio: false,
      selectedVoiceMode: 'original-only',
    });
  });

  it('clamps recipient-local volumes and marks generated audio egress-only', () => {
    const source = input();
    const plan = resolveRecipientOutputPolicy({
      ...source,
      // Validated contract inputs already reject these values; retain the pure
      // boundary assertion for stale/unsafe callers that bypass validation.
      request: {
        ...source.request,
        recipientPreferences: {
          ...source.request.recipientPreferences,
          audio: {
            mode: 'interpretation',
            originalAudioLevel: Number.NaN,
            translatedAudioLevel: 9,
          },
          voice: { mode: 'standard', standardVoiceId: 'voice-es-standard' },
        },
      } as RecipientOutputRequest,
    });

    expect(plan.audio.original.volume).toBe(0.25);
    expect(plan.audio.generated).toMatchObject({ volume: 1, enabled: true, egressOnly: true });
  });

  it('selects truthful original/translated captions with fallback and never claims unavailable output', () => {
    const source = input();
    const includeOriginal = resolveRecipientOutputPolicy({
      ...source,
      request: RecipientOutputRequestSchema.parse({
        ...source.request,
        recipientPreferences: {
          ...source.request.recipientPreferences,
          caption: { enabled: true, includeOriginal: true },
        },
      }),
    });
    const translatedFallback = resolveRecipientOutputPolicy(
      withAvailability(
        {
          ...source,
          request: RecipientOutputRequestSchema.parse({
            ...source.request,
            recipientPreferences: {
              ...source.request.recipientPreferences,
              caption: { enabled: true, includeOriginal: true },
            },
          }),
        },
        { originalCaptionsAvailable: false },
      ),
    );
    const unavailable = resolveRecipientOutputPolicy(
      withAvailability(source, {
        originalMediaAvailable: false,
        originalCaptionsAvailable: false,
        translatedTextAvailable: false,
        personalVoice: { available: false },
        standardVoice: { available: false },
      }),
    );

    expect(includeOriginal.captions).toEqual({ language: 'en-US', content: 'original' });
    expect(translatedFallback.captions).toEqual({ language: 'es-MX', content: 'translated' });
    expect(unavailable).toMatchObject({
      fallbackPath: 'unavailable',
      deliverCaption: false,
      deliverGeneratedAudio: false,
    });
    expect(unavailable.audio.original).toEqual({ enabled: false, volume: 0 });
  });

  it('does not choose translated-text when captions are disabled and no voice output exists', () => {
    const source = input({
      request: RecipientOutputRequestSchema.parse({
        ...input().request,
        recipientPreferences: {
          ...input().request.recipientPreferences,
          caption: { enabled: false, includeOriginal: false },
        },
      }),
    });
    const original = resolveRecipientOutputPolicy(
      withAvailability(source, {
        personalVoice: { available: false },
        standardVoice: { available: false },
      }),
    );
    const unavailable = resolveRecipientOutputPolicy(
      withAvailability(source, {
        originalMediaAvailable: false,
        personalVoice: { available: false },
        standardVoice: { available: false },
      }),
    );

    expect(original).toMatchObject({
      fallbackPath: 'original-media',
      deliverCaption: false,
      deliverGeneratedAudio: false,
    });
    expect(unavailable).toMatchObject({
      fallbackPath: 'unavailable',
      deliverCaption: false,
      deliverGeneratedAudio: false,
    });
  });
});
