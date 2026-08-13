import type { TranscriptionEvent, TranscriptionStatus } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  buildPiperVoiceIdsByLanguage,
  buildTextToSpeechVoiceIdsByLanguage,
  buildTranslationModelIds,
  buildTranslationProvider,
  programmeTimestampMs,
  resolvePiperSupportedLanguages,
  resolveTextToSpeechLanguages,
  resolveTranslationLanguages,
  warmUpAiProviders,
  type TextToSpeechWiringConfig,
  type TranslationWiringConfig,
} from '../ingest-service.js';
import {
  CompositeTimestampedTranslationProvider,
  M2m100TimestampedTranslationProvider,
  OpusMtTimestampedTranslationProvider,
} from '../translation-provider.js';

const voices = [
  { voiceId: 'es-primary', language: 'es', modelPath: 'es.onnx', configPath: null },
  { voiceId: 'fr-primary', language: 'fr', modelPath: 'fr.onnx', configPath: null },
  { voiceId: 'es-secondary', language: 'es', modelPath: 'es2.onnx', configPath: null },
];

describe('Piper voice registry wiring', () => {
  it('maps the first configured voice per language', () => {
    expect(buildPiperVoiceIdsByLanguage(voices)).toEqual(
      new Map([
        ['es', 'es-primary'],
        ['fr', 'fr-primary'],
      ]),
    );
  });

  it('resolves supported languages to the unique set of voice languages', () => {
    expect(resolvePiperSupportedLanguages(voices)).toEqual(['es', 'fr']);
  });
});

const mmsTtsVoices = [
  { language: 'yo', modelId: 'facebook/mms-tts-yor', localPath: null },
  { language: 'es', modelId: 'facebook/mms-tts-spa', localPath: null },
];

function ttsWiringConfig(
  overrides: Partial<TextToSpeechWiringConfig> = {},
): TextToSpeechWiringConfig {
  return {
    textToSpeechProvider: 'piper+mms',
    textToSpeechSupportedLanguages: ['fr', 'es', 'yo'],
    piperVoices: voices,
    mmsTtsVoices,
    ...overrides,
  };
}

describe('text-to-speech engine wiring', () => {
  it('derives piper+mms coverage from the union of both engines', () => {
    expect(resolveTextToSpeechLanguages(ttsWiringConfig())).toEqual(['es', 'fr', 'yo']);
  });

  it('lets piper voices win shared languages while mms fills the rest', () => {
    expect(buildTextToSpeechVoiceIdsByLanguage(ttsWiringConfig())).toEqual(
      new Map([
        ['es', 'es-primary'],
        ['fr', 'fr-primary'],
        ['yo', 'facebook/mms-tts-yor'],
      ]),
    );
  });

  it('keeps plain piper coverage limited to piper voices', () => {
    const config = ttsWiringConfig({ textToSpeechProvider: 'piper' });

    expect(resolveTextToSpeechLanguages(config)).toEqual(['es', 'fr']);
    expect(buildTextToSpeechVoiceIdsByLanguage(config)).toEqual(
      new Map([
        ['es', 'es-primary'],
        ['fr', 'fr-primary'],
      ]),
    );
  });

  it('keeps mock coverage bound to the configured supported languages', () => {
    const config = ttsWiringConfig({ textToSpeechProvider: 'mock' });

    expect(resolveTextToSpeechLanguages(config)).toEqual(['fr', 'es', 'yo']);
    expect(buildTextToSpeechVoiceIdsByLanguage(config)).toEqual(
      buildPiperVoiceIdsByLanguage(voices),
    );
  });
});

function wiringConfig(overrides: Partial<TranslationWiringConfig> = {}): TranslationWiringConfig {
  return {
    translationProvider: 'opus-mt',
    translationFallbackProvider: 'none',
    translationTimeoutMs: 30_000,
    translationSupportedTargetLanguages: ['fr', 'es', 'ar', 'yo'],
    argosPythonExecutable: 'python',
    argosPackageDir: null,
    opusMtPythonExecutable: 'python',
    opusMtModelCacheDir: null,
    opusMtMaxConcurrency: 1,
    opusMtAllowModelDownload: false,
    opusMtLanguageModels: [
      {
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        modelId: 'Helsinki-NLP/opus-mt-en-fr',
        localPath: null,
      },
      {
        sourceLanguage: 'en',
        targetLanguage: 'ar',
        modelId: 'Helsinki-NLP/opus-mt-en-ar',
        localPath: null,
      },
    ],
    m2m100PythonExecutable: 'python',
    m2m100ModelId: 'facebook/m2m100_418M',
    m2m100LocalPath: null,
    m2m100ModelCacheDir: null,
    m2m100MaxConcurrency: 1,
    m2m100AllowModelDownload: false,
    nllb200PythonExecutable: 'python',
    nllb200ModelId: 'facebook/nllb-200-distilled-600M',
    nllb200LocalPath: null,
    nllb200ModelCacheDir: null,
    nllb200MaxConcurrency: 1,
    nllb200AllowModelDownload: false,
    ...overrides,
  };
}

describe('translation fallback wiring', () => {
  it('limits OPUS-MT coverage to configured language pairs without a fallback', () => {
    const config = wiringConfig();

    expect(resolveTranslationLanguages(config)).toEqual(['fr', 'ar']);
    expect(buildTranslationProvider(config)).toBeInstanceOf(OpusMtTimestampedTranslationProvider);
    expect(buildTranslationModelIds(config)).toEqual(
      new Map([
        ['fr', 'Helsinki-NLP/opus-mt-en-fr'],
        ['ar', 'Helsinki-NLP/opus-mt-en-ar'],
      ]),
    );
  });

  it('restores the full configured bound and wraps the composite with the m2m100 fallback', () => {
    const config = wiringConfig({ translationFallbackProvider: 'm2m100' });

    expect(resolveTranslationLanguages(config)).toEqual(['fr', 'es', 'ar', 'yo']);
    const provider = buildTranslationProvider(config);
    expect(provider).toBeInstanceOf(CompositeTimestampedTranslationProvider);
    expect(provider.name).toBe('opus-mt+m2m100');
    expect(buildTranslationModelIds(config)).toEqual(
      new Map([
        ['fr', 'Helsinki-NLP/opus-mt-en-fr'],
        ['ar', 'Helsinki-NLP/opus-mt-en-ar'],
        ['es', 'facebook/m2m100_418M'],
        ['yo', 'facebook/m2m100_418M'],
      ]),
    );
  });

  it('restores the full configured bound and wraps the composite with the nllb200 fallback', () => {
    const config = wiringConfig({ translationFallbackProvider: 'nllb200' });

    // Same union-of-languages semantics as the m2m100 fallback: uncovered
    // OPUS-MT pairs are served by NLLB-200 (CC-BY-NC-4.0, non-commercial).
    expect(resolveTranslationLanguages(config)).toEqual(['fr', 'es', 'ar', 'yo']);
    const provider = buildTranslationProvider(config);
    expect(provider).toBeInstanceOf(CompositeTimestampedTranslationProvider);
    expect(provider.name).toBe('opus-mt+nllb200');
    expect(buildTranslationModelIds(config)).toEqual(
      new Map([
        ['fr', 'Helsinki-NLP/opus-mt-en-fr'],
        ['ar', 'Helsinki-NLP/opus-mt-en-ar'],
        ['es', 'facebook/nllb-200-distilled-600M'],
        ['yo', 'facebook/nllb-200-distilled-600M'],
      ]),
    );
  });

  it('only applies the fallback to the opus-mt primary provider', () => {
    const config = wiringConfig({
      translationProvider: 'm2m100',
      translationFallbackProvider: 'm2m100',
    });

    expect(resolveTranslationLanguages(config)).toEqual(['fr', 'es', 'ar', 'yo']);
    expect(buildTranslationProvider(config)).toBeInstanceOf(M2m100TimestampedTranslationProvider);
    expect(buildTranslationModelIds(config)).toEqual(
      new Map([
        ['fr', 'facebook/m2m100_418M'],
        ['es', 'facebook/m2m100_418M'],
        ['ar', 'facebook/m2m100_418M'],
        ['yo', 'facebook/m2m100_418M'],
      ]),
    );
  });
});

function transcriptionEvent(
  sequence: number,
  endMs: number,
  status: TranscriptionStatus,
): TranscriptionEvent {
  return {
    sessionId: 'ps_clock',
    streamId: 'stream_clock',
    chunkId: `ps_clock:chunk:${sequence}`,
    sequence,
    sourceText: `segment ${sequence}`,
    detectedLanguage: 'en',
    startMs: Math.max(0, endMs - 5_000),
    endMs,
    confidence: 0.9,
    status,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
}

describe('programme timestamp clock', () => {
  it('reports zero before any transcription chunk is processed', () => {
    expect(programmeTimestampMs([])).toBe(0);
    expect(
      programmeTimestampMs([
        transcriptionEvent(0, 15_000, 'queued'),
        transcriptionEvent(1, 30_000, 'transcribing'),
      ]),
    ).toBe(0);
  });

  it('tracks the max endMs across processed transcription chunks', () => {
    expect(
      programmeTimestampMs([
        transcriptionEvent(0, 15_000, 'transcribed'),
        transcriptionEvent(1, 30_000, 'failed'),
        transcriptionEvent(2, 45_000, 'transcribing'),
      ]),
    ).toBe(30_000);
  });

  it('stays monotonic when events are replaced with earlier positions', () => {
    expect(programmeTimestampMs([transcriptionEvent(0, 15_000, 'transcribed')], 45_000)).toBe(
      45_000,
    );
  });
});

describe('AI provider warm-up', () => {
  it('invokes optional warm-up hooks and tolerates failures', async () => {
    const calls: string[] = [];
    await warmUpAiProviders({
      transcription: {
        warmUp: async () => {
          calls.push('transcription');
        },
      },
      translation: {
        healthCheck: async () => {
          calls.push('translation');
          throw new Error('model still downloading');
        },
      },
    });
    expect(calls).toEqual(['transcription', 'translation']);
  });

  it('is a no-op for providers without warm-up hooks', async () => {
    await expect(warmUpAiProviders({ transcription: {}, translation: {} })).resolves.toBeUndefined();
  });
});
