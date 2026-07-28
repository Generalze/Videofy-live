import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AudioChunkMetadata } from '@videofy-live/shared-types';
import { MediaIngestError } from './ingest-error.js';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface TranscriptionProviderInput {
  sessionId: string;
  streamId: string;
  chunk: AudioChunkMetadata;
  audioPath: string;
  sourceLanguage?: string;
  sourceLanguageMode?: 'manual' | 'auto-detect';
}

export interface TranscriptionProviderResult {
  sourceText: string;
  detectedLanguage: string;
  confidence: number | null;
  providerLatencyMs?: number | null;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult>;
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
  runCommand?: CommandRunner;
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
      sourceText: `Mock transcript chunk ${input.chunk.index + 1}`,
      detectedLanguage: this.sourceLanguage,
      confidence: 0.99,
      providerLatencyMs: 0,
    };
  }
}

export class FasterWhisperTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'faster-whisper';
  private readonly runCommand: CommandRunner;

  constructor(private readonly options: FasterWhisperProviderOptions) {
    validateFasterWhisperConfig(options);
    this.runCommand = options.runCommand ?? defaultCommandRunner;
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

    return {
      sourceText: result.text,
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
    try {
      return await this.runFasterWhisperOnDevice(audioPath, this.options.device, languageHint);
    } catch (error) {
      if (
        this.options.device === 'cuda' &&
        this.options.allowGpuFallback &&
        error instanceof MediaIngestError &&
        error.code === 'transcription-gpu-unavailable'
      ) {
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
    const args = [
      '-c',
      FASTER_WHISPER_SCRIPT,
      audioPath,
      this.options.modelSize,
      device,
      this.options.computeType,
      this.options.modelCacheDir ?? '',
      languageHint ?? '',
    ];

    try {
      const result = await this.runCommand(this.options.pythonExecutable, args, {
        timeoutMs: this.options.timeoutMs,
      });
      const parsed = parseFasterWhisperResult(result.stdout);
      if (!parsed.device) parsed.device = device;
      return parsed;
    } catch (error) {
      throw classifyCommandError(error, 'python', `faster-whisper transcription failed.`);
    }
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
  text: string;
  detectedLanguage: string;
  confidence: number | null;
  device: string;
}

function parseFasterWhisperResult(stdout: string): FasterWhisperJsonResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new MediaIngestError(
      'faster-whisper returned invalid JSON output.',
      'transcription-failed',
      500,
    );
  }

  if (!isRecord(raw)) {
    throw new MediaIngestError(
      'faster-whisper returned an invalid response shape.',
      'transcription-failed',
      500,
    );
  }
  return {
    text: typeof raw['text'] === 'string' ? raw['text'] : '',
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

const FASTER_WHISPER_SCRIPT = String.raw`
import json
import math
import sys

audio_path = sys.argv[1]
model_size = sys.argv[2]
device = sys.argv[3]
compute_type = sys.argv[4]
model_cache_dir = sys.argv[5] or None
language_hint = sys.argv[6] or None

from faster_whisper import WhisperModel

kwargs = {"device": device, "compute_type": compute_type}
if model_cache_dir:
    kwargs["download_root"] = model_cache_dir

model = WhisperModel(model_size, **kwargs)
transcribe_kwargs = {"vad_filter": True}
if language_hint:
    transcribe_kwargs["language"] = language_hint
segments, info = model.transcribe(audio_path, **transcribe_kwargs)
texts = []
for segment in segments:
    text = (segment.text or "").strip()
    if text:
        texts.append(text)

confidence = getattr(info, "language_probability", None)
if confidence is not None and not math.isfinite(confidence):
    confidence = None

print(json.dumps({
    "text": " ".join(texts).strip(),
    "detectedLanguage": getattr(info, "language", None) or "und",
    "confidence": confidence,
    "device": device,
}))
`;
