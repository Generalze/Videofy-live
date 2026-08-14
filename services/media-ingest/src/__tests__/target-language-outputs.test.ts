// Repository owner: masterzee001.
import type {
  TargetLanguageCapability,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { buildTargetLanguageCatalogue } from '../language-controls.js';
import {
  buildTargetLanguageOutputs,
  capRecentEvents,
  capRecentEventsPerLanguage,
  type TargetLanguageOutputTally,
} from '../target-language-outputs.js';

describe('target language outputs', () => {
  it('catalogues the requested partner languages without overstating availability', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['en', 'es', 'fr', 'pt'],
      supportedVoiceLanguages: ['en', 'es'],
    });

    expect(catalogue.map((item) => item.language)).toEqual([
      'en',
      'yo',
      'pt',
      'es',
      'fr',
      'zh',
      'ar',
      'ru',
      'el',
      'la',
    ]);
    expect(catalogue.find((item) => item.language === 'es')).toMatchObject({
      availability: 'voice-available',
      voiceAvailable: true,
    });
    expect(catalogue.find((item) => item.language === 'en')).toMatchObject({
      label: 'English',
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
    expect(catalogue.find((item) => item.language === 'ar')).toMatchObject({
      availability: 'experimental',
      translationAvailable: false,
    });
    expect(catalogue.find((item) => item.language === 'la')).toMatchObject({
      availability: 'experimental',
      translationAvailable: false,
    });
    expect(catalogue.find((item) => item.language === 'ru')).toMatchObject({
      label: 'Russian',
      availability: 'experimental',
      translationAvailable: false,
    });
    expect(catalogue.find((item) => item.language === 'el')).toMatchObject({
      label: 'Greek',
      availability: 'experimental',
      translationAvailable: false,
    });
  });

  it('marks Arabic and Yoruba selectable once translation support exists', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['ar', 'yo'],
      supportedVoiceLanguages: [],
    });

    // Experimental metadata must not block selection when translation works.
    expect(catalogue.find((item) => item.language === 'ar')).toMatchObject({
      availability: 'text-only',
      translationAvailable: true,
      textOnly: true,
    });
    expect(catalogue.find((item) => item.language === 'yo')).toMatchObject({
      availability: 'text-only',
      translationAvailable: true,
      textOnly: true,
    });
  });

  it('marks Russian, Greek, Chinese, and Latin selectable once translation support exists', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['ru', 'el', 'zh', 'la'],
      supportedVoiceLanguages: [],
    });

    for (const language of ['ru', 'el', 'zh', 'la']) {
      expect(catalogue.find((item) => item.language === language)).toMatchObject({
        availability: 'text-only',
        translationAvailable: true,
        textOnly: true,
      });
    }
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

  it('derives identical outputs from incremental tallies without scanning events', () => {
    const catalogue = [capability('es', true, true), capability('fr', true, false)];
    const translation = {
      status: 'translated',
      progressPct: 100,
      totalSegments: 2,
      translatedSegments: 2,
      failedSegments: 0,
      sourceLanguage: 'en',
      targetLanguage: 'es',
      targetLanguages: ['es', 'fr'],
      // Deliberately empty: the tallies must be the source of truth.
      events: [],
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
      events: [],
    } satisfies TextToSpeechSessionMetadata;

    expect(
      buildTargetLanguageOutputs({
        selectedLanguages: ['es', 'fr'],
        catalogue,
        translation,
        generatedAudio,
        tallies: {
          translation: new Map<string, TargetLanguageOutputTally>([
            ['es', tally({ totalSegments: 1, completedSegments: 1 })],
            ['fr', tally({ totalSegments: 1, completedSegments: 1 })],
          ]),
          generatedAudio: new Map<string, TargetLanguageOutputTally>([
            ['es', tally({ totalSegments: 1, completedSegments: 1 })],
          ]),
        },
      }),
    ).toEqual([
      expect.objectContaining({
        language: 'es',
        status: 'ready',
        translationProgressPct: 100,
        audioProgressPct: 100,
        captionsAvailable: true,
        audioAvailable: true,
        error: null,
      }),
      expect.objectContaining({
        language: 'fr',
        status: 'captions-ready',
        captionsAvailable: true,
        audioAvailable: false,
      }),
    ]);

    expect(
      buildTargetLanguageOutputs({
        selectedLanguages: ['es'],
        catalogue,
        translation,
        generatedAudio,
        tallies: {
          translation: new Map<string, TargetLanguageOutputTally>([
            [
              'es',
              tally({ totalSegments: 2, completedSegments: 1, failedSegments: 1, lastError: 'es went wrong' }),
            ],
          ]),
          generatedAudio: new Map<string, TargetLanguageOutputTally>(),
        },
      }),
    ).toEqual([
      expect.objectContaining({
        language: 'es',
        status: 'failed',
        translationProgressPct: 50,
        error: 'es went wrong',
      }),
    ]);
  });
});

describe('broadcast media-state event capping', () => {
  it('keeps the most recent events per language while preserving order', () => {
    const events: Array<{ targetLanguage: string; sequence: number }> = [];
    for (let sequence = 0; sequence < 10; sequence += 1) {
      events.push({ targetLanguage: 'es', sequence });
      events.push({ targetLanguage: 'fr', sequence });
    }

    const capped = capRecentEventsPerLanguage(events, 3);

    expect(
      capped.filter((event) => event.targetLanguage === 'es').map((event) => event.sequence),
    ).toEqual([7, 8, 9]);
    expect(
      capped.filter((event) => event.targetLanguage === 'fr').map((event) => event.sequence),
    ).toEqual([7, 8, 9]);
    expect(capped.map((event) => `${event.targetLanguage}${event.sequence}`)).toEqual([
      'es7',
      'fr7',
      'es8',
      'fr8',
      'es9',
      'fr9',
    ]);
  });

  it('returns arrays under the limit unchanged', () => {
    const events = [
      { targetLanguage: 'es', sequence: 0 },
      { targetLanguage: 'fr', sequence: 0 },
    ];
    expect(capRecentEventsPerLanguage(events, 200)).toEqual(events);
    expect(capRecentEvents(events, 200)).toEqual(events);
  });

  it('caps plain event arrays to the most recent entries', () => {
    expect(capRecentEvents([1, 2, 3, 4, 5], 2)).toEqual([4, 5]);
  });
});

function tally(overrides: Partial<TargetLanguageOutputTally>): TargetLanguageOutputTally {
  return {
    totalSegments: 0,
    completedSegments: 0,
    failedSegments: 0,
    activeSegments: 0,
    lastError: null,
    ...overrides,
  };
}

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
