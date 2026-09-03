// Repository owner: masterzee001.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPUS_MT_LANGUAGE_MODELS,
  DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES,
  loadConfig,
} from '../config.js';

const SHARED_ENV_KEYS = [
  'AI_RUNTIME_PROFILE',
  'PIPER_VOICES',
  'PIPER_VOICE_SETTINGS',
  'PIPER_VOICE_ID',
  'PIPER_VOICE_LANGUAGE',
  'PIPER_MODEL_PATH',
  'PIPER_CONFIG_PATH',
  'TRANSCRIPTION_SOURCE_LANGUAGE',
  'FASTER_WHISPER_MODEL_SIZE',
  'TRANSLATION_TARGET_LANGUAGE',
  'TRANSLATION_SUPPORTED_TARGET_LANGUAGES',
  'TEXT_TO_SPEECH_SUPPORTED_LANGUAGES',
  'OPUS_MT_LANGUAGE_MODELS',
  'DEEPGRAM_API_KEY',
  'PROGRAMME_MEDIA_ORIGIN_INPUT',
  'PROGRAMME_SAFETY_DELAY_MS',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(SHARED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SHARED_ENV_KEYS) {
    delete process.env[key];
  }
  // Deleted CSV keys cannot be shielded with '' (readCsv throws on empty), so
  // loadRootEnv may refill them from a developer's root .env; tests that need a
  // deterministic value must set it explicitly.
  // Prevent a developer's root .env from changing the deterministic P6-G0 default.
  process.env['AI_RUNTIME_PROFILE'] = '';
});

afterEach(() => {
  for (const key of SHARED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('AI runtime profile config', () => {
  it('defaults to the locked development-demo profile', () => {
    expect(loadConfig().aiRuntimeProfile).toBe('development-demo');
  });

  it.each(['commercial-local', 'commercial-cloud', 'videofy-native'] as const)(
    'PIN: fails closed before starting the unconfigured %s profile',
    (profile) => {
      process.env['AI_RUNTIME_PROFILE'] = profile;

      expect(() => loadConfig()).toThrow(
        new RegExp(`AI_RUNTIME_PROFILE=${profile} cannot start`),
      );
    },
  );

  it('PIN: the commercial-cloud refusal names every blocked service context', () => {
    // C-AI1.1A replaced a blanket throw that said only "cannot start in P6-G0".
    // The refusal is unchanged; what changed is that the REGISTRY now decides it
    // and says which service contexts have no eligible provider, so an operator
    // is not left guessing what would fix it.
    process.env['AI_RUNTIME_PROFILE'] = 'commercial-cloud';

    let message = '';
    try {
      loadConfig();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('call:live');
    expect(message).toContain('programme:live');
    expect(message).toContain('programme:uploaded');
    expect(message).toContain('certified');
  });

  it('PIN: no credential VALUE can reach the refusal message', () => {
    // The gate reads env vars only through a presence predicate. A secret in a
    // startup error goes straight into a log aggregator.
    process.env['AI_RUNTIME_PROFILE'] = 'commercial-cloud';
    process.env['DEEPGRAM_API_KEY'] = 'sk-do-not-leak-me-0123456789';
    try {
      let message = '';
      try {
        loadConfig();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain('sk-do-not-leak-me-0123456789');
    } finally {
      delete process.env['DEEPGRAM_API_KEY'];
    }
  });

  it('rejects an unknown profile name', () => {
    process.env['AI_RUNTIME_PROFILE'] = 'commercial-mixed';

    expect(() => loadConfig()).toThrow(/Unsupported AI runtime profile/);
  });
});

describe('Piper voice registry config', () => {
  it('parses PIPER_VOICES entries with the default sentence silence', () => {
    process.env['PIPER_VOICES'] =
      'es|es_ES-sharvard-medium|C:\\models\\es.onnx|C:\\models\\es.onnx.json, FR|fr-siwis|C:\\models\\fr.onnx';

    const config = loadConfig();

    expect(config.piperVoices).toEqual([
      {
        voiceId: 'es_ES-sharvard-medium',
        language: 'es',
        modelPath: 'C:\\models\\es.onnx',
        configPath: 'C:\\models\\es.onnx.json',
        sentenceSilence: 0.25,
      },
      {
        voiceId: 'fr-siwis',
        language: 'fr',
        modelPath: 'C:\\models\\fr.onnx',
        configPath: null,
        sentenceSilence: 0.25,
      },
    ]);
  });

  it('applies PIPER_VOICE_SETTINGS overrides keyed by voiceId', () => {
    process.env['PIPER_VOICES'] =
      'es|es_ES-sharvard-medium|C:\\models\\es.onnx,fr|fr-siwis|C:\\models\\fr.onnx';
    process.env['PIPER_VOICE_SETTINGS'] = JSON.stringify({
      'fr-siwis': {
        lengthScale: 1.1,
        noiseScale: 0.5,
        noiseW: 0.9,
        sentenceSilence: 0.4,
        sampleRateHz: 22_050,
        speakerId: 0,
      },
    });

    const config = loadConfig();

    expect(config.piperVoices[0]).toEqual({
      voiceId: 'es_ES-sharvard-medium',
      language: 'es',
      modelPath: 'C:\\models\\es.onnx',
      configPath: null,
      sentenceSilence: 0.25,
    });
    expect(config.piperVoices[1]).toEqual({
      voiceId: 'fr-siwis',
      language: 'fr',
      modelPath: 'C:\\models\\fr.onnx',
      configPath: null,
      lengthScale: 1.1,
      noiseScale: 0.5,
      noiseW: 0.9,
      sentenceSilence: 0.4,
      sampleRateHz: 22_050,
      speakerId: 0,
    });
  });

  it('tolerates invalid PIPER_VOICE_SETTINGS payloads and values', () => {
    process.env['PIPER_VOICES'] = 'es|es-test|C:\\models\\es.onnx';
    process.env['PIPER_VOICE_SETTINGS'] = 'not-json';
    expect(loadConfig().piperVoices[0]).toMatchObject({ sentenceSilence: 0.25 });

    process.env['PIPER_VOICE_SETTINGS'] = JSON.stringify({
      'es-test': { lengthScale: 'fast', noiseW: 0.9, sampleRateHz: -1, speakerId: -1 },
      broken: 'nope',
    });
    expect(loadConfig().piperVoices[0]).toEqual({
      voiceId: 'es-test',
      language: 'es',
      modelPath: 'C:\\models\\es.onnx',
      configPath: null,
      noiseW: 0.9,
      sentenceSilence: 0.25,
    });
  });

  it('falls back to the legacy single-voice vars without a default sentence silence', () => {
    // Empty string (not delete): loadRootEnv only fills unset keys, so this
    // shields the test from a real PIPER_VOICES value in the developer's .env.
    process.env['PIPER_VOICES'] = '';
    process.env['PIPER_VOICE_ID'] = 'fr-default';
    process.env['PIPER_VOICE_LANGUAGE'] = 'fr';
    process.env['PIPER_MODEL_PATH'] = 'C:\\models\\legacy.onnx';
    process.env['PIPER_CONFIG_PATH'] = '';

    const config = loadConfig();

    expect(config.piperVoices).toEqual([
      {
        voiceId: 'fr-default',
        language: 'fr',
        modelPath: 'C:\\models\\legacy.onnx',
        configPath: null,
      },
    ]);
  });

  it('rejects malformed PIPER_VOICES entries', () => {
    process.env['PIPER_VOICES'] = 'es|missing-model-path';

    expect(() => loadConfig()).toThrow(
      /PIPER_VOICES entries must use language\|voiceId\|modelPath/,
    );
  });
});

describe('English and Spanish runtime prerequisites', () => {
  it('pins the P6.1A defaults so a revert cannot silently drop them', () => {
    expect(DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES.split(',')).toContain('en');
    expect(DEFAULT_OPUS_MT_LANGUAGE_MODELS).toContain('es:en:Helsinki-NLP/opus-mt-es-en');
    // English–French is the constant development pair; both directions stay pinned.
    expect(DEFAULT_OPUS_MT_LANGUAGE_MODELS).toContain('en:fr:Helsinki-NLP/opus-mt-en-fr');
    expect(DEFAULT_OPUS_MT_LANGUAGE_MODELS).toContain('fr:en:Helsinki-NLP/opus-mt-fr-en');
  });

  it('supports the multilingual small opt-in, English target, and explicit ES-to-EN OPUS-MT', () => {
    process.env['TRANSCRIPTION_SOURCE_LANGUAGE'] = 'en';
    process.env['FASTER_WHISPER_MODEL_SIZE'] = 'small';
    process.env['TRANSLATION_TARGET_LANGUAGE'] = 'fr';
    process.env['TRANSLATION_SUPPORTED_TARGET_LANGUAGES'] = 'fr,es,de,pt,it,ja,zh,ar,yo,en';
    process.env['TEXT_TO_SPEECH_SUPPORTED_LANGUAGES'] = 'fr,es,de,pt,it,ja,zh,ar,yo,en';
    process.env['OPUS_MT_LANGUAGE_MODELS'] =
      'en:fr:Helsinki-NLP/opus-mt-en-fr,en:es:Helsinki-NLP/opus-mt-en-es,en:pt:Helsinki-NLP/opus-mt-en-ROMANCE,es:en:Helsinki-NLP/opus-mt-es-en';
    const config = loadConfig();

    expect(config.transcriptionSourceLanguage).toBe('en');
    expect(config.fasterWhisperModelSize).toBe('small');
    expect(config.translationTargetLanguage).toBe('fr');
    expect(config.translationSupportedTargetLanguages).toContain('en');
    expect(config.textToSpeechSupportedLanguages).toContain('en');
    expect(config.opusMtLanguageModels).toContainEqual({
      sourceLanguage: 'es',
      targetLanguage: 'en',
      modelId: 'Helsinki-NLP/opus-mt-es-en',
      localPath: null,
    });
  });
});

describe('MMS text-to-speech config', () => {
  const MMS_ENV_KEYS = [
    'MMS_TTS_VOICES',
    'MMS_TTS_PYTHON',
    'MMS_TTS_MODEL_CACHE_DIR',
    'MMS_TTS_ALLOW_MODEL_DOWNLOAD',
    'TEXT_TO_SPEECH_PROVIDER',
    'AI_PYTHON_EXECUTABLE',
  ] as const;

  let savedMmsEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedMmsEnv = Object.fromEntries(MMS_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of MMS_ENV_KEYS) {
      // Empty string (not delete): loadRootEnv only fills unset keys, so this
      // shields the tests from real values in the developer's .env.
      process.env[key] = '';
    }
  });

  afterEach(() => {
    for (const key of MMS_ENV_KEYS) {
      const value = savedMmsEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults to the Yoruba MMS voice with local-only models', () => {
    const config = loadConfig();

    // facebook/mms-tts-yor is licensed CC-BY-NC-4.0 (non-commercial use only).
    expect(config.mmsTtsVoices).toEqual([
      { language: 'yo', modelId: 'facebook/mms-tts-yor', localPath: null },
    ]);
    expect(config.mmsTtsPythonExecutable).toBe('python');
    expect(config.mmsTtsModelCacheDir).toBeNull();
    expect(config.mmsTtsAllowModelDownload).toBe(false);
  });

  it('parses MMS_TTS_VOICES entries with optional forward-slash local paths', () => {
    process.env['MMS_TTS_VOICES'] =
      'yo|facebook/mms-tts-yor|C:/models/mms/yor, HA|facebook/mms-tts-hau';

    expect(loadConfig().mmsTtsVoices).toEqual([
      { language: 'yo', modelId: 'facebook/mms-tts-yor', localPath: 'C:/models/mms/yor' },
      { language: 'ha', modelId: 'facebook/mms-tts-hau', localPath: null },
    ]);
  });

  it('rejects malformed MMS_TTS_VOICES entries', () => {
    process.env['MMS_TTS_VOICES'] = 'yo';

    expect(() => loadConfig()).toThrow(
      /MMS_TTS_VOICES entries must use language\|modelId\[\|localPath\]/,
    );
  });

  it('falls back to AI_PYTHON_EXECUTABLE like m2m100 when MMS_TTS_PYTHON is unset', () => {
    process.env['AI_PYTHON_EXECUTABLE'] = 'C:/ai/python312/python.exe';
    expect(loadConfig().mmsTtsPythonExecutable).toBe('C:/ai/python312/python.exe');

    process.env['MMS_TTS_PYTHON'] = 'C:/mms/python.exe';
    expect(loadConfig().mmsTtsPythonExecutable).toBe('C:/mms/python.exe');
  });

  it('parses the model cache dir and download opt-in', () => {
    process.env['MMS_TTS_MODEL_CACHE_DIR'] = 'C:/models/mms-cache';
    process.env['MMS_TTS_ALLOW_MODEL_DOWNLOAD'] = 'TRUE';

    const config = loadConfig();

    expect(config.mmsTtsModelCacheDir).toBe('C:/models/mms-cache');
    expect(config.mmsTtsAllowModelDownload).toBe(true);
  });

  it('accepts the composite piper+mms text-to-speech provider', () => {
    process.env['TEXT_TO_SPEECH_PROVIDER'] = 'piper+mms';

    expect(loadConfig().textToSpeechProvider).toBe('piper+mms');
  });

  it('rejects unknown text-to-speech providers', () => {
    process.env['TEXT_TO_SPEECH_PROVIDER'] = 'espeak';

    expect(() => loadConfig()).toThrow(
      /TEXT_TO_SPEECH_PROVIDER must be "mock", "piper", "piper\+mms" or "streaming"/,
    );
  });
});

describe('translation fallback provider config', () => {
  const FALLBACK_KEY = 'TRANSLATION_FALLBACK_PROVIDER';
  let savedFallback: string | undefined;

  beforeEach(() => {
    savedFallback = process.env[FALLBACK_KEY];
  });

  afterEach(() => {
    if (savedFallback === undefined) {
      delete process.env[FALLBACK_KEY];
    } else {
      process.env[FALLBACK_KEY] = savedFallback;
    }
  });

  it('defaults to none', () => {
    // Empty string (not delete): loadRootEnv only fills unset keys, so this
    // shields the test from a real fallback value in the developer's .env.
    process.env[FALLBACK_KEY] = '';

    expect(loadConfig().translationFallbackProvider).toBe('none');
  });

  it('accepts the m2m100 fallback provider', () => {
    process.env[FALLBACK_KEY] = 'm2m100';

    expect(loadConfig().translationFallbackProvider).toBe('m2m100');
  });

  it('accepts the nllb200 fallback provider', () => {
    process.env[FALLBACK_KEY] = 'nllb200';

    expect(loadConfig().translationFallbackProvider).toBe('nllb200');
  });

  it('rejects unknown fallback providers', () => {
    process.env[FALLBACK_KEY] = 'argos';

    expect(() => loadConfig()).toThrow(
      /TRANSLATION_FALLBACK_PROVIDER must be "none", "m2m100", or "nllb200"/,
    );
  });
});

describe('NLLB-200 fallback model config', () => {
  const NLLB_STRING_ENV_KEYS = [
    'NLLB200_PYTHON',
    'NLLB200_MODEL_ID',
    'NLLB200_LOCAL_PATH',
    'NLLB200_MODEL_CACHE_DIR',
    'NLLB200_ALLOW_MODEL_DOWNLOAD',
    'AI_PYTHON_EXECUTABLE',
  ] as const;
  const NLLB_INT_ENV_KEY = 'NLLB200_MAX_CONCURRENCY';

  let savedNllbEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedNllbEnv = Object.fromEntries(
      [...NLLB_STRING_ENV_KEYS, NLLB_INT_ENV_KEY].map((key) => [key, process.env[key]]),
    );
    for (const key of NLLB_STRING_ENV_KEYS) {
      // Empty string (not delete): loadRootEnv only fills unset keys, so this
      // shields the tests from real values in the developer's .env.
      process.env[key] = '';
    }
    // Empty string would fail integer parsing, so the concurrency key is removed.
    delete process.env[NLLB_INT_ENV_KEY];
  });

  afterEach(() => {
    for (const key of [...NLLB_STRING_ENV_KEYS, NLLB_INT_ENV_KEY]) {
      const value = savedNllbEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults to the distilled 600M model with local-only loading', () => {
    const config = loadConfig();

    // facebook/nllb-200-distilled-600M is licensed CC-BY-NC-4.0
    // (non-commercial use only); validate before partner use.
    expect(config.nllb200ModelId).toBe('facebook/nllb-200-distilled-600M');
    expect(config.nllb200PythonExecutable).toBe('python');
    expect(config.nllb200LocalPath).toBeNull();
    expect(config.nllb200ModelCacheDir).toBeNull();
    expect(config.nllb200MaxConcurrency).toBe(1);
    expect(config.nllb200AllowModelDownload).toBe(false);
  });

  it('parses the NLLB-200 model, cache, and concurrency overrides', () => {
    process.env['NLLB200_MODEL_ID'] = 'facebook/nllb-200-1.3B';
    process.env['NLLB200_LOCAL_PATH'] = 'C:/models/nllb-200';
    process.env['NLLB200_MODEL_CACHE_DIR'] = 'C:/models/nllb-cache';
    process.env['NLLB200_MAX_CONCURRENCY'] = '2';
    process.env['NLLB200_ALLOW_MODEL_DOWNLOAD'] = 'TRUE';

    const config = loadConfig();

    expect(config.nllb200ModelId).toBe('facebook/nllb-200-1.3B');
    expect(config.nllb200LocalPath).toBe('C:/models/nllb-200');
    expect(config.nllb200ModelCacheDir).toBe('C:/models/nllb-cache');
    expect(config.nllb200MaxConcurrency).toBe(2);
    expect(config.nllb200AllowModelDownload).toBe(true);
  });

  it('falls back to AI_PYTHON_EXECUTABLE like m2m100 when NLLB200_PYTHON is unset', () => {
    process.env['AI_PYTHON_EXECUTABLE'] = 'C:/ai/python312/python.exe';
    expect(loadConfig().nllb200PythonExecutable).toBe('C:/ai/python312/python.exe');

    process.env['NLLB200_PYTHON'] = 'C:/nllb/python.exe';
    expect(loadConfig().nllb200PythonExecutable).toBe('C:/nllb/python.exe');
  });
});

/*
 * The two settings that decide whether a programme is protected, and whether
 * anybody can be shown one. Both default to the safe answer, and both refuse
 * a value that would produce a broadcast nobody could trust.
 */
describe('programme media production and the safety delay', () => {
  it('produces no media and holds nothing, by default', () => {
    const config = loadConfig();
    expect(config.programmeMediaOriginInput).toBeNull();
    // True live is the default and is a choice, not an omission.
    expect(config.programmeSafetyDelayMs).toBe(0);
  });

  it('takes a source template that names the run', () => {
    process.env['PROGRAMME_MEDIA_ORIGIN_INPUT'] = 'rtmp://127.0.0.1/live/{runId}';
    expect(loadConfig().programmeMediaOriginInput).toBe('rtmp://127.0.0.1/live/{runId}');
  });

  it('refuses a template that does not name the run', () => {
    /*
     * One source shared by every broadcast on the host means two programmes
     * carrying each other's pictures -- and it would look like a working
     * deployment until somebody watched the wrong channel.
     */
    process.env['PROGRAMME_MEDIA_ORIGIN_INPUT'] = 'rtmp://127.0.0.1/live/stream';
    expect(loadConfig().programmeMediaOriginInput).toBeNull();
  });

  it('accepts a delay of zero rather than treating it as unset', () => {
    process.env['PROGRAMME_SAFETY_DELAY_MS'] = '0';
    // Routed through a positive-integer reader, this would be a startup crash
    // on a perfectly valid configuration.
    expect(loadConfig().programmeSafetyDelayMs).toBe(0);
  });

  it('takes a configured delay', () => {
    process.env['PROGRAMME_SAFETY_DELAY_MS'] = '45000';
    expect(loadConfig().programmeSafetyDelayMs).toBe(45_000);
  });

  it('refuses a delay that is not a whole number of milliseconds', () => {
    process.env['PROGRAMME_SAFETY_DELAY_MS'] = 'about a minute';
    expect(() => loadConfig()).toThrow(/PROGRAMME_SAFETY_DELAY_MS/u);
  });

  it('refuses a negative delay', () => {
    process.env['PROGRAMME_SAFETY_DELAY_MS'] = '-1000';
    expect(() => loadConfig()).toThrow(/PROGRAMME_SAFETY_DELAY_MS/u);
  });
});
