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
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../translation-provider.js';

const validProbe: ProbeResult = {
  durationMs: 30_000,
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
    originalName: 'monitor.mp4',
    sizeBytes: 2048,
    mimeType: 'video/mp4',
  };
}

const extractor: AudioExtractor = async (input) =>
  completedExtraction([
    chunk(input.sessionId, 0, 0, 15_000),
    chunk(input.sessionId, 1, 15_000, 30_000),
  ]);

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

function completedExtraction(chunks: AudioChunkMetadata[]): AudioExtractionMetadata {
  return {
    ...emptyAudioExtraction('completed'),
    progressPct: 100,
    chunkCount: chunks.length,
    chunks,
    completedAt: '2026-07-27T00:00:00.000Z',
  };
}

function transcriber(
  transcribe: (input: TranscriptionProviderInput) => Promise<TranscriptionProviderResult>,
): TranscriptionProvider {
  return {
    name: 'monitor-transcription',
    transcribe,
  };
}

function translator(
  translate: (input: TranslationProviderInput) => Promise<TranslationProviderResult>,
): TimestampedTranslationProvider {
  return {
    name: 'monitor-translation',
    translate,
  };
}

function store(
  options: {
    transcriptionProvider?: TranscriptionProvider;
    translationProvider?: TimestampedTranslationProvider;
    onSessionChange?: ConstructorParameters<typeof ProcessingSessionStore>[0]['onSessionChange'];
  } = {},
): ProcessingSessionStore {
  const storeOptions: ConstructorParameters<typeof ProcessingSessionStore>[0] = {
    outputBaseDir: 'C:/tmp/chunks',
    extractAudio: extractor,
    transcriptionProvider:
      options.transcriptionProvider ??
      transcriber(async (input) => ({
        sourceText: `source ${input.chunk.index}`,
        detectedLanguage: 'en',
        confidence: 0.9,
      })),
    translationProvider:
      options.translationProvider ??
      translator(async (input) => ({
        translatedText: `[${input.targetLanguage}] ${input.sourceText}`,
      })),
  };
  if (options.onSessionChange) {
    storeOptions.onSessionChange = options.onSessionChange;
  }
  return new ProcessingSessionStore(storeOptions);
}

describe('operator session monitoring and recovery', () => {
  it('pauses and resumes an active processing session', async () => {
    let release: ((value: TranscriptionProviderResult) => void) | undefined;
    let activeSessionId: string | undefined;
    const sessionStore = store({
      transcriptionProvider: transcriber(async (input) => {
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

    const paused = sessionStore.pauseSession(activeSessionId!);
    expect(paused.state).toBe('paused');
    expect(paused.monitoring.events[0]).toMatchObject({ action: 'pause', status: 'accepted' });

    const resumed = sessionStore.resumeSession(activeSessionId!);
    expect(resumed.state).toBe('processing');
    release?.({ sourceText: 'done', detectedLanguage: 'en', confidence: 0.9 });
    const completed = await created;
    expect(completed.state).toBe('completed');
  });

  it('cancels active processing without silently completing the session', async () => {
    let release: ((value: TranscriptionProviderResult) => void) | undefined;
    let activeSessionId: string | undefined;
    const sessionStore = store({
      transcriptionProvider: transcriber(async () => {
        return await new Promise<TranscriptionProviderResult>((resolve) => {
          release = resolve;
        });
      }),
      onSessionChange: (session) => {
        activeSessionId = session.id;
      },
    });

    const created = sessionStore.createFromUpload(upload(), async () => validProbe);
    await waitUntil(() => activeSessionId !== undefined);

    const cancelled = sessionStore.cancelSession(activeSessionId!);
    expect(cancelled.state).toBe('cancelled');
    release?.({ sourceText: 'cancelled', detectedLanguage: 'en', confidence: 0.9 });
    await expect(created).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('prevents invalid lifecycle transitions and records rejected actions', async () => {
    const sessionStore = store();
    const session = await sessionStore.createFromUpload(upload(), async () => validProbe);

    expect(() => sessionStore.pauseSession(session.id)).toThrow(/Only processing sessions/);
    expect(sessionStore.get(session.id)?.monitoring.events[0]).toMatchObject({
      action: 'pause',
      status: 'rejected',
    });
  });

  it('keeps failed transcription segments visible in monitoring', async () => {
    const session = await store({
      transcriptionProvider: transcriber(async (input) => {
        if (input.chunk.index === 1) throw new Error('transcription worker failed');
        return { sourceText: 'ok', detectedLanguage: 'en', confidence: 0.9 };
      }),
    }).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.monitoring.failedSegmentCount).toBe(1);
    expect(session.monitoring.lastError).toContain('transcription chunk');
    expect(session.transcription.events.find((event) => event.status === 'failed')).toBeTruthy();
  });

  it('keeps failed translation segments visible in monitoring', async () => {
    const session = await store({
      translationProvider: translator(async (input) => {
        if (input.sequence === 1) throw new Error('translation worker failed');
        return { translatedText: 'ok' };
      }),
    }).createFromUpload(upload(), async () => validProbe);

    expect(session.state).toBe('failed');
    expect(session.monitoring.failedSegmentCount).toBe(1);
    expect(session.monitoring.lastError).toContain('translation segment');
    expect(session.translation.events.find((event) => event.status === 'failed')).toBeTruthy();
  });

  it('records retry success as a recovery event', async () => {
    const attempts = new Map<number, number>();
    const sessionStore = store({
      translationProvider: translator(async (input) => {
        const current = attempts.get(input.sequence) ?? 0;
        attempts.set(input.sequence, current + 1);
        if (input.sequence === 1 && current === 0) throw new Error('first retry target failed');
        return { translatedText: `ok ${input.sequence}` };
      }),
    });
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedSegment = failed.translation.events.find((event) => event.status === 'failed')!;

    const recovered = await sessionStore.retryTranslationSegment(
      failed.id,
      failedSegment.segmentId,
    );

    expect(recovered.state).toBe('completed');
    expect(recovered.monitoring.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'retry-translation',
          status: 'succeeded',
          segmentId: failedSegment.segmentId,
        }),
      ]),
    );
  });

  it('records retry failure and last error without silent failure', async () => {
    const sessionStore = store({
      translationProvider: translator(async () => {
        throw new Error('retry provider failed');
      }),
    });
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedSegment = failed.translation.events[0]!;

    const retried = await sessionStore.retryTranslationSegment(failed.id, failedSegment.segmentId);

    expect(retried.state).toBe('failed');
    expect(retried.monitoring.lastError).toContain('translation segment');
    expect(retried.monitoring.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'retry-translation', status: 'failed' }),
      ]),
    );
  });

  it('prevents duplicate retries while a retry is active', async () => {
    let release: ((value: TranslationProviderResult) => void) | undefined;
    let retryAttempt = 0;
    const sessionStore = store({
      translationProvider: translator(async () => {
        retryAttempt += 1;
        if (retryAttempt <= 2) throw new Error('initial translation failed');
        return await new Promise<TranslationProviderResult>((resolve) => {
          release = resolve;
        });
      }),
    });
    const failed = await sessionStore.createFromUpload(upload(), async () => validProbe);
    const failedSegment = failed.translation.events[0]!;

    const retry = sessionStore.retryTranslationSegment(failed.id, failedSegment.segmentId);
    await waitUntil(
      () =>
        sessionStore
          .get(failed.id)
          ?.translation.events.some((event) => event.status === 'retrying') === true,
    );

    await expect(
      sessionStore.retryTranslationSegment(failed.id, failedSegment.segmentId),
    ).rejects.toMatchObject({ code: 'duplicate-processing' });

    release?.({ translatedText: 'recovered' });
    await retry;
  });

  it('calculates overall progress from extraction, transcription and translation', async () => {
    const session = await store({
      transcriptionProvider: transcriber(async (input) => {
        if (input.chunk.index === 1) throw new Error('middle transcription failed');
        return { sourceText: 'ok', detectedLanguage: 'en', confidence: 0.9 };
      }),
    }).createFromUpload(upload(), async () => validProbe);

    expect(session.monitoring.overallProgressPct).toBe(40);
    expect(session.monitoring.currentStage).toBe('failed');
  });

  it('summarizes average and latest translation latency', async () => {
    const session = await store().createFromUpload(upload(), async () => validProbe);

    expect(session.monitoring.averageLatencyMs).not.toBeNull();
    expect(session.monitoring.latestLatencyMs).not.toBeNull();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for monitoring condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
