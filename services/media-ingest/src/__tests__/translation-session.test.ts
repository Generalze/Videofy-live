import type { AudioChunkMetadata, AudioExtractionMetadata } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
  type UploadedMediaFile,
} from '../media-session.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderInput,
  TranscriptionProviderResult,
} from '../transcription-provider.js';
import {
  MockTimestampedTranslationProvider,
  type TimestampedTranslationProvider,
  type TranslationProviderInput,
  type TranslationProviderResult,
} from '../translation-provider.js';

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

function transcriptionProvider(
  transcribe: (input: TranscriptionProviderInput) => Promise<TranscriptionProviderResult>,
): TranscriptionProvider {
  return {
    name: 'test-transcription',
    transcribe,
  };
}

function translationProvider(
  translate: (input: TranslationProviderInput) => Promise<TranslationProviderResult>,
): TimestampedTranslationProvider {
  return {
    name: 'test-translation',
    translate,
  };
}

function store(
  translator: TimestampedTranslationProvider,
  options: {
    transcriber?: TranscriptionProvider;
    timeoutMs?: number;
    targetLanguage?: string;
    supportedTargetLanguages?: readonly string[];
    onSessionChange?: ConstructorParameters<typeof ProcessingSessionStore>[0]['onSessionChange'];
  } = {},
): ProcessingSessionStore {
  const storeOptions: ConstructorParameters<typeof ProcessingSessionStore>[0] = {
    outputBaseDir: 'C:/tmp/chunks',
    extractAudio: extractor,
    transcriptionProvider:
      options.transcriber ??
      transcriptionProvider(async (input) => ({
        sourceText: `source ${input.chunk.index}`,
        detectedLanguage: 'en',
        confidence: 0.9,
      })),
    translationProvider: translator,
    translationTimeoutMs: options.timeoutMs ?? 30_000,
    translationTargetLanguage: options.targetLanguage ?? 'fr',
  };
  if (options.supportedTargetLanguages) {
    storeOptions.translationSupportedTargetLanguages = options.supportedTargetLanguages;
  }
  if (options.onSessionChange) {
    storeOptions.onSessionChange = options.onSessionChange;
  }
  return new ProcessingSessionStore(storeOptions);
}

describe('timestamped translation sessions', () => {
  it('translates transcribed segments successfully', async () => {
    const session = await store(
      translationProvider(async (input) => ({
        translatedText: `${input.targetLanguage}:${input.sourceText}`,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('completed');
    expect(session.translation).toMatchObject({
      status: 'translated',
      totalSegments: 3,
      translatedSegments: 3,
      failedSegments: 0,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      progressPct: 100,
    });
    expect(session.translation.events.every((event) => event.status === 'translated')).toBe(true);
  });

  it('stores the selected target language on the session', async () => {
    const session = await store(
      new MockTimestampedTranslationProvider(['fr', 'es']),
    ).createFromUpload(upload({ targetLanguage: 'es' }), async () => validProbe);

    expect(session.targetLanguage).toBe('es');
    expect(session.translation.targetLanguage).toBe('es');
    expect(session.translation.events.every((event) => event.targetLanguage === 'es')).toBe(true);
  });

  it('allows two sessions to use different target languages', async () => {
    const sessionStore = store(new MockTimestampedTranslationProvider(['fr', 'de']));

    const french = await sessionStore.createFromUpload(
      upload({ originalName: 'clip-fr.mp4', targetLanguage: 'fr' }),
      async () => validProbe,
    );
    const german = await sessionStore.createFromUpload(
      upload({ originalName: 'clip-de.mp4', targetLanguage: 'de' }),
      async () => validProbe,
    );

    expect(french.targetLanguage).toBe('fr');
    expect(german.targetLanguage).toBe('de');
    expect(french.translation.events[0]?.translatedText).toBe('[fr] source 0');
    expect(german.translation.events[0]?.translatedText).toBe('[de] source 0');
  });

  it('preserves source timestamps', async () => {
    const session = await store(
      translationProvider(async (input) => ({
        translatedText: `[${input.targetLanguage}] ${input.sourceText}`,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.translation.events.map((event) => [event.startMs, event.endMs])).toEqual([
      [0, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
  });

  it('preserves segment ordering', async () => {
    const session = await store(
      translationProvider(async (input) => ({
        translatedText: `ordered ${input.sequence}`,
      })),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.translation.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(session.translation.events.map((event) => event.translatedText)).toEqual([
      'ordered 0',
      'ordered 1',
      'ordered 2',
    ]);
  });

  it('keeps empty source text as an empty translation', async () => {
    const session = await store(new MockTimestampedTranslationProvider(['fr']), {
      transcriber: transcriptionProvider(async () => ({
        sourceText: '',
        detectedLanguage: 'en',
        confidence: null,
      })),
    }).createFromUpload(upload(), async () => validProbe);

    expect(session.translation.events.every((event) => event.status === 'translated')).toBe(true);
    expect(session.translation.events.every((event) => event.sourceText === '')).toBe(true);
    expect(session.translation.events.every((event) => event.translatedText === '')).toBe(true);
  });

  it('rejects an unsupported target language clearly', async () => {
    await expect(
      store(new MockTimestampedTranslationProvider(['es']), {
        targetLanguage: 'es',
        supportedTargetLanguages: ['es'],
      }).createFromUpload(upload({ targetLanguage: 'fr' }), async () => validProbe),
    ).rejects.toMatchObject({
      code: 'unsupported-language',
      message: 'Unsupported target language: fr. Supported languages: es.',
    });
  });

  it('marks segments failed on provider timeout', async () => {
    const session = await store(
      translationProvider(
        async () => await new Promise<TranslationProviderResult>(() => undefined),
      ),
      { timeoutMs: 1 },
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.translation.failedSegments).toBe(3);
    expect(session.translation.events[0]?.error).toMatch(/timed out/);
  });

  it('marks segments failed on provider failure', async () => {
    const session = await store(
      translationProvider(async () => {
        throw new Error('provider unavailable');
      }),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.translation.failedSegments).toBe(3);
    expect(session.translation.events[0]?.error).toBe('provider unavailable');
  });

  it('supports retrying a failed segment without restarting the session', async () => {
    const attempts = new Map<number, number>();
    const sessionStore = store(
      translationProvider(async (input) => {
        const current = attempts.get(input.sequence) ?? 0;
        attempts.set(input.sequence, current + 1);
        if (input.sequence === 1 && current === 0) {
          throw new Error('first translation failed');
        }
        return {
          translatedText: `retry ${input.sequence}`,
        };
      }),
    );
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedSegment = failed.translation.events.find((event) => event.status === 'failed')!;

    const retried = await sessionStore.retryTranslationSegment(failed.id, failedSegment.segmentId);

    expect(retried.state).toBe('completed');
    expect(retried.translation.failedSegments).toBe(0);
    expect(retried.translation.translatedSegments).toBe(3);
    expect(retried.translation.events[1]?.translatedText).toBe('retry 1');
  });

  it('rejects duplicate processing while a segment is active', async () => {
    let release: ((value: TranslationProviderResult) => void) | undefined;
    let activeSessionId: string | undefined;
    let activeSegmentId: string | undefined;
    const sessionStore = store(
      translationProvider(async (input) => {
        if (input.sequence > 0) {
          return { translatedText: 'done' };
        }
        return await new Promise<TranslationProviderResult>((resolve) => {
          release = resolve;
        });
      }),
      {
        onSessionChange: (session) => {
          const active = session.translation.events.find((event) => event.status === 'translating');
          if (active) {
            activeSessionId = session.id;
            activeSegmentId = active.segmentId;
          }
        },
      },
    );

    const created = sessionStore.createFromUpload(upload(), async () => validProbe);
    await waitUntil(() => activeSessionId !== undefined && activeSegmentId !== undefined);

    await expect(
      sessionStore.retryTranslationSegment(activeSessionId!, activeSegmentId!),
    ).rejects.toMatchObject({
      code: 'duplicate-processing',
    });

    release?.({ translatedText: 'done' });
    await created;
  });

  it('preserves partial failure while successful segments remain translated', async () => {
    const session = await store(
      translationProvider(async (input) => {
        if (input.sequence === 1) throw new Error('middle failed');
        return {
          translatedText: `ok ${input.sequence}`,
        };
      }),
    ).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.translation.translatedSegments).toBe(2);
    expect(session.translation.failedSegments).toBe(1);
    expect(session.translation.events.map((event) => event.status)).toEqual([
      'translated',
      'failed',
      'translated',
    ]);
  });

  it('exports paired source and translated text in timestamp order', async () => {
    const sessionStore = store(new MockTimestampedTranslationProvider(['fr']));
    const session = await sessionStore.createFromUpload(upload(), async () => validProbe);

    expect(sessionStore.exportPairedTranslation(session.id)).toBe(
      '[00:00.000 - 00:15.000]\nen: source 0\nfr: [fr] source 0\n\n[00:15.000 - 00:30.000]\nen: source 1\nfr: [fr] source 1\n\n[00:30.000 - 00:31.000]\nen: source 2\nfr: [fr] source 2',
    );
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
