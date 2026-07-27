import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { AudioChunkMetadata, AudioExtractionMetadata } from '@videofy-live/shared-types';
import { emptyAudioExtraction } from '../services/media-ingest/src/audio-extraction.js';
import {
  ProcessingSessionStore,
  type AudioExtractor,
  type ProbeResult,
} from '../services/media-ingest/src/media-session.js';
import {
  PiperTextToSpeechProvider,
  type TextToSpeechProvider,
  type TextToSpeechProviderInput,
  type TextToSpeechProviderResult,
} from '../services/media-ingest/src/text-to-speech-provider.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderInput,
  TranscriptionProviderResult,
} from '../services/media-ingest/src/transcription-provider.js';
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../services/media-ingest/src/translation-provider.js';

const execFileAsync = promisify(execFile);

const piperExecutable = resolve('services/media-ingest/model_cache/piper/bin/piper/piper.exe');
const modelPath = resolve(
  'services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx',
);
const configPath = resolve(
  'services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx.json',
);
const voiceId = 'es_ES-sharvard-medium';
const targetLanguage = 'es';
const translatedText = 'Hola, esta es una prueba de Videofy Live.';
const segmentStartMs = 0;
const segmentEndMs = 3000;

async function main(): Promise<void> {
  const outputBaseDir = await mkdtemp(join(tmpdir(), 'videofy-piper-session-'));
  const piper = new PiperTextToSpeechProvider({
    executable: piperExecutable,
    timeoutMs: 120_000,
    voices: [{ voiceId, language: targetLanguage, modelPath, configPath }],
  });
  const flakyPiper = failFirstProvider(piper);
  const store = new ProcessingSessionStore({
    outputBaseDir,
    extractAudio: extractor,
    transcriptionProvider: transcriber,
    translationProvider: translator,
    translationTargetLanguage: targetLanguage,
    translationSupportedTargetLanguages: [targetLanguage],
    textToSpeechProvider: flakyPiper,
    textToSpeechTimeoutMs: 120_000,
    textToSpeechVoiceId: voiceId,
    textToSpeechSupportedLanguages: [targetLanguage],
  });

  const wallStartedAt = performance.now();
  const failed = await store.createFromUpload(
    {
      path: join(outputBaseDir, 'input.wav'),
      originalName: 'p3-piper-smoke.wav',
      sizeBytes: 4096,
      mimeType: 'audio/wav',
      targetLanguage,
    },
    async () => probe,
  );
  const failedEvent = failed.generatedAudio.events[0];
  if (!failedEvent || failedEvent.status !== 'failed') {
    throw new Error('Expected first generated-audio event to fail visibly.');
  }

  const retried = await store.retryGeneratedAudioSegment(failed.id, failedEvent.segmentId);
  const generatedEvent = retried.generatedAudio.events[0];
  if (!generatedEvent || generatedEvent.status !== 'generated') {
    throw new Error('Expected retry to generate audio.');
  }
  if (
    generatedEvent.sequence !== 0 ||
    generatedEvent.startMs !== segmentStartMs ||
    generatedEvent.endMs !== segmentEndMs ||
    generatedEvent.targetLanguage !== targetLanguage ||
    generatedEvent.voiceId !== voiceId
  ) {
    throw new Error('Generated-audio metadata did not preserve segment identity.');
  }

  const audioPath = join(outputBaseDir, retried.id, 'tts', generatedEvent.audioFilename);
  const audioFile = await stat(audioPath);
  const probeResult = await ffprobe(audioPath);
  if (probeResult.durationSeconds <= 0 || probeResult.codecName !== 'pcm_s16le') {
    throw new Error(`Generated WAV is not playable PCM audio: ${JSON.stringify(probeResult)}`);
  }
  await readFile(audioPath);

  const wallClockMs = Math.round(performance.now() - wallStartedAt);
  console.log(
    JSON.stringify(
      {
        piper: {
          executable: piperExecutable,
          release: '2023.11.14-2',
          modelPath,
          configPath,
          voiceId,
          targetLanguage,
        },
        failure: {
          state: failed.state,
          status: failedEvent.status,
          error: failedEvent.error,
          monitoringLastError: failed.monitoring.lastError,
        },
        retry: {
          state: retried.state,
          status: generatedEvent.status,
          sequence: generatedEvent.sequence,
          startMs: generatedEvent.startMs,
          endMs: generatedEvent.endMs,
          providerLatencyMs: generatedEvent.providerLatencyMs,
          audioFilename: generatedEvent.audioFilename,
          outputPath: audioPath,
          fileSizeBytes: audioFile.size,
          durationSeconds: probeResult.durationSeconds,
          codecName: probeResult.codecName,
          sampleRateHz: probeResult.sampleRateHz,
          channels: probeResult.channels,
          monitoring: retried.monitoring,
        },
        wallClockMs,
      },
      null,
      2,
    ),
  );
}

const probe: ProbeResult = {
  durationMs: segmentEndMs,
  hasAudio: true,
  hasVideo: false,
  codecs: [{ type: 'audio', codecName: 'pcm_s16le' }],
};

const extractor: AudioExtractor = async (input) => {
  const chunk: AudioChunkMetadata = {
    chunkId: `${input.sessionId}:chunk:0`,
    index: 0,
    filename: 'chunk-000000.wav',
    startMs: segmentStartMs,
    endMs: segmentEndMs,
    durationMs: segmentEndMs - segmentStartMs,
    status: 'ready',
  };
  const extraction: AudioExtractionMetadata = {
    ...emptyAudioExtraction('completed'),
    progressPct: 100,
    chunkCount: 1,
    chunks: [chunk],
    completedAt: new Date().toISOString(),
  };
  return extraction;
};

const transcriber: TranscriptionProvider = {
  name: 'smoke-transcription',
  transcribe: async (_input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> => ({
    sourceText: 'Hello, this is a Videofy Live test.',
    detectedLanguage: 'en',
    confidence: 0.99,
    providerLatencyMs: 0,
  }),
};

const translator: TimestampedTranslationProvider = {
  name: 'smoke-translation',
  translate: async (_input: TranslationProviderInput): Promise<TranslationProviderResult> => ({
    translatedText,
  }),
};

function failFirstProvider(realProvider: TextToSpeechProvider): TextToSpeechProvider {
  let failed = false;
  return {
    name: realProvider.name,
    generate: async (input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> => {
      if (!failed) {
        failed = true;
        throw new Error('P3.1A intentional Piper failure for retry validation.');
      }
      return await realProvider.generate(input);
    },
  };
}

async function ffprobe(audioPath: string): Promise<{
  durationSeconds: number;
  fileSizeBytes: number;
  codecName: string;
  sampleRateHz: number;
  channels: number;
}> {
  const result = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,sample_rate,channels:format=duration,size',
    '-of',
    'json',
    audioPath,
  ]);
  const parsed = JSON.parse(String(result.stdout)) as {
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
    format?: { duration?: string; size?: string };
  };
  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    fileSizeBytes: Number(parsed.format?.size ?? 0),
    codecName: parsed.streams?.[0]?.codec_name ?? '',
    sampleRateHz: Number(parsed.streams?.[0]?.sample_rate ?? 0),
    channels: Number(parsed.streams?.[0]?.channels ?? 0),
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
