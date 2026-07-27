import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaIngestError, ProcessingSessionStore } from '../media-session.js';
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function transcriber(
  transcribe: (input: TranscriptionProviderInput) => Promise<TranscriptionProviderResult>,
): TranscriptionProvider {
  return { name: 'mic-transcriber', transcribe };
}

function translator(
  translate: (input: TranslationProviderInput) => Promise<TranslationProviderResult>,
): TimestampedTranslationProvider {
  return { name: 'mic-translator', translate };
}

async function store(
  options: {
    transcribe?: (input: TranscriptionProviderInput) => Promise<TranscriptionProviderResult>;
    translate?: (input: TranslationProviderInput) => Promise<TranslationProviderResult>;
  } = {},
): Promise<ProcessingSessionStore> {
  const outputBaseDir = await mkdtemp(join(tmpdir(), 'videofy-mic-'));
  tempDirs.push(outputBaseDir);
  return new ProcessingSessionStore({
    outputBaseDir,
    transcriptionProvider: transcriber(
      options.transcribe ??
        (async (input) => ({
          sourceText: `mic text ${input.chunk.index}`,
          detectedLanguage: 'en',
          confidence: 0.92,
        })),
    ),
    translationProvider: translator(
      options.translate ??
        (async (input) => ({
          translatedText: `${input.targetLanguage}:${input.sourceText}`,
        })),
    ),
    translationTargetLanguage: 'fr',
  });
}

describe('microphone capture sessions', () => {
  it('starts, pauses, resumes and stops a browser microphone session', async () => {
    const sessions = await store();
    const created = await sessions.createMicrophoneSession({
      deviceId: 'device-1',
      deviceLabel: 'USB microphone',
      targetLanguage: 'fr',
    });

    expect(created).toMatchObject({
      sourceKind: 'microphone',
      state: 'processing',
      microphoneCapture: {
        status: 'capturing',
        deviceId: 'device-1',
        deviceLabel: 'USB microphone',
      },
    });

    expect(sessions.pauseSession(created.id).microphoneCapture.status).toBe('paused');
    expect(sessions.resumeSession(created.id).microphoneCapture.status).toBe('capturing');
    expect(sessions.stopMicrophoneSession(created.id)).toMatchObject({
      state: 'completed',
      microphoneCapture: { status: 'stopped' },
    });
  });

  it('accepts ordered chunks with continuous timestamps and reuses transcription/translation flow', async () => {
    const sessions = await store();
    const session = await sessions.createMicrophoneSession({ targetLanguage: 'es' });

    const afterFirst = await sessions.ingestMicrophoneChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      mimeType: 'audio/webm;codecs=opus',
      sizeBytes: 1200,
    });
    const afterSecond = await sessions.ingestMicrophoneChunk(session.id, {
      sequence: 1,
      startMs: 15_000,
      endMs: 22_500,
      mimeType: 'audio/webm;codecs=opus',
      sizeBytes: 900,
    });

    expect(afterFirst.state).toBe('processing');
    expect(afterSecond.microphoneCapture.chunks.map((chunk) => chunk.startMs)).toEqual([0, 15_000]);
    expect(afterSecond.microphoneCapture.chunks.map((chunk) => chunk.endMs)).toEqual([
      15_000,
      22_500,
    ]);
    expect(afterSecond.transcription.events.map((event) => event.sourceText)).toEqual([
      'mic text 0',
      'mic text 1',
    ]);
    expect(afterSecond.translation.events.map((event) => event.translatedText)).toEqual([
      'es:mic text 0',
      'es:mic text 1',
    ]);
    expect(afterSecond.monitoring.currentStage).toBe('microphone-capture');
  });

  it('rejects timestamp gaps or overlaps with a visible failed session', async () => {
    const sessions = await store();
    const session = await sessions.createMicrophoneSession();
    await sessions.ingestMicrophoneChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      mimeType: 'audio/webm',
      sizeBytes: 1200,
    });

    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 1,
        startMs: 16_000,
        endMs: 20_000,
        mimeType: 'audio/webm',
        sizeBytes: 600,
      }),
    ).rejects.toMatchObject({
      code: 'audio-timeline-invalid',
      session: {
        state: 'failed',
        microphoneCapture: { status: 'failed' },
        monitoring: { lastError: expect.stringContaining('gap or overlap') },
      },
    });
  });

  it('prevents duplicate active microphone sessions', async () => {
    const sessions = await store();
    await sessions.createMicrophoneSession();

    await expect(sessions.createMicrophoneSession()).rejects.toMatchObject({
      code: 'duplicate-processing',
    });
  });

  it('prevents duplicate chunk processing while a chunk is active', async () => {
    let release!: (value: TranscriptionProviderResult) => void;
    const active = new Promise<TranscriptionProviderResult>((resolve) => {
      release = resolve;
    });
    const sessions = await store({ transcribe: async () => active });
    const session = await sessions.createMicrophoneSession();

    const first = sessions.ingestMicrophoneChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      mimeType: 'audio/webm',
      sizeBytes: 1200,
    });
    await Promise.resolve();

    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 1,
        startMs: 15_000,
        endMs: 30_000,
        mimeType: 'audio/webm',
        sizeBytes: 1200,
      }),
    ).rejects.toMatchObject({ code: 'duplicate-processing' });

    release({ sourceText: 'done', detectedLanguage: 'en', confidence: 0.8 });
    await first;
  });

  it('marks missing or corrupt microphone audio as failed', async () => {
    const sessions = await store();
    const session = await sessions.createMicrophoneSession();

    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 0,
        startMs: 0,
        endMs: 15_000,
        mimeType: 'audio/webm',
        sizeBytes: 0,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-media',
      session: {
        state: 'failed',
        microphoneCapture: { status: 'failed' },
      },
    });
  });

  it('keeps translation failures visible for recovery', async () => {
    const sessions = await store({
      translate: async () => {
        throw new MediaIngestError('translation unavailable', 'translation-failed', 502);
      },
    });
    const session = await sessions.createMicrophoneSession();

    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 0,
        startMs: 0,
        endMs: 15_000,
        mimeType: 'audio/webm',
        sizeBytes: 1200,
      }),
    ).rejects.toMatchObject({
      session: {
        state: 'failed',
        translation: { failedSegments: 1 },
        monitoring: { failedSegmentCount: 1 },
      },
    });
  });

  it('handles device disconnection and blocks further chunk ingest', async () => {
    const sessions = await store();
    const session = await sessions.createMicrophoneSession();

    expect(sessions.failMicrophoneDeviceDisconnected(session.id)).toMatchObject({
      state: 'failed',
      microphoneCapture: {
        status: 'failed',
        error: 'Microphone device disconnected.',
      },
    });
    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 0,
        startMs: 0,
        endMs: 15_000,
        mimeType: 'audio/webm',
        sizeBytes: 1200,
      }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
  });

  it('cancels capture sessions and keeps cleanup state explicit', async () => {
    const sessions = await store();
    const session = await sessions.createMicrophoneSession();
    await sessions.ingestMicrophoneChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 5_000,
      mimeType: 'audio/webm',
      sizeBytes: 500,
    });

    const cancelled = sessions.cancelSession(session.id);

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      microphoneCapture: {
        status: 'cancelled',
        durationMs: 5_000,
      },
    });
    await expect(
      sessions.ingestMicrophoneChunk(session.id, {
        sequence: 1,
        startMs: 5_000,
        endMs: 10_000,
        mimeType: 'audio/webm',
        sizeBytes: 500,
      }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });
  });
});
