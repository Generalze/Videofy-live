import type {
  TargetLanguageCapability,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { buildTargetLanguageCatalogue } from '../language-controls.js';
import { buildTargetLanguageOutputs } from '../target-language-outputs.js';

describe('target language outputs', () => {
  it('catalogues the requested partner languages without overstating availability', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['es', 'fr', 'pt'],
      supportedVoiceLanguages: ['es'],
    });

    expect(catalogue.map((item) => item.language)).toEqual([
      'yo',
      'pt',
      'es',
      'fr',
      'zh',
      'la',
    ]);
    expect(catalogue.find((item) => item.language === 'es')).toMatchObject({
      availability: 'voice-available',
      voiceAvailable: true,
    });
    expect(catalogue.find((item) => item.language === 'fr')).toMatchObject({
      availability: 'text-only',
      textOnly: true,
    });
    expect(catalogue.find((item) => item.language === 'yo')).toMatchObject({
      availability: 'experimental',
      translationAvailable: false,
    });
    expect(catalogue.find((item) => item.language === 'la')).toMatchObject({
      availability: 'experimental',
      translationAvailable: false,
    });
  });

  it('reports audio-ready and caption-only channels independently', () => {
    const catalogue = [
      capability('es', true, true),
      capability('fr', true, false),
    ];
    const translation = {
      status: 'translated',
      progressPct: 100,
      totalSegments: 2,
      translatedSegments: 2,
      failedSegments: 0,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      targetLanguages: ['es', 'fr'],
      events: [translationEvent('es'), translationEvent('fr')],
    } satisfies TranslationSessionMetadata;
    const generatedAudio = {
      status: 'generated',
      progressPct: 100,
      totalSegments: 1,
      generatedSegments: 1,
      failedSegments: 0,
      targetLanguage: 'es',
      targetLanguages: ['es', 'fr'],
      voiceId: 'es-test',
      textOnlyLanguages: ['fr'],
      outputFormat: { container: 'wav', codec: 'pcm_s16le' },
      events: [generatedEvent('es')],
    } satisfies TextToSpeechSessionMetadata;

    expect(
      buildTargetLanguageOutputs({
        selectedLanguages: ['es', 'fr'],
        catalogue,
        translation,
        generatedAudio,
      }),
    ).toEqual([
      expect.objectContaining({
        language: 'es',
        status: 'ready',
        captionsAvailable: true,
        audioAvailable: true,
      }),
      expect.objectContaining({
        language: 'fr',
        status: 'captions-ready',
        captionsAvailable: true,
        audioAvailable: false,
      }),
    ]);
  });
});

function capability(
  language: string,
  translationAvailable: boolean,
  voiceAvailable: boolean,
): TargetLanguageCapability {
  return {
    language,
    label: language,
    translationAvailable,
    voiceAvailable,
    textOnly: translationAvailable && !voiceAvailable,
    experimental: false,
    availability: voiceAvailable ? 'voice-available' : 'text-only',
    translationModel: null,
    voiceId: voiceAvailable ? `${language}-test` : null,
    license: 'test',
    commercialUse: 'unknown',
  };
}

function translationEvent(targetLanguage: string): TranslationSessionMetadata['events'][number] {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: 'chunk-0',
    sequence: 0,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: 'hello',
    translatedText: `${targetLanguage}:hello`,
    startMs: 0,
    endMs: 1000,
    status: 'translated',
    latency: { queuedMs: 0, providerMs: 1, totalMs: 1 },
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}

function generatedEvent(targetLanguage: string): TextToSpeechSessionMetadata['events'][number] {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: 'chunk-0',
    sequence: 0,
    targetLanguage,
    translatedText: `${targetLanguage}:hello`,
    startMs: 0,
    endMs: 1000,
    voiceId: `${targetLanguage}-test`,
    audioFilename: 'tts-000000.wav',
    durationMs: 900,
    providerLatencyMs: 2,
    status: 'generated',
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}
