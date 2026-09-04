// Repository owner: masterzee001.
import type {
  TargetLanguageCapability,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import { describe, expect, it } from 'vitest';
import {
  buildTargetLanguageCatalogue,
  configuredCapabilityProviderIds,
} from '../language-controls.js';

/**
 * The catalogue is a DEPLOYMENT's answer, so these tests say which providers
 * the deployment has rather than inheriting whatever credentials the machine
 * running the suite happens to hold. A test that read the ambient environment
 * would pass or fail for reasons that have nothing to do with the code.
 */
const FULLY_CREDENTIALLED = [
  'deepgram',
  'elevenlabs',
  'azure',
  'google-cloud',
  'naijalingo',
  'faster-whisper',
  'opus-mt',
  'm2m100',
  'nllb-200',
  'piper',
  'mms-tts',
];

const WITHOUT_THE_SPECIALIST = FULLY_CREDENTIALLED.filter((id) => id !== 'naijalingo');
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

    // The P6.1 preview set keeps exactly the availability it had before the
    // catalogue replaced the private candidate list.
    const pinned: Record<string, TargetLanguageCapability['availability']> = {
      en: 'voice-available',
      yo: 'experimental',
      pt: 'text-only',
      es: 'voice-available',
      fr: 'text-only',
      zh: 'experimental',
      ar: 'experimental',
      ru: 'experimental',
      el: 'experimental',
      la: 'experimental',
    };
    for (const [language, availability] of Object.entries(pinned)) {
      expect(catalogue.find((item) => item.language === language), language).toMatchObject({
        availability,
      });
    }
    expect(catalogue.find((item) => item.language === 'es')).toMatchObject({
      availability: 'voice-available',
      voiceAvailable: true,
    });
    expect(catalogue.find((item) => item.language === 'en')).toMatchObject({
      label: 'English',
      nativeName: 'English',
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
    expect(catalogue.find((item) => item.language === 'la')).toMatchObject({
      label: 'Latin',
      availability: 'experimental',
      translationAvailable: false,
    });
  });

  it('lists every catalogue language, unavailable ones included, in catalogue order', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['en', 'es'],
      supportedVoiceLanguages: ['en'],
      configuredProviderIds: FULLY_CREDENTIALLED,
    });

    const catalogueCodes = LANGUAGE_CATALOGUE.map((language) => language.code);
    expect(catalogue.slice(0, catalogueCodes.length).map((item) => item.language)).toEqual(
      catalogueCodes,
    );
    expect(new Set(catalogue.map((item) => item.language)).size).toBe(catalogue.length);

    /*
     * PRESENT AND NOT SELECTABLE, which is now a smaller set than it was.
     * Welsh used to be here because the resolver's MT stage was a ten-entry
     * array; with the engines declared, Welsh is a vendor claim -- `limited`,
     * selectable, and labelled beta. Venda is the honest example: no
     * translation engine in this deployment lists it at all.
     */
    const venda = catalogue.find((item) => item.language === 've');
    expect(venda).toMatchObject({
      label: 'Venda',
      nativeName: 'Tshivenḓa',
      availability: 'unavailable',
      translationAvailable: false,
      voiceAvailable: false,
      state: 'unavailable',
      targetState: 'unavailable',
    });
    expect(venda?.reason).toMatch(/No provider/);

    const welsh = catalogue.find((item) => item.language === 'cy');
    expect(welsh).toMatchObject({ label: 'Welsh', nativeName: 'Cymraeg', state: 'limited' });

    // The resolver's evidence rides alongside the deployment's own answer.
    expect(catalogue.find((item) => item.language === 'es')).toMatchObject({
      state: 'available',
      providers: { stt: 'deepgram', mt: 'opus-mt' },
    });
    expect(catalogue.find((item) => item.language === 'de')).toMatchObject({
      state: 'limited',
      availability: 'experimental',
      translationAvailable: false,
    });

    // A language the chain can translate and cannot speak is captions-only.
    // It is a product state, and the row says so rather than reading blank.
    expect(catalogue.find((item) => item.language === 'wo')).toMatchObject({
      captionsOnly: true,
      // No voice at all, so the conservative target word is `unavailable`;
      // `captionsOnly` is what makes the row offerable and honest.
      targetState: 'unavailable',
    });
  });

  it('tells the truth about the Nigerian languages when 9jaLingo is not configured', () => {
    /*
     * THE FINDING THIS WHOLE WAVE EXISTS FOR (2026-08-26, founder-confirmed).
     * With only the general vendors credentialled, Hausa, Igbo, Yoruba and
     * Nigerian Pidgin are still SERVED -- and served wrongly, with every
     * server signal green. The row must carry the warning, because nothing
     * downstream can hear the difference.
     */
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['yo', 'ha', 'ig'],
      supportedVoiceLanguages: ['yo', 'ha', 'ig'],
      configuredProviderIds: WITHOUT_THE_SPECIALIST,
    });
    for (const language of ['ha', 'ig', 'yo']) {
      const row = catalogue.find((item) => item.language === language);
      expect(row?.degraded, language).toBe(true);
      expect(row?.providers?.tts, language).toBe('azure');
      expect(row?.reason, language).toMatch(/DEGRADED/);
      expect(row?.state, language).not.toBe('available');
    }

    const withSpecialist = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['yo'],
      supportedVoiceLanguages: ['yo'],
      configuredProviderIds: [...WITHOUT_THE_SPECIALIST, 'naijalingo'],
    });
    const yoruba = withSpecialist.find((item) => item.language === 'yo');
    expect(yoruba?.degraded).toBeUndefined();
    expect(yoruba?.providers?.tts).toBe('naijalingo');
  });

  it('reads which providers are configured from NAMES, never from values', () => {
    const ids = configuredCapabilityProviderIds({
      DEEPGRAM_API_KEY: 'anything-at-all',
      AZURE_SPEECH_KEY: 'anything-at-all',
      AZURE_SPEECH_REGION: 'northeurope',
      // Set but empty is the NORMAL state of a deployment template, and it
      // means "not configured" rather than "configured with nothing".
      NAIJALINGO_API_KEY: '   ',
    });
    expect(ids).toContain('deepgram');
    expect(ids).toContain('azure');
    expect(ids).not.toContain('naijalingo');
    expect(ids).not.toContain('elevenlabs');
    // Local engines ship in the image; a credential is the thing that is absent.
    expect(ids).toContain('opus-mt');
    expect(ids).toContain('faster-whisper');
  });

  it('keeps a language this deployment enables even when the catalogue does not list it', () => {
    const catalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: ['tlh'],
      supportedVoiceLanguages: [],
    });

    expect(catalogue.find((item) => item.language === 'tlh')).toMatchObject({
      label: 'tlh',
      availability: 'text-only',
      state: 'unavailable',
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
