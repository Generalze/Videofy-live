import type { AudioExtractionMetadata, AudioChunkMetadata } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  MediaIngestError,
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
  type ProcessingSession,
  type UploadedMediaFile,
} from '../media-session.js';

const validVideoProbe: ProbeResult = {
  durationMs: 31_000,
  hasAudio: true,
  hasVideo: true,
  codecs: [
    { type: 'video', codecName: 'h264' },
    { type: 'audio', codecName: 'aac' },
  ],
};

const validAudioProbe: ProbeResult = {
  durationMs: 16_000,
  hasAudio: true,
  hasVideo: false,
  codecs: [{ type: 'audio', codecName: 'mp3' }],
};

const successfulExtractor: AudioExtractor = async (input) =>
  completedExtraction([
    chunk(0, 0, 15_000),
    chunk(1, 15_000, 30_000),
    chunk(2, 30_000, input.expectedDurationMs),
  ]);

function upload(overrides: Partial<UploadedMediaFile> = {}): UploadedMediaFile {
  return {
    path: 'C:/tmp/upload',
    originalName: 'clip.mp4',
    sizeBytes: 2048,
    mimeType: 'video/mp4',
    ...overrides,
  };
}

function store(extractAudio: AudioExtractor = successfulExtractor): ProcessingSessionStore {
  return new ProcessingSessionStore({
    outputBaseDir: 'C:/tmp/chunks',
    extractAudio,
  });
}

function chunk(index: number, startMs: number, endMs: number): AudioChunkMetadata {
  return {
    chunkId: `ps_test:chunk:${index}`,
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

describe('ProcessingSessionStore', () => {
  it('accepts a valid video upload, extracts audio and stores chunk metadata', async () => {
    const session = await store().createFromUpload(upload(), async () => validVideoProbe);

    expect(session.state).toBe('completed');
    expect(session.media).toMatchObject({
      filename: 'clip.mp4',
      fileSizeBytes: 2048,
      mimeType: 'video/mp4',
      durationMs: 31_000,
      hasAudio: true,
      hasVideo: true,
    });
    expect(session.audioExtraction).toMatchObject({
      status: 'completed',
      chunkCount: 3,
      progressPct: 100,
    });
    expect(session.transcription).toMatchObject({
      status: 'transcribed',
      totalChunks: 3,
      transcribedChunks: 3,
      failedChunks: 0,
    });
    expect(session.audioExtraction.chunks.map((item) => [item.startMs, item.endMs])).toEqual([
      [0, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
  });

  it('accepts a valid audio upload and converts it through the same extraction path', async () => {
    const session = await store(async (input) =>
      completedExtraction([chunk(0, 0, 15_000), chunk(1, 15_000, input.expectedDurationMs)]),
    ).createFromUpload(
      upload({ originalName: 'speech.mp3', mimeType: 'audio/mpeg' }),
      async () => validAudioProbe,
    );

    expect(session.state).toBe('completed');
    expect(session.media).toMatchObject({
      filename: 'speech.mp3',
      hasAudio: true,
      hasVideo: false,
    });
    expect(session.audioExtraction.chunkCount).toBe(2);
    expect(session.transcription.transcribedChunks).toBe(2);
  });

  it('rejects an unsupported extension', async () => {
    await expect(
      store().createFromUpload(upload({ originalName: 'notes.txt', mimeType: 'text/plain' })),
    ).rejects.toMatchObject({
      code: 'unsupported-extension',
      message: 'Unsupported media type. Upload MP4, MOV, MP3, or WAV.',
    });
  });

  it('rejects unsafe filenames and path traversal', async () => {
    await expect(
      store().createFromUpload(upload({ originalName: '../clip.mp4' })),
    ).rejects.toMatchObject({
      code: 'unsafe-filename',
      message: 'Unsafe media filename rejected.',
    });
  });

  it('rejects corrupt media before extraction', async () => {
    await expect(
      store().createFromUpload(upload(), async () => {
        throw new MediaIngestError('Invalid or corrupt media: probe failed', 'invalid-media', 400);
      }),
    ).rejects.toMatchObject({
      code: 'invalid-media',
      message: 'Invalid or corrupt media: probe failed',
    });
  });

  it('rejects video with missing audio', async () => {
    await expect(
      store().createFromUpload(upload(), async () => ({
        ...validVideoProbe,
        hasAudio: false,
        codecs: [{ type: 'video', codecName: 'h264' }],
      })),
    ).rejects.toMatchObject({
      code: 'invalid-media',
      message: 'Invalid video media: no audio stream was found.',
    });
  });

  it('creates a stream ID and processing-session record with success states', async () => {
    const changes: string[] = [];
    const session = await new ProcessingSessionStore({
      outputBaseDir: 'C:/tmp/chunks',
      extractAudio: successfulExtractor,
      onSessionChange: (next) => {
        changes.push(next.state);
      },
    }).createFromUpload(upload(), async () => validVideoProbe);

    expect(session.id).toMatch(/^ps_/);
    expect(session.streamId).toMatch(/^stream_/);
    expect(changes.at(0)).toBe('created');
    expect(changes).toContain('validating');
    expect(changes).toContain('ready');
    expect(changes).toContain('processing');
    expect(changes.at(-1)).toBe('completed');
  });

  it('records session failure state when FFmpeg extraction fails', async () => {
    const failingExtractor: AudioExtractor = async () => {
      throw new MediaIngestError(
        'FFmpeg audio extraction failed: test failure',
        'audio-extraction-failed',
        500,
      );
    };

    await expect(
      store(failingExtractor).createFromUpload(upload(), async () => validVideoProbe),
    ).rejects.toMatchObject({
      code: 'audio-extraction-failed',
      session: {
        state: 'failed',
        audioExtraction: {
          status: 'failed',
          error: 'FFmpeg audio extraction failed: test failure',
        },
      },
    });
  });

  it('protects against duplicate processing on a completed session', async () => {
    const sessionStore = store();
    const session = await sessionStore.createFromUpload(upload(), async () => validVideoProbe);

    await expect(sessionStore.startAudioExtraction(session.id)).rejects.toMatchObject({
      code: 'duplicate-processing',
    });
  });

  it('protects against duplicate submissions', async () => {
    const sessionStore = store();
    await sessionStore.createFromUpload(upload(), async () => validVideoProbe);

    await expect(
      sessionStore.createFromUpload(upload(), async () => validVideoProbe),
    ).rejects.toMatchObject({
      code: 'duplicate-submission',
    });
  });

  it('cleans failed processing artifacts and leaves the source session retryable', async () => {
    let failedSession: ProcessingSession | undefined;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: 'C:/tmp/chunks',
      extractAudio: async () => {
        throw new MediaIngestError(
          'FFmpeg audio extraction failed: test failure',
          'audio-extraction-failed',
          500,
        );
      },
      cleanupAudio: async (_outputBaseDir, sessionId) => {
        expect(sessionId).toBe(failedSession?.id);
      },
    });

    try {
      await sessionStore.createFromUpload(upload(), async () => validVideoProbe);
    } catch (error) {
      if (error instanceof MediaIngestError) {
        failedSession = error.session as ProcessingSession;
      }
    }

    expect(failedSession?.state).toBe('failed');
    const cleaned = await sessionStore.cleanupFailedAudio(failedSession!.id);

    expect(cleaned.state).toBe('ready');
    expect(cleaned.audioExtraction).toMatchObject({
      status: 'cleaned',
      chunkCount: 0,
    });
  });
});
