import type {
  AudioExtractionMetadata,
  AudioChunkMetadata,
  TimestampedTranslationEvent,
  TranscriptionEvent,
} from '@videofy-live/shared-types';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAudioExtraction } from '../audio-extraction.js';
import {
  MediaIngestError,
  ProcessingSessionStore,
  type AudioExtractor,
  type PartialEventMarker,
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

/**
 * Streaming captions mark interim events with `isFinal: false`; a final event
 * carries no flag at all, which is the contract the gateway reads.
 */
function finality(event: (TranscriptionEvent | TimestampedTranslationEvent) & PartialEventMarker): string {
  return event.isFinal === false ? `partial#${event.partialSequence}` : 'final';
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

  it('reattaches a byte-identical re-upload to the existing completed session', async () => {
    const extractions: string[] = [];
    const sessionStore = store(async (input) => {
      extractions.push(input.sessionId);
      return await successfulExtractor(input);
    });
    const first = await sessionStore.createFromUpload(upload(), async () => validVideoProbe);
    const replay = await sessionStore.createFromUpload(upload(), async () => validVideoProbe);

    expect(first.state).toBe('completed');
    expect(replay.state).toBe('completed');
    // Idempotent reattach: the pipeline is not re-run for identical bytes.
    expect(replay.id).toBe(first.id);
    expect(replay.streamId).toBe(first.streamId);
    expect(extractions).toEqual([first.id]);
  });

  it('creates a fresh session when the prior identical upload failed', async () => {
    let attempts = 0;
    const sessionStore = store(async (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new MediaIngestError('extraction failed once', 'audio-extraction-failed', 500);
      }
      return await successfulExtractor(input);
    });

    let failedSessionId = '';
    await sessionStore.createFromUpload(upload(), async () => validVideoProbe).catch((error: unknown) => {
      if (error instanceof MediaIngestError) {
        failedSessionId = (error.session as ProcessingSession).id;
      }
    });
    expect(failedSessionId).not.toBe('');

    const retried = await sessionStore.createFromUpload(upload(), async () => validVideoProbe);
    expect(retried.state).toBe('completed');
    expect(retried.id).not.toBe(failedSessionId);
  });

  it('shares a single render between concurrent viewer-ready media requests', async () => {
    const outputDir = await createTempDir();
    const temp = await createTempDir();
    const sourcePath = join(temp, 'clip.mp4');
    await writeFile(sourcePath, Buffer.from('uploaded source media'));
    const renderedPaths: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      extractAudio: successfulExtractor,
      renderViewerReadyMedia: async (input) => {
        renderedPaths.push(input.outputPath);
        // Keep the render in flight long enough for the second request to join.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await mkdir(dirname(input.outputPath), { recursive: true });
        await writeFile(input.outputPath, Buffer.from('viewer-ready mp4'));
      },
    });
    const session = await sessionStore.createFromUpload(
      upload({ path: sourcePath, requestedSessionId: 'wrs_concurrent_render' }),
      async () => validVideoProbe,
    );

    const [first, second] = await Promise.all([
      sessionStore.getViewerReadyMediaFile(session.id),
      sessionStore.getViewerReadyMediaFile(session.id),
    ]);

    // One ffmpeg render serves both concurrent requests.
    expect(renderedPaths).toHaveLength(1);
    // The renderer writes to a temp path that is atomically promoted afterwards.
    expect(renderedPaths[0]).toContain('programme.tmp-');
    const finalPath = join(outputDir, session.id, 'viewer-ready', 'programme.mp4');
    expect(first).toEqual({
      mediaPath: finalPath,
      mimeType: 'video/mp4',
      sizeBytes: 'viewer-ready mp4'.length,
    });
    expect(second).toEqual(first);
  });

  it('maintains incremental per-language output tallies as events transition', async () => {
    const outputDir = await createTempDir();
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      extractAudio: successfulExtractor,
      translationTargetLanguage: 'es',
      translationSupportedTargetLanguages: ['es', 'fr'],
      textToSpeechSupportedLanguages: ['es'],
    });
    const session = await sessionStore.createFromUpload(
      upload({ targetLanguage: 'es', targetLanguages: ['es', 'fr'] }),
      async () => validVideoProbe,
    );

    expect(session.state).toBe('completed');
    const tallies = sessionStore.getTargetLanguageOutputTallies(session.id);
    expect(tallies).not.toBeNull();
    const completedTally = {
      totalSegments: 3,
      completedSegments: 3,
      failedSegments: 0,
      activeSegments: 0,
      lastError: null,
    };
    expect(tallies!.translation.get('es')).toEqual(completedTally);
    expect(tallies!.translation.get('fr')).toEqual(completedTally);
    expect(tallies!.generatedAudio.get('es')).toEqual(completedTally);
    // Caption-only language: no generated-audio events, no tally.
    expect(tallies!.generatedAudio.has('fr')).toBe(false);

    // A language revision boundary resets the tallies together with the events.
    sessionStore.updateSourceLanguageControl(session.id, {
      action: 'override',
      language: 'pt',
    });
    const reset = sessionStore.getTargetLanguageOutputTallies(session.id);
    expect(reset!.translation.size).toBe(0);
    expect(reset!.generatedAudio.size).toBe(0);

    expect(sessionStore.getTargetLanguageOutputTallies('ps_unknown')).toBeNull();
  });

  it('protects against concurrent duplicate submissions', async () => {
    const sessionStore = store();
    let releaseProbe!: (probe: ProbeResult) => void;
    const pendingProbe = new Promise<ProbeResult>((resolve) => {
      releaseProbe = resolve;
    });
    const first = sessionStore.createFromUpload(upload(), async () => pendingProbe);

    await expect(
      sessionStore.createFromUpload(upload(), async () => validVideoProbe),
    ).rejects.toMatchObject({
      code: 'duplicate-submission',
    });

    releaseProbe(validVideoProbe);
    await expect(first).resolves.toMatchObject({ state: 'completed' });
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
      segmentId: 'wrs_demo:webrtc:1:0-s0',
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
      '0:es:wrs_demo:webrtc:1:0-s0',
      '1:es:wrs_demo:webrtc:1:1-s0',
      '2:es:wrs_demo:webrtc:1:2-s0',
      '3:es:wrs_demo:webrtc:1:3-s0',
      '4:es:wrs_demo:webrtc:1:4-s0',
    ]);
  });

  it('releases generated-audio dedupe keys when a WebRTC session is replaced', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const generatedAudioReady: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'es',
      translationSupportedTargetLanguages: ['es'],
      textToSpeechSupportedLanguages: ['es'],
      onGeneratedAudioReady: (event) => generatedAudioReady.push(event.segmentId),
    });
    const webRtcInput = {
      sessionId: 'wrs_dedupe',
      broadcastId: 'broadcast_dedupe',
      broadcasterPeerId: 'peer_broadcaster',
      targetLanguage: 'es',
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual' as const,
    };
    const session = await sessionStore.createWebRtcSession({ ...webRtcInput, revision: 1 });
    await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'dedupe-0.wav'),
    });
    expect(generatedAudioReady).toHaveLength(1);
    sessionStore.stopWebRtcSession(session.id);

    const readyKeys = (
      sessionStore as unknown as {
        generatedAudioReadyKeysBySession: Map<string, Set<string>>;
      }
    ).generatedAudioReadyKeysBySession;
    expect(readyKeys.has(session.id)).toBe(true);

    // Replacing the session for a new revision must release the old keys with it.
    await sessionStore.createWebRtcSession({ ...webRtcInput, revision: 2 });
    expect(readyKeys.has(session.id)).toBe(false);

    await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'dedupe-1.wav'),
    });
    expect(generatedAudioReady).toHaveLength(2);
  });

  it('honors a per-session standard-voice override for WebRTC call sessions', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const generatedVoiceIds: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'es',
      translationSupportedTargetLanguages: ['es', 'fr'],
      textToSpeechSupportedLanguages: ['es', 'fr'],
      onGeneratedAudioReady: (event) => generatedVoiceIds.push(event.voiceId),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_demo_participant_a',
      broadcastId: 'callcast_demo_participant_a',
      broadcasterPeerId: 'peer_call_a',
      revision: 1,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
    });
    await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'voice-override-0.wav'),
    });

    expect(generatedVoiceIds).toEqual(['es_ES-sharvard-female']);
    sessionStore.stopWebRtcSession(session.id);

    await expect(sessionStore.removeCallSession('wrs_not_a_call')).rejects.toMatchObject({
      code: 'invalid-media',
    });
    await expect(sessionStore.removeCallSession(session.id)).resolves.toBe(true);
    expect(sessionStore.get(session.id)).toBeNull();
    await expect(sessionStore.removeCallSession(session.id)).resolves.toBe(false);

    await expect(
      sessionStore.createWebRtcSession({
        sessionId: 'call_demo_participant_b',
        broadcastId: 'callcast_demo_participant_b',
        broadcasterPeerId: 'peer_call_b',
        revision: 1,
        targetLanguage: 'es',
        targetLanguages: ['es'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        voiceIdsByLanguage: { es: '../escape' },
      }),
    ).rejects.toMatchObject({ code: 'unsafe-filename' });
  });

  it('accepts VAD-gapped call utterances (silence between speech) but still rejects overlap', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const captions: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      onTranslationEvent: (event) => captions.push(`${event.sequence}:${event.status}`),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_gaps_participant_1_r1',
      broadcastId: 'callcast_gaps_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    async function utterance(sequence: number, startMs: number, endMs: number): Promise<void> {
      await sessionStore.ingestWebRtcChunk(session.id, {
        sequence,
        startMs,
        endMs,
        sampleRate: 16000,
        channelCount: 1,
        pcmFormat: 'pcm_s16le',
        mimeType: 'audio/wav',
        sizeBytes: wavFixture().length,
        sourcePath: await createStagedWav(stagingDir, `gap-${sequence}.wav`),
      });
    }

    // Real speech: an utterance, a pause, another utterance, a longer pause.
    await utterance(0, 0, 3_000);
    await utterance(1, 9_500, 12_000);
    await utterance(2, 21_000, 24_000);

    const after = sessionStore.get(session.id)!;
    expect(after.state).toBe('processing');
    expect(after.audioExtraction.chunks.map((chunk) => chunk.startMs)).toEqual([0, 9_500, 21_000]);
    expect(captions.length).toBeGreaterThanOrEqual(3);

    // Overlapping audio is still a timeline error, recorded without killing the call.
    const overlapped = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 3,
      startMs: 22_000,
      endMs: 26_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'gap-overlap.wav'),
    });
    expect(overlapped.state).toBe('processing');
    expect(overlapped.audioExtraction.chunks).toHaveLength(3);
  });

  it('keeps a native call alive after a failed chunk and still processes later audio', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const generated: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      onGeneratedAudioReady: (event) => generated.push(`${event.sequence}:${event.status}`),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_resilience_participant_1_r1',
      broadcastId: 'callcast_resilience_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    // A chunk whose staged file vanished (the exact production failure: a
    // retried submission after the file was already consumed).
    const afterFailure = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: join(stagingDir, 'missing-chunk.wav'),
    });
    expect(afterFailure.state).toBe('processing');
    expect(afterFailure.webrtcTranscriptionBridge?.failedChunks).toBe(1);

    // The next utterance must still be accepted and fully processed.
    const afterRecovery = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 1,
      startMs: 15_000,
      endMs: 30_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'recovered.wav'),
    });
    expect(afterRecovery.state).toBe('processing');
    expect(generated.length).toBeGreaterThan(0);
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

  it('streams partial call captions without audio, stored chunks or leftover files', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const transcripts: string[] = [];
    const captions: string[] = [];
    const generated: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      onTranscriptionEvent: (event) =>
        transcripts.push(`${event.sequence}:${event.status}:${finality(event)}`),
      onTranslationEvent: (event) =>
        captions.push(`${event.sequence}:${event.status}:${finality(event)}:${event.translatedText}`),
      onGeneratedAudioReady: (event) => generated.push(`${event.sequence}:${event.status}`),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_partial_participant_1_r1',
      broadcastId: 'callcast_partial_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    // Two interim chunks while the speaker is still talking: same sequence and
    // startMs as the final that will follow, growing endMs.
    const afterFirstPartial = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 4_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'partial-0-0.wav'),
      partial: true,
      partialSequence: 0,
    });
    await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 7_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'partial-0-1.wav'),
      partial: true,
      partialSequence: 1,
    });

    // Captions were delivered, but nothing durable was touched.
    expect(transcripts).toEqual(['0:transcribed:partial#0', '0:transcribed:partial#1']);
    expect(captions).toEqual([
      '0:translated:partial#0:[fr] Mock transcript chunk 1',
      '0:translated:partial#1:[fr] Mock transcript chunk 1',
    ]);
    expect(generated).toEqual([]);
    expect(afterFirstPartial.state).toBe('processing');
    expect(afterFirstPartial.audioExtraction.chunks).toHaveLength(0);
    expect(afterFirstPartial.transcription.events).toHaveLength(0);
    expect(afterFirstPartial.translation.events).toHaveLength(0);
    expect(afterFirstPartial.generatedAudio.events).toHaveLength(0);
    expect(afterFirstPartial.webrtcTranscriptionBridge?.failedChunks).toBe(0);

    // No partial audio survives, in the staging area or the session output.
    expect(await readdir(stagingDir)).toEqual([]);
    expect(await readdir(join(outputDir, session.id))).toEqual([]);

    // The final chunk reuses the same sequence and startMs and is processed in full.
    const final = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 9_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'final-0.wav'),
    });

    expect(final.state).toBe('processing');
    expect(final.audioExtraction.chunks).toHaveLength(1);
    expect(final.transcription.events).toHaveLength(1);
    expect(final.transcription.events[0]).toMatchObject({
      // The partials borrowed this sequence without consuming it.
      sequence: 0,
      chunkId: 'call_partial_participant_1_r1:webrtc:1:0-s0',
      status: 'transcribed',
    });
    expect((final.transcription.events[0] as PartialEventMarker).isFinal).toBeUndefined();
    expect(final.translation.events).toHaveLength(1);
    expect(final.generatedAudio.events).toHaveLength(1);
    expect(generated).toEqual(['0:generated']);
    expect(transcripts.slice(2)).toEqual(['0:queued:final', '0:transcribing:final', '0:transcribed:final']);
    expect(captions.slice(2)).toEqual([
      '0:queued:final:',
      '0:translating:final:',
      '0:translated:final:[fr] Mock transcript chunk 1',
    ]);
    expect(await readdir(join(outputDir, session.id))).toContain('webrtc-chunk-000000.wav');
    expect(await readdir(join(outputDir, session.id))).not.toContain(
      'webrtc-partial-000000-0000.wav',
    );
  });

  it('rejects partial chunks for programme WebRTC sessions and keeps them running', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'wrs_partial_programme',
      broadcastId: 'broadcast_partial_programme',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    await expect(
      sessionStore.ingestWebRtcChunk(session.id, {
        sequence: 0,
        startMs: 0,
        endMs: 4_000,
        sampleRate: 16000,
        channelCount: 1,
        pcmFormat: 'pcm_s16le',
        mimeType: 'audio/wav',
        sizeBytes: wavFixture().length,
        sourcePath: await createStagedWav(stagingDir, 'programme-partial.wav'),
        partial: true,
        partialSequence: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid-transition' });

    // The programme session is untouched: not failed, no chunk consumed, and
    // the ordinary chunk for that sequence is still accepted.
    const rejected = sessionStore.get(session.id)!;
    expect(rejected.state).toBe('processing');
    expect(rejected.audioExtraction.chunks).toHaveLength(0);
    expect(rejected.error).toBeNull();
    expect(await readdir(stagingDir)).toEqual([]);

    const accepted = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 15_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'programme-final.wav'),
    });
    expect(accepted.state).toBe('processing');
    expect(accepted.audioExtraction.chunks).toHaveLength(1);
    expect(accepted.transcription.events).toHaveLength(1);
  });

  it('drops a partial that arrives while another chunk is being processed', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const transcripts: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      onTranscriptionEvent: (event) =>
        transcripts.push(`${event.sequence}:${event.status}:${finality(event)}`),
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_partial_race_participant_1_r1',
      broadcastId: 'callcast_partial_race_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    // Start a final chunk without awaiting it, then push a partial into the
    // same session while that work is still in flight.
    const inFlight = sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 9_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'race-final.wav'),
    });
    const dropped = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 1,
      startMs: 9_000,
      endMs: 11_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'race-partial.wav'),
      partial: true,
      partialSequence: 0,
    });

    // Dropped, not failed: no error, no failure counter, no leftover audio.
    expect(dropped.state).toBe('processing');
    expect(dropped.webrtcTranscriptionBridge?.failedChunks).toBe(0);
    expect(dropped.error).toBeNull();

    const final = await inFlight;
    expect(final.state).toBe('processing');
    expect(final.transcription.events).toHaveLength(1);
    expect(transcripts.every((entry) => entry.endsWith(':final'))).toBe(true);
    expect(await readdir(stagingDir)).toEqual([]);
    const outputFiles = await readdir(join(outputDir, session.id));
    expect(outputFiles).toContain('webrtc-chunk-000000.wav');
    expect(outputFiles.some((name) => name.startsWith('webrtc-partial-'))).toBe(false);
  });

  it('never emits a zero-length caption window, even for a boundary segment', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const windows: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      onTranscriptionEvent: (event) => windows.push(`${event.startMs}-${event.endMs}`),
      transcriptionProvider: {
        name: 'boundary-transcriber',
        // A segment that starts at (and runs past) the end of the chunk window:
        // the clamp used to collapse it to endMs === startMs, which the
        // timestamped-translation contract rejects, losing the caption.
        transcribe: async (input) => ({
          segments: [
            {
              text: 'boundary segment',
              startMs: input.chunk.endMs - input.chunk.startMs + 500,
              endMs: input.chunk.endMs - input.chunk.startMs + 900,
            },
          ],
          detectedLanguage: 'en',
          confidence: 0.9,
        }),
      },
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_boundary_participant_1_r1',
      broadcastId: 'callcast_boundary_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 2_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'boundary.wav'),
    });

    // The store emits an event per status transition, so assert the invariant
    // over every window rather than assuming how many there are.
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      const [startMs, endMs] = window.split('-').map(Number);
      expect(endMs).toBeGreaterThan(startMs as number);
    }
    // The boundary segment specifically must survive as a one-millisecond
    // window rather than collapsing to nothing.
    expect(windows).toContain('1999-2000');
  });

  it('keeps a failed partial off the speech-loss counters', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      transcriptionProvider: {
        name: 'failing-transcriber',
        transcribe: async () => {
          throw new Error('transcription exploded');
        },
      },
    });
    const session = await sessionStore.createWebRtcSession({
      sessionId: 'call_partial_fail_participant_1_r1',
      broadcastId: 'callcast_partial_fail_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    const afterFailure = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 1_500,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'failing-partial.wav'),
      partial: true,
      partialSequence: 0,
    });

    // A preview that failed is not speech that was lost: the final chunk still
    // carries this audio, so the call's fault counters must stay clean.
    expect(afterFailure.state).toBe('processing');
    expect(afterFailure.webrtcTranscriptionBridge?.failedChunks).toBe(0);
    expect(afterFailure.webrtcTranscriptionBridge?.lastError).toBeNull();
    expect(afterFailure.monitoring.lastError).toBeNull();
    // ...but it is still visible, on its own counter.
    expect(afterFailure.webrtcTranscriptionBridge?.failedPartialChunks).toBe(1);
    expect(afterFailure.webrtcTranscriptionBridge?.lastPartialError).toBe('transcription exploded');

    // The failure path still cleans up after itself.
    expect(await readdir(stagingDir)).toEqual([]);
    const outputFiles = await readdir(join(outputDir, session.id));
    expect(outputFiles.some((name) => name.startsWith('webrtc-partial-'))).toBe(false);

    // The final chunk for the same utterance is unaffected and still accepted.
    const final = await sessionStore.ingestWebRtcChunk(session.id, {
      sequence: 0,
      startMs: 0,
      endMs: 2_000,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      mimeType: 'audio/wav',
      sizeBytes: wavFixture().length,
      sourcePath: await createStagedWav(stagingDir, 'recovering-final.wav'),
    });
    expect(final.audioExtraction.chunks).toHaveLength(1);
  });

  it('warms the call language pair and voice when a call session is created', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const translated: string[] = [];
    const synthesized: string[] = [];
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      warmUpCallModels: true,
      translationProvider: {
        name: 'warm-translator',
        translate: async (input) => {
          translated.push(`${input.sourceLanguage}->${input.targetLanguage}`);
          return { translatedText: `[${input.targetLanguage}] ${input.sourceText}` };
        },
      },
      textToSpeechProvider: {
        name: 'warm-tts',
        generate: async (input) => {
          synthesized.push(`${input.targetLanguage}:${input.voiceId}`);
          await writeFile(input.outputPath, wavFixture());
          return { audioPath: input.outputPath, providerLatencyMs: 1 };
        },
      },
    });

    await sessionStore.createWebRtcSession({
      sessionId: 'call_warm_participant_1_r1',
      broadcastId: 'callcast_warm_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      voiceIdsByLanguage: { fr: 'fr_FR-siwis-medium' },
    });

    // Warming is fire-and-forget, so give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translated).toEqual(['en->fr']);
    expect(synthesized).toEqual(['fr:fr_FR-siwis-medium']);

    // The probe clip is never kept: it exists only to make the model load.
    const ttsDir = join(outputDir, 'call_warm_participant_1_r1', 'tts');
    const leftovers = await readdir(ttsDir).catch(() => []);
    expect(leftovers.filter((name) => name.startsWith('warmup-'))).toEqual([]);

    // A second call on the same pair must not pay for warming again.
    await sessionStore.createWebRtcSession({
      sessionId: 'call_warm_participant_2_r1',
      broadcastId: 'callcast_warm_participant_2_r1',
      broadcasterPeerId: 'peer_call_participant_2',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      voiceIdsByLanguage: { fr: 'fr_FR-siwis-medium' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translated).toEqual(['en->fr']);
    expect(synthesized).toEqual(['fr:fr_FR-siwis-medium']);
  });

  it('does not warm an auto-detect call, whose source language is not yet known', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    let attempts = 0;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      warmUpCallModels: true,
      translationProvider: {
        name: 'counting-translator',
        translate: async (input) => {
          attempts += 1;
          return { translatedText: `[${input.targetLanguage}] ${input.sourceText}` };
        },
      },
    });

    await sessionStore.createWebRtcSession({
      sessionId: 'call_autodetect_participant_1_r1',
      broadcastId: 'callcast_autodetect_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguageMode: 'auto-detect',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Warming 'en->fr' here would load the wrong pair and occupy the single
    // translation slot exactly when the first real utterance needs it.
    expect(attempts).toBe(0);
  });

  it('does not probe a voice for a captions-only language, and retries only transient failures', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    const synthesized: string[] = [];
    let translateAttempts = 0;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'yo',
      translationSupportedTargetLanguages: ['yo'],
      // 'yo' translates but has no voice here: captions-only.
      textToSpeechSupportedLanguages: [],
      warmUpCallModels: true,
      translationProvider: {
        name: 'permanently-failing-translator',
        translate: async () => {
          translateAttempts += 1;
          throw new MediaIngestError('Unsupported pair.', 'unsupported-language', 400);
        },
      },
      textToSpeechProvider: {
        name: 'recording-tts',
        generate: async (input) => {
          synthesized.push(input.targetLanguage);
          await writeFile(input.outputPath, wavFixture());
          return { audioPath: input.outputPath, providerLatencyMs: 1 };
        },
      },
    });

    const create = async (participant: number) =>
      await sessionStore.createWebRtcSession({
        sessionId: `call_captions_participant_${participant}_r1`,
        broadcastId: `callcast_captions_participant_${participant}_r1`,
        broadcasterPeerId: `peer_call_participant_${participant}`,
        revision: 1,
        targetLanguage: 'yo',
        targetLanguages: ['yo'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      });

    await create(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await create(2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No voice exists for the language, so no doomed synthesis is attempted.
    expect(synthesized).toEqual([]);
    // A 4xx is decided by configuration: attempted once, not once per call.
    expect(translateAttempts).toBe(1);
  });

  it('never fails a call when warm-up throws, and does not warm programme sessions', async () => {
    const outputDir = await createTempDir();
    const stagingDir = await createTempDir();
    let warmAttempts = 0;
    const sessionStore = new ProcessingSessionStore({
      outputBaseDir: outputDir,
      webRtcStagingDir: stagingDir,
      translationTargetLanguage: 'fr',
      translationSupportedTargetLanguages: ['fr'],
      textToSpeechSupportedLanguages: ['fr'],
      warmUpCallModels: true,
      translationProvider: {
        name: 'exploding-translator',
        translate: async () => {
          warmAttempts += 1;
          throw new Error('model still downloading');
        },
      },
    });

    // A programme session is not a call: it must not warm at all.
    const programme = await sessionStore.createWebRtcSession({
      sessionId: 'wrs_warm_programme',
      broadcastId: 'broadcast_warm_programme',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warmAttempts).toBe(0);
    expect(programme.state).toBe('processing');

    // A call whose warm-up throws still starts, clean.
    const call = await sessionStore.createWebRtcSession({
      sessionId: 'call_warm_fail_participant_1_r1',
      broadcastId: 'callcast_warm_fail_participant_1_r1',
      broadcasterPeerId: 'peer_call_participant_1',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warmAttempts).toBe(1);
    expect(call.state).toBe('processing');
    expect(call.error).toBeNull();
    expect(call.webrtcTranscriptionBridge?.failedChunks).toBe(0);
    expect(call.monitoring.lastError).toBeNull();
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
