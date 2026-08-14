// Repository owner: masterzee001.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PythonWorkerError,
  type PythonWorkerConfig,
  type PythonWorkerFactory,
} from '../persistent-python-worker.js';
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

type WorkerHandler = (
  payload: Record<string, unknown>,
  config: PythonWorkerConfig,
) => Promise<unknown> | unknown;

function fakeWorkerFactory(handler: WorkerHandler) {
  const configs: PythonWorkerConfig[] = [];
  const requests: Array<{ payload: Record<string, unknown>; config: PythonWorkerConfig }> = [];
  const factory: PythonWorkerFactory = (config) => {
    configs.push(config);
    return {
      async request(payload) {
        const record = payload as Record<string, unknown>;
        requests.push({ payload: record, config });
        return await handler(record, config);
      },
      dispose() {},
    };
  };
  return { factory, configs, requests };
}

function provider(handler: WorkerHandler, overrides: Partial<FasterWhisperProviderOptions> = {}) {
  const { factory, configs, requests } = fakeWorkerFactory(handler);
  const ffmpegCalls: Array<{ command: string; args: readonly string[] }> = [];
  const runCommand: CommandRunner = async (command, args) => {
    ffmpegCalls.push({ command, args });
    return { stdout: '', stderr: '' };
  };
  const local = new FasterWhisperTranscriptionProvider({
    pythonExecutable: 'python',
    ffmpegExecutable: 'ffmpeg',
    modelSize: 'small',
    device: 'cpu',
    computeType: 'int8',
    modelCacheDir: null,
    allowGpuFallback: false,
    timeoutMs: 30_000,
    runCommand,
    createWorker: factory,
    ...overrides,
  });
  return { local, configs, requests, ffmpegCalls };
}

function whisperResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    segments: [{ text: 'hello world', startMs: 250, endMs: 2_250 }],
    detectedLanguage: 'en',
    confidence: 0.91,
    device: 'cpu',
    ...overrides,
  };
}

function workerDevice(config: PythonWorkerConfig): string {
  return String(config.args[3]);
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
      segments: [{ text: 'Mock transcript chunk 1', startMs: 0, endMs: 15_000 }],
      detectedLanguage: 'en',
      confidence: 0.99,
    });
  });

  it('runs faster-whisper successfully and reports provider latency', async () => {
    const { local, configs, requests } = provider(() => whisperResult());

    const result = await local.transcribe(chunk('chunk-000000.wav'));

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ command: 'python', maxConcurrency: 1 });
    expect(configs[0]?.args).toContain('small');
    expect(requests[0]?.payload['audioPath']).toBe(join('C:/tmp/chunks/ps_test', 'chunk-000000.wav'));
    expect(result).toMatchObject({
      segments: [{ text: 'hello world', startMs: 250, endMs: 2_250 }],
      detectedLanguage: 'en',
      confidence: 0.91,
    });
    expect(result.providerLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reuses one persistent worker for many chunks instead of spawning per call', async () => {
    const { local, configs, requests } = provider(() => whisperResult());

    await local.transcribe(chunk('chunk-000000.wav'));
    await local.transcribe(chunk('chunk-000001.wav'));
    await local.transcribe(chunk('chunk-000002.wav'));

    expect(configs).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => String(request.payload['audioPath']))).toEqual([
      join('C:/tmp/chunks/ps_test', 'chunk-000000.wav'),
      join('C:/tmp/chunks/ps_test', 'chunk-000001.wav'),
      join('C:/tmp/chunks/ps_test', 'chunk-000002.wav'),
    ]);
  });

  it('passes the manual language hint through the worker payload', async () => {
    const { local, requests } = provider(() => whisperResult());

    await local.transcribe({
      ...chunk('chunk-000000.wav'),
      sourceLanguage: 'es',
      sourceLanguageMode: 'manual',
    });
    await local.transcribe({
      ...chunk('chunk-000000.wav'),
      sourceLanguage: 'es',
      sourceLanguageMode: 'auto-detect',
    });

    expect(requests[0]?.payload['languageHint']).toBe('es');
    expect(requests[1]?.payload['languageHint']).toBeNull();
  });

  it('passes the multilingual small model to the worker for manual Spanish input', async () => {
    const { local, configs, requests } = provider(() => whisperResult({ detectedLanguage: 'es' }), {
      modelSize: 'small',
    });

    await local.transcribe({
      ...chunk('spanish.wav'),
      sourceLanguage: 'es',
      sourceLanguageMode: 'manual',
    });

    expect(configs[0]?.args).toContain('small');
    expect(requests[0]?.payload['languageHint']).toBe('es');
  });

  it('preserves per-segment timestamps from multi-segment whisper output', async () => {
    const { local } = provider(() =>
      whisperResult({
        segments: [
          { text: 'first sentence.', startMs: 0, endMs: 3_100 },
          { text: 'second sentence.', startMs: 3_400, endMs: 7_900 },
          { text: 'third sentence.', startMs: 8_200, endMs: 14_600 },
        ],
      }),
    );

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      segments: [
        { text: 'first sentence.', startMs: 0, endMs: 3_100 },
        { text: 'second sentence.', startMs: 3_400, endMs: 7_900 },
        { text: 'third sentence.', startMs: 8_200, endMs: 14_600 },
      ],
    });
  });

  it('drops malformed segment entries and repairs inverted timestamps', async () => {
    const { local } = provider(() =>
      whisperResult({
        segments: [
          { text: 'kept', startMs: 2_000, endMs: 1_000 },
          { startMs: 0, endMs: 500 },
          'not-a-segment',
        ],
      }),
    );

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      segments: [{ text: 'kept', startMs: 2_000, endMs: 2_000 }],
    });
  });

  it('normalises microphone WebM/Ogg chunks before transcription', async () => {
    const { local, ffmpegCalls, requests } = provider(() => whisperResult());

    await local.transcribe(chunk('mic-chunk-000000.webm'));

    expect(ffmpegCalls.map((call) => call.command)).toEqual(['ffmpeg']);
    expect(ffmpegCalls[0]?.args).toContain('16000');
    expect(ffmpegCalls[0]?.args).toContain('pcm_s16le');
    expect(String(requests[0]?.payload['audioPath'])).toContain('mic-chunk-000000.normalized.wav');
  });

  it('reuses upload WAV chunks without unnecessary conversion', async () => {
    const { local, ffmpegCalls, requests } = provider(() => whisperResult());

    await local.transcribe(chunk('chunk-000000.wav'));

    expect(ffmpegCalls).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('accepts empty speech', async () => {
    const { local } = provider(() => whisperResult({ segments: [], confidence: null }));

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      segments: [],
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
          createWorker: fakeWorkerFactory(() => whisperResult()).factory,
        }),
    ).toThrow(/model cache directory does not exist/);
  });

  it('fails clearly when Python is unavailable', async () => {
    const { local } = provider(() => {
      throw new PythonWorkerError(
        'Failed to start faster-whisper worker: spawn python ENOENT',
        'spawn-failed',
        { code: 'ENOENT' },
      );
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-python-unavailable',
      message: 'Python executable not found for faster-whisper transcription.',
    });
  });

  it('fails clearly when FFmpeg is unavailable for microphone normalisation', async () => {
    const { local } = provider(() => whisperResult(), {
      runCommand: async () => {
        const error = new Error('spawn ffmpeg ENOENT') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      },
    });

    await expect(local.transcribe(chunk('mic-chunk-000000.ogg'))).rejects.toMatchObject({
      code: 'transcription-ffmpeg-unavailable',
      message: 'FFmpeg executable not found for microphone audio normalisation.',
    });
  });

  it('fails clearly on timeout', async () => {
    const { local } = provider(() => {
      throw new PythonWorkerError(
        'faster-whisper worker request timed out after 30000 ms.',
        'timeout',
      );
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-timeout',
    });
  });

  it('fails clearly when the worker dies with a missing faster-whisper model', async () => {
    const { local } = provider(() => {
      throw new PythonWorkerError(
        'faster-whisper worker exited unexpectedly (code 1, signal null).',
        'worker-exited',
        { stderr: 'Model tiny.en not found in cache', exitCode: 1 },
      );
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-model-unavailable',
    });
  });

  it('fails clearly on provider failure', async () => {
    const { local } = provider(() => {
      throw new Error('unexpected decoder failure');
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-failed',
      message: expect.stringContaining('unexpected decoder failure'),
    });
  });

  it('does not silently fall back from GPU to CPU', async () => {
    const { local } = provider(() => whisperResult({ device: 'cpu' }), {
      device: 'cuda',
      allowGpuFallback: false,
    });

    await expect(local.transcribe(chunk('chunk-000000.wav'))).rejects.toMatchObject({
      code: 'transcription-gpu-unavailable',
    });
  });

  it('falls back from GPU to CPU only when configured, then sticks to the CPU worker', async () => {
    const { local, configs, requests } = provider(
      (_payload, config) => {
        if (workerDevice(config) === 'cuda') {
          throw new PythonWorkerError(
            'faster-whisper worker exited unexpectedly (code 1, signal null).',
            'worker-exited',
            { stderr: 'CUDA driver version is insufficient', exitCode: 1 },
          );
        }
        return whisperResult({ device: 'cpu' });
      },
      { device: 'cuda', allowGpuFallback: true },
    );

    await expect(local.transcribe(chunk('chunk-000000.wav'))).resolves.toMatchObject({
      segments: [{ text: 'hello world', startMs: 250, endMs: 2_250 }],
    });
    expect(configs.map(workerDevice)).toEqual(['cuda', 'cpu']);

    // Subsequent chunks skip the failed GPU worker entirely.
    await local.transcribe(chunk('chunk-000001.wav'));
    expect(configs.map(workerDevice)).toEqual(['cuda', 'cpu']);
    expect(requests.map((request) => workerDevice(request.config))).toEqual([
      'cuda',
      'cpu',
      'cpu',
    ]);
  });
});

describe('faster-whisper warm-up', () => {
  it('sends a silent clip through the worker with a generous cold-start budget', async () => {
    const seenOptions: Array<{ timeoutMs: number }> = [];
    const seenPayloads: Array<Record<string, unknown>> = [];
    const factory: PythonWorkerFactory = () => ({
      async request(payload, options) {
        seenPayloads.push(payload as Record<string, unknown>);
        seenOptions.push(options);
        return {
          segments: [],
          detectedLanguage: null,
          confidence: null,
          device: 'cpu',
        };
      },
      dispose() {},
    });
    const warmable = new FasterWhisperTranscriptionProvider({
      pythonExecutable: 'python',
      ffmpegExecutable: 'ffmpeg',
      modelSize: 'small',
      device: 'cpu',
      computeType: 'int8',
      modelCacheDir: null,
      allowGpuFallback: false,
      timeoutMs: 30_000,
      createWorker: factory,
    });

    await warmable.warmUp();

    expect(seenPayloads).toHaveLength(1);
    expect(String(seenPayloads[0]!['audioPath'])).toMatch(/videofy-whisper-warmup-.*\.wav$/);
    expect(seenOptions[0]!.timeoutMs).toBeGreaterThanOrEqual(300_000);
  });
});
