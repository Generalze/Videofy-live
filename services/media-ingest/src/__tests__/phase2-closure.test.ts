import type { AudioChunkMetadata, AudioExtractionMetadata } from '@videofy-live/shared-types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
  type UploadedMediaFile,
} from '../media-session.js';
import {
  FasterWhisperTranscriptionProvider,
  type CommandRunner as TranscriptionCommandRunner,
} from '../transcription-provider.js';
import {
  ArgosTimestampedTranslationProvider,
  type CommandRunner as TranslationCommandRunner,
} from '../translation-provider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const videoProbe: ProbeResult = {
  durationMs: 31_000,
  hasAudio: true,
  hasVideo: true,
  codecs: [
    { type: 'video', codecName: 'h264' },
    { type: 'audio', codecName: 'aac' },
  ],
};

const audioProbe: ProbeResult = {
  durationMs: 16_000,
  hasAudio: true,
  hasVideo: false,
  codecs: [{ type: 'audio', codecName: 'mp3' }],
};

function upload(overrides: Partial<UploadedMediaFile> = {}): UploadedMediaFile {
  return {
    path: 'C:/tmp/source-media',
    originalName: 'phase2.mp4',
    sizeBytes: 4096,
    mimeType: 'video/mp4',
    targetLanguage: 'es',
    ...overrides,
  };
}

function chunk(
  sessionId: string,
  index: number,
  startMs: number,
  endMs: number,
): AudioChunkMetadata {
  return {
    chunkId: `${sessionId}:chunk:${index}`,
    index,
    filename: `chunk-${String(index).padStart(6, '0')}.wav`,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    status: 'ready',
  };
}

const threeChunkExtractor: AudioExtractor = async (input) =>
  completedExtraction([
    chunk(input.sessionId, 0, 0, 15_000),
    chunk(input.sessionId, 1, 15_000, 30_000),
    chunk(input.sessionId, 2, 30_000, input.expectedDurationMs),
  ]);

const audioExtractor: AudioExtractor = async (input) =>
  completedExtraction([
    chunk(input.sessionId, 0, 0, 15_000),
    chunk(input.sessionId, 1, 15_000, input.expectedDurationMs),
  ]);

function completedExtraction(chunks: AudioChunkMetadata[]): AudioExtractionMetadata {
  return {
    ...emptyAudioExtraction('completed'),
    progressPct: 100,
    chunkCount: chunks.length,
    chunks,
    completedAt: '2026-07-27T00:00:00.000Z',
  };
}

async function phase2Store(options: {
  extractAudio?: AudioExtractor;
  transcribe?: TranscriptionCommandRunner;
  translate?: TranslationCommandRunner;
  cleanupAudio?: ConstructorParameters<typeof ProcessingSessionStore>[0]['cleanupAudio'];
  onSessionChange?: ConstructorParameters<typeof ProcessingSessionStore>[0]['onSessionChange'];
} = {}): Promise<ProcessingSessionStore> {
  const outputBaseDir = await mkdtemp(join(tmpdir(), 'videofy-phase2-'));
  tempDirs.push(outputBaseDir);
  const transcribeRunner = options.transcribe ?? successfulWhisper;
  const storeOptions: ConstructorParameters<typeof ProcessingSessionStore>[0] = {
    outputBaseDir,
    extractAudio: options.extractAudio ?? threeChunkExtractor,
    transcriptionProvider: new FasterWhisperTranscriptionProvider({
      pythonExecutable: 'python',
      ffmpegExecutable: 'ffmpeg',
      modelSize: 'tiny',
      device: 'cpu',
      computeType: 'int8',
      modelCacheDir: null,
      allowGpuFallback: false,
      timeoutMs: 30_000,
      // FFmpeg normalisation still runs through the command seam.
      runCommand: transcribeRunner,
      // Transcription itself now flows through the persistent worker; adapt it
      // back onto the same runner so the scenarios keep one injection point.
      createWorker: () => ({
        request: async (payload, requestOptions) => {
          const audioPath = String((payload as { audioPath?: unknown }).audioPath ?? '');
          const result = await transcribeRunner(
            'python',
            ['-c', 'faster-whisper-worker', audioPath],
            { timeoutMs: requestOptions.timeoutMs },
          );
          return JSON.parse(result.stdout) as unknown;
        },
        dispose: () => undefined,
      }),
    }),
    translationProvider: new ArgosTimestampedTranslationProvider({
      pythonExecutable: 'python',
      packageDir: null,
      supportedTargetLanguages: ['fr', 'es', 'de'],
      timeoutMs: 30_000,
      runCommand: options.translate ?? successfulArgos,
    }),
    translationSupportedTargetLanguages: ['fr', 'es', 'de'],
    translationTargetLanguage: 'fr',
  };
  if (options.cleanupAudio) storeOptions.cleanupAudio = options.cleanupAudio;
  if (options.onSessionChange) storeOptions.onSessionChange = options.onSessionChange;
  return new ProcessingSessionStore(storeOptions);
}

const successfulWhisper: TranscriptionCommandRunner = async (command, args) => {
  if (command === 'ffmpeg') return { stdout: '', stderr: '' };
  const audioPath = String(args[2]);
  return {
    stdout: JSON.stringify({
      segments: [
        {
          text: `transcript ${basename(audioPath).replace(/\.normalized\.wav$|\.wav$|\.webm$|\.ogg$/, '')}`,
          startMs: 0,
          endMs: 15_000,
        },
      ],
      detectedLanguage: 'en',
      confidence: 0.93,
      device: 'cpu',
    }),
    stderr: '',
  };
};

const successfulArgos: TranslationCommandRunner = async (_command, args) => ({
  stdout: JSON.stringify({ translatedText: `${args[3]}:${args[4]}` }),
  stderr: '',
});

describe('Phase 2 closure validation', () => {
  it('validates uploaded video through faster-whisper transcription and Argos translation', async () => {
    const session = await (
      await phase2Store()
    ).createFromUpload(upload({ targetLanguage: 'es' }), async () => videoProbe);

    expect(session.state).toBe('completed');
    expect(session.media).toMatchObject({ hasAudio: true, hasVideo: true });
    expect(session.targetLanguage).toBe('es');
    expect(session.transcription.events.every((event) => event.providerLatencyMs !== null)).toBe(
      true,
    );
    expect(session.translation).toMatchObject({
      providerName: 'argos',
      providerStatus: 'ready',
      targetLanguage: 'es',
      failedSegments: 0,
      progressPct: 100,
    });
    assertContinuousTimeline(session.audioExtraction.chunks);
    assertOrdered(session.transcription.events.map((event) => event.sequence));
    assertOrdered(session.translation.events.map((event) => event.sequence));
    expect(new Set(session.audioExtraction.chunks.map((item) => item.chunkId)).size).toBe(
      session.audioExtraction.chunkCount,
    );
    expect(session.monitoring.overallProgressPct).toBe(100);
    expect(session.monitoring.averageLatencyMs).not.toBeNull();
  });

  it('validates uploaded audio with the same timestamped pipeline and exports', async () => {
    const store = await phase2Store({ extractAudio: audioExtractor });
    const session = await store.createFromUpload(
      upload({ originalName: 'phase2.mp3', mimeType: 'audio/mpeg', targetLanguage: 'fr' }),
      async () => audioProbe,
    );

    expect(session.state).toBe('completed');
    expect(session.media).toMatchObject({ hasAudio: true, hasVideo: false });
    assertContinuousTimeline(session.audioExtraction.chunks);
    expect(store.exportTranscript(session.id)).toContain('[00:00.000 - 00:15.000]');
    expect(store.exportPairedTranslation(session.id)).toContain('fr:transcript chunk-000000');
  });

  it('validates browser microphone chunks without gaps, duplicates or target-language drift', async () => {
    const whisperCalls: string[] = [];
    const store = await phase2Store({
      transcribe: async (command, args, options) => {
        whisperCalls.push(command);
        return await successfulWhisper(command, args, options);
      },
    });
    const created = await store.createMicrophoneSession({ targetLanguage: 'de' });
    const first = await store.ingestMicrophoneChunk(created.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      mimeType: 'audio/webm;codecs=opus',
      sizeBytes: 2048,
    });
    const second = await store.ingestMicrophoneChunk(created.id, {
      sequence: 1,
      startMs: 15_000,
      endMs: 21_000,
      mimeType: 'audio/ogg',
      sizeBytes: 1024,
    });

    expect(first.monitoring.currentStage).toBe('microphone-capture');
    expect(second.translation.events.every((event) => event.targetLanguage === 'de')).toBe(true);
    assertContinuousTimeline(second.audioExtraction.chunks);
    expect(whisperCalls).toEqual(['ffmpeg', 'python', 'ffmpeg', 'python']);
    expect(store.stopMicrophoneSession(created.id).state).toBe('completed');
    expect(store.exportPairedTranslation(created.id)).toContain('de:transcript mic-chunk-000000');
  });

  it('validates visible provider failure, retry recovery, latency and no silent fallback', async () => {
    const attempts = new Map<number, number>();
    const store = await phase2Store({
      translate: async (_command, args) => {
        const sequence = Number(String(args[4]).match(/chunk-(\d+)/)?.[1] ?? 0);
        const current = attempts.get(sequence) ?? 0;
        attempts.set(sequence, current + 1);
        if (sequence === 1 && current === 0) {
          throw new Error('argos provider unavailable');
        }
        return { stdout: JSON.stringify({ translatedText: `${args[3]}:${args[4]}` }), stderr: '' };
      },
    });
    const failed = await store.createFromUpload(upload({ targetLanguage: 'fr' }), async () => videoProbe);
    const failedSegment = failed.translation.events.find((event) => event.status === 'failed')!;

    expect(failed.state).toBe('failed');
    expect(failed.translation.providerName).toBe('argos');
    expect(failed.translation.providerStatus).toBe('failed');
    expect(failed.translation.events.some((event) => event.translatedText.startsWith('[fr]'))).toBe(
      false,
    );
    expect(failed.monitoring.lastError).toContain('translation segment');

    const recovered = await store.retryTranslationSegment(failed.id, failedSegment.segmentId);

    expect(recovered.state).toBe('completed');
    expect(recovered.translation.failedSegments).toBe(0);
    expect(recovered.monitoring.latestLatencyMs).not.toBeNull();
    expect(store.exportPairedTranslation(recovered.id)).toContain('fr:transcript chunk-000001');
  });

  it('validates pause, resume, cancel and failure cleanup behaviour', async () => {
    let release: ((value: { stdout: string; stderr: string }) => void) | undefined;
    let activeSessionId: string | undefined;
    let transcribeCalls = 0;
    const store = await phase2Store({
      transcribe: async (command, args, options) => {
        if (command === 'ffmpeg') return await successfulWhisper(command, args, options);
        if (transcribeCalls > 0) {
          transcribeCalls += 1;
          return await successfulWhisper(command, args, options);
        }
        transcribeCalls += 1;
        return await new Promise((resolve) => {
          release = resolve;
        });
      },
      onSessionChange: (session) => {
        if (session.transcription.events.some((event) => event.status === 'transcribing')) {
          activeSessionId = session.id;
        }
      },
    });

    const created = store.createFromUpload(upload({ originalName: 'pause.mp4' }), async () => videoProbe);
    await waitUntil(() => activeSessionId !== undefined);
    expect(store.pauseSession(activeSessionId!).state).toBe('paused');
    expect(store.resumeSession(activeSessionId!).state).toBe('processing');
    release?.({
      stdout: JSON.stringify({
        segments: [{ text: 'resumed transcript', startMs: 0, endMs: 15_000 }],
        detectedLanguage: 'en',
        confidence: 0.9,
        device: 'cpu',
      }),
      stderr: '',
    });
    expect((await created).state).toBe('completed');

    let cleanedSessionId = '';
    const failingStore = await phase2Store({
      extractAudio: async () => {
        throw new Error('validation extraction failed');
      },
      cleanupAudio: async (_outputBaseDir, sessionId) => {
        cleanedSessionId = sessionId;
      },
    });
    const failed = await failingStore
      .createFromUpload(upload({ originalName: 'cleanup.mp4' }), async () => videoProbe)
      .catch((error: unknown) => {
        if (error && typeof error === 'object' && 'session' in error) {
          return error.session as ReturnType<ProcessingSessionStore['get']>;
        }
        throw error;
      });
    expect(failed?.state).toBe('failed');
    const cleaned = await failingStore.cleanupFailedAudio(failed!.id);
    expect(cleaned.state).toBe('ready');
    expect(cleanedSessionId).toBe(failed!.id);

    let cancelRelease: ((value: { stdout: string; stderr: string }) => void) | undefined;
    let cancelSessionId: string | undefined;
    const cancelStore = await phase2Store({
      transcribe: async () =>
        await new Promise((resolve) => {
          cancelRelease = resolve;
        }),
      onSessionChange: (session) => {
        cancelSessionId = session.id;
      },
    });
    const cancelledRun = cancelStore.createFromUpload(
      upload({ originalName: 'cancel.mp4' }),
      async () => videoProbe,
    );
    await waitUntil(() => cancelSessionId !== undefined);
    expect(cancelStore.cancelSession(cancelSessionId!).state).toBe('cancelled');
    cancelRelease?.({
      stdout: JSON.stringify({
        segments: [{ text: 'late result', startMs: 0, endMs: 15_000 }],
        detectedLanguage: 'en',
        confidence: 0.9,
        device: 'cpu',
      }),
      stderr: '',
    });
    await expect(cancelledRun).resolves.toMatchObject({ state: 'cancelled' });
  });
});

function assertContinuousTimeline(chunks: AudioChunkMetadata[]): void {
  let previousEndMs = 0;
  for (const [index, item] of chunks.entries()) {
    expect(item.index).toBe(index);
    expect(item.startMs).toBe(previousEndMs);
    expect(item.endMs).toBeGreaterThan(item.startMs);
    expect(item.durationMs).toBe(item.endMs - item.startMs);
    previousEndMs = item.endMs;
  }
}

function assertOrdered(values: number[]): void {
  expect(values).toEqual(values.slice().sort((a, b) => a - b));
  expect(new Set(values).size).toBe(values.length);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for Phase 2 validation condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
