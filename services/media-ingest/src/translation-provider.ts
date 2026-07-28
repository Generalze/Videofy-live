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
  providerName?: string;
  modelId?: string | null;
  providerLatencyMs?: number | null;
}

export interface TimestampedTranslationProvider {
  readonly name: string;
  translate(input: TranslationProviderInput): Promise<TranslationProviderResult>;
  healthCheck?(): Promise<ProviderHealthCheck>;
}

export interface ProviderHealthCheck {
  provider: string;
  status: 'ready' | 'loading' | 'failed';
  modelId: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface ArgosTranslateConfig {
  pythonExecutable: string;
  packageDir: string | null;
  supportedTargetLanguages: string[];
  timeoutMs: number;
}

export interface TranslationProviderConfig {
  providerName: 'mock' | 'argos' | 'opus-mt';
  supportedTargetLanguages: string[];
  argos: ArgosTranslateConfig;
  opusMt?: OpusMtConfig;
}

export interface OpusMtConfig {
  pythonExecutable: string;
  modelCacheDir: string | null;
  supportedTargetLanguages: string[];
  languageModels: OpusMtLanguageModelConfig[];
  timeoutMs: number;
  maxConcurrency: number;
  allowModelDownload: boolean;
}

export interface OpusMtLanguageModelConfig {
  sourceLanguage: string;
  targetLanguage: string;
  modelId: string;
  localPath: string | null;
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

export interface OpusMtProviderOptions extends OpusMtConfig {
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
  if (config.providerName === 'opus-mt') {
    if (!config.opusMt) {
      throw new MediaIngestError(
        'OPUS-MT translation provider requires opusMt configuration.',
        'translation-model-unavailable',
        500,
      );
    }
    return new OpusMtTimestampedTranslationProvider(config.opusMt);
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

export class OpusMtTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'opus-mt';
  private readonly runCommand: CommandRunner;
  private active = 0;

  constructor(private readonly options: OpusMtProviderOptions) {
    if (options.maxConcurrency < 1) {
      throw new MediaIngestError(
        'OPUS-MT max concurrency must be at least 1.',
        'translation-failed',
        500,
      );
    }
    this.runCommand = options.runCommand ?? defaultCommandRunner;
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    const startedAt = Date.now();
    try {
      const model = this.options.languageModels[0] ?? null;
      if (!model) {
        throw new MediaIngestError(
          'No OPUS-MT language model is configured.',
          'translation-model-unavailable',
          500,
        );
      }
      await this.runCommand(
        this.options.pythonExecutable,
        ['-c', OPUS_MT_HEALTH_SCRIPT, model.modelId, model.localPath ?? '', this.options.modelCacheDir ?? ''],
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        provider: this.name,
        status: 'ready',
        modelId: model.modelId,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: 'failed',
        modelId: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'OPUS-MT health check failed.',
      };
    }
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
      return { translatedText: '', providerName: this.name, modelId: null, providerLatencyMs: 0 };
    }
    if (this.active >= this.options.maxConcurrency) {
      throw new MediaIngestError(
        'OPUS-MT translation concurrency limit reached.',
        'translation-delayed',
        429,
      );
    }

    const model = this.findModel(input.sourceLanguage, input.targetLanguage);
    const startedAt = Date.now();
    this.active += 1;
    try {
      const result = await this.runCommand(
        this.options.pythonExecutable,
        [
          '-c',
          OPUS_MT_TRANSLATE_SCRIPT,
          input.sourceLanguage,
          input.targetLanguage,
          input.sourceText,
          model.modelId,
          model.localPath ?? '',
          this.options.modelCacheDir ?? '',
          this.options.allowModelDownload ? '1' : '0',
        ],
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        translatedText: parseOpusMtResult(result.stdout),
        providerName: this.name,
        modelId: model.modelId,
        providerLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw classifyOpusMtError(error);
    } finally {
      this.active -= 1;
    }
  }

  private findModel(sourceLanguage: string, targetLanguage: string): OpusMtLanguageModelConfig {
    const normalizedSource = sourceLanguage.toLowerCase();
    const normalizedTarget = targetLanguage.toLowerCase();
    const model = this.options.languageModels.find(
      (candidate) =>
        candidate.sourceLanguage.toLowerCase() === normalizedSource &&
        candidate.targetLanguage.toLowerCase() === normalizedTarget,
    );
    if (!model) {
      throw new MediaIngestError(
        `Translation unavailable for language pair: ${sourceLanguage}->${targetLanguage}.`,
        'unsupported-language',
        400,
      );
    }
    return model;
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

function parseOpusMtResult(stdout: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new MediaIngestError(
      'OPUS-MT returned invalid JSON output.',
      'translation-failed',
      500,
    );
  }
  if (!isRecord(raw) || typeof raw['translatedText'] !== 'string') {
    throw new MediaIngestError(
      'OPUS-MT returned an invalid response shape.',
      'translation-failed',
      500,
    );
  }
  return raw['translatedText'];
}

function classifyOpusMtError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : 'OPUS-MT translation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      'Python executable not found for OPUS-MT translation.',
      'translation-python-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError('OPUS-MT translation timed out.', 'translation-timeout', 504);
  }
  if (
    combined.includes('no module named') ||
    combined.includes('transformers') ||
    combined.includes('sentencepiece') ||
    combined.includes('torch')
  ) {
    return new MediaIngestError(
      'Python OPUS-MT dependencies are unavailable.',
      'translation-python-unavailable',
      500,
    );
  }
  if (
    combined.includes('local_files_only') ||
    combined.includes('model') ||
    combined.includes('not a local folder') ||
    combined.includes('does not exist')
  ) {
    return new MediaIngestError(
      'OPUS-MT model is unavailable in the configured local cache.',
      'translation-model-unavailable',
      500,
    );
  }
  return new MediaIngestError(`OPUS-MT translation failed. ${message}`, 'translation-failed', 500);
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

const OPUS_MT_HEALTH_SCRIPT = String.raw`
import sys
model_id = sys.argv[1]
local_path = sys.argv[2] or model_id
cache_dir = sys.argv[3] or None
from transformers import MarianMTModel, MarianTokenizer
kwargs = {"local_files_only": True}
if cache_dir:
    kwargs["cache_dir"] = cache_dir
MarianTokenizer.from_pretrained(local_path, **kwargs)
MarianMTModel.from_pretrained(local_path, **kwargs)
print("ok")
`;

const OPUS_MT_TRANSLATE_SCRIPT = String.raw`
import json
import sys
source_language = sys.argv[1]
target_language = sys.argv[2]
source_text = sys.argv[3]
model_id = sys.argv[4]
local_path = sys.argv[5] or model_id
cache_dir = sys.argv[6] or None
allow_download = sys.argv[7] == "1"
from transformers import MarianMTModel, MarianTokenizer
kwargs = {"local_files_only": not allow_download}
if cache_dir:
    kwargs["cache_dir"] = cache_dir
tokenizer = MarianTokenizer.from_pretrained(local_path, **kwargs)
model = MarianMTModel.from_pretrained(local_path, **kwargs)
tokens = tokenizer([source_text], return_tensors="pt", padding=True, truncation=True)
translated = model.generate(**tokens)
text = tokenizer.batch_decode(translated, skip_special_tokens=True)[0]
print(json.dumps({
    "translatedText": text,
    "sourceLanguage": source_language,
    "targetLanguage": target_language,
    "modelId": model_id,
}))
`;
