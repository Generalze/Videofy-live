import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MediaIngestError } from './ingest-error.js';

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
}

export interface PiperVoiceConfig {
  voiceId: string;
  language: string;
  modelPath: string;
  configPath: string | null;
}

export interface TextToSpeechProviderConfig {
  providerName: 'mock' | 'piper';
  timeoutMs: number;
  supportedLanguages: string[];
  defaultVoiceId: string;
  piper: PiperConfig;
}

export interface PiperConfig {
  executable: string;
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

export interface PiperTextToSpeechProviderOptions extends PiperConfig {
  runCommand?: PiperCommandRunner;
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
    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, minimalWav());
    return {
      audioPath: input.outputPath,
      providerLatencyMs: 0,
    };
  }
}

export class PiperTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'piper';
  private readonly runCommand: PiperCommandRunner;

  constructor(private readonly options: PiperTextToSpeechProviderOptions) {
    validatePiperConfig(options);
    this.runCommand = options.runCommand ?? defaultPiperCommandRunner;
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const voice = this.resolveVoice(input.targetLanguage, input.voiceId);
    if (!input.translatedText) {
      await mkdir(dirname(input.outputPath), { recursive: true });
      await writeFile(input.outputPath, minimalWav());
      return {
        audioPath: input.outputPath,
        providerLatencyMs: 0,
      };
    }

    const startedAt = Date.now();
    try {
      await mkdir(dirname(input.outputPath), { recursive: true });
      await this.runCommand(this.options.executable, buildPiperArgs(voice, input.outputPath), {
        timeoutMs: this.options.timeoutMs,
        input: input.translatedText,
      });
      return {
        audioPath: input.outputPath,
        providerLatencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      throw classifyPiperError(error);
    }
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

function buildPiperArgs(voice: PiperVoiceConfig, outputPath: string): string[] {
  const args = ['--model', voice.modelPath, '--output_file', outputPath];
  if (voice.configPath) {
    args.push('--config', voice.configPath);
  }
  return args;
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
