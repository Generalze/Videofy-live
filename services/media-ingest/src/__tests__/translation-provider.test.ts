import { describe, expect, it } from 'vitest';
import {
  ArgosTimestampedTranslationProvider,
  MockTimestampedTranslationProvider,
  OpusMtTimestampedTranslationProvider,
  createTimestampedTranslationProvider,
  type CommandRunner,
} from '../translation-provider.js';

function provider(runCommand: CommandRunner): ArgosTimestampedTranslationProvider {
  return new ArgosTimestampedTranslationProvider({
    pythonExecutable: 'python',
    packageDir: null,
    supportedTargetLanguages: ['fr', 'es', 'de'],
    timeoutMs: 30_000,
    runCommand,
  });
}

function input(overrides: Partial<Parameters<ArgosTimestampedTranslationProvider['translate']>[0]> = {}) {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: 'ps_test:chunk:0',
    sequence: 0,
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    sourceText: 'hello',
    startMs: 0,
    endMs: 15_000,
    ...overrides,
  };
}

describe('translation providers', () => {
  it('keeps the mock provider available', async () => {
    const mock = createTimestampedTranslationProvider({
      providerName: 'mock',
      supportedTargetLanguages: ['fr'],
      argos: {
        pythonExecutable: 'python',
        packageDir: null,
        supportedTargetLanguages: ['fr'],
        timeoutMs: 1000,
      },
    });

    expect(mock).toBeInstanceOf(MockTimestampedTranslationProvider);
    await expect(mock.translate(input())).resolves.toEqual({ translatedText: '[fr] hello' });
  });

  it('translates successfully with local Argos', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const argos = provider(async (command, args) => {
      calls.push({ command, args });
      return { stdout: JSON.stringify({ translatedText: 'bonjour' }), stderr: '' };
    });

    await expect(argos.translate(input())).resolves.toEqual({ translatedText: 'bonjour' });
    expect(calls[0]?.command).toBe('python');
    expect(calls[0]?.args[2]).toBe('en');
    expect(calls[0]?.args[3]).toBe('fr');
    expect(calls[0]?.args[4]).toBe('hello');
  });

  it('uses each session target language from provider input', async () => {
    const targets: string[] = [];
    const argos = provider(async (_command, args) => {
      targets.push(String(args[3]));
      return { stdout: JSON.stringify({ translatedText: `${args[3]} text` }), stderr: '' };
    });

    await argos.translate(input({ targetLanguage: 'fr' }));
    await argos.translate(input({ targetLanguage: 'de' }));

    expect(targets).toEqual(['fr', 'de']);
  });

  it('preserves empty source text without invoking Python', async () => {
    const calls: string[] = [];
    const argos = provider(async (command) => {
      calls.push(command);
      return { stdout: JSON.stringify({ translatedText: 'unused' }), stderr: '' };
    });

    await expect(argos.translate(input({ sourceText: '' }))).resolves.toEqual({
      translatedText: '',
    });
    expect(calls).toEqual([]);
  });

  it('rejects unsupported languages clearly', async () => {
    const argos = provider(async () => ({ stdout: JSON.stringify({ translatedText: '' }), stderr: '' }));

    await expect(argos.translate(input({ targetLanguage: 'it' }))).rejects.toMatchObject({
      code: 'unsupported-language',
      message: 'Unsupported target language: it.',
    });
  });

  it('fails clearly when Python is unavailable', async () => {
    const argos = provider(async () => {
      const error = new Error('spawn python ENOENT') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    });

    await expect(argos.translate(input())).rejects.toMatchObject({
      code: 'translation-python-unavailable',
      message: 'Python executable not found for Argos translation.',
    });
  });

  it('fails clearly on timeout', async () => {
    const argos = provider(async () => {
      const error = new Error('Command timed out') as Error & { signal: string };
      error.signal = 'SIGTERM';
      throw error;
    });

    await expect(argos.translate(input())).rejects.toMatchObject({
      code: 'translation-timeout',
    });
  });

  it('fails clearly on provider failure', async () => {
    const argos = provider(async () => {
      throw new Error('decoder exploded');
    });

    await expect(argos.translate(input())).rejects.toMatchObject({
      code: 'translation-failed',
      message: expect.stringContaining('decoder exploded'),
    });
  });

  it('does not silently fall back to mock translation', async () => {
    const argos = new ArgosTimestampedTranslationProvider({
      pythonExecutable: 'python',
      packageDir: null,
      supportedTargetLanguages: ['fr'],
      timeoutMs: 1000,
      runCommand: async () => {
        throw new Error('argos unavailable');
      },
    });

    await expect(argos.translate(input())).rejects.toMatchObject({
      code: 'translation-failed',
    });
  });

  it('runs OPUS-MT through the existing translation provider interface without downloading models', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const opus = new OpusMtTimestampedTranslationProvider({
      pythonExecutable: 'C:/ai/python312/python.exe',
      modelCacheDir: 'C:/models/opus',
      supportedTargetLanguages: ['fr', 'es'],
      languageModels: [
        {
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          modelId: 'Helsinki-NLP/opus-mt-en-fr',
          localPath: 'C:/models/opus/en-fr',
        },
      ],
      timeoutMs: 30_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { stdout: JSON.stringify({ translatedText: 'bonjour' }), stderr: '' };
      },
    });

    await expect(opus.translate(input())).resolves.toMatchObject({
      translatedText: 'bonjour',
      providerName: 'opus-mt',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
    });
    expect(calls[0]?.command).toBe('C:/ai/python312/python.exe');
    expect(calls[0]?.args.at(-1)).toBe('0');
  });

  it('fails clearly when OPUS-MT dependencies or models are unavailable', async () => {
    const opus = new OpusMtTimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelCacheDir: null,
      supportedTargetLanguages: ['fr'],
      languageModels: [
        {
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          modelId: 'Helsinki-NLP/opus-mt-en-fr',
          localPath: null,
        },
      ],
      timeoutMs: 1000,
      maxConcurrency: 1,
      allowModelDownload: false,
      runCommand: async () => {
        const error = new Error('No module named transformers');
        throw error;
      },
    });

    await expect(opus.translate(input())).rejects.toMatchObject({
      code: 'translation-python-unavailable',
    });
  });
});
