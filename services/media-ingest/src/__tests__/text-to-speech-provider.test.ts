import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockTextToSpeechProvider,
  PiperTextToSpeechProvider,
  createTextToSpeechProvider,
  type PiperCommandRunner,
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

  it('runs Piper successfully and writes the requested output file', async () => {
    const { modelPath, configPath } = await modelFiles();
    const outputPath = join(await tempDir(), 'piper.wav');
    const runCommand: PiperCommandRunner = async (_command, args, options) => {
      expect(args).toEqual([
        '--model',
        modelPath,
        '--output_file',
        outputPath,
        '--config',
        configPath,
      ]);
      expect(options.input).toBe('hola');
      await writeFile(outputPath, 'wav');
      return { stdout: '', stderr: '' };
    };
    const provider = new PiperTextToSpeechProvider({
      executable: 'piper',
      timeoutMs: 30_000,
      voices: [{ voiceId: 'es-test', language: 'es', modelPath, configPath }],
      runCommand,
    });

    const result = await provider.generate(input(outputPath));

    expect(result.audioPath).toBe(outputPath);
    expect(result.providerLatencyMs).toEqual(expect.any(Number));
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('wav');
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
});
