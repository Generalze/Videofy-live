import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockTextToSpeechProvider,
  PiperTextToSpeechProvider,
  createTextToSpeechProvider,
  type PiperCommandRunner,
  type PiperVoiceConfig,
} from '../text-to-speech-provider.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-tts-provider-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function input(outputPath: string, overrides: Partial<Parameters<PiperTextToSpeechProvider['generate']>[0]> = {}) {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: 'segment-0',
    sequence: 0,
    targetLanguage: 'es',
    translatedText: 'hola',
    startMs: 0,
    endMs: 1000,
    voiceId: 'es-test',
    outputPath,
    ...overrides,
  };
}

async function modelFiles(): Promise<{ modelPath: string; configPath: string }> {
  const dir = await tempDir();
  const modelPath = join(dir, 'voice.onnx');
  const configPath = join(dir, 'voice.onnx.json');
  await writeFile(modelPath, 'model');
  await writeFile(configPath, '{}');
  return { modelPath, configPath };
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

describe('text-to-speech providers', () => {
  it('preserves the mock provider for tests', async () => {
    const provider = createTextToSpeechProvider({
      providerName: 'mock',
      timeoutMs: 30_000,
      supportedLanguages: ['es'],
      defaultVoiceId: 'mock-voice',
      piper: {
        executable: 'piper',
        timeoutMs: 30_000,
        voices: [],
      },
    });
    const outputPath = join(await tempDir(), 'mock.wav');

    const result = await provider.generate(input(outputPath, { voiceId: 'mock-voice' }));

    expect(provider).toBeInstanceOf(MockTextToSpeechProvider);
    expect(result.audioPath).toBe(outputPath);
    await expect(readFile(outputPath)).resolves.toHaveLength(44);
  });

  it('runs Piper successfully and normalizes the requested output file', async () => {
    const { modelPath, configPath } = await modelFiles();
    const outputPath = join(await tempDir(), 'piper.wav');
    const rawOutputPath = `${outputPath}.piper.wav`;
    const runCommand: PiperCommandRunner = async (_command, args, options) => {
      expect(args).toEqual([
        '--model',
        modelPath,
        '--output_file',
        rawOutputPath,
        '--config',
        configPath,
      ]);
      expect(options.input).toBe('hola');
      await writeFile(rawOutputPath, 'native wav');
      return { stdout: '', stderr: '' };
    };
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath }],
      runCommand,
      runNormalizeCommand: async (_command, args) => {
        expect(args).toEqual([
          '-y',
          '-i',
          rawOutputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '22050',
          '-af',
          'loudnorm=I=-19:TP=-1.5:LRA=7',
          '-acodec',
          'pcm_s16le',
          '-f',
          'wav',
          outputPath,
        ]);
        await writeFile(outputPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    const result = await provider.generate(input(outputPath));

    expect(result.audioPath).toBe(outputPath);
    expect(result.providerLatencyMs).toEqual(expect.any(Number));
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('normalized wav');
    await expect(readFile(rawOutputPath, 'utf8')).rejects.toThrow();
  });

  it('passes prosody settings to Piper and normalizes at the voice native sample rate', async () => {
    const { modelPath, configPath } = await modelFiles();
    const outputPath = join(await tempDir(), 'piper.wav');
    const rawOutputPath = `${outputPath}.piper.wav`;
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [
        {
          voiceId: 'es-test',
          language: 'es',
          modelPath,
          configPath,
          sampleRateHz: 48_000,
          lengthScale: 1.1,
          noiseScale: 0.5,
          noiseW: 0.9,
          sentenceSilence: 0.25,
        },
      ],
      runCommand: async (_command, args) => {
        expect(args).toEqual([
          '--model',
          modelPath,
          '--output_file',
          rawOutputPath,
          '--config',
          configPath,
          '--length_scale',
          '1.1',
          '--noise_scale',
          '0.5',
          '--noise_w',
          '0.9',
          '--sentence_silence',
          '0.25',
        ]);
        await writeFile(rawOutputPath, 'native wav');
        return { stdout: '', stderr: '' };
      },
      runNormalizeCommand: async (_command, args) => {
        expect(args).toContain('-ar');
        expect(args[args.indexOf('-ar') + 1]).toBe('48000');
        expect(args[args.indexOf('-af') + 1]).toBe('loudnorm=I=-19:TP=-1.5:LRA=7');
        await writeFile(outputPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    const result = await provider.generate(input(outputPath));

    expect(result.audioPath).toBe(outputPath);
  });

  it('prepends a clamped atempo filter when the clip overruns its segment window', async () => {
    const { modelPath } = await modelFiles();
    const audioFilters: string[] = [];
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async (_command, args) => {
        const rawOutputPath = args[args.indexOf('--output_file') + 1];
        if (typeof rawOutputPath !== 'string') throw new Error('missing raw output path');
        const durationMs = rawOutputPath.includes('overrun')
          ? 1200
          : rawOutputPath.includes('clamped')
            ? 2000
            : 1040;
        await writeRawWav(rawOutputPath, durationMs);
        return { stdout: '', stderr: '' };
      },
      runNormalizeCommand: async (_command, args) => {
        const audioFilter = args[args.indexOf('-af') + 1];
        if (typeof audioFilter !== 'string') throw new Error('missing audio filter');
        audioFilters.push(audioFilter);
        const outputPath = args[args.length - 1];
        if (typeof outputPath !== 'string') throw new Error('missing output path');
        await writeFile(outputPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });

    const dir = await tempDir();
    await provider.generate(input(join(dir, 'overrun.wav')));
    await provider.generate(input(join(dir, 'clamped.wav')));
    await provider.generate(input(join(dir, 'within-tolerance.wav')));

    expect(audioFilters).toEqual([
      'atempo=1.2,loudnorm=I=-19:TP=-1.5:LRA=7',
      'atempo=1.25,loudnorm=I=-19:TP=-1.5:LRA=7',
      'loudnorm=I=-19:TP=-1.5:LRA=7',
    ]);
  });

  function lengthScaleArg(args: readonly string[] | undefined): string | null {
    if (!args) return null;
    const index = args.indexOf('--length_scale');
    return index === -1 ? null : (args[index + 1] ?? null);
  }

  function preFitProvider(
    piperArgs: string[][],
    voice: PiperVoiceConfig,
  ): PiperTextToSpeechProvider {
    return new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [voice],
      runCommand: async (_command, args) => {
        piperArgs.push([...args]);
        const rawOutputPath = args[args.indexOf('--output_file') + 1];
        if (typeof rawOutputPath !== 'string') throw new Error('missing raw output path');
        await writeFile(rawOutputPath, 'native wav');
        return { stdout: '', stderr: '' };
      },
      runNormalizeCommand: async (_command, args) => {
        const outputPath = args[args.length - 1];
        if (typeof outputPath !== 'string') throw new Error('missing output path');
        await writeFile(outputPath, 'normalized wav');
        return { stdout: '', stderr: '' };
      },
    });
  }

  it('pre-fits the Piper length scale when estimated speech overruns the segment window', async () => {
    const { modelPath } = await modelFiles();
    const piperArgs: string[][] = [];
    const provider = preFitProvider(piperArgs, {
      voiceId: 'es-test',
      language: 'es',
      modelPath,
      configPath: null,
    });

    // 30 chars at 15 chars/s in Spanish estimates 2000 ms against an 1800 ms window.
    await provider.generate(
      input(join(await tempDir(), 'pre-fit.wav'), {
        translatedText: 'x'.repeat(30),
        endMs: 1800,
      }),
    );

    expect(lengthScaleArg(piperArgs[0])).toBe('0.9');
  });

  it('does not pre-fit when the estimated speech fits comfortably in the window', async () => {
    const { modelPath } = await modelFiles();
    const piperArgs: string[][] = [];
    const provider = preFitProvider(piperArgs, {
      voiceId: 'es-test',
      language: 'es',
      modelPath,
      configPath: null,
    });

    await provider.generate(input(join(await tempDir(), 'comfortable.wav')));

    expect(lengthScaleArg(piperArgs[0])).toBeNull();
  });

  it('clamps the pre-fit length scale to the 0.8 floor', async () => {
    const { modelPath } = await modelFiles();
    const piperArgs: string[][] = [];
    const provider = preFitProvider(piperArgs, {
      voiceId: 'es-test',
      language: 'es',
      modelPath,
      configPath: null,
    });

    // 60 chars at 15 chars/s estimates 4000 ms against a 1000 ms window: raw ratio 0.25.
    await provider.generate(
      input(join(await tempDir(), 'clamp-floor.wav'), { translatedText: 'x'.repeat(60) }),
    );

    expect(lengthScaleArg(piperArgs[0])).toBe('0.8');
  });

  it('composes the pre-fit length scale with a voice-configured lengthScale', async () => {
    const { modelPath } = await modelFiles();
    const piperArgs: string[][] = [];
    const provider = preFitProvider(piperArgs, {
      voiceId: 'es-test',
      language: 'es',
      modelPath,
      configPath: null,
      lengthScale: 1.1,
    });

    await provider.generate(
      input(join(await tempDir(), 'compose.wav'), {
        translatedText: 'x'.repeat(30),
        endMs: 1800,
      }),
    );

    expect(lengthScaleArg(piperArgs[0])).toBe('0.99');
  });

  it('rejects unsupported language or voice clearly', async () => {
    const { modelPath } = await modelFiles();
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async () => ({ stdout: '', stderr: '' }),
    });
    const outputPath = join(await tempDir(), 'piper.wav');

    await expect(provider.generate(input(outputPath, { targetLanguage: 'fr' }))).rejects.toMatchObject({
      code: 'unsupported-tts-language',
    });
    await expect(provider.generate(input(outputPath, { voiceId: 'missing' }))).rejects.toMatchObject({
      code: 'unsupported-tts-voice',
    });
  });

  it('fails clearly when Piper executable or model is missing', async () => {
    const dir = await tempDir();
    expect(
      () =>
        new PiperTextToSpeechProvider({
          executable: 'piper',
          timeoutMs: 30_000,
          voices: [
            {
              voiceId: 'es-test',
              language: 'es',
              modelPath: join(dir, 'missing.onnx'),
              configPath: null,
            },
          ],
        }),
    ).toThrow(/Configured Piper model does not exist/);

    const { modelPath } = await modelFiles();
    const provider = new PiperTextToSpeechProvider({
      executable: 'missing-piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async () => {
        const error = new Error('spawn missing-piper ENOENT');
        (error as { code?: string }).code = 'ENOENT';
        throw error;
      },
    });

    await expect(provider.generate(input(join(await tempDir(), 'out.wav')))).rejects.toMatchObject({
      code: 'tts-piper-unavailable',
    });
  });

  it('fails clearly on timeout and provider failure without silent fallback', async () => {
    const { modelPath } = await modelFiles();
    const timeoutProvider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 1,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async () => {
        const error = new Error('timed out');
        (error as { signal?: string }).signal = 'SIGTERM';
        throw error;
      },
    });
    await expect(timeoutProvider.generate(input(join(await tempDir(), 'timeout.wav')))).rejects.toMatchObject({
      code: 'tts-timeout',
    });

    const failedProvider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async () => {
        throw new Error('piper crashed');
      },
    });
    await expect(failedProvider.generate(input(join(await tempDir(), 'failed.wav')))).rejects.toMatchObject({
      code: 'tts-failed',
      message: expect.stringContaining('piper crashed'),
    });
  });

  it('fails clearly when Piper output normalisation cannot run', async () => {
    const { modelPath } = await modelFiles();
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath: null }],
      runCommand: async (_command, args) => {
        const rawOutputPath = args[args.indexOf('--output_file') + 1];
        if (typeof rawOutputPath !== 'string') throw new Error('missing raw output path');
        await writeFile(rawOutputPath, 'native wav');
        return { stdout: '', stderr: '' };
      },
      runNormalizeCommand: async () => {
        const error = new Error('spawn ffmpeg ENOENT');
        (error as { code?: string }).code = 'ENOENT';
        throw error;
      },
    });

    await expect(provider.generate(input(join(await tempDir(), 'normalize.wav')))).rejects.toMatchObject({
      code: 'tts-ffmpeg-unavailable',
    });
  });
});
