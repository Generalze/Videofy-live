import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AudioChunkMetadata } from '@videofy-live/shared-types';
import { MediaIngestError } from './ingest-error.js';
import {
  filterHallucinatedSegments,
  type RecognisedSegment,
} from './hallucination-filter.js';
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
   * The recogniser's own doubt about this segment, passed on rather than
   * consumed. The provider drops what is plainly not speech, but a caller with
   * more context can be stricter — an interim caption is a preview of a
   * half-spoken sentence and can afford to wait, where a final cannot.
   * Absent when the provider does not report them.
   */
  noSpeechProb?: number | null;
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
  /** See FasterWhisperProviderOptions.detectForeignSpeech. */
  detectForeignSpeech?: boolean;
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
  /**
   * Ask the recogniser, separately from transcription, what language was
   * actually spoken, and discard the utterance when it confidently disagrees
   * with what the participant declared.
   *
   * This exists for the case where one microphone feeds two sessions with
   * different declared languages — a shared device, or a second voice in the
   * room. The session whose language is not being spoken otherwise publishes
   * fluent nonsense under that participant's name.
   *
   * Costs an extra detection pass per chunk, so it is opt-in.
   */
  detectForeignSpeech?: boolean;
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

    // Silence transcribed as subtitle credits or invented replies reaches
    // participants as captions that appear by themselves, so it is removed here
    // rather than downstream: everything after this point treats a segment as
    // something a person said.
    const { kept } = filterHallucinatedSegments(result.segments);

    // The declared language still drives transcription; this only refuses to
    // publish when the recogniser separately says, with high confidence, that
    // a different language was spoken. Silence is better than a fluent
    // invention attributed to someone who did not say it.
    const declared = input.sourceLanguageMode === 'manual' ? input.sourceLanguage : null;
    if (
      declared &&
      result.spokenLanguage &&
      primarySubtag(result.spokenLanguage) !== primarySubtag(declared) &&
      (result.spokenLanguageProbability ?? 0) >= FOREIGN_SPEECH_CONFIDENCE
    ) {
      return {
        segments: [],
        detectedLanguage: result.detectedLanguage,
        confidence: result.confidence,
        providerLatencyMs,
      };
    }

    return {
      segments: kept.map((segment) => ({
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
        noSpeechProb: segment.noSpeechProb ?? null,
        avgLogProb: segment.avgLogProb ?? null,
      })),
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
        this.options.detectForeignSpeech ? '1' : '',
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
  /** Carries the recogniser's own non-speech/confidence signals for filtering. */
  segments: RecognisedSegment[];
  detectedLanguage: string;
  confidence: number | null;
  /**
   * What the recogniser believes was actually spoken, asked separately so a
   * forced decoder cannot simply echo the language it was told to use. Null
   * when detection is off or failed.
   */
  spokenLanguage: string | null;
  spokenLanguageProbability: number | null;
  device: string;
}

/**
 * How sure the recogniser must be that a DIFFERENT language was spoken before
 * an utterance is refused. Deliberately high: losing real speech is the worse
 * failure, and the participant's declaration wins every close call.
 */
const FOREIGN_SPEECH_CONFIDENCE = 0.85;

/** Compares languages by primary subtag, matching the rest of the pipeline. */
function primarySubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
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
    spokenLanguage:
      typeof raw['spokenLanguage'] === 'string' && raw['spokenLanguage']
        ? raw['spokenLanguage']
        : null,
    spokenLanguageProbability: finiteOrNull(raw['spokenLanguageProbability']),
    device: typeof raw['device'] === 'string' && raw['device'] ? raw['device'] : '',
  };
}

function parseFasterWhisperSegments(value: unknown): RecognisedSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: RecognisedSegment[] = [];
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
    segments.push({
      text: entry['text'],
      startMs,
      endMs,
      // Absent when a provider does not report them; the filter then leaves the
      // segment alone rather than dropping everything it cannot judge.
      noSpeechProb: finiteOrNull(entry['noSpeechProb']),
      avgLogProb: finiteOrNull(entry['avgLogProb']),
    });
  }
  return segments;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

detect_foreign = (sys.argv[5] if len(sys.argv) > 5 else "") == "1"

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

kwargs = {"device": device, "compute_type": compute_type}
if model_cache_dir:
    kwargs["download_root"] = model_cache_dir

model = WhisperModel(model_size, **kwargs)

def handle(payload):
    audio_path = payload["audioPath"]
    language_hint = payload.get("languageHint") or None
    transcribe_kwargs = {
        "vad_filter": True,
        # Each chunk is an independent utterance from a live call, not the next
        # part of one recording. Conditioning on previous text lets an invented
        # line become the context for the next one, which is how a single
        # hallucination turns into a run of them.
        "condition_on_previous_text": False,
    }
    # The declared language IS forced onto the decoder. Letting it auto-detect
    # instead was tried and made recognition materially worse: a French speaker
    # producing short utterances is frequently detected as English, and the
    # result is either English words published under their name or the
    # utterance discarded entirely. Manual language authority exists precisely
    # because the speaker knows better than the detector.
    if language_hint:
        transcribe_kwargs["language"] = language_hint

    # What was ACTUALLY spoken, asked separately so it cannot influence the
    # transcription above. A forced decoder reports back the language it was
    # told to use, so it can never reveal that the microphone is carrying
    # something else — which is what a shared device or a second voice in the
    # room produces. Best effort only: if detection fails the utterance is
    # published as normal.
    spoken_language = None
    spoken_probability = None
    if language_hint and detect_foreign:
        try:
            waveform = decode_audio(audio_path, sampling_rate=16000)
            spoken_language, spoken_probability, _ = model.detect_language(
                audio=waveform, vad_filter=True
            )
            spoken_probability = float(spoken_probability)
        except Exception:
            spoken_language = None
            spoken_probability = None

    segments, info = model.transcribe(audio_path, **transcribe_kwargs)
    segment_payloads = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            # The recogniser's own view of whether this was speech at all, and
            # how confident it was, travel with the text so the caller can drop
            # confident silence without re-deriving it.
            no_speech = getattr(segment, "no_speech_prob", None)
            avg_logprob = getattr(segment, "avg_logprob", None)
            segment_payloads.append({
                "text": text,
                "startMs": int(round((segment.start or 0.0) * 1000)),
                "endMs": int(round((segment.end or 0.0) * 1000)),
                "noSpeechProb": float(no_speech) if no_speech is not None and math.isfinite(no_speech) else None,
                "avgLogProb": float(avg_logprob) if avg_logprob is not None and math.isfinite(avg_logprob) else None,
            })
    confidence = getattr(info, "language_probability", None)
    if confidence is not None and not math.isfinite(confidence):
        confidence = None
    return {
        "segments": segment_payloads,
        "detectedLanguage": getattr(info, "language", None) or "und",
        "confidence": confidence,
        "spokenLanguage": spoken_language,
        "spokenLanguageProbability": spoken_probability,
        "device": device,
    }

run_worker_loop(handle)
`}`;
