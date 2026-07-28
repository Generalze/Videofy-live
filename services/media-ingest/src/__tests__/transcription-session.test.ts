import type { AudioChunkMetadata, AudioExtractionMetadata } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
  type UploadedMediaFile,
} from '../media-session.js';
import { MockTimestampedTranslationProvider } from '../translation-provider.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderInput,
  TranscriptionProviderResult,
} from '../transcription-provider.js';

const validProbe: ProbeResult = {
  durationMs: 31_000,
  hasAudio: true,
  hasVideo: true,
  codecs: [
    { type: 'video', codecName: 'h264' },
    { type: 'audio', codecName: 'aac' },
  ],
};

function upload(): UploadedMediaFile {
  return {
    path: 'C:/tmp/upload',
    originalName: 'clip.mp4',
    sizeBytes: 2048,
    mimeType: 'video/mp4',
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

function store(provider: TranscriptionProvider, timeoutMs = 30_000): ProcessingSessionStore {
  return new ProcessingSessionStore({
    outputBaseDir: 'C:/tmp/chunks',
    extractAudio: extractor,
    transcriptionProvider: provider,
    transcriptionTimeoutMs: timeoutMs,
  });
}

function provider(
  transcribe: (input: TranscriptionProviderInput) => Promise<TranscriptionProviderResult>,
): TranscriptionProvider {
  return {
    name: 'test',
    transcribe,
  };
}

describe('timestamped transcription sessions', () => {
  it('transcribes ready chunks successfully', async () => {
    const session = await store(
      provider(async (input) => ({
        sourceText: `text ${input.chunk.index}`,
        detectedLanguage: 'en',
        confidence: 0.9,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('completed');
    expect(session.transcription).toMatchObject({
      status: 'transcribed',
      totalChunks: 3,
      transcribedChunks: 3,
      failedChunks: 0,
      detectedLanguage: 'en',
      progressPct: 100,
    });
  });

  it('preserves correct chunk ordering', async () => {
    const session = await store(
      provider(async (input) => ({
        sourceText: `ordered ${input.chunk.index}`,
        detectedLanguage: 'en',
        confidence: null,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.transcription.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(session.transcription.events.map((event) => event.sourceText)).toEqual([
      'ordered 0',
      'ordered 1',
      'ordered 2',
    ]);
  });

  it('preserves chunk timestamps', async () => {
    const session = await store(
      provider(async () => ({
        sourceText: 'timestamped',
        detectedLanguage: 'en',
        confidence: 0.8,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.transcription.events.map((event) => [event.startMs, event.endMs])).toEqual([
      [0, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
  });

  it('accepts empty speech as a transcribed chunk', async () => {
    const session = await store(
      provider(async () => ({
        sourceText: '',
        detectedLanguage: 'en',
        confidence: null,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.transcription.events.every((event) => event.status === 'transcribed')).toBe(
      true,
    );
    expect(session.transcription.events.every((event) => event.sourceText === '')).toBe(true);
  });

  it('marks chunks failed on provider timeout', async () => {
    const session = await store(
      provider(async () => await new Promise<TranscriptionProviderResult>(() => undefined)),
      1,
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.transcription.failedChunks).toBe(3);
    expect(session.transcription.events[0]?.error).toMatch(/timed out/);
  });

  it('marks chunks failed on provider failure', async () => {
    const session = await store(
      provider(async () => {
        throw new Error('provider unavailable');
      }),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.transcription.failedChunks).toBe(3);
    expect(session.transcription.events[0]?.error).toBe('provider unavailable');
  });

  it('supports retrying a failed chunk without restarting the session', async () => {
    const attempts = new Map<number, number>();
    const sessionStore = store(
      provider(async (input) => {
        const current = attempts.get(input.chunk.index) ?? 0;
        attempts.set(input.chunk.index, current + 1);
        if (input.chunk.index === 1 && current === 0) {
          throw new Error('first attempt failed');
        }
        return {
          sourceText: `retry ${input.chunk.index}`,
          detectedLanguage: 'en',
          confidence: 0.95,
        };
      }),
    );
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedChunk = failed.transcription.events.find((event) => event.status === 'failed')!;

    const retried = await sessionStore.retryTranscriptionChunk(failed.id, failedChunk.chunkId);

    expect(retried.state).toBe('completed');
    expect(retried.transcription.failedChunks).toBe(0);
    expect(retried.transcription.transcribedChunks).toBe(3);
  });

  it('rejects duplicate processing while a chunk is active', async () => {
    let release: ((value: TranscriptionProviderResult) => void) | undefined;
    let activeSessionId: string | undefined;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: 'C:/tmp/chunks',
      extractAudio: extractor,
      transcriptionProvider: provider(async (input) => {
        if (input.chunk.index > 0) {
          return { sourceText: 'done', detectedLanguage: 'en', confidence: 0.9 };
        }
        return await new Promise<TranscriptionProviderResult>((resolve) => {
          release = resolve;
        });
      }),
      onSessionChange: (session) => {
        if (session.transcription.events.some((event) => event.status === 'transcribing')) {
          activeSessionId = session.id;
        }
      },
    });

    const created = sessionStore.createFromUpload(upload(), async () => validProbe);
    await waitUntil(() => activeSessionId !== undefined);

    await expect(sessionStore.startTranscription(activeSessionId!)).rejects.toMatchObject({
      code: 'duplicate-processing',
    });

    release?.({ sourceText: 'done', detectedLanguage: 'en', confidence: 0.9 });
    await created;
  });

  it('preserves partial session failure while successful chunks remain transcribed', async () => {
    const session = await store(
      provider(async (input) => {
        if (input.chunk.index === 1) throw new Error('middle failed');
        return {
          sourceText: `ok ${input.chunk.index}`,
          detectedLanguage: 'en',
          confidence: 0.9,
        };
      }),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.transcription.transcribedChunks).toBe(2);
    expect(session.transcription.failedChunks).toBe(1);
    expect(session.transcription.events.map((event) => event.status)).toEqual([
      'transcribed',
      'failed',
      'transcribed',
    ]);
  });

  it('exports a completed transcript in timestamp order', async () => {
    const sessionStore = store(
      provider(async (input) => ({
        sourceText: `line ${input.chunk.index}`,
        detectedLanguage: 'en',
        confidence: 0.9,
      })),
    );
    const session = await sessionStore.createFromUpload(upload(), async () => validProbe);

    expect(sessionStore.exportTranscript(session.id)).toBe(
      '[00:00.000 - 00:15.000] line 0\n[00:15.000 - 00:30.000] line 1\n[00:30.000 - 00:31.000] line 2',
    );
  });

  it('stores manual source language and passes it to the transcription provider', async () => {
    const seen: Array<{ language?: string; mode?: string }> = [];
    const session = await store(
      provider(async (input) => {
        seen.push({
          ...(input.sourceLanguage ? { language: input.sourceLanguage } : {}),
          ...(input.sourceLanguageMode ? { mode: input.sourceLanguageMode } : {}),
        });
        return {
          sourceText: 'manual language',
          detectedLanguage: 'en',
          confidence: 0.98,
        };
      }),
    ).createFromUpload(
      {
        ...upload(),
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        targetLanguage: 'fr',
      },
      async () => validProbe,
    );

    expect(seen.every((item) => item.language === 'en' && item.mode === 'manual')).toBe(true);
    expect(session.sourceLanguageControl).toMatchObject({
      activeLanguage: 'en',
      mode: 'manual',
      status: 'manual',
      revision: 0,
    });
    expect(session.transcription.sourceLanguageRevision).toBe(0);
  });

  it('marks low-confidence auto-detect results for confirmation without switching silently', async () => {
    const session = await store(
      provider(async () => ({
        sourceText: 'low confidence language',
        detectedLanguage: 'pt',
        confidence: 0.5,
      })),
    ).createFromUpload(
      {
        ...upload(),
        sourceLanguageMode: 'auto-detect',
        targetLanguage: 'fr',
      },
      async () => validProbe,
    );

    expect(session.sourceLanguageControl).toMatchObject({
      activeLanguage: 'en',
      detectedLanguage: 'pt',
      detectionConfidence: 0.5,
      status: 'needs-confirmation',
      revision: 0,
    });
  });

  it('creates a language revision boundary on operator override', async () => {
    const sessionStore = store(
      provider(async () => ({
        sourceText: 'source',
        detectedLanguage: 'en',
        confidence: 0.99,
      })),
    );
    const session = await sessionStore.createFromUpload(upload(), async () => validProbe);

    const updated = sessionStore.updateSourceLanguageControl(session.id, {
      action: 'override',
      language: 'pt',
    });

    expect(updated.sourceLanguageControl).toMatchObject({
      activeLanguage: 'pt',
      revision: 1,
      status: 'manual',
    });
    expect(updated.translation.events).toEqual([]);
    expect(updated.generatedAudio.events).toEqual([]);
  });

  it('locks and unlocks the confirmed source language without changing revision', async () => {
    const sessionStore = store(
      provider(async () => ({
        sourceText: 'source',
        detectedLanguage: 'en',
        confidence: 0.99,
      })),
    );
    const session = await sessionStore.createFromUpload(
      {
        ...upload(),
        sourceLanguageMode: 'auto-detect',
      },
      async () => validProbe,
    );

    const locked = sessionStore.updateSourceLanguageControl(session.id, { action: 'lock' });
    expect(locked.sourceLanguageControl).toMatchObject({
      activeLanguage: 'en',
      locked: true,
      status: 'locked',
      revision: 0,
    });

    const unlocked = sessionStore.updateSourceLanguageControl(session.id, { action: 'unlock' });
    expect(unlocked.sourceLanguageControl).toMatchObject({
      activeLanguage: 'en',
      locked: false,
      mode: 'auto-detect',
      status: 'detecting',
      revision: 0,
    });
  });

  it('supports configured text-only target languages without failing translated text', async () => {
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: 'C:/tmp/chunks',
      extractAudio: async (input) => completedExtraction([chunk(input.sessionId, 0, 0, 1000)]),
      transcriptionProvider: provider(async () => ({
        sourceText: 'hello',
        detectedLanguage: 'en',
        confidence: 0.99,
      })),
      translationProvider: new MockTimestampedTranslationProvider(['yo', 'fr']),
      translationSupportedTargetLanguages: ['yo', 'fr'],
      textToSpeechSupportedLanguages: ['fr'],
    });

    const session = await sessionStore.createFromUpload(
      {
        ...upload(),
        targetLanguage: 'yo',
        targetLanguages: ['yo', 'fr'],
      },
      async () => validProbe,
    );

    expect(session.translation.status).toBe('translated');
    expect(session.generatedAudio).toMatchObject({
      status: 'generated',
      providerStatus: 'text-only',
      textOnlyLanguages: ['yo'],
      totalSegments: 1,
    });
    expect(session.targetLanguageCatalogue.find((item) => item.language === 'yo')).toMatchObject({
      textOnly: true,
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
