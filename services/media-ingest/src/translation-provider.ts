import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MediaIngestError } from './ingest-error.js';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface TranslationProviderInput {
  sessionId: string;
  streamId: string;
  segmentId: string;
  sequence: number;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  startMs: number;
  endMs: number;
}

export interface TranslationProviderResult {
  translatedText: string;
}

export interface TimestampedTranslationProvider {
  readonly name: string;
  translate(input: TranslationProviderInput): Promise<TranslationProviderResult>;
}

export interface ArgosTranslateConfig {
  pythonExecutable: string;
  packageDir: string | null;
  supportedTargetLanguages: string[];
  timeoutMs: number;
}

export interface TranslationProviderConfig {
  providerName: 'mock' | 'argos';
  supportedTargetLanguages: string[];
  argos: ArgosTranslateConfig;
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

export interface ArgosTranslateProviderOptions extends ArgosTranslateConfig {
  runCommand?: CommandRunner;
}

export function createTimestampedTranslationProvider(
  config: TranslationProviderConfig,
): TimestampedTranslationProvider {
  if (config.providerName === 'mock') {
    return new MockTimestampedTranslationProvider(config.supportedTargetLanguages);
  }
  if (config.providerName === 'argos') {
    return new ArgosTimestampedTranslationProvider(config.argos);
  }
  throw new MediaIngestError(
    `Unsupported translation provider: ${config.providerName}.`,
    'unsupported-translation-provider',
    400,
  );
}

export async function translateWithTimeout(
  provider: TimestampedTranslationProvider,
  input: TranslationProviderInput,
  timeoutMs: number,
): Promise<TranslationProviderResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      provider.translate(input),
      new Promise<TranslationProviderResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new MediaIngestError(
              `Translation provider timed out after ${timeoutMs} ms.`,
              'translation-timeout',
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

export class MockTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'mock';

  constructor(private readonly supportedTargetLanguages: string[]) {}

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    if (!this.supportedTargetLanguages.includes(input.targetLanguage)) {
      throw new MediaIngestError(
        `Unsupported target language: ${input.targetLanguage}.`,
        'unsupported-language',
        400,
      );
    }

    return {
      translatedText: input.sourceText ? `[${input.targetLanguage}] ${input.sourceText}` : '',
    };
  }
}

export class ArgosTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'argos';
  private readonly runCommand: CommandRunner;

  constructor(private readonly options: ArgosTranslateProviderOptions) {
    this.runCommand = options.runCommand ?? defaultCommandRunner;
  }

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    if (!this.options.supportedTargetLanguages.includes(input.targetLanguage)) {
      throw new MediaIngestError(
        `Unsupported target language: ${input.targetLanguage}.`,
        'unsupported-language',
        400,
      );
    }
    if (!input.sourceText) {
      return { translatedText: '' };
    }

    try {
      const result = await this.runCommand(
        this.options.pythonExecutable,
        [
          '-c',
          ARGOS_SCRIPT,
          input.sourceLanguage || 'und',
          input.targetLanguage,
          input.sourceText,
          this.options.packageDir ?? '',
        ],
        { timeoutMs: this.options.timeoutMs },
      );
      return { translatedText: parseArgosResult(result.stdout) };
    } catch (error) {
      throw classifyArgosError(error);
    }
  }
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

function parseArgosResult(stdout: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new MediaIngestError(
      'Argos Translate returned invalid JSON output.',
      'translation-failed',
      500,
    );
  }
  if (!isRecord(raw) || typeof raw['translatedText'] !== 'string') {
    throw new MediaIngestError(
      'Argos Translate returned an invalid response shape.',
      'translation-failed',
      500,
    );
  }
  return raw['translatedText'];
}

function classifyArgosError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : 'Argos translation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      'Python executable not found for Argos translation.',
      'translation-python-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError('Translation provider timed out.', 'translation-timeout', 504);
  }
  if (combined.includes('no module named') || combined.includes('argostranslate')) {
    return new MediaIngestError(
      'Python argostranslate package is unavailable.',
      'translation-python-unavailable',
      500,
    );
  }
  if (combined.includes('unsupported language pair') || combined.includes('translation unavailable')) {
    return new MediaIngestError(message, 'unsupported-language', 400);
  }

  return new MediaIngestError(`Argos translation failed. ${message}`, 'translation-failed', 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const ARGOS_SCRIPT = String.raw`
import json
import sys

source_language = sys.argv[1]
target_language = sys.argv[2]
source_text = sys.argv[3]
package_dir = sys.argv[4] or None

from argostranslate import package, translate

if package_dir:
    package.install_from_path(package_dir)

installed_languages = translate.get_installed_languages()
source = next((lang for lang in installed_languages if lang.code == source_language), None)
target = next((lang for lang in installed_languages if lang.code == target_language), None)
if source is None or target is None:
    raise RuntimeError(f"Unsupported language pair: {source_language}->{target_language}")

translation = source.get_translation(target)
if translation is None:
    raise RuntimeError(f"Translation unavailable for language pair: {source_language}->{target_language}")

print(json.dumps({"translatedText": translation.translate(source_text)}))
`;
