import type { AudioExtractionMetadata, AudioChunkMetadata } from '@videofy-live/shared-types';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

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

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-ingest-webrtc-'));
  tempDirs.push(dir);
  return dir;
}

async function createStagedWav(stagingDir: string, filename: string): Promise<string> {
  const path = join(stagingDir, filename);
  await writeFile(path, wavFixture());
  return path;
}

function wavFixture(): Buffer {
  const samples = Buffer.alloc(320);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
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

  it('can create an upload processing session with a requested safe session ID', async () => {
    const session = await store().createFromUpload(
      upload({ requestedSessionId: 'wrs_uploaded_video' }),
      async () => validVideoProbe,
    );

    expect(session.id).toBe('wrs_uploaded_video');
    expect(session.sourceKind).toBe('upload');
    expect(session.state).toBe('completed');
  });

  it('resolves uploaded source media for session-bound playback', async () => {
    const temp = await createTempDir();
    const sourcePath = join(temp, 'clip.mp4');
    const source = Buffer.from('uploaded source media');
    await writeFile(sourcePath, source);
    const sessionStore = store();
    const session = await sessionStore.createFromUpload(
      upload({
        path: sourcePath,
        requestedSessionId: 'wrs_uploaded_video',
      }),
      async () => validVideoProbe,
    );

    const file = await sessionStore.getSourceMediaFile(session.id);

    expect(file).toEqual({
      mediaPath: sourcePath,
      mimeType: 'video/mp4',
      sizeBytes: source.length,
    });
  });

  it('renders and resolves viewer-ready uploaded video media after generated audio completes', async () => {
    const outputDir = await createTempDir();
    const temp = await createTempDir();
    const sourcePath = join(temp, 'clip.mp4');
    await writeFile(sourcePath, Buffer.from('uploaded source media'));
    const renderCalls: Array<{ segmentCount: number; originalVolume: number; translatedVolume: number }> = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      extractAudio: successfulExtractor,
      renderViewerReadyMediaOnCompletion: true,
      renderViewerReadyMedia: async (input) => {
        renderCalls.push({
          segmentCount: input.segments.length,
          originalVolume: input.originalVolume,
          translatedVolume: input.translatedVolume,
        });
        await mkdir(dirname(input.outputPath), { recursive: true });
        await writeFile(input.outputPath, Buffer.from('viewer-ready mp4'));
      },
    });
    const session = await sessionStore.createFromUpload(
      upload({
        path: sourcePath,
        requestedSessionId: 'wrs_viewer_ready',
      }),
      async () => validVideoProbe,
    );

    const file = await sessionStore.getViewerReadyMediaFile(session.id);

    expect(session.state).toBe('completed');
    expect(renderCalls).toEqual([{ segmentCount: 3, originalVolume: 0.2, translatedVolume: 1 }]);
    expect(file).toEqual({
      mediaPath: join(outputDir, session.id, 'viewer-ready', 'programme.mp4'),
      mimeType: 'video/mp4',
      sizeBytes: 'viewer-ready mp4'.length,
    });
  });

  it('rejects source-media delivery for unavailable or unsafe sessions', async () => {
    const sessionStore = store();

    await expect(sessionStore.getSourceMediaFile('../bad-session')).rejects.toMatchObject({
      code: 'unsafe-path',
    });
    await expect(sessionStore.getSourceMediaFile('wrs_missing')).rejects.toMatchObject({
      code: 'invalid-transition',
    });
  });

  it('rejects unsafe or duplicate requested upload session IDs', async () => {
    const sessionStore = store();
    await expect(
      sessionStore.createFromUpload(
        upload({ requestedSessionId: '../bad-session' }),
        async () => validVideoProbe,
      ),
    ).rejects.toMatchObject({
      code: 'unsafe-filename',
      message: 'Unsafe requested session ID rejected.',
    });

    await sessionStore.createFromUpload(
      upload({ requestedSessionId: 'wrs_uploaded_video' }),
      async () => validVideoProbe,
    );

    await expect(
      sessionStore.createFromUpload(
        upload({
          originalName: 'second.mp4',
          sizeBytes: 4096,
          requestedSessionId: 'wrs_uploaded_video',
        }),
        async () => validVideoProbe,
      ),
    ).rejects.toMatchObject({
      code: 'duplicate-processing',
      message: 'Processing session wrs_uploaded_video already exists.',
    });
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

  it('creates a WebRTC programme session and runs transcription, translation and generated audio', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const events: string[] = [];
    const translations: string[] = [];
    const generatedAudioReady: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'es',
      translationSupportedTargetLanguages: ['es', 'fr'],
      textToSpeechSupportedLanguages: ['es', 'fr'],
      onTranscriptionEvent: (event) => events.push(`${event.sequence}:${event.status}`),
      onTranslationEvent: (event) => translations.push(`${event.sequence}:${event.status}:${event.targetLanguage}`),
      onGeneratedAudioReady: (event) =>
        generatedAudioReady.push(`${event.sequence}:${event.targetLanguage}:${event.segmentId}`),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'wrs_demo',
      broadcastId: 'broadcast_demo',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });
    let updated = session;
    for (let sequence = 0; sequence < 5; sequence += 1) {
      updated = await sessionStore.ingestWebRtcChunk(session.id, {
        sequence,
        startMs: sequence * 15_000,
        endMs: (sequence + 1) * 15_000,
        sampleRate: 16000,
        channelCount: 1,
        pcmFormat: 'pcm_s16le',
        mimeType: 'audio/wav',
        sizeBytes: wavFixture().length,
        sourcePath: await createStagedWav(stagingDir, `chunk-${sequence}.wav`),
      });
      expect(updated.state).toBe('processing');
    }

    expect(updated.sourceKind).toBe('webrtc');
    expect(updated.transcription.events[0]).toMatchObject({
      sessionId: 'wrs_demo',
      streamId: 'broadcast_demo',
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      status: 'transcribed',
    });
    expect(updated.translation.events[0]).toMatchObject({
      sessionId: 'wrs_demo',
      streamId: 'broadcast_demo',
      sequence: 0,
      sourceText: 'Mock transcript chunk 1',
      translatedText: '[es] Mock transcript chunk 1',
      targetLanguage: 'es',
      startMs: 0,
      endMs: 15_000,
      status: 'translated',
    });
    expect(updated.generatedAudio.events[0]).toMatchObject({
      sessionId: 'wrs_demo',
      segmentId: 'wrs_demo:webrtc:1:0',
      sequence: 0,
      targetLanguage: 'es',
      startMs: 0,
      endMs: 15_000,
      status: 'generated',
    });
    expect(updated.webrtcTranscriptionBridge).toMatchObject({
      status: 'chunking',
      chunkCount: 5,
      transcribedChunks: 5,
      latestTranscript: 'Mock transcript chunk 5',
    });

    expect(updated.transcription.events[4]).toMatchObject({
      sequence: 4,
      startMs: 60_000,
      endMs: 75_000,
      sourceText: 'Mock transcript chunk 5',
      status: 'transcribed',
    });
    expect(updated.translation.events[4]).toMatchObject({
      sequence: 4,
      startMs: 60_000,
      endMs: 75_000,
      translatedText: '[es] Mock transcript chunk 5',
      status: 'translated',
    });
    expect(updated.generatedAudio.events[4]).toMatchObject({
      sequence: 4,
      startMs: 60_000,
      endMs: 75_000,
      status: 'generated',
    });

    const stopped = sessionStore.stopWebRtcSession(session.id);
    expect(stopped.state).toBe('completed');
    expect(stopped.webrtcTranscriptionBridge?.status).toBe('stopped');
    expect(events).toEqual([
      '0:queued',
      '0:transcribing',
      '0:transcribed',
      '1:queued',
      '1:transcribing',
      '1:transcribed',
      '2:queued',
      '2:transcribing',
      '2:transcribed',
      '3:queued',
      '3:transcribing',
      '3:transcribed',
      '4:queued',
      '4:transcribing',
      '4:transcribed',
    ]);
    expect(translations).toEqual([
      '0:queued:es',
      '0:translating:es',
      '0:translated:es',
      '1:queued:es',
      '1:translating:es',
      '1:translated:es',
      '2:queued:es',
      '2:translating:es',
      '2:translated:es',
      '3:queued:es',
      '3:translating:es',
      '3:translated:es',
      '4:queued:es',
      '4:translating:es',
      '4:translated:es',
    ]);
    expect(generatedAudioReady).toEqual([
      '0:es:wrs_demo:webrtc:1:0',
      '1:es:wrs_demo:webrtc:1:1',
      '2:es:wrs_demo:webrtc:1:2',
      '3:es:wrs_demo:webrtc:1:3',
      '4:es:wrs_demo:webrtc:1:4',
    ]);
  });

  it('rejects duplicate and out-of-order WebRTC chunks clearly', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'wrs_order',
      broadcastId: 'broadcast_demo',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
    });

    await expect(
      sessionStore.ingestWebRtcChunk(session.id, {
        sequence: 1,
        startMs: 0,
        endMs: 10,
        sampleRate: 16000,
        channelCount: 1,
        pcmFormat: 'pcm_s16le',
        mimeType: 'audio/wav',
        sizeBytes: wavFixture().length,
        sourcePath: await createStagedWav(stagingDir, 'out-of-order.wav'),
      }),
    ).rejects.toMatchObject({ code: 'audio-timeline-invalid' });
  });

  it('rejects unsafe WebRTC staged paths', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const outsideDir = await createTempDir();
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'wrs_safe',
      broadcastId: 'broadcast_demo',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
    });

    await expect(
      sessionStore.ingestWebRtcChunk(session.id, {
        sequence: 0,
        startMs: 0,
        endMs: 10,
        sampleRate: 16000,
        channelCount: 1,
        pcmFormat: 'pcm_s16le',
        mimeType: 'audio/wav',
        sizeBytes: wavFixture().length,
        sourcePath: await createStagedWav(outsideDir, 'outside.wav'),
      }),
    ).rejects.toMatchObject({ code: 'unsafe-filename' });
  });
});
