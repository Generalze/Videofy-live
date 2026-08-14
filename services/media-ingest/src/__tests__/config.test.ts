// Repository owner: masterzee001.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const SHARED_ENV_KEYS = [
  'AI_RUNTIME_PROFILE',
  'PIPER_VOICES',
  'PIPER_VOICE_SETTINGS',
  'PIPER_VOICE_ID',
  'PIPER_VOICE_LANGUAGE',
  'PIPER_MODEL_PATH',
  'PIPER_CONFIG_PATH',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(SHARED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SHARED_ENV_KEYS) {
    delete process.env[key];
  }
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
    'fails closed before starting the unconfigured %s profile',
    (profile) => {
      process.env['AI_RUNTIME_PROFILE'] = profile;

      expect(() => loadConfig()).toThrow(
        new RegExp(`AI_RUNTIME_PROFILE=${profile} cannot start in P6-G0`),
      );
    },
  );

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
    });
  });

  it('tolerates invalid PIPER_VOICE_SETTINGS payloads and values', () => {
    process.env['PIPER_VOICES'] = 'es|es-test|C:\\models\\es.onnx';
    process.env['PIPER_VOICE_SETTINGS'] = 'not-json';
    expect(loadConfig().piperVoices[0]).toMatchObject({ sentenceSilence: 0.25 });

    process.env['PIPER_VOICE_SETTINGS'] = JSON.stringify({
      'es-test': { lengthScale: 'fast', noiseW: 0.9, sampleRateHz: -1 },
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
      /TEXT_TO_SPEECH_PROVIDER must be "mock", "piper", or "piper\+mms"/,
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
