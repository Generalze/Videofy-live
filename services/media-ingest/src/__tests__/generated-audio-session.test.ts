import type {
  AudioChunkMetadata,
  AudioExtractionMetadata,
  GeneratedAudioEvent,
} from '@videofy-live/shared-types';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
  type UploadedMediaFile,
} from '../media-session.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
  TextToSpeechProviderResult,
} from '../text-to-speech-provider.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderInput,
  TranscriptionProviderResult,
} from '../transcription-provider.js';
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../translation-provider.js';

const tempDirs: string[] = [];

const validProbe: ProbeResult = {
  durationMs: 31_000,
  hasAudio: true,
  hasVideo: true,
  codecs: [
    { type: 'video', codecName: 'h264' },
    { type: 'audio', codecName: 'aac' },
  ],
};

function upload(overrides: Partial<UploadedMediaFile> = {}): UploadedMediaFile {
  return {
    path: 'C:/tmp/upload',
    originalName: 'clip.mp4',
    sizeBytes: 2048,
    mimeType: 'video/mp4',
    targetLanguage: 'es',
    ...overrides,
  };
}

function chunk(sessionId: string, index: number, startMs: number, endMs: number): AudioChunkMetadata {
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

const extractor: AudioExtractor = async (input) =>
  completedExtraction([
    chunk(input.sessionId, 0, 0, 15_000),
    chunk(input.sessionId, 1, 15_000, 30_000),
    chunk(input.sessionId, 2, 30_000, 31_000),
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

function transcriptionProvider(): TranscriptionProvider {
  return {
    name: 'test-transcription',
    transcribe: async (input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> => ({
      sourceText: `source ${input.chunk.index}`,
      detectedLanguage: 'en',
      confidence: 0.9,
    }),
  };
}

function translationProvider(): TimestampedTranslationProvider {
  return {
    name: 'test-translation',
    translate: async (input: TranslationProviderInput): Promise<TranslationProviderResult> => ({
      translatedText: `${input.targetLanguage}:source ${input.sequence}`,
    }),
  };
}

function ttsProvider(
  generate: (input: TextToSpeechProviderInput) => Promise<TextToSpeechProviderResult>,
): TextToSpeechProvider {
  return {
    name: 'test-tts',
    generate,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-tts-session-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTestWav(filePath: string, durationMs = 100): Promise<void> {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = Math.max(1, Math.round((sampleRate * channels * bytesPerSample * durationMs) / 1000));
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
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  await writeFile(filePath, buffer);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sessionStore(
  provider: TextToSpeechProvider,
  options: {
    targetLanguage?: string;
    supportedLanguages?: readonly string[];
    voiceId?: string;
    timeoutMs?: number;
    onSessionChange?: ConstructorParameters<typeof ProcessingSessionStore>[0]['onSessionChange'];
    onGeneratedAudioReady?: ConstructorParameters<
      typeof ProcessingSessionStore
    >[0]['onGeneratedAudioReady'];
  } = {},
): Promise<{ store: ProcessingSessionStore; outputBaseDir: string }> {
  const outputBaseDir = await tempDir();
  const storeOptions: ConstructorParameters<typeof ProcessingSessionStore>[0] = {
    outputBaseDir,
    extractAudio: extractor,
    transcriptionProvider: transcriptionProvider(),
    translationProvider: translationProvider(),
    translationTargetLanguage: options.targetLanguage ?? 'es',
    translationSupportedTargetLanguages: ['es', 'fr'],
    textToSpeechProvider: provider,
    textToSpeechTimeoutMs: options.timeoutMs ?? 30_000,
    textToSpeechVoiceId: options.voiceId ?? 'es-test',
    textToSpeechSupportedLanguages: options.supportedLanguages ?? ['es', 'fr'],
  };
  if (options.onSessionChange) storeOptions.onSessionChange = options.onSessionChange;
  if (options.onGeneratedAudioReady) {
    storeOptions.onGeneratedAudioReady = options.onGeneratedAudioReady;
  }
  return { store: new ProcessingSessionStore(storeOptions), outputBaseDir };
}

describe('generated-audio sessions', () => {
  it('generates one audio file for each translated segment', async () => {
    const { store, outputBaseDir } = await sessionStore(
      ttsProvider(async (input) => {
        await writeTestWav(input.outputPath, 100 + input.sequence);
        return { audioPath: input.outputPath, providerLatencyMs: 7 };
      }),
    );

    const session = await store.createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('completed');
    expect(session.generatedAudio).toMatchObject({
      status: 'generated',
      totalSegments: 3,
      generatedSegments: 3,
      failedSegments: 0,
      targetLanguage: 'es',
      voiceId: 'es-test',
      progressPct: 100,
    });
    for (const event of session.generatedAudio.events) {
      const audioPath = join(
        outputBaseDir,
        session.id,
        'tts',
        event.targetLanguage,
        event.audioFilename,
      );
      expect((await readFile(audioPath)).toString('ascii', 0, 4)).toBe('RIFF');
      expect(event.durationMs).not.toBeNull();
    }
  });

  it('preserves timestamps and sequence metadata', async () => {
    const { store } = await sessionStore(
      ttsProvider(async (input) => {
        await writeTestWav(input.outputPath);
        return { audioPath: input.outputPath, providerLatencyMs: 3 };
      }),
    );

    const session = await store.createFromUpload(upload(), async () => validProbe);

    expect(session.generatedAudio.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(session.generatedAudio.events.map((event) => [event.startMs, event.endMs])).toEqual([
      [0, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
    expect(session.generatedAudio.events.every((event) => event.targetLanguage === 'es')).toBe(true);
    expect(session.generatedAudio.events.every((event) => event.providerLatencyMs === 3)).toBe(true);
  });

  it('keeps voice output separate by language and preserves caption-only channels', async () => {
    const generatedLanguages: string[] = [];
    const { store, outputBaseDir } = await sessionStore(
      ttsProvider(async (input) => {
        generatedLanguages.push(input.targetLanguage);
        await writeTestWav(input.outputPath);
        return { audioPath: input.outputPath, providerLatencyMs: 4 };
      }),
      { supportedLanguages: ['es'] },
    );

    const session = await store.createFromUpload(
      upload({ targetLanguages: ['es', 'fr'] }),
      async () => validProbe,
    );

    expect(session.state).toBe('completed');
    expect(session.translation.events).toHaveLength(6);
    expect(generatedLanguages).toEqual(['es', 'es', 'es']);
    expect(session.generatedAudio.textOnlyLanguages).toEqual(['fr']);
    expect(session.generatedAudio.events).toHaveLength(3);
    expect(session.generatedAudio.events.every((event) => event.targetLanguage === 'es')).toBe(true);
    expect(
      existsSync(
        join(
          outputBaseDir,
          session.id,
          'tts',
          'es',
          session.generatedAudio.events[0]?.audioFilename ?? '',
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(outputBaseDir, session.id, 'tts', 'fr'))).toBe(false);
  });

  it('publishes generated-audio ready events and resolves safe WAV delivery metadata', async () => {
    const readyEvents: GeneratedAudioEvent[] = [];
    const { store, outputBaseDir } = await sessionStore(
      ttsProvider(async (input) => {
        await writeTestWav(input.outputPath, 250 + input.sequence);
        return { audioPath: input.outputPath, providerLatencyMs: 11 };
      }),
      { onGeneratedAudioReady: (event) => readyEvents.push(event) },
    );

    const session = await store.createFromUpload(upload(), async () => validProbe);
    const firstEvent = session.generatedAudio.events[0];
    expect(firstEvent).toBeDefined();
    expect(readyEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(readyEvents).toHaveLength(new Set(readyEvents.map((event) => event.segmentId)).size);
    expect(readyEvents[0]).toMatchObject({
      sessionId: session.id,
      streamId: session.streamId,
      segmentId: firstEvent?.segmentId,
      sequence: 0,
      targetLanguage: 'es',
      voiceId: 'es-test',
      providerLatencyMs: 11,
    });

    const file = await store.getGeneratedAudioFile(session.id, firstEvent?.segmentId ?? '');
    expect(file).toMatchObject({
      sessionId: session.id,
      segmentId: firstEvent?.segmentId,
      sequence: 0,
      targetLanguage: 'es',
      voiceId: 'es-test',
      providerLatencyMs: 11,
    });
    expect(file.audioPath.startsWith(join(outputBaseDir, session.id))).toBe(true);
    expect(file.sizeBytes).toBeGreaterThan(44);
    expect(file.durationMs).toBeGreaterThan(0);
  });

  it('rejects missing, wrong-session and unsafe generated-audio delivery requests', async () => {
    const { store, outputBaseDir } = await sessionStore(
      ttsProvider(async (input) => {
        await writeTestWav(input.outputPath);
        return { audioPath: input.outputPath, providerLatencyMs: 5 };
      }),
    );
    const session = await store.createFromUpload(upload(), async () => validProbe);
    const segmentId = session.generatedAudio.events[0]?.segmentId ?? '';

    await expect(store.getGeneratedAudioFile(session.id, '../segment')).rejects.toMatchObject({
      code: 'unsafe-path',
    });
    await expect(store.getGeneratedAudioFile('ps_missing', segmentId)).rejects.toMatchObject({
      code: 'invalid-transition',
      statusCode: 404,
    });

    await rm(join(outputBaseDir, session.id), { recursive: true, force: true });
    await expect(store.getGeneratedAudioFile(session.id, segmentId)).rejects.toMatchObject({
      code: 'generated-audio-unavailable',
      statusCode: 404,
    });
  });

  it('keeps translated text-only output when no approved voice exists and rejects unsupported voice clearly', async () => {
    const unsupportedLanguage = await sessionStore(
      ttsProvider(async (input) => {
        await writeTestWav(input.outputPath);
        return { audioPath: input.outputPath };
      }),
      { supportedLanguages: ['es'], targetLanguage: 'fr' },
    );

    const textOnlySession = await unsupportedLanguage.store.createFromUpload(
      upload({ targetLanguage: 'fr' }),
      async () => validProbe,
    );
    expect(textOnlySession.translation.status).toBe('translated');
    expect(textOnlySession.generatedAudio).toMatchObject({
      status: 'generated',
      providerStatus: 'text-only',
      textOnlyLanguages: ['fr'],
    });

    const unsupportedVoice = await sessionStore(
      ttsProvider(async () => {
        throw new Error('Unsupported Piper voice: missing.');
      }),
      { voiceId: 'missing' },
    );
    const voiceSession = await unsupportedVoice.store.createFromUpload(
      upload({ originalName: 'voice.mp4' }),
      async () => validProbe,
    );
    expect(voiceSession.state).toBe('failed');
    expect(voiceSession.generatedAudio.events[0]?.error).toBe('Unsupported Piper voice: missing.');
  });

  it('marks timeout and provider failure without silent fallback', async () => {
    const timeout = await sessionStore(
      ttsProvider(async () => await new Promise<TextToSpeechProviderResult>(() => undefined)),
      { timeoutMs: 1 },
    );
    const timedOut = await timeout.store.createFromUpload(upload(), async () => validProbe);
    expect(timedOut.state).toBe('failed');
    expect(timedOut.generatedAudio.status).toBe('failed');
    expect(timedOut.generatedAudio.events[0]?.error).toMatch(/timed out/);

    const failed = await sessionStore(
      ttsProvider(async () => {
        throw new Error('piper failed');
      }),
    );
    const failedSession = await failed.store.createFromUpload(
      upload({ originalName: 'provider.mp4' }),
      async () => validProbe,
    );
    expect(failedSession.state).toBe('failed');
    expect(failedSession.generatedAudio.failedSegments).toBe(3);
  });

  it('retries failed generated-audio segments', async () => {
    const attempts = new Map<number, number>();
    const { store } = await sessionStore(
      ttsProvider(async (input) => {
        const current = attempts.get(input.sequence) ?? 0;
        attempts.set(input.sequence, current + 1);
        if (input.sequence === 1 && current === 0) throw new Error('first TTS failed');
        await writeTestWav(input.outputPath);
        return { audioPath: input.outputPath, providerLatencyMs: 5 };
      }),
    );
    const failed = await store.createFromUpload(upload(), async () => validProbe);
    const failedSegmentId =
      failed.generatedAudio.events.find((event) => event.status === 'failed')?.segmentId ?? '';

    const retried = await store.retryGeneratedAudioSegment(failed.id, failedSegmentId);

    expect(retried.state).toBe('completed');
    expect(retried.generatedAudio.failedSegments).toBe(0);
    expect(retried.generatedAudio.generatedSegments).toBe(3);
  });

  it('prevents duplicate generated-audio processing', async () => {
    let release: ((value: TextToSpeechProviderResult) => void) | undefined;
    let activeSessionId = '';
    let activeSegmentId = '';
    const { store } = await sessionStore(
      ttsProvider(async (input) => {
        if (input.sequence > 0) {
          await writeTestWav(input.outputPath);
          return { audioPath: input.outputPath };
        }
        return await new Promise<TextToSpeechProviderResult>((resolve) => {
          release = async (value) => {
            await writeTestWav(input.outputPath);
            resolve(value);
          };
        });
      }),
      {
        onSessionChange: (session) => {
          const active = session.generatedAudio.events.find((event) => event.status === 'generating');
          if (active) {
            activeSessionId = session.id;
            activeSegmentId = active.segmentId;
          }
        },
      },
    );

    const created = store.createFromUpload(upload(), async () => validProbe);
    await waitUntil(() => activeSessionId !== '' && activeSegmentId !== '');

    await expect(store.retryGeneratedAudioSegment(activeSessionId, activeSegmentId)).rejects.toMatchObject({
      code: 'duplicate-processing',
    });

    release?.({ audioPath: 'released', providerLatencyMs: 1 });
    await created;
  });

  it('cleans failed partial output before exposing failed state', async () => {
    let partialPath = '';
    const { store } = await sessionStore(
      ttsProvider(async (input) => {
        partialPath = input.outputPath;
        await writeFile(input.outputPath, 'partial');
        throw new Error('write failed');
      }),
    );

    const session = await store.createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(partialPath).not.toBe('');
    expect(existsSync(partialPath)).toBe(false);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
