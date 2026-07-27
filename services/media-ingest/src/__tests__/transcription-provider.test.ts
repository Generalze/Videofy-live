import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaIngestError } from '../ingest-error.js';
import {
  FasterWhisperTranscriptionProvider,
  MockTranscriptionProvider,
  createTranscriptionProvider,
  type CommandRunner,
  type FasterWhisperProviderOptions,
} from '../transcription-provider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function chunk(filename: string) {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    chunk: {
      chunkId: 'ps_test:mic:0',
      index: 0,
      filename,
      startMs: 0,
      endMs: 15_000,
      durationMs: 15_000,
      status: 'ready' as const,
    },
    audioPath: join('C:/tmp/chunks/ps_test', filename),
  };
}

function provider(
  runCommand: CommandRunner,
  overrides: Partial<FasterWhisperProviderOptions> = {},
): FasterWhisperTranscriptionProvider {
  return new FasterWhisperTranscriptionProvider({
    pythonExecutable: 'python',
    ffmpegExecutable: 'ffmpeg',
    modelSize: 'small',
    device: 'cpu',
    computeType: 'int8',
    modelCacheDir: null,
    allowGpuFallback: false,
    timeoutMs: 30_000,
    runCommand,
    ...overrides,
  });
}

function whisperOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: 'hello world',
    detectedLanguage: 'en',
    confidence: 0.91,
    device: 'cpu',
    ...overrides,
  });
}

describe('transcription providers', () => {
  it('preserves the mock provider', async () => {
    const mock = createTranscriptionProvider({
      providerName: 'mock',
      sourceLanguage: 'en',
      timeoutMs: 1000,
      fasterWhisper: {
        pythonExecutable: 'python',
        ffmpegExecutable: 'ffmpeg',
        modelSize: 'small',
        device: 'cpu',
        computeType: 'int8',
        modelCacheDir: null,
        allowGpuFallback: false,
        timeoutMs: 1000,
      },
    });

    expect(mock).toBeInstanceOf(MockTranscriptionProvider);
    await expect(mock.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      sourceText: 'Mock transcript chunk 1',
      detectedLanguage: 'en',
      confidence: 0.99,
    });
  });

  it('runs faster-whisper successfully and reports provider latency', async () => {
    const commands: string[] = [];
    const local = provider(async (command) => {
      commands.push(command);
      return { stdout: whisperOutput(), stderr: '' };
    });

    const result = await local.transcribe(chunk('chunk-000000.wav'));

    expect(commands).toEqual(['python']);
    expect(result).toMatchObject({
      sourceText: 'hello world',
      detectedLanguage: 'en',
      confidence: 0.91,
    });
    expect(result.providerLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('normalises microphone WebM/Ogg chunks before transcription', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const local = provider(async (command, args) => {
      calls.push({ command, args });
      return command === 'ffmpeg'
        ? { stdout: '', stderr: '' }
        : { stdout: whisperOutput(), stderr: '' };
    });

    await local.transcribe(chunk('mic-chunk-000000.webm'));

    expect(calls.map((call) => call.command)).toEqual(['ffmpeg', 'python']);
    expect(calls[0]?.args).toContain('16000');
    expect(calls[0]?.args).toContain('pcm_s16le');
    expect(calls[1]?.args.join(' ')).toContain('mic-chunk-000000.normalized.wav');
  });

  it('reuses upload WAV chunks without unnecessary conversion', async () => {
    const calls: string[] = [];
    const local = provider(async (command) => {
      calls.push(command);
      return { stdout: whisperOutput(), stderr: '' };
    });

    await local.transcribe(chunk('chunk-000000.wav'));

    expect(calls).toEqual(['python']);
  });

  it('accepts empty speech', async () => {
    const local = provider(async () => ({
      stdout: whisperOutput({ text: '', confidence: null }),
      stderr: '',
    }));

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      sourceText: '',
      detectedLanguage: 'en',
      confidence: null,
    });
  });

  it('fails clearly when the model cache directory is missing', async () => {
    expect(
      () =>
        new FasterWhisperTranscriptionProvider({
          pythonExecutable: 'python',
          ffmpegExecutable: 'ffmpeg',
          modelSize: 'small',
          device: 'cpu',
          computeType: 'int8',
          modelCacheDir: join(tmpdir(), 'missing-videofy-model-cache'),
          allowGpuFallback: false,
          timeoutMs: 30_000,
          runCommand: async () => ({ stdout: whisperOutput(), stderr: '' }),
        }),
    ).toThrow(/model cache directory does not exist/);
  });

  it('fails clearly when Python is unavailable', async () => {
    const local = provider(async () => {
      const error = new Error('spawn python ENOENT') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-python-unavailable',
      message: 'Python executable not found for faster-whisper transcription.',
    });
  });

  it('fails clearly when FFmpeg is unavailable for microphone normalisation', async () => {
    const local = provider(async (command) => {
      if (command === 'ffmpeg') {
        const error = new Error('spawn ffmpeg ENOENT') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
      return { stdout: whisperOutput(), stderr: '' };
    });

    await expect(local.transcribe(chunk('mic-chunk-000000.ogg'))).rejects.toMatchObject({
      code: 'transcription-ffmpeg-unavailable',
      message: 'FFmpeg executable not found for microphone audio normalisation.',
    });
  });

  it('fails clearly on timeout', async () => {
    const local = provider(async () => {
      const error = new Error('Command timed out') as Error & { signal: string };
      error.signal = 'SIGTERM';
      throw error;
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-timeout',
    });
  });

  it('fails clearly when Python reports a missing faster-whisper model', async () => {
    const local = provider(async () => {
      const error = new Error('model not found') as Error & { stderr: string };
      error.stderr = 'Model tiny.en not found in cache';
      throw error;
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-model-unavailable',
    });
  });

  it('fails clearly on provider failure', async () => {
    const local = provider(async () => {
      throw new Error('unexpected decoder failure');
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-failed',
      message: expect.stringContaining('unexpected decoder failure'),
    });
  });

  it('does not silently fall back from GPU to CPU', async () => {
    const local = provider(
      async () => ({ stdout: whisperOutput({ device: 'cpu' }), stderr: '' }),
      {
        device: 'cuda',
        allowGpuFallback: false,
      },
    );

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-gpu-unavailable',
    });
  });

  it('falls back from GPU to CPU only when configured', async () => {
    const devices: string[] = [];
    const local = provider(
      async (_command, args) => {
        const requestedDevice = String(args[4]);
        devices.push(requestedDevice);
        if (requestedDevice === 'cuda') {
          throw new MediaIngestError('CUDA unavailable', 'transcription-gpu-unavailable', 500);
        }
        return { stdout: whisperOutput({ device: 'cpu' }), stderr: '' };
      },
      {
        device: 'cuda',
        allowGpuFallback: true,
      },
    );

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      sourceText: 'hello world',
    });
    expect(devices).toEqual(['cuda', 'cpu']);
  });
});
