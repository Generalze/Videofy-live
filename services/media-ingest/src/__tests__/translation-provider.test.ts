// Repository owner: masterzee001.
import { describe, expect, it } from 'vitest';
import {
  PersistentPythonWorker,
  PythonWorkerError,
  type PythonWorkerConfig,
  type PythonWorkerFactory,
  type WorkerChildProcessLike,
} from '../persistent-python-worker.js';
import { MediaIngestError } from '../ingest-error.js';
import {
  ArgosTimestampedTranslationProvider,
  CompositeTimestampedTranslationProvider,
  MockTimestampedTranslationProvider,
  M2m100TimestampedTranslationProvider,
  NLLB_LANGUAGE_CODES,
  Nllb200TimestampedTranslationProvider,
  OpusMtTimestampedTranslationProvider,
  createTimestampedTranslationProvider,
  type CommandRunner,
  type Nllb200ProviderOptions,
  type TimestampedTranslationProvider,
  type TranslationProviderInput,
} from '../translation-provider.js';

type WorkerHandler = (
  payload: Record<string, unknown>,
  config: PythonWorkerConfig,
) => Promise<unknown> | unknown;

function fakeWorkerFactory(handler: WorkerHandler) {
  const configs: PythonWorkerConfig[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const factory: PythonWorkerFactory = (config) => {
    configs.push(config);
    return {
      async request(payload) {
        const record = payload as Record<string, unknown>;
        requests.push(record);
        return await handler(record, config);
      },
      dispose() {},
    };
  };
  return { factory, configs, requests };
}

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

  it('runs OPUS-MT through one persistent worker without downloading models', async () => {
    const { factory, configs, requests } = fakeWorkerFactory(() => ({
      translatedText: 'bonjour',
    }));
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
      createWorker: factory,
    });

    await expect(opus.translate(input())).resolves.toMatchObject({
      translatedText: 'bonjour',
      providerName: 'opus-mt',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
    });
    await expect(opus.translate(input({ sourceText: 'good evening' }))).resolves.toMatchObject({
      translatedText: 'bonjour',
    });

    // One worker process serves every request; model config travels via spawn argv.
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ command: 'C:/ai/python312/python.exe', maxConcurrency: 1 });
    expect(configs[0]?.args).toContain('C:/models/opus');
    expect(configs[0]?.args.at(-1)).toBe('0');
    // The text and per-pair model travel in the JSON request payload, not argv.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      op: 'translate',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      sourceText: 'hello',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
      localPath: 'C:/models/opus/en-fr',
    });
  });

  it('selects the explicit ES-to-EN OPUS-MT route for English recipients', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ translatedText: 'good morning' }));
    const opus = new OpusMtTimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelCacheDir: 'C:/models/opus',
      supportedTargetLanguages: ['en'],
      languageModels: [
        {
          sourceLanguage: 'es',
          targetLanguage: 'en',
          modelId: 'Helsinki-NLP/opus-mt-es-en',
          localPath: 'C:/models/opus/es-en',
        },
      ],
      timeoutMs: 30_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(
      opus.translate(input({ sourceLanguage: 'es', targetLanguage: 'en', sourceText: 'buenos días' })),
    ).resolves.toMatchObject({
      translatedText: 'good morning',
      modelId: 'Helsinki-NLP/opus-mt-es-en',
    });
    expect(requests[0]).toMatchObject({
      sourceLanguage: 'es',
      targetLanguage: 'en',
      modelId: 'Helsinki-NLP/opus-mt-es-en',
      localPath: 'C:/models/opus/es-en',
    });
  });

  it('reports OPUS-MT health through the persistent worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ status: 'ok' }));
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
      createWorker: factory,
    });

    await expect(opus.healthCheck()).resolves.toMatchObject({
      provider: 'opus-mt',
      status: 'ready',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
    });
    expect(requests[0]).toMatchObject({ op: 'health', modelId: 'Helsinki-NLP/opus-mt-en-fr' });
  });

  it('fails clearly when OPUS-MT dependencies or models are unavailable', async () => {
    const { factory } = fakeWorkerFactory(() => {
      throw new PythonWorkerError(
        'opus-mt worker exited unexpectedly (code 1, signal null).',
        'worker-exited',
        { stderr: "ModuleNotFoundError: No module named 'transformers'", exitCode: 1 },
      );
    });
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
      createWorker: factory,
    });

    await expect(opus.translate(input())).rejects.toMatchObject({
      code: 'translation-python-unavailable',
    });
  });

  it('maps worker queue overflow to the translation-delayed error', async () => {
    const { factory } = fakeWorkerFactory(() => {
      throw new PythonWorkerError(
        'opus-mt worker queue is full (200 requests pending).',
        'queue-overflow',
      );
    });
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
      maxConcurrency: 2,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(opus.translate(input())).rejects.toMatchObject({
      code: 'translation-delayed',
      statusCode: 429,
    });
  });

  it('sends long multiline source text over stdin JSON through a single OPUS-MT process', async () => {
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const writtenLines: string[] = [];
    const spawnFake = (command: string, args: readonly string[]): WorkerChildProcessLike => {
      spawns.push({ command, args });
      const stdoutListeners: Array<(chunk: unknown) => void> = [];
      return {
        stdin: {
          write: (line: string): boolean => {
            writtenLines.push(line);
            const request = JSON.parse(line) as {
              id: number;
              payload: { sourceText: string };
            };
            queueMicrotask(() => {
              for (const listener of stdoutListeners) {
                listener(
                  `${JSON.stringify({
                    id: request.id,
                    ok: true,
                    result: { translatedText: `[fr] ${request.payload.sourceText}` },
                  })}\n`,
                );
              }
            });
            return true;
          },
          end: () => undefined,
        },
        stdout: {
          on: (_event: 'data', listener: (chunk: unknown) => void): void => {
            stdoutListeners.push(listener);
          },
        },
        stderr: { on: () => undefined },
        on: () => undefined,
        kill: () => undefined,
      };
    };
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
      timeoutMs: 5_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: (config) => new PersistentPythonWorker({ ...config, spawn: spawnFake }),
    });

    const longMultilineText = `${'First "quoted" line with unicode ané \u00fcber.\nSecond line.\n'.repeat(
      2_000,
    )}final line`;
    const result = await opus.translate(input({ sourceText: longMultilineText }));
    expect(result.translatedText).toBe(`[fr] ${longMultilineText}`);
    await expect(opus.translate(input({ sourceText: 'short' }))).resolves.toMatchObject({
      translatedText: '[fr] short',
    });

    expect(spawns).toHaveLength(1);
    expect(writtenLines).toHaveLength(2);
    // The full text survives the JSON stdin line intact (no argv length limits).
    const firstRequest = JSON.parse(writtenLines[0]!) as { payload: { sourceText: string } };
    expect(firstRequest.payload.sourceText).toBe(longMultilineText);
    expect(writtenLines[0]!.endsWith('\n')).toBe(true);
  });

  it('runs the multilingual M2M100 model through one persistent worker', async () => {
    const { factory, configs, requests } = fakeWorkerFactory(() => ({
      translatedText: 'Bawo ni agbaye',
    }));
    const m2m100 = new M2m100TimestampedTranslationProvider({
      pythonExecutable: 'C:/ai/python.exe',
      modelId: 'facebook/m2m100_418M',
      localPath: 'C:/models/m2m100',
      modelCacheDir: 'C:/models',
      supportedTargetLanguages: ['es', 'fr', 'pt', 'yo', 'zh'],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(
      m2m100.translate(input({ targetLanguage: 'yo' })),
    ).resolves.toMatchObject({
      translatedText: 'Bawo ni agbaye',
      providerName: 'm2m100',
      modelId: 'facebook/m2m100_418M',
    });
    await expect(m2m100.translate(input({ targetLanguage: 'zh' }))).resolves.toMatchObject({
      translatedText: 'Bawo ni agbaye',
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ command: 'C:/ai/python.exe', maxConcurrency: 1 });
    expect(configs[0]?.args).toContain('facebook/m2m100_418M');
    expect(configs[0]?.args.at(-1)).toBe('0');
    expect(requests[0]).toMatchObject({
      op: 'translate',
      sourceLanguage: 'en',
      targetLanguage: 'yo',
      sourceText: 'hello',
    });
  });

  it('maps M2M100 worker queue overflow to the translation-delayed error', async () => {
    const { factory } = fakeWorkerFactory(() => {
      throw new PythonWorkerError(
        'm2m100 worker queue is full (200 requests pending).',
        'queue-overflow',
      );
    });
    const m2m100 = new M2m100TimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelId: 'facebook/m2m100_418M',
      localPath: null,
      modelCacheDir: null,
      supportedTargetLanguages: ['es', 'fr'],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(m2m100.translate(input())).rejects.toMatchObject({
      code: 'translation-delayed',
      statusCode: 429,
    });
  });

  it('selects Arabic and Yoruba OPUS-MT target tokens and sends the target language in the payload', async () => {
    const { factory, configs, requests } = fakeWorkerFactory(() => ({
      translatedText: 'مرحبا',
    }));
    const opus = new OpusMtTimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelCacheDir: null,
      supportedTargetLanguages: ['ar'],
      languageModels: [
        {
          sourceLanguage: 'en',
          targetLanguage: 'ar',
          modelId: 'Helsinki-NLP/opus-mt-en-ar',
          localPath: null,
        },
      ],
      timeoutMs: 1000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(opus.translate(input({ targetLanguage: 'ar' }))).resolves.toMatchObject({
      translatedText: 'مرحبا',
      modelId: 'Helsinki-NLP/opus-mt-en-ar',
    });
    // The worker resolves the ">>ara<<" prefix from the payload target language.
    expect(requests[0]).toMatchObject({
      op: 'translate',
      targetLanguage: 'ar',
      modelId: 'Helsinki-NLP/opus-mt-en-ar',
    });
    // The embedded worker script knows the Arabic and Yoruba ISO-639-3 tokens
    // used by multi-target Marian vocabularies (>>ara<< / >>yor<<).
    const workerScript = String(configs[0]?.args[1]);
    expect(workerScript).toContain('"ar": "ara"');
    expect(workerScript).toContain('"yo": "yor"');
  });

  it('probes explicit per-language Marian control-token candidates first', async () => {
    const { factory, configs } = fakeWorkerFactory(() => ({ translatedText: '你好' }));
    const opus = new OpusMtTimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelCacheDir: null,
      supportedTargetLanguages: ['zh'],
      languageModels: [
        {
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          modelId: 'Helsinki-NLP/opus-mt-en-zh',
          localPath: null,
        },
      ],
      timeoutMs: 1000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await opus.translate(input({ targetLanguage: 'zh' }));

    // The explicit candidate lists cover vocabularies the generic
    // 2-letter/iso3/"_br" probing misses (e.g. ">>cmn_Hans<<" on en-zh).
    const workerScript = String(configs[0]?.args[1]);
    expect(workerScript).toContain('"zh": ["cmn_Hans", "cmn", "zho", "zh"]');
    expect(workerScript).toContain('"el": ["ell", "el"]');
    expect(workerScript).toContain('"ru": ["rus", "ru"]');
    expect(workerScript).toContain('"la": ["la", "lat"]');
  });

  it('hardens both worker generate calls against degenerate repetition', async () => {
    const opusWorker = fakeWorkerFactory(() => ({ translatedText: 'bonjour' }));
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
      createWorker: opusWorker.factory,
    });
    const m2m100Worker = fakeWorkerFactory(() => ({ translatedText: 'Bawo ni' }));
    const m2m100 = new M2m100TimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelId: 'facebook/m2m100_418M',
      localPath: null,
      modelCacheDir: null,
      supportedTargetLanguages: ['yo'],
      timeoutMs: 1000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: m2m100Worker.factory,
    });

    await opus.translate(input());
    await m2m100.translate(input({ targetLanguage: 'yo' }));

    // Marian models already default to beam search: only the n-gram block is
    // added so OPUS-MT decoding is not slowed further.
    const opusScript = String(opusWorker.configs[0]?.args[1]);
    expect(opusScript).toContain('no_repeat_ngram_size=3');
    expect(opusScript).not.toContain('num_beams');
    // M2M100 gets beams plus the n-gram block: greedy decoding degenerates
    // into repetition on low-resource targets such as Yoruba.
    const m2m100Script = String(m2m100Worker.configs[0]?.args[1]);
    expect(m2m100Script).toContain('num_beams=4');
    expect(m2m100Script).toContain('no_repeat_ngram_size=3');
  });

  it('rejects languages outside the configured M2M100 catalogue', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ translatedText: 'unused' }));
    const m2m100 = new M2m100TimestampedTranslationProvider({
      pythonExecutable: 'python',
      modelId: 'facebook/m2m100_418M',
      localPath: null,
      modelCacheDir: null,
      supportedTargetLanguages: ['es', 'fr', 'pt', 'yo', 'zh'],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      allowModelDownload: false,
      createWorker: factory,
    });

    await expect(m2m100.translate(input({ targetLanguage: 'la' }))).rejects.toMatchObject({
      code: 'unsupported-language',
    });
    expect(requests).toEqual([]);
  });
});

function nllb200Provider(
  overrides: Partial<Nllb200ProviderOptions> = {},
): Nllb200TimestampedTranslationProvider {
  return new Nllb200TimestampedTranslationProvider({
    pythonExecutable: 'python',
    modelId: 'facebook/nllb-200-distilled-600M',
    localPath: null,
    modelCacheDir: null,
    supportedTargetLanguages: ['es', 'fr', 'pt', 'yo', 'zh', 'ru', 'el', 'la'],
    timeoutMs: 60_000,
    maxConcurrency: 1,
    allowModelDownload: false,
    ...overrides,
  });
}

describe('NLLB-200 translation provider', () => {
  it('runs the multilingual NLLB-200 model through one persistent worker', async () => {
    const { factory, configs, requests } = fakeWorkerFactory(() => ({
      translatedText: 'Bawo ni agbaye',
    }));
    const nllb200 = nllb200Provider({
      pythonExecutable: 'C:/ai/python.exe',
      localPath: 'C:/models/nllb-200',
      modelCacheDir: 'C:/models',
      createWorker: factory,
    });

    await expect(nllb200.translate(input({ targetLanguage: 'yo' }))).resolves.toMatchObject({
      translatedText: 'Bawo ni agbaye',
      providerName: 'nllb200',
      modelId: 'facebook/nllb-200-distilled-600M',
    });
    await expect(nllb200.translate(input({ targetLanguage: 'zh' }))).resolves.toMatchObject({
      translatedText: 'Bawo ni agbaye',
    });

    // One worker process serves every request; model config travels via spawn argv.
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ command: 'C:/ai/python.exe', maxConcurrency: 1 });
    expect(configs[0]?.args).toContain('facebook/nllb-200-distilled-600M');
    expect(configs[0]?.args).toContain('C:/models/nllb-200');
    expect(configs[0]?.args.at(-1)).toBe('0');
    // The payload carries both the pipeline codes and the pre-mapped
    // FLORES-200 codes the tokenizer needs.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      op: 'translate',
      sourceLanguage: 'en',
      targetLanguage: 'yo',
      sourceNllbCode: 'eng_Latn',
      targetNllbCode: 'yor_Latn',
      sourceText: 'hello',
    });
    expect(requests[1]).toMatchObject({
      sourceNllbCode: 'eng_Latn',
      targetNllbCode: 'zho_Hans',
    });
    // Empirically validated generation settings and streaming model load.
    const workerScript = String(configs[0]?.args[1]);
    expect(workerScript).toContain('AutoModelForSeq2SeqLM');
    expect(workerScript).toContain('low_cpu_mem_usage=True');
    expect(workerScript).toContain('convert_tokens_to_ids(payload["targetNllbCode"])');
    expect(workerScript).toContain('num_beams=4');
    expect(workerScript).toContain('no_repeat_ngram_size=3');
    expect(workerScript).toContain('max_new_tokens=256');
  });

  it('reports NLLB-200 health through the persistent worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ status: 'ok' }));
    const nllb200 = nllb200Provider({ createWorker: factory });

    await expect(nllb200.healthCheck()).resolves.toMatchObject({
      provider: 'nllb200',
      status: 'ready',
      modelId: 'facebook/nllb-200-distilled-600M',
    });
    expect(requests[0]).toMatchObject({ op: 'health' });
  });

  it('rejects languages outside the configured NLLB-200 catalogue', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ translatedText: 'unused' }));
    const nllb200 = nllb200Provider({
      supportedTargetLanguages: ['es', 'fr'],
      createWorker: factory,
    });

    await expect(nllb200.translate(input({ targetLanguage: 'yo' }))).rejects.toMatchObject({
      code: 'unsupported-language',
    });
    expect(requests).toEqual([]);
  });

  it('rejects languages without a FLORES-200 code before reaching the worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ translatedText: 'unused' }));
    const nllb200 = nllb200Provider({ createWorker: factory });

    // Latin is in the configured catalogue but NLLB-200 has no code for it,
    // so the pair fails fast and the composite can reroute it.
    expect(NLLB_LANGUAGE_CODES['la']).toBeUndefined();
    await expect(nllb200.translate(input({ targetLanguage: 'la' }))).rejects.toMatchObject({
      code: 'unsupported-language',
    });
    expect(requests).toEqual([]);
  });

  it('maps NLLB-200 worker queue overflow to the translation-delayed error', async () => {
    const { factory } = fakeWorkerFactory(() => {
      throw new PythonWorkerError(
        'nllb200 worker queue is full (200 requests pending).',
        'queue-overflow',
      );
    });
    const nllb200 = nllb200Provider({ createWorker: factory });

    await expect(nllb200.translate(input({ targetLanguage: 'yo' }))).rejects.toMatchObject({
      code: 'translation-delayed',
      statusCode: 429,
    });
  });

  it('preserves empty source text without invoking the worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({ translatedText: 'unused' }));
    const nllb200 = nllb200Provider({ createWorker: factory });

    await expect(nllb200.translate(input({ targetLanguage: 'yo', sourceText: '' }))).resolves.toEqual(
      {
        translatedText: '',
        providerName: 'nllb200',
        modelId: 'facebook/nllb-200-distilled-600M',
        providerLatencyMs: 0,
      },
    );
    expect(requests).toEqual([]);
  });

  it('maps the partner language codes to FLORES-200 codes', () => {
    expect(NLLB_LANGUAGE_CODES).toMatchObject({
      en: 'eng_Latn',
      es: 'spa_Latn',
      fr: 'fra_Latn',
      pt: 'por_Latn',
      ar: 'arb_Arab',
      yo: 'yor_Latn',
      zh: 'zho_Hans',
      ru: 'rus_Cyrl',
      el: 'ell_Grek',
      de: 'deu_Latn',
      it: 'ita_Latn',
      ja: 'jpn_Jpan',
      ig: 'ibo_Latn',
      ha: 'hau_Latn',
      sw: 'swh_Latn',
    });
  });
});

interface StubProviderOptions {
  name: string;
  translate?: (input: TranslationProviderInput) => Promise<never> | never;
}

function stubProvider(options: StubProviderOptions) {
  const calls: TranslationProviderInput[] = [];
  const disposals: string[] = [];
  const provider: TimestampedTranslationProvider = {
    name: options.name,
    async translate(request) {
      calls.push(request);
      if (options.translate) return await options.translate(request);
      return {
        translatedText: `[${options.name}:${request.targetLanguage}] ${request.sourceText}`,
        providerName: options.name,
        modelId: `${options.name}-model`,
        providerLatencyMs: 1,
      };
    },
    dispose() {
      disposals.push(options.name);
    },
  };
  return { provider, calls, disposals };
}

describe('composite translation fallback chain', () => {
  it('routes supported pairs to the primary provider only', async () => {
    const primary = stubProvider({ name: 'opus-mt' });
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: primary.provider,
      fallback: fallback.provider,
    });

    await expect(composite.translate(input())).resolves.toMatchObject({
      translatedText: '[opus-mt:fr] hello',
      providerName: 'opus-mt',
    });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    expect(composite.name).toBe('opus-mt+m2m100');
  });

  it('retries via the fallback when the primary rejects the pair and remembers it', async () => {
    const primary = stubProvider({
      name: 'opus-mt',
      translate: () => {
        throw new MediaIngestError(
          'Translation unavailable for language pair: en->yo.',
          'unsupported-language',
          400,
        );
      },
    });
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: primary.provider,
      fallback: fallback.provider,
    });

    await expect(composite.translate(input({ targetLanguage: 'yo' }))).resolves.toMatchObject({
      translatedText: '[m2m100:yo] hello',
      providerName: 'm2m100',
    });
    await expect(composite.translate(input({ targetLanguage: 'yo' }))).resolves.toMatchObject({
      providerName: 'm2m100',
    });

    // The failing pair is remembered: the primary is only probed once.
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(2);
  });

  it('skips the primary for pairs seeded as known-unsupported', async () => {
    const primary = stubProvider({ name: 'opus-mt' });
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: primary.provider,
      fallback: fallback.provider,
      primaryUnsupportedPairs: [{ sourceLanguage: 'en', targetLanguage: 'yo' }],
    });

    await expect(composite.translate(input({ targetLanguage: 'yo' }))).resolves.toMatchObject({
      providerName: 'm2m100',
    });
    await expect(composite.translate(input({ targetLanguage: 'fr' }))).resolves.toMatchObject({
      providerName: 'opus-mt',
    });
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it('propagates non-language primary failures without falling back', async () => {
    const primary = stubProvider({
      name: 'opus-mt',
      translate: () => {
        throw new MediaIngestError('OPUS-MT translation timed out.', 'translation-timeout', 504);
      },
    });
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: primary.provider,
      fallback: fallback.provider,
    });

    await expect(composite.translate(input())).rejects.toMatchObject({
      code: 'translation-timeout',
    });
    expect(fallback.calls).toHaveLength(0);

    // The pair is NOT remembered as unsupported: the primary is retried next time.
    await expect(composite.translate(input())).rejects.toMatchObject({
      code: 'translation-timeout',
    });
    expect(primary.calls).toHaveLength(2);
  });

  it('reports primary health and names the fallback provider', async () => {
    const primary = stubProvider({ name: 'opus-mt' });
    const withHealth: TimestampedTranslationProvider = {
      ...primary.provider,
      async healthCheck() {
        return {
          provider: 'opus-mt',
          status: 'ready',
          modelId: 'Helsinki-NLP/opus-mt-en-fr',
          latencyMs: 5,
          error: null,
        };
      },
    };
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: withHealth,
      fallback: fallback.provider,
    });

    await expect(composite.healthCheck()).resolves.toMatchObject({
      provider: 'opus-mt',
      status: 'ready',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
      fallbackProvider: 'm2m100',
    });
  });

  it('disposes both providers', () => {
    const primary = stubProvider({ name: 'opus-mt' });
    const fallback = stubProvider({ name: 'm2m100' });
    const composite = new CompositeTimestampedTranslationProvider({
      primary: primary.provider,
      fallback: fallback.provider,
    });

    composite.dispose();

    expect(primary.disposals).toEqual(['opus-mt']);
    expect(fallback.disposals).toEqual(['m2m100']);
  });

  it('serves Yoruba through M2M100 while OPUS-MT keeps its covered pairs', async () => {
    const opusWorker = fakeWorkerFactory(() => ({ translatedText: 'bonjour' }));
    const m2m100Worker = fakeWorkerFactory(() => ({ translatedText: 'Bawo ni' }));
    const composite = new CompositeTimestampedTranslationProvider({
      primary: new OpusMtTimestampedTranslationProvider({
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
        createWorker: opusWorker.factory,
      }),
      fallback: new M2m100TimestampedTranslationProvider({
        pythonExecutable: 'python',
        modelId: 'facebook/m2m100_418M',
        localPath: null,
        modelCacheDir: null,
        supportedTargetLanguages: ['fr', 'yo'],
        timeoutMs: 1000,
        maxConcurrency: 1,
        allowModelDownload: false,
        createWorker: m2m100Worker.factory,
      }),
    });

    await expect(composite.translate(input({ targetLanguage: 'yo' }))).resolves.toMatchObject({
      translatedText: 'Bawo ni',
      providerName: 'm2m100',
      modelId: 'facebook/m2m100_418M',
    });
    await expect(composite.translate(input({ targetLanguage: 'fr' }))).resolves.toMatchObject({
      translatedText: 'bonjour',
      providerName: 'opus-mt',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
    });
    expect(m2m100Worker.requests).toHaveLength(1);
    expect(opusWorker.requests).toHaveLength(1);
  });
});
