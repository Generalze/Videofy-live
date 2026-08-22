import type { TranscriptEvent } from './transcript-event.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AudioChunkMetadata } from '@videofy-live/shared-types';
import { MediaIngestError } from './ingest-error.js';
import { logger } from './logger.js';
import {
  readHallucinationThresholds,
  rejectHallucinatedSpeech,
  type HallucinationThresholds,
} from './speech-confidence.js';
import {
  PYTHON_WORKER_LOOP,
  createPersistentPythonWorker,
  type PythonWorkerFactory,
  type PythonWorkerLike,
} from './persistent-python-worker.js';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const WARMUP_SILENCE_MS = 200;
const WARMUP_TIMEOUT_MS = 300_000;

/** Minimal 16 kHz mono PCM16 WAV of silence for provider warm-up. */
function silentWav(durationMs: number): Buffer {
  const sampleRate = 16_000;
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export interface TranscriptionProviderInput {
  sessionId: string;
  streamId: string;
  chunk: AudioChunkMetadata;
  audioPath: string;
  sourceLanguage?: string;
  sourceLanguageMode?: 'manual' | 'auto-detect';
}

export interface TranscriptionSegment {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * The model's own estimate that this segment contained no speech, 0-1.
   *
   * Optional because not every provider reports it. Present, it is what
   * separates an utterance from a fabrication — see speech-confidence.ts.
   */
  noSpeechProb?: number | null;
  /** Mean token log-probability; closer to 0 is more confident. */
  avgLogProb?: number | null;
}

export interface TranscriptionProviderResult {
  segments: TranscriptionSegment[];
  detectedLanguage: string;
  confidence: number | null;
  providerLatencyMs?: number | null;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult>;
  /** Optional: pre-load the model so the first real chunk pays no cold start. */
  warmUp?(): Promise<void>;
}

export interface TranscriptionProviderConfig {
  providerName: 'mock' | 'faster-whisper';
  sourceLanguage: string;
  timeoutMs: number;
  fasterWhisper: FasterWhisperConfig;
}

export interface FasterWhisperConfig {
  pythonExecutable: string;
  ffmpegExecutable: string;
  modelSize: string;
  device: 'cpu' | 'cuda';
  computeType: string;
  modelCacheDir: string | null;
  allowGpuFallback: boolean;
  timeoutMs: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

export interface FasterWhisperProviderOptions extends FasterWhisperConfig {
  /** Seam for FFmpeg microphone-audio normalisation commands. */
  runCommand?: CommandRunner;
  /** Seam for the persistent faster-whisper python worker. */
  createWorker?: PythonWorkerFactory;
}

export function createTranscriptionProvider(
  config: TranscriptionProviderConfig,
): TranscriptionProvider {
  if (config.providerName === 'mock') {
    return new MockTranscriptionProvider(config.sourceLanguage);
  }
  if (config.providerName === 'faster-whisper') {
    return new FasterWhisperTranscriptionProvider(config.fasterWhisper);
  }
  throw new MediaIngestError(
    `Unsupported transcription provider: ${config.providerName}.`,
    'unsupported-transcription-provider',
    400,
  );
}

export async function transcribeWithTimeout(
  provider: TranscriptionProvider,
  input: TranscriptionProviderInput,
  timeoutMs: number,
): Promise<TranscriptionProviderResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      provider.transcribe(input),
      new Promise<TranscriptionProviderResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new MediaIngestError(
              `Transcription provider timed out after ${timeoutMs} ms.`,
              'transcription-timeout',
              504,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';

  constructor(private readonly sourceLanguage: string) {}

  async transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> {
    return {
      segments: [
        {
          text: `Mock transcript chunk ${input.chunk.index + 1}`,
          startMs: 0,
          endMs: Math.max(0, input.chunk.endMs - input.chunk.startMs),
        },
      ],
      detectedLanguage: this.sourceLanguage,
      confidence: 0.99,
      providerLatencyMs: 0,
    };
  }
}

export class FasterWhisperTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'faster-whisper';
  private readonly runCommand: CommandRunner;
  private readonly createWorker: PythonWorkerFactory;
  private readonly workers = new Map<FasterWhisperConfig['device'], PythonWorkerLike>();
  private preferCpuFallback = false;

  /** Where "the model heard nothing" is defined. Read once, at construction. */
  private readonly hallucination: HallucinationThresholds = readHallucinationThresholds(process.env);

  constructor(private readonly options: FasterWhisperProviderOptions) {
    validateFasterWhisperConfig(options);
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.createWorker = options.createWorker ?? createPersistentPythonWorker;
  }

  /**
   * Loads the model ahead of the first real chunk by transcribing a tiny
   * silent clip. Without this, the first upload after service start pays the
   * whole model load inside the pipeline's per-chunk timeout and fails on
   * slow or memory-pressured machines while a later retry succeeds.
   */
  async warmUp(): Promise<void> {
    const warmupPath = resolve(
      tmpdir(),
      `videofy-whisper-warmup-${process.pid}.wav`,
    );
    await writeFile(warmupPath, silentWav(WARMUP_SILENCE_MS));
    try {
      const device = this.preferCpuFallback ? 'cpu' : this.options.device;
      await this.workerFor(device).request(
        { audioPath: warmupPath, languageHint: null },
        { timeoutMs: WARMUP_TIMEOUT_MS },
      );
    } finally {
      await rm(warmupPath, { force: true }).catch(() => undefined);
    }
  }

  async transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> {
    const startedAt = Date.now();
    const audioPath = await this.prepareAudioPath(input);
    const result = await this.runFasterWhisper(
      audioPath,
      input.sourceLanguageMode === 'manual' ? input.sourceLanguage : undefined,
    );
    const providerLatencyMs = Math.max(0, Date.now() - startedAt);
    if (
      this.options.device === 'cuda' &&
      result.device !== 'cuda' &&
      !this.options.allowGpuFallback
    ) {
      throw new MediaIngestError(
        `faster-whisper did not run on requested GPU device. Requested cuda, received ${result.device}.`,
        'transcription-gpu-unavailable',
        500,
      );
    }

    // Words the model itself believes were never spoken are dropped HERE, at
    // the boundary where they enter the system, rather than downstream. A
    // fabricated sentence that gets past this point is translated and then
    // spoken in the speaker's own voice, and by then nothing can tell it from
    // something they said.
    const { kept, rejected } = rejectHallucinatedSpeech(result.segments, this.hallucination);
    if (rejected > 0) {
      // Counts and probabilities, never the invented text: writing that down is
      // how it ends up quoted back as though somebody said it. The numbers are
      // here so the thresholds can be tuned from a real microphone in a real
      // room rather than guessed at.
      logger.info('Discarded transcription the model reported as silence', {
        rejected,
        noSpeechProbs: result.segments
          .filter((segment) => typeof segment.noSpeechProb === 'number')
          .map((segment) => Number(segment.noSpeechProb).toFixed(2)),
      });
    }

    return {
      segments: kept,
      detectedLanguage: result.detectedLanguage,
      confidence: result.confidence,
      providerLatencyMs,
    };
  }

  private async prepareAudioPath(input: TranscriptionProviderInput): Promise<string> {
    if (isAlreadyNormalizedWav(input.audioPath)) {
      return input.audioPath;
    }

    const normalizedPath = resolve(
      input.audioPath,
      '..',
      `${basename(input.audioPath, extname(input.audioPath))}.normalized.wav`,
    );
    try {
      await this.runCommand(
        this.options.ffmpegExecutable,
        buildFfmpegNormalizeArgs(input.audioPath, normalizedPath),
        { timeoutMs: this.options.timeoutMs },
      );
      return normalizedPath;
    } catch (error) {
      throw classifyCommandError(
        error,
        'ffmpeg',
        `FFmpeg microphone audio normalisation failed.`,
      );
    }
  }

  private async runFasterWhisper(
    audioPath: string,
    languageHint: string | undefined,
  ): Promise<FasterWhisperJsonResult> {
    const initialDevice = this.preferCpuFallback ? 'cpu' : this.options.device;
    try {
      return await this.runFasterWhisperOnDevice(audioPath, initialDevice, languageHint);
    } catch (error) {
      if (
        initialDevice === 'cuda' &&
        this.options.allowGpuFallback &&
        error instanceof MediaIngestError &&
        error.code === 'transcription-gpu-unavailable'
      ) {
        // Remember the fallback so subsequent chunks do not pay a failed GPU
        // worker start-up (and model reload attempt) each time.
        this.preferCpuFallback = true;
        return await this.runFasterWhisperOnDevice(audioPath, 'cpu', languageHint);
      }
      throw error;
    }
  }

  private async runFasterWhisperOnDevice(
    audioPath: string,
    device: FasterWhisperConfig['device'],
    languageHint: string | undefined,
  ): Promise<FasterWhisperJsonResult> {
    try {
      const raw = await this.workerFor(device).request(
        { audioPath, languageHint: languageHint ?? null },
        { timeoutMs: this.options.timeoutMs },
      );
      const parsed = parseFasterWhisperResult(raw);
      if (!parsed.device) parsed.device = device;
      return parsed;
    } catch (error) {
      throw classifyCommandError(error, 'python', `faster-whisper transcription failed.`);
    }
  }

  private workerFor(device: FasterWhisperConfig['device']): PythonWorkerLike {
    const existing = this.workers.get(device);
    if (existing) return existing;
    const worker = this.createWorker({
      command: this.options.pythonExecutable,
      args: [
        '-c',
        FASTER_WHISPER_WORKER_SCRIPT,
        this.options.modelSize,
        device,
        this.options.computeType,
        this.options.modelCacheDir ?? '',
      ],
      maxConcurrency: 1,
      label: 'faster-whisper',
    });
    this.workers.set(device, worker);
    return worker;
  }

  dispose(): void {
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
  }
}

function isAlreadyNormalizedWav(audioPath: string): boolean {
  return extname(audioPath).toLowerCase() === '.wav';
}

function buildFfmpegNormalizeArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    'wav',
    outputPath,
  ];
}

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<CommandResult> {
  const result = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

interface FasterWhisperJsonResult {
  segments: TranscriptionSegment[];
  detectedLanguage: string;
  confidence: number | null;
  device: string;
}

function parseFasterWhisperResult(raw: unknown): FasterWhisperJsonResult {
  if (!isRecord(raw)) {
    throw new MediaIngestError(
      'faster-whisper returned an invalid response shape.',
      'transcription-failed',
      500,
    );
  }
  return {
    segments: parseFasterWhisperSegments(raw['segments']),
    detectedLanguage:
      typeof raw['detectedLanguage'] === 'string' && raw['detectedLanguage']
        ? raw['detectedLanguage']
        : 'und',
    confidence:
      typeof raw['confidence'] === 'number' && Number.isFinite(raw['confidence'])
        ? Math.max(0, Math.min(1, raw['confidence']))
        : null,
    device: typeof raw['device'] === 'string' && raw['device'] ? raw['device'] : '',
  };
}

function parseFasterWhisperSegments(value: unknown): TranscriptionSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptionSegment[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['text'] !== 'string') continue;
    const startMs =
      typeof entry['startMs'] === 'number' && Number.isFinite(entry['startMs'])
        ? Math.max(0, Math.round(entry['startMs']))
        : 0;
    const endMs =
      typeof entry['endMs'] === 'number' && Number.isFinite(entry['endMs'])
        ? Math.max(startMs, Math.round(entry['endMs']))
        : startMs;
    const probability = (name: string): number | null =>
      typeof entry[name] === 'number' && Number.isFinite(entry[name] as number)
        ? (entry[name] as number)
        : null;
    segments.push({
      text: entry['text'],
      startMs,
      endMs,
      noSpeechProb: probability('noSpeechProb'),
      avgLogProb: probability('avgLogProb'),
    });
  }
  return segments;
}

function classifyCommandError(
  error: unknown,
  commandKind: 'python' | 'ffmpeg',
  fallbackMessage: string,
): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : fallbackMessage;
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      commandKind === 'python'
        ? 'Python executable not found for faster-whisper transcription.'
        : 'FFmpeg executable not found for microphone audio normalisation.',
      commandKind === 'python'
        ? 'transcription-python-unavailable'
        : 'transcription-ffmpeg-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError(
      'faster-whisper transcription timed out.',
      'transcription-timeout',
      504,
    );
  }
  if (combined.includes('no module named') || combined.includes('faster_whisper')) {
    return new MediaIngestError(
      'Python faster-whisper package is unavailable.',
      'transcription-python-unavailable',
      500,
    );
  }
  if (
    combined.includes('model') &&
    (combined.includes('not found') ||
      combined.includes('unable to open') ||
      combined.includes('does not exist') ||
      combined.includes('not a local folder'))
  ) {
    return new MediaIngestError(
      'faster-whisper model is unavailable or missing from the configured cache.',
      'transcription-model-unavailable',
      500,
    );
  }
  if (
    combined.includes('cuda') ||
    combined.includes('cudnn') ||
    combined.includes('gpu') ||
    combined.includes('ctranslate2')
  ) {
    return new MediaIngestError(
      'GPU support is unavailable for faster-whisper with the configured device/compute type.',
      'transcription-gpu-unavailable',
      500,
    );
  }

  return new MediaIngestError(`${fallbackMessage} ${message}`, 'transcription-failed', 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateFasterWhisperConfig(config: FasterWhisperConfig): void {
  if (config.modelCacheDir && !existsSync(config.modelCacheDir)) {
    throw new MediaIngestError(
      `Configured faster-whisper model cache directory does not exist: ${config.modelCacheDir}.`,
      'transcription-model-unavailable',
      500,
    );
  }
}

/**
 * Persistent faster-whisper worker: imports faster_whisper and loads the
 * WhisperModel once per process, then serves {"audioPath", "languageHint"}
 * requests over the shared stdin/stdout JSON-lines loop.
 */
const FASTER_WHISPER_WORKER_SCRIPT = `${PYTHON_WORKER_LOOP}\n${String.raw`
import math

model_size = sys.argv[1]
device = sys.argv[2]
compute_type = sys.argv[3]
model_cache_dir = sys.argv[4] or None

from faster_whisper import WhisperModel

kwargs = {"device": device, "compute_type": compute_type}
if model_cache_dir:
    kwargs["download_root"] = model_cache_dir

model = WhisperModel(model_size, **kwargs)

def handle(payload):
    audio_path = payload["audioPath"]
    language_hint = payload.get("languageHint") or None
    transcribe_kwargs = {
        "vad_filter": True,
        # Kept, but NOT the fix it was credited with being.
        #
        # This library only carries context across 30-second decode windows, and
        # a call chunk is never that long — so for live calls this kwarg is a
        # no-op. It still matters for the upload/programme path, and it would
        # matter here if chunk length ever grew, which is why it stays set.
        #
        # SCOPE (corrected 17 Aug 2026). The paragraph below is accurate about
        # the session it describes: same-language identical repetition while the
        # synthesiser was speaking a DIFFERENT language, which is the recogniser
        # filling in near-silence. It is not a complete account of "repetition on
        # a call", and reading it as one sent a later investigation down the
        # wrong path. There are TWO distinct defects:
        #
        #   Defect A - near-silence / recogniser fabrication. This comment, the
        #     gateway VAD voiced-fraction rule, and speech-confidence.ts.
        #   Defect B - ACOUSTIC RECAPTURE: translated speech leaves a
        #     loudspeaker, re-enters an open microphone, and is transcribed as
        #     fresh human speech. Nothing here addresses it, and no Whisper
        #     setting can: the audio really was spoken, just not by a person.
        #     Its signature is a caption whose text is in the WRONG LANGUAGE for
        #     its declared sourceLanguage while playback was active.
        #
        # Both are real. Neither fix substitutes for the other.
        #
        # With this true the model is primed with the text it produced for the
        # PREVIOUS chunk, so a call becomes a feedback loop: it completes
        # sentences the speaker never finished, and once it repeats a phrase it
        # keeps repeating it. Reported from a real call as "a lot of
        # repetitions" and "I only said the first words" — and this service
        # transcribes an interim chunk every 1.5 seconds, which hands the loop
        # a fresh opportunity six times a sentence.
        #
        # Off means each chunk is transcribed on its own audio and nothing else.
        "condition_on_previous_text": False,
        # No sampling. The default falls back through increasing temperatures
        # when a decode looks poor, which is how a doubtful segment becomes a
        # confident invention on the retry.
        "temperature": 0.0,
        # The model's own silence filters, aligned with speech-confidence.ts so
        # the same numbers mean the same thing on both sides of the boundary.
        "no_speech_threshold": 0.6,
        "log_prob_threshold": -1.0,
    }
    if language_hint:
        transcribe_kwargs["language"] = language_hint
    segments, info = model.transcribe(audio_path, **transcribe_kwargs)
    segment_payloads = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            # noSpeechProb and avgLogProb are the model's own evidence that it
            # heard nothing and guessed anyway. Discarding them — as this did —
            # leaves no way to tell an utterance from a fabrication.
            no_speech = getattr(segment, "no_speech_prob", None)
            avg_logprob = getattr(segment, "avg_logprob", None)
            segment_payloads.append({
                "text": text,
                "startMs": int(round((segment.start or 0.0) * 1000)),
                "endMs": int(round((segment.end or 0.0) * 1000)),
                "noSpeechProb": no_speech if isinstance(no_speech, float) and math.isfinite(no_speech) else None,
                "avgLogProb": avg_logprob if isinstance(avg_logprob, float) and math.isfinite(avg_logprob) else None,
            })
    confidence = getattr(info, "language_probability", None)
    if confidence is not None and not math.isfinite(confidence):
        confidence = None
    return {
        "segments": segment_payloads,
        "detectedLanguage": getattr(info, "language", None) or "und",
        "confidence": confidence,
        "device": device,
    }

run_worker_loop(handle)
`}`;

/**
 * Per-request fallback for batch transcription.
 *
 * Translation and speech synthesis have had composites since P6.1; STT has not,
 * which meant there was no degraded path at all -- a primary failure was a
 * failed chunk. The asymmetry was an omission rather than a decision.
 *
 * Deliberately simpler than the translation composite: that one learns which
 * language PAIRS a primary cannot serve and routes them permanently. There is no
 * equivalent per-request key here, so this retries once and reports which
 * provider actually answered.
 */
export interface CompositeTranscriptionProviderOptions {
  primary: TranscriptionProvider;
  fallback: TranscriptionProvider;
  /** Called when the primary failed and the fallback was used. */
  onFallback?: (detail: { provider: string; message: string }) => void;
}

export class CompositeTranscriptionProvider implements TranscriptionProvider {
  readonly name: string;
  private readonly primary: TranscriptionProvider;
  private readonly fallback: TranscriptionProvider;
  private readonly onFallback: (detail: { provider: string; message: string }) => void;

  constructor(options: CompositeTranscriptionProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.name = `${options.primary.name}+${options.fallback.name}`;
    this.onFallback = options.onFallback ?? (() => {});
  }

  async transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> {
    try {
      return await this.primary.transcribe(input);
    } catch (error) {
      // Reported, never silent. A fallback nobody knows happened is how a
      // degraded provider stays degraded for a month.
      const message = error instanceof Error ? error.message : 'unknown';
      this.onFallback({ provider: this.primary.name, message });
      return await this.fallback.transcribe(input);
    }
  }

  async warmUp(): Promise<void> {
    // Both, because either may serve the first real chunk.
    await Promise.allSettled([this.primary.warmUp?.(), this.fallback.warmUp?.()]);
  }
}

/**
 * Normalize a batch result into platform-owned `TranscriptEvent`s.
 *
 * This is the batch half of the normalization boundary. Each provider segment
 * becomes one CANONICAL FINAL -- batch has no interim state to be reversible
 * about, so it never produces a partial.
 *
 * The segment ids come from `mintSegmentId`, exactly as on the streaming side.
 * A provider index or a vendor-supplied id would make batch and streaming
 * segments identify differently, and downstream would have to know which
 * execution mode produced an event in order to interpret it -- which is the
 * coupling this boundary exists to prevent.
 */
export function toTranscriptEvents(
  result: TranscriptionProviderResult,
  context: {
    sessionId: string;
    streamId: string;
    providerName: string;
    mintSegmentId: () => string;
    /** Offset of this chunk on the platform timeline. */
    chunkStartMs: number;
    discontinuity?: boolean;
  },
): TranscriptEvent[] {
  return result.segments
    .filter((segment) => segment.text.trim() !== '')
    .map((segment) => ({
      kind: 'final' as const,
      sessionId: context.sessionId,
      streamId: context.streamId,
      segmentId: context.mintSegmentId(),
      // Batch emits one canonical final per segment, so the first revision is
      // also the last. Streaming reaches higher numbers; nothing downstream
      // should care which, only that higher supersedes lower.
      revision: 1,
      text: segment.text,
      startMs: context.chunkStartMs + segment.startMs,
      endMs: context.chunkStartMs + segment.endMs,
      ...(result.detectedLanguage === '' ? {} : { detectedLanguage: result.detectedLanguage }),
      ...(context.discontinuity ? { discontinuity: true } : {}),
      provider: {
        name: context.providerName,
        startMs: segment.startMs,
        endMs: segment.endMs,
        confidence: result.confidence,
        ...(segment.noSpeechProb === undefined ? {} : { noSpeechProb: segment.noSpeechProb }),
        ...(segment.avgLogProb === undefined ? {} : { avgLogProb: segment.avgLogProb }),
        ...(result.providerLatencyMs === undefined ? {} : { latencyMs: result.providerLatencyMs }),
      },
    }));
}
