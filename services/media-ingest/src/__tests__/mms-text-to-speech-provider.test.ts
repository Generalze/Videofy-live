import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PythonWorkerError,
  type PythonWorkerConfig,
  type PythonWorkerFactory,
} from '../persistent-python-worker.js';
import {
  CompositeTextToSpeechProvider,
  MmsTextToSpeechProvider,
  createTextToSpeechProvider,
  type MmsTextToSpeechProviderOptions,
  type PiperTextToSpeechProviderOptions,
  type TextToSpeechProvider,
  type TextToSpeechProviderInput,
} from '../text-to-speech-provider.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-mms-tts-provider-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type WorkerHandler = (
  payload: Record<string, unknown>,
  config: PythonWorkerConfig,
) => Promise<unknown> | unknown;

function fakeWorkerFactory(handler: WorkerHandler) {
  const configs: PythonWorkerConfig[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const disposals: number[] = [];
  const factory: PythonWorkerFactory = (config) => {
    configs.push(config);
    return {
      async request(payload) {
        const record = payload as Record<string, unknown>;
        requests.push(record);
        return await handler(record, config);
      },
      dispose() {
        disposals.push(configs.length);
      },
    };
  };
  return { factory, configs, requests, disposals };
}

function input(
  outputPath: string,
  overrides: Partial<TextToSpeechProviderInput> = {},
): TextToSpeechProviderInput {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: 'segment-0',
    sequence: 0,
    targetLanguage: 'yo',
    translatedText: 'Bawo ni',
    startMs: 0,
    endMs: 2000,
    voiceId: 'facebook/mms-tts-yor',
    outputPath,
    ...overrides,
  };
}

function mmsProvider(
  overrides: Partial<MmsTextToSpeechProviderOptions> = {},
): MmsTextToSpeechProvider {
  return new MmsTextToSpeechProvider({
    pythonExecutable: 'C:/ai/python312/python.exe',
    ffmpegExecutable: 'ffmpeg',
    voices: [{ language: 'yo', modelId: 'facebook/mms-tts-yor', localPath: null }],
    modelCacheDir: 'C:/models/mms',
    allowModelDownload: false,
    timeoutMs: 30_000,
    ...overrides,
  });
}

async function writeRawWav(filePath: string, durationMs: number, sampleRate = 16_000): Promise<void> {
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = Math.max(
    1,
    Math.round((sampleRate * channels * bytesPerSample * durationMs) / 1000),
  );
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  await writeFile(filePath, buffer);
}

describe('MMS text-to-speech provider', () => {
  it('synthesizes through one persistent worker and normalizes at the reported sample rate', async () => {
    const dir = await tempDir();
    const outputPath = join(dir, 'mms.wav');
    const rawOutputPath = `${outputPath}.mms.wav`;
    const { factory, configs, requests } = fakeWorkerFactory(async (payload) => {
      await writeFile(String(payload['outputPath']), 'raw mms wav');
      return { sampleRateHz: 16_000, durationMs: 1_500 };
    });
    const normalizeArgs: string[][] = [];
    const provider = mmsProvider({
      createWorker: factory,
      runNormalizeCommand: async (_command, args) => {
        normalizeArgs.push([...args]);
        const finalPath = args[args.length - 1];
        if (typeof finalPath !== 'string') throw new Error('missing output path');
        await writeFile(finalPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    const result = await provider.generate(input(outputPath));
    await provider.generate(input(join(dir, 'second.wav')));

    expect(result.audioPath).toBe(outputPath);
    expect(result.providerLatencyMs).toEqual(expect.any(Number));
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('normalized wav');
    await expect(readFile(rawOutputPath, 'utf8')).rejects.toThrow();

    // One worker process serves every request; cache config travels via spawn argv.
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      command: 'C:/ai/python312/python.exe',
      maxConcurrency: 1,
      label: 'mms-tts',
    });
    expect(configs[0]?.args).toContain('C:/models/mms');
    expect(configs[0]?.args.at(-1)).toBe('0');
    const workerScript = String(configs[0]?.args[1]);
    expect(workerScript).toContain('VitsModel');
    expect(workerScript).toContain('AutoTokenizer');
    expect(workerScript).toContain('import wave');

    // The text and model travel in the JSON request payload, not argv; python
    // writes the raw WAV to the side path the provider hands over.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      text: 'Bawo ni',
      modelId: 'facebook/mms-tts-yor',
      localPath: null,
      outputPath: rawOutputPath,
    });

    expect(normalizeArgs[0]).toEqual([
      '-y',
      '-i',
      rawOutputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      'loudnorm=I=-19:TP=-1.5:LRA=7',
      '-acodec',
      'pcm_s16le',
      '-f',
      'wav',
      outputPath,
    ]);
  });

  it('prepends a clamped atempo filter when the synthesized clip overruns its window', async () => {
    const dir = await tempDir();
    const outputPath = join(dir, 'overrun.wav');
    const { factory } = fakeWorkerFactory(async (payload) => {
      await writeRawWav(String(payload['outputPath']), 3_000);
      return { sampleRateHz: 16_000, durationMs: 3_000 };
    });
    const audioFilters: string[] = [];
    const provider = mmsProvider({
      createWorker: factory,
      runNormalizeCommand: async (_command, args) => {
        const audioFilter = args[args.indexOf('-af') + 1];
        if (typeof audioFilter !== 'string') throw new Error('missing audio filter');
        audioFilters.push(audioFilter);
        await writeFile(outputPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    await provider.generate(input(outputPath));

    // 3000 ms of audio against a 2000 ms window clamps to the 1.25 atempo ceiling.
    expect(audioFilters).toEqual(['atempo=1.25,loudnorm=I=-19:TP=-1.5:LRA=7']);
  });

  it('rejects unsupported languages without invoking the worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({
      sampleRateHz: 16_000,
      durationMs: 0,
    }));
    const provider = mmsProvider({ createWorker: factory });

    await expect(
      provider.generate(input(join(await tempDir(), 'out.wav'), { targetLanguage: 'fr' })),
    ).rejects.toMatchObject({ code: 'unsupported-tts-language' });
    expect(requests).toEqual([]);
  });

  it('writes a silent placeholder for empty text without invoking the worker', async () => {
    const { factory, requests } = fakeWorkerFactory(() => ({
      sampleRateHz: 16_000,
      durationMs: 0,
    }));
    const provider = mmsProvider({ createWorker: factory });
    const outputPath = join(await tempDir(), 'silent.wav');

    const result = await provider.generate(input(outputPath, { translatedText: '' }));

    expect(result).toEqual({ audioPath: outputPath, providerLatencyMs: 0 });
    await expect(readFile(outputPath)).resolves.toHaveLength(44);
    expect(requests).toEqual([]);
  });

  it('rejects empty or invalid MMS voice configuration clearly', () => {
    expect(() => mmsProvider({ voices: [] })).toThrow(/At least one MMS-TTS voice/);
    expect(() =>
      mmsProvider({ voices: [{ language: ' ', modelId: 'facebook/mms-tts-yor', localPath: null }] }),
    ).toThrow(/Invalid MMS-TTS voice configuration/);
  });

  it('fails clearly when the response shape is invalid', async () => {
    const { factory } = fakeWorkerFactory(() => ({ sampleRateHz: 'sixteen-k' }));
    const provider = mmsProvider({ createWorker: factory });

    await expect(provider.generate(input(join(await tempDir(), 'bad.wav')))).rejects.toMatchObject({
      code: 'tts-failed',
      message: expect.stringContaining('invalid response shape'),
    });
  });

  it('classifies worker failures without silent fallback', async () => {
    const failing = (error: PythonWorkerError) => {
      const { factory } = fakeWorkerFactory(() => {
        throw error;
      });
      return mmsProvider({ createWorker: factory });
    };
    const dir = await tempDir();

    await expect(
      failing(
        new PythonWorkerError('mms-tts worker queue is full (200 requests pending).', 'queue-overflow'),
      ).generate(input(join(dir, 'queued.wav'))),
    ).rejects.toMatchObject({
      code: 'tts-failed',
      statusCode: 503,
      message: expect.stringContaining('concurrency limit'),
    });

    await expect(
      failing(
        new PythonWorkerError('Failed to start mms-tts worker: spawn python ENOENT', 'spawn-failed', {
          code: 'ENOENT',
        }),
      ).generate(input(join(dir, 'no-python.wav'))),
    ).rejects.toMatchObject({
      code: 'tts-failed',
      message: expect.stringContaining('Python executable not found'),
    });

    await expect(
      failing(
        new PythonWorkerError('mms-tts worker request timed out after 30000 ms.', 'timeout'),
      ).generate(input(join(dir, 'timeout.wav'))),
    ).rejects.toMatchObject({ code: 'tts-timeout' });

    await expect(
      failing(
        new PythonWorkerError(
          'mms-tts worker exited unexpectedly (code 1, signal null).',
          'worker-exited',
          { stderr: "ModuleNotFoundError: No module named 'transformers'", exitCode: 1 },
        ),
      ).generate(input(join(dir, 'no-deps.wav'))),
    ).rejects.toMatchObject({
      code: 'tts-failed',
      message: expect.stringContaining('dependencies are unavailable'),
    });

    await expect(
      failing(
        new PythonWorkerError(
          'facebook/mms-tts-yor is not a local folder and cannot be found with local_files_only=True.',
          'python-error',
          { errorType: 'OSError' },
        ),
      ).generate(input(join(dir, 'no-model.wav'))),
    ).rejects.toMatchObject({ code: 'tts-model-unavailable' });
  });

  it('disposes the persistent worker', async () => {
    const { factory, disposals } = fakeWorkerFactory(async (payload) => {
      await writeFile(String(payload['outputPath']), 'raw mms wav');
      return { sampleRateHz: 16_000, durationMs: 100 };
    });
    const provider = mmsProvider({
      createWorker: factory,
      runNormalizeCommand: async (_command, args) => {
        await writeFile(String(args[args.length - 1]), 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    await provider.generate(input(join(await tempDir(), 'disposed.wav')));
    provider.dispose();

    expect(disposals).toEqual([1]);
  });
});

interface StubTtsProvider {
  provider: TextToSpeechProvider;
  calls: TextToSpeechProviderInput[];
  disposals: string[];
}

function stubTtsProvider(name: string): StubTtsProvider {
  const calls: TextToSpeechProviderInput[] = [];
  const disposals: string[] = [];
  const provider: TextToSpeechProvider = {
    name,
    async generate(request) {
      calls.push(request);
      return { audioPath: request.outputPath, providerLatencyMs: 1 };
    },
    dispose() {
      disposals.push(name);
    },
  };
  return { provider, calls, disposals };
}

describe('composite piper+mms text-to-speech provider', () => {
  it('routes piper-covered languages to piper and the rest to mms', async () => {
    const piper = stubTtsProvider('piper');
    const mms = stubTtsProvider('mms');
    const composite = new CompositeTextToSpeechProvider({
      primary: piper.provider,
      primaryLanguages: ['es', 'fr'],
      secondary: mms.provider,
      secondaryLanguages: ['yo', 'es'],
    });

    // Piper wins languages both engines cover.
    await composite.generate(input('es.wav', { targetLanguage: 'es', voiceId: 'es-test' }));
    await composite.generate(input('yo.wav', { targetLanguage: 'yo' }));

    expect(composite.name).toBe('piper+mms');
    expect(piper.calls.map((call) => call.targetLanguage)).toEqual(['es']);
    expect(mms.calls.map((call) => call.targetLanguage)).toEqual(['yo']);

    await expect(
      composite.generate(input('de.wav', { targetLanguage: 'de' })),
    ).rejects.toMatchObject({ code: 'unsupported-tts-language' });
  });

  it('disposes both engines', () => {
    const piper = stubTtsProvider('piper');
    const mms = stubTtsProvider('mms');
    const composite = new CompositeTextToSpeechProvider({
      primary: piper.provider,
      primaryLanguages: ['es'],
      secondary: mms.provider,
      secondaryLanguages: ['yo'],
    });

    composite.dispose();

    expect(piper.disposals).toEqual(['piper']);
    expect(mms.disposals).toEqual(['mms']);
  });

  it('builds the routed composite from the piper+mms provider name', async () => {
    const dir = await tempDir();
    const modelPath = join(dir, 'voice.onnx');
    await writeFile(modelPath, 'model');
    const piperCommands: string[] = [];
    const piperOptions: PiperTextToSpeechProviderOptions = {
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async (_command, args) => {
        piperCommands.push('piper');
        const rawOutputPath = args[args.indexOf('--output_file') + 1];
        if (typeof rawOutputPath !== 'string') throw new Error('missing raw output path');
        await writeFile(rawOutputPath, 'native wav');
        return { stdout: '', stderr: '' };
      },
      runNormalizeCommand: async (_command, args) => {
        await writeFile(String(args[args.length - 1]), 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    };
    const { factory, requests } = fakeWorkerFactory(async (payload) => {
      await writeFile(String(payload['outputPath']), 'raw mms wav');
      return { sampleRateHz: 16_000, durationMs: 500 };
    });
    const mmsOptions: MmsTextToSpeechProviderOptions = {
      pythonExecutable: 'python',
      voices: [{ language: 'yo', modelId: 'facebook/mms-tts-yor', localPath: 'C:/models/mms/yor' }],
      modelCacheDir: null,
      allowModelDownload: false,
      timeoutMs: 30_000,
      createWorker: factory,
      runNormalizeCommand: async (_command, args) => {
        await writeFile(String(args[args.length - 1]), 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    };
    const provider = createTextToSpeechProvider({
      providerName: 'piper+mms',
      timeoutMs: 30_000,
      supportedLanguages: ['es', 'yo'],
      defaultVoiceId: 'es-test',
      piper: piperOptions,
      mms: mmsOptions,
    });

    expect(provider.name).toBe('piper+mms');

    await provider.generate(
      input(join(dir, 'es.wav'), { targetLanguage: 'es', voiceId: 'es-test', translatedText: 'hola' }),
    );
    await provider.generate(input(join(dir, 'yo.wav')));

    expect(piperCommands).toEqual(['piper']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      text: 'Bawo ni',
      modelId: 'facebook/mms-tts-yor',
      localPath: 'C:/models/mms/yor',
    });
  });

  it('requires mms configuration for the piper+mms provider', () => {
    expect(() =>
      createTextToSpeechProvider({
        providerName: 'piper+mms',
        timeoutMs: 30_000,
        supportedLanguages: ['es', 'yo'],
        defaultVoiceId: 'es-test',
        piper: {
          executable: 'piper',
          timeoutMs: 30_000,
          voices: [],
        },
      }),
    ).toThrow(/requires mms configuration/);
  });
});
