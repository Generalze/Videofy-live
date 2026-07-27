import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ProcessingSessionStore,
  type ProcessingSession,
} from '../services/media-ingest/src/media-session.js';
import { FasterWhisperTranscriptionProvider } from '../services/media-ingest/src/transcription-provider.js';
import { ArgosTimestampedTranslationProvider } from '../services/media-ingest/src/translation-provider.js';

interface SmokeSummary {
  sessionId: string;
  sourceKind: ProcessingSession['sourceKind'];
  state: ProcessingSession['state'];
  targetLanguage: string;
  transcriptionText: string;
  detectedLanguage: string | null;
  transcriptionConfidence: number | null;
  transcriptionProviderLatencyMs: number | null;
  translationText: string;
  translationLatencyMs: number | null;
  chunkCount: number;
  timestamps: Array<{ sequence: number; startMs: number; endMs: number }>;
  transcriptExport: string;
  translationExport: string;
  wallClockMs: number;
  monitoring: ProcessingSession['monitoring'];
}

const smokeRoot = join(tmpdir(), 'videofy-live-p3-smoke');
const uploadAudioPath = join(smokeRoot, 'uploaded-audio.wav');
const microphoneAudioPath = join(smokeRoot, 'browser-mic.webm');
const outputBaseDir = join(smokeRoot, 'session-output');
const pythonExecutable = resolve('services/media-ingest/.venv/Scripts/python.exe');
const modelCacheDir = resolve('services/media-ingest/model_cache/faster-whisper');
const modelSize = process.env['P3_WHISPER_MODEL_SIZE'] ?? 'small';
const computeType = process.env['P3_WHISPER_COMPUTE_TYPE'] ?? 'int8';
const targetLanguage = process.env['P3_TARGET_LANGUAGE'] ?? 'es';
const providerTimeoutMs = Number(process.env['P3_PROVIDER_TIMEOUT_MS'] ?? 600_000);

async function main(): Promise<void> {
  process.env['HF_HUB_DISABLE_XET'] = process.env['HF_HUB_DISABLE_XET'] ?? '1';
  await mkdir(outputBaseDir, { recursive: true });
  await mkdir(modelCacheDir, { recursive: true });

  const store = new ProcessingSessionStore({
    outputBaseDir,
    transcriptionProvider: new FasterWhisperTranscriptionProvider({
      pythonExecutable,
      ffmpegExecutable: 'ffmpeg',
      modelSize,
      device: 'cpu',
      computeType,
      modelCacheDir,
      allowGpuFallback: false,
      timeoutMs: providerTimeoutMs,
    }),
    transcriptionTimeoutMs: providerTimeoutMs,
    translationProvider: new ArgosTimestampedTranslationProvider({
      pythonExecutable,
      packageDir: null,
      supportedTargetLanguages: [targetLanguage],
      timeoutMs: providerTimeoutMs,
    }),
    translationTimeoutMs: providerTimeoutMs,
    translationSupportedTargetLanguages: [targetLanguage],
    translationTargetLanguage: targetLanguage,
  });

  const uploadSummary = await runUploadSmoke(store);
  const microphoneSummary = await runMicrophoneSmoke(store);

  console.log(
    JSON.stringify(
      {
        configuration: {
          pythonExecutable,
          modelSize,
          computeType,
          device: 'cpu',
          modelCacheDir,
          targetLanguage,
          providerTimeoutMs,
        },
        upload: uploadSummary,
        microphone: microphoneSummary,
      },
      null,
      2,
    ),
  );
}

async function runUploadSmoke(store: ProcessingSessionStore): Promise<SmokeSummary> {
  const file = await stat(uploadAudioPath);
  const startedAt = performance.now();
  const session = await store.createFromUpload({
    path: uploadAudioPath,
    originalName: 'p3-uploaded-audio.wav',
    sizeBytes: file.size,
    mimeType: 'audio/wav',
    targetLanguage,
  });
  return summarize(store, session, performance.now() - startedAt);
}

async function runMicrophoneSmoke(store: ProcessingSessionStore): Promise<SmokeSummary> {
  const file = await stat(microphoneAudioPath);
  const session = await store.createMicrophoneSession({
    deviceId: 'p3-smoke-device',
    deviceLabel: 'P3 Smoke Browser WebM Sample',
    targetLanguage,
  });
  const startedAt = performance.now();
  const processed = await store.ingestMicrophoneChunk(session.id, {
    sequence: 0,
    startMs: 0,
    endMs: 8000,
    mimeType: 'audio/webm',
    sizeBytes: file.size,
    sourcePath: microphoneAudioPath,
  });
  const stopped =
    processed.state === 'processing' || processed.state === 'paused'
      ? store.stopMicrophoneSession(session.id)
      : processed;
  return summarize(store, stopped, performance.now() - startedAt);
}

function summarize(
  store: ProcessingSessionStore,
  session: ProcessingSession,
  wallClockMs: number,
): SmokeSummary {
  assertCompleted(session);
  const transcriptionEvents = session.transcription.events.slice().sort((a, b) => a.sequence - b.sequence);
  const translationEvents = session.translation.events.slice().sort((a, b) => a.sequence - b.sequence);
  const timestamps = transcriptionEvents.map((event) => ({
    sequence: event.sequence,
    startMs: event.startMs,
    endMs: event.endMs,
  }));
  assertOrderedTimestamps(timestamps);
  const transcriptionText = transcriptionEvents.map((event) => event.sourceText).join(' ').trim();
  const translationText = translationEvents.map((event) => event.translatedText).join(' ').trim();
  if (!transcriptionText) throw new Error(`Empty transcription for ${session.id}`);
  if (!translationText) throw new Error(`Empty translation for ${session.id}`);

  return {
    sessionId: session.id,
    sourceKind: session.sourceKind,
    state: session.state,
    targetLanguage: session.targetLanguage,
    transcriptionText,
    detectedLanguage: session.transcription.detectedLanguage,
    transcriptionConfidence: transcriptionEvents[0]?.confidence ?? null,
    transcriptionProviderLatencyMs: transcriptionEvents[0]?.providerLatencyMs ?? null,
    translationText,
    translationLatencyMs: translationEvents[0]?.latency.totalMs ?? null,
    chunkCount: timestamps.length,
    timestamps,
    transcriptExport: store.exportTranscript(session.id),
    translationExport: store.exportPairedTranslation(session.id),
    wallClockMs: Math.round(wallClockMs),
    monitoring: session.monitoring,
  };
}

function assertCompleted(session: ProcessingSession): void {
  if (session.state !== 'completed') {
    throw new Error(`Expected completed session ${session.id}, received ${session.state}: ${session.error ?? 'no error'}`);
  }
  if (session.transcription.events.some((event) => event.status !== 'transcribed')) {
    throw new Error(`Session ${session.id} has non-transcribed events`);
  }
  if (session.translation.events.some((event) => event.status !== 'translated')) {
    throw new Error(`Session ${session.id} has non-translated events`);
  }
}

function assertOrderedTimestamps(
  timestamps: Array<{ sequence: number; startMs: number; endMs: number }>,
): void {
  for (let index = 0; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    if (!current) continue;
    if (current.sequence !== index) {
      throw new Error(`Unexpected sequence order at ${index}: ${current.sequence}`);
    }
    if (current.endMs <= current.startMs) {
      throw new Error(`Invalid timestamp range for sequence ${current.sequence}`);
    }
    const previous = timestamps[index - 1];
    if (previous && previous.endMs !== current.startMs) {
      throw new Error(`Timestamp continuity mismatch between ${previous.sequence} and ${current.sequence}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
