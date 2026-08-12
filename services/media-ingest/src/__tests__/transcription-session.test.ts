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

function wholeChunkSegments(input: TranscriptionProviderInput, text: string) {
  return [{ text, startMs: 0, endMs: input.chunk.endMs - input.chunk.startMs }];
}

describe('timestamped transcription sessions', () => {
  it('transcribes ready chunks successfully', async () => {
    const session = await store(
      provider(async (input) => ({
        segments: wholeChunkSegments(input, `text ${input.chunk.index}`),
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
        segments: wholeChunkSegments(input, `ordered ${input.chunk.index}`),
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
      provider(async (input) => ({
        segments: wholeChunkSegments(input, 'timestamped'),
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

  it('fans out one transcription event per whisper segment with absolute timestamps', async () => {
    const session = await store(
      provider(async (input) => ({
        segments:
          input.chunk.index === 0
            ? [
                { text: 'first sentence.', startMs: 0, endMs: 4_000 },
                { text: 'second sentence.', startMs: 4_500, endMs: 9_000 },
                { text: 'third sentence.', startMs: 9_500, endMs: 16_000 },
              ]
            : wholeChunkSegments(input, `chunk ${input.chunk.index}`),
        detectedLanguage: 'en',
        confidence: 0.9,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('completed');
    expect(session.transcription.events).toHaveLength(5);
    expect(session.transcription.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(session.transcription.events.map((event) => event.chunkId)).size).toBe(5);
    expect(
      session.transcription.events.map((event) => event.chunkId.slice(event.chunkId.indexOf(':chunk:'))),
    ).toEqual([':chunk:0-s0', ':chunk:0-s1', ':chunk:0-s2', ':chunk:1-s0', ':chunk:2-s0']);
    expect(session.transcription.events.map((event) => [event.startMs, event.endMs])).toEqual([
      [0, 4_000],
      [4_500, 9_000],
      [9_500, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
    expect(session.transcription.events.map((event) => event.sourceText)).toEqual([
      'first sentence.',
      'second sentence.',
      'third sentence.',
      'chunk 1',
      'chunk 2',
    ]);
  });

  it('skips empty or whitespace-only speech segments and completes cleanly', async () => {
    const session = await store(
      provider(async () => ({
        segments: [{ text: '   ', startMs: 0, endMs: 1_000 }],
        detectedLanguage: 'en',
        confidence: null,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('completed');
    expect(session.transcription).toMatchObject({ status: 'transcribed', progressPct: 100 });
    expect(session.transcription.events).toEqual([]);
    expect(session.translation.events).toEqual([]);
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
          segments: wholeChunkSegments(input, `retry ${input.chunk.index}`),
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

  it('renumbers fan-out sequences into timeline order after a chunk retry', async () => {
    const attempts = new Map<number, number>();
    const sessionStore = store(
      provider(async (input) => {
        const current = attempts.get(input.chunk.index) ?? 0;
        attempts.set(input.chunk.index, current + 1);
        if (input.chunk.index === 1 && current === 0) {
          throw new Error('first attempt failed');
        }
        return {
          segments:
            input.chunk.index === 0
              ? [
                  { text: 'chunk0 first.', startMs: 0, endMs: 7_000 },
                  { text: 'chunk0 second.', startMs: 7_000, endMs: 15_000 },
                ]
              : wholeChunkSegments(input, `chunk${input.chunk.index} text`),
          detectedLanguage: 'en',
          confidence: 0.95,
        };
      }),
    );
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedChunk = failed.transcription.events.find((event) => event.status === 'failed')!;

    const retried = await sessionStore.retryTranscriptionChunk(failed.id, failedChunk.chunkId);

    expect(retried.state).toBe('completed');
    // The retried chunk's fan-out lands back in its timeline position with
    // contiguous 0-based sequences instead of trailing the counter.
    expect(retried.transcription.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(retried.transcription.events.map((event) => event.sourceText)).toEqual([
      'chunk0 first.',
      'chunk0 second.',
      'chunk1 text',
      'chunk2 text',
    ]);
    expect(sessionStore.exportTranscript(failed.id)).toBe(
      '[00:00.000 - 00:07.000] chunk0 first.\n' +
        '[00:07.000 - 00:15.000] chunk0 second.\n' +
        '[00:15.000 - 00:30.000] chunk1 text\n' +
        '[00:30.000 - 00:31.000] chunk2 text',
    );
    // Downstream passes inherit the timeline order, and the generated-audio
    // channel keeps its contiguous 0-based per-language sequence contract.
    expect(retried.translation.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(retried.translation.events.map((event) => event.sourceText)).toEqual([
      'chunk0 first.',
      'chunk0 second.',
      'chunk1 text',
      'chunk2 text',
    ]);
    expect(retried.generatedAudio.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(retried.generatedAudio.events.map((event) => event.audioFilename)).toEqual([
      'tts-000000.wav',
      'tts-000001.wav',
      'tts-000002.wav',
      'tts-000003.wav',
    ]);
  });

  it('rejects duplicate processing while a chunk is active', async () => {
    let release: ((value: TranscriptionProviderResult) => void) | undefined;
    let activeSessionId: string | undefined;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: 'C:/tmp/chunks',
      extractAudio: extractor,
      transcriptionProvider: provider(async (input) => {
        if (input.chunk.index > 0) {
          return {
            segments: wholeChunkSegments(input, 'done'),
            detectedLanguage: 'en',
            confidence: 0.9,
          };
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

    release?.({
      segments: [{ text: 'done', startMs: 0, endMs: 15_000 }],
      detectedLanguage: 'en',
      confidence: 0.9,
    });
    await created;
  });

  it('preserves partial session failure while successful chunks remain transcribed', async () => {
    const session = await store(
      provider(async (input) => {
        if (input.chunk.index === 1) throw new Error('middle failed');
        return {
          segments: wholeChunkSegments(input, `ok ${input.chunk.index}`),
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
        segments: wholeChunkSegments(input, `line ${input.chunk.index}`),
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
          segments: wholeChunkSegments(input, 'manual language'),
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
      provider(async (input) => ({
        segments: wholeChunkSegments(input, 'low confidence language'),
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
      provider(async (input) => ({
        segments: wholeChunkSegments(input, 'source'),
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
      provider(async (input) => ({
        segments: wholeChunkSegments(input, 'source'),
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
      transcriptionProvider: provider(async (input) => ({
        segments: wholeChunkSegments(input, 'hello'),
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
