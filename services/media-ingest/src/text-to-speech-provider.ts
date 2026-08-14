// Repository owner: masterzee001.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { MediaIngestError } from './ingest-error.js';
import {
  PYTHON_WORKER_LOOP,
  PythonWorkerError,
  createPersistentPythonWorker,
  type PythonWorkerFactory,
  type PythonWorkerLike,
} from './persistent-python-worker.js';

const execFileAsync = promisify(execFile);
// TTS requests beyond the worker's concurrency queue inside the persistent
// worker; only once this many requests are already queued do we fail fast.
const MAX_QUEUED_TTS_REQUESTS = 200;

export interface TextToSpeechProviderInput {
  sessionId: string;
  streamId: string;
  segmentId: string;
  sequence: number;
  targetLanguage: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  voiceId: string;
  outputPath: string;
}

export interface TextToSpeechProviderResult {
  audioPath: string;
  providerLatencyMs?: number | null;
}

export interface TextToSpeechProvider {
  readonly name: string;
  generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult>;
  dispose?(): void;
}

export interface PiperVoiceConfig {
  voiceId: string;
  language: string;
  modelPath: string;
  configPath: string | null;
  sampleRateHz?: number;
  lengthScale?: number;
  noiseScale?: number;
  noiseW?: number;
  sentenceSilence?: number;
  /** Piper multi-speaker model speaker; zero is a valid selection. */
  speakerId?: number;
}

export const DEFAULT_PIPER_SAMPLE_RATE_HZ = 22_050;

const PIPER_LOUDNORM_FILTER = 'loudnorm=I=-19:TP=-1.5:LRA=7';
const PIPER_MAX_ATEMPO = 1.25;
const PIPER_DURATION_FIT_TOLERANCE = 1.05;
const PIPER_PRE_FIT_TOLERANCE = 1.1;
const PIPER_MIN_PRE_FIT_LENGTH_SCALE = 0.8;
const PIPER_DEFAULT_CHARS_PER_SECOND = 13;
const PIPER_CHARS_PER_SECOND_BY_LANGUAGE: Readonly<Record<string, number>> = {
  ar: 12,
  es: 15,
  fr: 14,
  pt: 14,
};

export interface TextToSpeechProviderConfig {
  providerName: 'mock' | 'piper' | 'piper+mms';
  timeoutMs: number;
  supportedLanguages: string[];
  defaultVoiceId: string;
  piper: PiperTextToSpeechProviderOptions;
  mms?: MmsTextToSpeechProviderOptions;
}

export interface PiperConfig {
  executable: string;
  ffmpegExecutable?: string;
  voices: PiperVoiceConfig[];
  timeoutMs: number;
}

export interface PiperCommandResult {
  stdout: string;
  stderr: string;
}

export type PiperCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; input: string },
) => Promise<PiperCommandResult>;

export type NormalizeCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<PiperCommandResult>;

export interface PiperTextToSpeechProviderOptions extends PiperConfig {
  runCommand?: PiperCommandRunner;
  runNormalizeCommand?: NormalizeCommandRunner;
}

export interface MmsTtsVoiceConfig {
  language: string;
  modelId: string;
  localPath: string | null;
}

export interface MmsTtsConfig {
  pythonExecutable: string;
  ffmpegExecutable?: string;
  voices: MmsTtsVoiceConfig[];
  modelCacheDir: string | null;
  allowModelDownload: boolean;
  timeoutMs: number;
}

export interface MmsTextToSpeechProviderOptions extends MmsTtsConfig {
  /** Seam for the persistent MMS-TTS python worker. */
  createWorker?: PythonWorkerFactory;
  runNormalizeCommand?: NormalizeCommandRunner;
}

export function createTextToSpeechProvider(
  config: TextToSpeechProviderConfig,
): TextToSpeechProvider {
  if (config.providerName === 'mock') {
    return new MockTextToSpeechProvider(config.supportedLanguages);
  }
  if (config.providerName === 'piper') {
    return new PiperTextToSpeechProvider(config.piper);
  }
  if (config.providerName === 'piper+mms') {
    if (!config.mms) {
      throw new MediaIngestError(
        'The piper+mms text-to-speech provider requires mms configuration.',
        'unsupported-tts-provider',
        400,
      );
    }
    return new CompositeTextToSpeechProvider({
      primary: new PiperTextToSpeechProvider(config.piper),
      primaryLanguages: config.piper.voices.map((voice) => voice.language),
      secondary: new MmsTextToSpeechProvider(config.mms),
      secondaryLanguages: config.mms.voices.map((voice) => voice.language),
    });
  }
  throw new MediaIngestError(
    `Unsupported text-to-speech provider: ${config.providerName}.`,
    'unsupported-tts-provider',
    400,
  );
}

export async function generateSpeechWithTimeout(
  provider: TextToSpeechProvider,
  input: TextToSpeechProviderInput,
  timeoutMs: number,
): Promise<TextToSpeechProviderResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      provider.generate(input),
      new Promise<TextToSpeechProviderResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new MediaIngestError(
              `Text-to-speech provider timed out after ${timeoutMs} ms.`,
              'tts-timeout',
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

export class MockTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'mock';

  constructor(private readonly supportedLanguages: readonly string[]) {}

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    if (!this.supportedLanguages.includes(input.targetLanguage)) {
      throw new MediaIngestError(
        `Unsupported TTS language: ${input.targetLanguage}.`,
        'unsupported-tts-language',
        400,
      );
    }
    return await writeMinimalWav(input.outputPath);
  }
}

export interface CompositeTextToSpeechProviderOptions {
  primary: TextToSpeechProvider;
  primaryLanguages: readonly string[];
  secondary: TextToSpeechProvider;
  secondaryLanguages: readonly string[];
}

/**
 * Routes each request by target language: the primary engine (Piper) serves
 * every language it has a configured voice for, and the secondary engine
 * (MMS-TTS) covers the remaining languages.
 */
export class CompositeTextToSpeechProvider implements TextToSpeechProvider {
  readonly name: string;
  private readonly primary: TextToSpeechProvider;
  private readonly secondary: TextToSpeechProvider;
  private readonly primaryLanguages: Set<string>;
  private readonly secondaryLanguages: Set<string>;

  constructor(options: CompositeTextToSpeechProviderOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.name = `${options.primary.name}+${options.secondary.name}`;
    this.primaryLanguages = new Set(
      options.primaryLanguages.map((language) => language.toLowerCase()),
    );
    this.secondaryLanguages = new Set(
      options.secondaryLanguages.map((language) => language.toLowerCase()),
    );
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const language = input.targetLanguage.toLowerCase();
    if (this.primaryLanguages.has(language)) {
      return await this.primary.generate(input);
    }
    if (this.secondaryLanguages.has(language)) {
      return await this.secondary.generate(input);
    }
    throw new MediaIngestError(
      `Unsupported TTS language: ${input.targetLanguage}.`,
      'unsupported-tts-language',
      400,
    );
  }

  dispose(): void {
    this.primary.dispose?.();
    this.secondary.dispose?.();
  }
}

export class MmsTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'mms';
  private readonly createWorker: PythonWorkerFactory;
  private readonly runNormalizeCommand: NormalizeCommandRunner;
  private worker: PythonWorkerLike | null = null;

  constructor(private readonly options: MmsTextToSpeechProviderOptions) {
    validateMmsTtsConfig(options);
    this.createWorker = options.createWorker ?? createPersistentPythonWorker;
    this.runNormalizeCommand = options.runNormalizeCommand ?? defaultNormalizeCommandRunner;
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const voice = this.resolveVoice(input.targetLanguage);
    if (!input.translatedText) {
      return await writeMinimalWav(input.outputPath);
    }

    const startedAt = Date.now();
    const rawOutputPath = `${input.outputPath}.mms.wav`;
    try {
      await mkdir(dirname(input.outputPath), { recursive: true });
      const raw = await this.getWorker().request(
        {
          text: input.translatedText,
          modelId: voice.modelId,
          localPath: voice.localPath,
          outputPath: rawOutputPath,
        },
        { timeoutMs: this.options.timeoutMs },
      );
      const synthesis = parseMmsTtsResult(raw);
      await normalizeSynthesizedWav({
        engineLabel: 'MMS',
        ffmpegExecutable: this.options.ffmpegExecutable ?? 'ffmpeg',
        runNormalizeCommand: this.runNormalizeCommand,
        timeoutMs: this.options.timeoutMs,
        rawOutputPath,
        outputPath: input.outputPath,
        sampleRateHz: synthesis.sampleRateHz,
        startMs: input.startMs,
        endMs: input.endMs,
      });
      return {
        audioPath: input.outputPath,
        providerLatencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      throw classifyMmsTtsError(error);
    }
  }

  dispose(): void {
    this.worker?.dispose();
    this.worker = null;
  }

  private resolveVoice(targetLanguage: string): MmsTtsVoiceConfig {
    const normalized = targetLanguage.toLowerCase();
    const voice = this.options.voices.find(
      (candidate) => candidate.language.toLowerCase() === normalized,
    );
    if (!voice) {
      throw new MediaIngestError(
        `Unsupported TTS language: ${targetLanguage}.`,
        'unsupported-tts-language',
        400,
      );
    }
    return voice;
  }

  private getWorker(): PythonWorkerLike {
    if (!this.worker) {
      this.worker = this.createWorker({
        command: this.options.pythonExecutable,
        args: [
          '-c',
          MMS_TTS_WORKER_SCRIPT,
          this.options.modelCacheDir ?? '',
          this.options.allowModelDownload ? '1' : '0',
        ],
        maxConcurrency: 1,
        maxQueueLength: MAX_QUEUED_TTS_REQUESTS,
        label: 'mms-tts',
      });
    }
    return this.worker;
  }
}

export class PiperTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'piper';
  private readonly runCommand: PiperCommandRunner;
  private readonly runNormalizeCommand: NonNullable<PiperTextToSpeechProviderOptions['runNormalizeCommand']>;

  constructor(private readonly options: PiperTextToSpeechProviderOptions) {
    validatePiperConfig(options);
    this.runCommand = options.runCommand ?? defaultPiperCommandRunner;
    this.runNormalizeCommand = options.runNormalizeCommand ?? defaultNormalizeCommandRunner;
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const voice = this.resolveVoice(input.targetLanguage, input.voiceId);
    if (!input.translatedText) {
      return await writeMinimalWav(input.outputPath);
    }

    const startedAt = Date.now();
    const rawOutputPath = `${input.outputPath}.piper.wav`;
    try {
      await mkdir(dirname(input.outputPath), { recursive: true });
      const lengthScale = computePreFitLengthScale(voice, input);
      await this.runCommand(
        this.options.executable,
        buildPiperArgs(voice, rawOutputPath, lengthScale),
        {
          timeoutMs: this.options.timeoutMs,
          input: input.translatedText,
        },
      );
      await this.normalizeOutput(rawOutputPath, input.outputPath, voice, input);
      return {
        audioPath: input.outputPath,
        providerLatencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      throw classifyPiperError(error);
    }
  }

  private async normalizeOutput(
    inputPath: string,
    outputPath: string,
    voice: PiperVoiceConfig,
    input: TextToSpeechProviderInput,
  ): Promise<void> {
    await normalizeSynthesizedWav({
      engineLabel: 'Piper',
      ffmpegExecutable: this.options.ffmpegExecutable ?? 'ffmpeg',
      runNormalizeCommand: this.runNormalizeCommand,
      timeoutMs: this.options.timeoutMs,
      rawOutputPath: inputPath,
      outputPath,
      sampleRateHz: voice.sampleRateHz ?? DEFAULT_PIPER_SAMPLE_RATE_HZ,
      startMs: input.startMs,
      endMs: input.endMs,
    });
  }

  private resolveVoice(targetLanguage: string, voiceId: string): PiperVoiceConfig {
    const voice = this.options.voices.find((candidate) => candidate.voiceId === voiceId);
    if (!voice) {
      throw new MediaIngestError(
        `Unsupported Piper voice: ${voiceId}.`,
        'unsupported-tts-voice',
        400,
      );
    }
    if (voice.language !== targetLanguage) {
      throw new MediaIngestError(
        `Unsupported Piper language for voice ${voiceId}: ${targetLanguage}.`,
        'unsupported-tts-language',
        400,
      );
    }
    return voice;
  }
}

function buildPiperArgs(
  voice: PiperVoiceConfig,
  outputPath: string,
  lengthScaleOverride?: number,
): string[] {
  const args = ['--model', voice.modelPath, '--output_file', outputPath];
  if (voice.configPath) {
    args.push('--config', voice.configPath);
  }
  const lengthScale = lengthScaleOverride ?? voice.lengthScale;
  if (lengthScale !== undefined) {
    args.push('--length_scale', String(lengthScale));
  }
  if (voice.noiseScale !== undefined) {
    args.push('--noise_scale', String(voice.noiseScale));
  }
  if (voice.noiseW !== undefined) {
    args.push('--noise_w', String(voice.noiseW));
  }
  if (voice.sentenceSilence !== undefined) {
    args.push('--sentence_silence', String(voice.sentenceSilence));
  }
  if (voice.speakerId !== undefined) {
    args.push('--speaker', String(voice.speakerId));
  }
  return args;
}

function estimateNaturalSpeechMs(text: string, language: string): number {
  const charsPerSecond =
    PIPER_CHARS_PER_SECOND_BY_LANGUAGE[language] ?? PIPER_DEFAULT_CHARS_PER_SECOND;
  return Math.round((text.length / charsPerSecond) * 1000);
}

function computePreFitLengthScale(
  voice: PiperVoiceConfig,
  input: TextToSpeechProviderInput,
): number | undefined {
  const windowMs = input.endMs - input.startMs;
  if (windowMs <= 0) return undefined;
  const estimatedMs = estimateNaturalSpeechMs(input.translatedText, input.targetLanguage);
  if (estimatedMs <= windowMs * PIPER_PRE_FIT_TOLERANCE) return undefined;
  const fitScale = Math.min(1, Math.max(PIPER_MIN_PRE_FIT_LENGTH_SCALE, windowMs / estimatedMs));
  return Math.round((voice.lengthScale ?? 1) * fitScale * 10_000) / 10_000;
}

async function buildNormalizeAudioFilter(
  rawOutputPath: string,
  startMs: number,
  endMs: number,
): Promise<string> {
  const filters: string[] = [];
  const windowMs = endMs - startMs;
  const clipDurationMs = await readRawWavDurationMs(rawOutputPath);
  if (
    clipDurationMs !== null &&
    windowMs > 0 &&
    clipDurationMs > windowMs * PIPER_DURATION_FIT_TOLERANCE
  ) {
    const atempo = Math.min(PIPER_MAX_ATEMPO, Math.max(1, clipDurationMs / windowMs));
    filters.push(`atempo=${Math.round(atempo * 10_000) / 10_000}`);
  }
  filters.push(PIPER_LOUDNORM_FILTER);
  return filters.join(',');
}

async function readRawWavDurationMs(audioPath: string): Promise<number | null> {
  let buffer: Buffer;
  try {
    buffer = await readFile(audioPath);
  } catch {
    return null;
  }
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      byteRate = buffer.readUInt32LE(dataOffset + 8);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || dataSize === null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

async function defaultPiperCommandRunner(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; input: string },
): Promise<PiperCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Piper timed out after ${options.timeoutMs} ms.`);
      (error as { signal?: string }).signal = 'SIGTERM';
      reject(error);
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Piper exited with code ${code ?? 'unknown'}.`);
      (error as { stderr?: string }).stderr = stderr;
      reject(error);
    });

    child.stdin.end(`${options.input}\n`);
  });
}

async function defaultNormalizeCommandRunner(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<PiperCommandResult> {
  const result = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function classifyPiperError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : 'Piper generation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      'Piper executable not found for text-to-speech generation.',
      'tts-piper-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError('Piper generation timed out.', 'tts-timeout', 504);
  }
  if (combined.includes('model') && (combined.includes('not found') || combined.includes('no such'))) {
    return new MediaIngestError(
      'Piper model is unavailable or missing.',
      'tts-model-unavailable',
      500,
    );
  }

  return new MediaIngestError(`Piper generation failed. ${message}`, 'tts-failed', 500);
}

interface NormalizeSynthesizedWavOptions {
  engineLabel: string;
  ffmpegExecutable: string;
  runNormalizeCommand: NormalizeCommandRunner;
  timeoutMs: number;
  rawOutputPath: string;
  outputPath: string;
  sampleRateHz: number;
  startMs: number;
  endMs: number;
}

/**
 * Shared loudnorm/atempo normalisation step: fits the raw synthesized WAV into
 * its segment window and levels loudness, writing 16-bit PCM mono at the
 * engine's native sample rate. The raw file is always removed afterwards.
 */
async function normalizeSynthesizedWav(options: NormalizeSynthesizedWavOptions): Promise<void> {
  try {
    const audioFilter = await buildNormalizeAudioFilter(
      options.rawOutputPath,
      options.startMs,
      options.endMs,
    );
    await options.runNormalizeCommand(
      options.ffmpegExecutable,
      [
        '-y',
        '-i',
        options.rawOutputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(options.sampleRateHz),
        '-af',
        audioFilter,
        '-acodec',
        'pcm_s16le',
        '-f',
        'wav',
        options.outputPath,
      ],
      { timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    throw classifyNormalizeError(error, options.engineLabel);
  } finally {
    await rm(options.rawOutputPath, { force: true }).catch(() => undefined);
  }
}

function classifyNormalizeError(error: unknown, engineLabel: string): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message =
    typeof err.message === 'string' ? err.message : `${engineLabel} output normalisation failed.`;
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      `FFmpeg executable not found for ${engineLabel} output normalisation.`,
      'tts-ffmpeg-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError(
      `${engineLabel} output normalisation timed out.`,
      'tts-timeout',
      504,
    );
  }
  return new MediaIngestError(
    `${engineLabel} output normalisation failed. ${message}`,
    'tts-failed',
    500,
  );
}

function parseMmsTtsResult(raw: unknown): { sampleRateHz: number; durationMs: number } {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const sampleRateHz = record?.['sampleRateHz'];
  const durationMs = record?.['durationMs'];
  if (
    typeof sampleRateHz !== 'number' ||
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new MediaIngestError(
      'MMS text-to-speech returned an invalid response shape.',
      'tts-failed',
      500,
    );
  }
  return { sampleRateHz, durationMs };
}

function classifyMmsTtsError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  if (error instanceof PythonWorkerError && error.kind === 'queue-overflow') {
    return new MediaIngestError(
      'MMS text-to-speech concurrency limit reached.',
      'tts-failed',
      503,
    );
  }
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message =
    typeof err.message === 'string' ? err.message : 'MMS text-to-speech generation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT' || (error instanceof PythonWorkerError && error.kind === 'spawn-failed')) {
    return new MediaIngestError(
      'Python executable not found for MMS text-to-speech generation.',
      'tts-failed',
      500,
    );
  }
  if (
    (error instanceof PythonWorkerError && error.kind === 'timeout') ||
    err.signal === 'SIGTERM' ||
    combined.includes('timed out')
  ) {
    return new MediaIngestError('MMS text-to-speech generation timed out.', 'tts-timeout', 504);
  }
  if (
    combined.includes('no module named') ||
    combined.includes('transformers') ||
    combined.includes('torch') ||
    combined.includes('numpy')
  ) {
    return new MediaIngestError(
      'Python MMS text-to-speech dependencies are unavailable.',
      'tts-failed',
      500,
    );
  }
  if (
    combined.includes('local_files_only') ||
    combined.includes('not a local folder') ||
    combined.includes('does not exist') ||
    combined.includes("couldn't connect")
  ) {
    return new MediaIngestError(
      'MMS text-to-speech model is unavailable in the configured local cache.',
      'tts-model-unavailable',
      500,
    );
  }
  return new MediaIngestError(
    `MMS text-to-speech generation failed. ${message}`,
    'tts-failed',
    500,
  );
}

function validateMmsTtsConfig(config: MmsTtsConfig): void {
  if (config.voices.length === 0) {
    throw new MediaIngestError(
      'At least one MMS-TTS voice must be configured.',
      'unsupported-tts-voice',
      400,
    );
  }
  for (const voice of config.voices) {
    if (!voice.language.trim() || !voice.modelId.trim()) {
      throw new MediaIngestError(
        'Invalid MMS-TTS voice configuration.',
        'unsupported-tts-voice',
        400,
      );
    }
  }
}

function validatePiperConfig(config: PiperConfig): void {
  if (config.voices.length === 0) {
    throw new MediaIngestError(
      'At least one Piper voice must be configured.',
      'unsupported-tts-voice',
      400,
    );
  }
  for (const voice of config.voices) {
    if (!voice.voiceId.trim() || !voice.language.trim()) {
      throw new MediaIngestError('Invalid Piper voice configuration.', 'unsupported-tts-voice', 400);
    }
    if (!existsSync(voice.modelPath)) {
      throw new MediaIngestError(
        `Configured Piper model does not exist: ${voice.modelPath}.`,
        'tts-model-unavailable',
        500,
      );
    }
    if (voice.configPath && !existsSync(voice.configPath)) {
      throw new MediaIngestError(
        `Configured Piper model config does not exist: ${voice.configPath}.`,
        'tts-model-unavailable',
        500,
      );
    }
  }
}

function minimalWav(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
    0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d,
    0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
  ]);
}

async function writeMinimalWav(outputPath: string): Promise<TextToSpeechProviderResult> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, minimalWav());
  return {
    audioPath: outputPath,
    providerLatencyMs: 0,
  };
}

/**
 * Persistent MMS-TTS worker: imports transformers once, loads each VITS model
 * on first use and caches it per modelId in-process, then serves
 * {"text", "modelId", "localPath", "outputPath"} requests over the shared
 * JSON-lines loop. The worker writes the raw 16-bit PCM mono WAV itself at the
 * model's native sample rate and reports {"sampleRateHz", "durationMs"}.
 */
const MMS_TTS_WORKER_SCRIPT = `${PYTHON_WORKER_LOOP}\n${String.raw`
cache_dir = sys.argv[1] or None
allow_download = sys.argv[2] == "1"

import wave

import numpy
import torch
from transformers import AutoTokenizer, VitsModel

_models = {}

def _load(model_id, local_path):
    key = local_path or model_id
    cached = _models.get(key)
    if cached is not None:
        return cached
    kwargs = {"local_files_only": not allow_download}
    if cache_dir:
        kwargs["cache_dir"] = cache_dir
    tokenizer = AutoTokenizer.from_pretrained(key, **kwargs)
    model = VitsModel.from_pretrained(key, low_cpu_mem_usage=True, **kwargs)
    model.eval()
    _models[key] = (tokenizer, model)
    return _models[key]

def handle(payload):
    tokenizer, model = _load(payload["modelId"], payload.get("localPath"))
    inputs = tokenizer(payload["text"], return_tensors="pt")
    with torch.no_grad():
        waveform = model(**inputs).waveform[0]
    samples = numpy.clip(waveform.cpu().numpy(), -1.0, 1.0)
    pcm = (samples * 32767.0).astype(numpy.int16)
    sample_rate = int(model.config.sampling_rate)
    with wave.open(payload["outputPath"], "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return {
        "sampleRateHz": sample_rate,
        "durationMs": int(round(len(pcm) * 1000 / sample_rate)),
    }

run_worker_loop(handle)
`}`;
