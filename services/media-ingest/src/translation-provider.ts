import { execFile } from 'node:child_process';
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
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
// Translation requests beyond maxConcurrency queue inside the persistent
// worker; only once this many requests are already queued do we fail fast
// with the 429 'translation-delayed' error.
const MAX_QUEUED_TRANSLATIONS = 200;

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
  dispose?(): void;
}

export interface ProviderHealthCheck {
  provider: string;
  status: 'ready' | 'loading' | 'failed';
  modelId: string | null;
  latencyMs: number | null;
  error: string | null;
  /** Set when a composite provider keeps a fallback behind the reported primary. */
  fallbackProvider?: string;
}

export interface ArgosTranslateConfig {
  pythonExecutable: string;
  packageDir: string | null;
  supportedTargetLanguages: string[];
  timeoutMs: number;
}

export interface TranslationProviderConfig {
  providerName: 'mock' | 'argos' | 'opus-mt' | 'm2m100';
  supportedTargetLanguages: string[];
  argos: ArgosTranslateConfig;
  opusMt?: OpusMtConfig;
  m2m100?: M2m100Config;
}

export interface M2m100Config {
  pythonExecutable: string;
  modelId: string;
  localPath: string | null;
  modelCacheDir: string | null;
  supportedTargetLanguages: string[];
  timeoutMs: number;
  maxConcurrency: number;
  allowModelDownload: boolean;
}

export interface Nllb200Config {
  pythonExecutable: string;
  modelId: string;
  localPath: string | null;
  modelCacheDir: string | null;
  supportedTargetLanguages: string[];
  timeoutMs: number;
  maxConcurrency: number;
  allowModelDownload: boolean;
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
  /** Seam for the persistent OPUS-MT python worker. */
  createWorker?: PythonWorkerFactory;
}

export interface M2m100ProviderOptions extends M2m100Config {
  /** Seam for the persistent M2M100 python worker. */
  createWorker?: PythonWorkerFactory;
}

export interface Nllb200ProviderOptions extends Nllb200Config {
  /** Seam for the persistent NLLB-200 python worker. */
  createWorker?: PythonWorkerFactory;
}

/**
 * FLORES-200 language codes used by NLLB-200 tokenizers, keyed by the
 * two-letter codes used across the ingest pipeline. NLLB-200 models
 * (facebook/nllb-200-distilled-600M) are licensed CC-BY-NC-4.0
 * (non-commercial use only); validate before partner use.
 */
export const NLLB_LANGUAGE_CODES: Record<string, string> = {
  en: 'eng_Latn',
  es: 'spa_Latn',
  fr: 'fra_Latn',
  pt: 'por_Latn',
  ar: 'arb_Arab',
  yo: 'yor_Latn',
  zh: 'zho_Hans',
  ru: 'rus_Cyrl',
  el: 'ell_Grek',
  de: 'deu_Latn',
  it: 'ita_Latn',
  ja: 'jpn_Jpan',
  ig: 'ibo_Latn',
  ha: 'hau_Latn',
  sw: 'swh_Latn',
};

function nllbLanguageCode(language: string): string {
  const code = NLLB_LANGUAGE_CODES[language.toLowerCase()];
  if (!code) {
    throw new MediaIngestError(
      `NLLB-200 has no language code for: ${language}.`,
      'unsupported-language',
      400,
    );
  }
  return code;
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
  if (config.providerName === 'm2m100') {
    if (!config.m2m100) {
      throw new MediaIngestError(
        'M2M100 translation provider requires m2m100 configuration.',
        'translation-model-unavailable',
        500,
      );
    }
    return new M2m100TimestampedTranslationProvider(config.m2m100);
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

export interface TranslationLanguagePair {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface CompositeTranslationProviderOptions {
  primary: TimestampedTranslationProvider;
  fallback: TimestampedTranslationProvider;
  /** Pairs the primary provider is already known not to cover; routed straight to the fallback. */
  primaryUnsupportedPairs?: readonly TranslationLanguagePair[];
}

/**
 * Per-pair fallback chain: routes every request to the quality-preferred
 * primary provider unless the (source,target) pair is known to be unsupported
 * there, in which case the fallback provider serves it. Pairs the primary
 * rejects at runtime with `unsupported-language` are retried once via the
 * fallback and remembered so later requests skip the failing primary call.
 */
export class CompositeTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name: string;
  private readonly primary: TimestampedTranslationProvider;
  private readonly fallback: TimestampedTranslationProvider;
  private readonly primaryUnsupportedPairs = new Set<string>();

  constructor(options: CompositeTranslationProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.name = `${options.primary.name}+${options.fallback.name}`;
    for (const pair of options.primaryUnsupportedPairs ?? []) {
      this.primaryUnsupportedPairs.add(languagePairKey(pair.sourceLanguage, pair.targetLanguage));
    }
  }

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    const pair = languagePairKey(input.sourceLanguage, input.targetLanguage);
    if (this.primaryUnsupportedPairs.has(pair)) {
      return await this.fallback.translate(input);
    }
    try {
      return await this.primary.translate(input);
    } catch (error) {
      if (error instanceof MediaIngestError && error.code === 'unsupported-language') {
        this.primaryUnsupportedPairs.add(pair);
        return await this.fallback.translate(input);
      }
      throw error;
    }
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    const health = this.primary.healthCheck
      ? await this.primary.healthCheck()
      : {
          provider: this.primary.name,
          status: 'ready' as const,
          modelId: null,
          latencyMs: null,
          error: null,
        };
    return { ...health, fallbackProvider: this.fallback.name };
  }

  dispose(): void {
    this.primary.dispose?.();
    this.fallback.dispose?.();
  }
}

function languagePairKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage.toLowerCase()}->${targetLanguage.toLowerCase()}`;
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
  private readonly createWorker: PythonWorkerFactory;
  private worker: PythonWorkerLike | null = null;

  constructor(private readonly options: OpusMtProviderOptions) {
    if (options.maxConcurrency < 1) {
      throw new MediaIngestError(
        'OPUS-MT max concurrency must be at least 1.',
        'translation-failed',
        500,
      );
    }
    this.createWorker = options.createWorker ?? createPersistentPythonWorker;
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
      await this.getWorker().request(
        { op: 'health', modelId: model.modelId, localPath: model.localPath },
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

    const model = this.findModel(input.sourceLanguage, input.targetLanguage);
    const startedAt = Date.now();
    try {
      const raw = await this.getWorker().request(
        {
          op: 'translate',
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          sourceText: input.sourceText,
          modelId: model.modelId,
          localPath: model.localPath,
        },
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        translatedText: parseOpusMtResult(raw),
        providerName: this.name,
        modelId: model.modelId,
        providerLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw classifyOpusMtError(error);
    }
  }

  dispose(): void {
    this.worker?.dispose();
    this.worker = null;
  }

  private getWorker(): PythonWorkerLike {
    if (!this.worker) {
      this.worker = this.createWorker({
        command: this.options.pythonExecutable,
        args: [
          '-c',
          OPUS_MT_WORKER_SCRIPT,
          this.options.modelCacheDir ?? '',
          this.options.allowModelDownload ? '1' : '0',
        ],
        maxConcurrency: this.options.maxConcurrency,
        maxQueueLength: MAX_QUEUED_TRANSLATIONS,
        label: 'opus-mt',
      });
    }
    return this.worker;
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

export class M2m100TimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'm2m100';
  private readonly createWorker: PythonWorkerFactory;
  private worker: PythonWorkerLike | null = null;

  constructor(private readonly options: M2m100ProviderOptions) {
    if (options.maxConcurrency < 1) {
      throw new MediaIngestError(
        'M2M100 max concurrency must be at least 1.',
        'translation-failed',
        500,
      );
    }
    this.createWorker = options.createWorker ?? createPersistentPythonWorker;
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    const startedAt = Date.now();
    try {
      await this.getWorker().request(
        { op: 'health' },
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        provider: this.name,
        status: 'ready',
        modelId: this.options.modelId,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: 'failed',
        modelId: this.options.modelId,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'M2M100 health check failed.',
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
      return {
        translatedText: '',
        providerName: this.name,
        modelId: this.options.modelId,
        providerLatencyMs: 0,
      };
    }

    const startedAt = Date.now();
    try {
      const raw = await this.getWorker().request(
        {
          op: 'translate',
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          sourceText: input.sourceText,
        },
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        translatedText: parseM2m100Result(raw),
        providerName: this.name,
        modelId: this.options.modelId,
        providerLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw classifyM2m100Error(error);
    }
  }

  dispose(): void {
    this.worker?.dispose();
    this.worker = null;
  }

  private getWorker(): PythonWorkerLike {
    if (!this.worker) {
      this.worker = this.createWorker({
        command: this.options.pythonExecutable,
        args: [
          '-c',
          M2M100_WORKER_SCRIPT,
          this.options.modelId,
          this.options.localPath ?? '',
          this.options.modelCacheDir ?? '',
          this.options.allowModelDownload ? '1' : '0',
        ],
        maxConcurrency: this.options.maxConcurrency,
        maxQueueLength: MAX_QUEUED_TRANSLATIONS,
        label: 'm2m100',
      });
    }
    return this.worker;
  }
}

/**
 * NLLB-200 fallback provider: quality rescue for languages where M2M100
 * degenerates into repetition (empirically: Yoruba). One persistent worker
 * loads the model once; the licence is CC-BY-NC-4.0 (non-commercial use only).
 */
export class Nllb200TimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'nllb200';
  private readonly createWorker: PythonWorkerFactory;
  private worker: PythonWorkerLike | null = null;

  constructor(private readonly options: Nllb200ProviderOptions) {
    if (options.maxConcurrency < 1) {
      throw new MediaIngestError(
        'NLLB-200 max concurrency must be at least 1.',
        'translation-failed',
        500,
      );
    }
    this.createWorker = options.createWorker ?? createPersistentPythonWorker;
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    const startedAt = Date.now();
    try {
      await this.getWorker().request(
        { op: 'health' },
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        provider: this.name,
        status: 'ready',
        modelId: this.options.modelId,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: 'failed',
        modelId: this.options.modelId,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'NLLB-200 health check failed.',
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
      return {
        translatedText: '',
        providerName: this.name,
        modelId: this.options.modelId,
        providerLatencyMs: 0,
      };
    }

    // Both codes must map before the worker is involved; unknown codes fail
    // fast with `unsupported-language` so the composite can reroute the pair.
    const sourceNllbCode = nllbLanguageCode(input.sourceLanguage);
    const targetNllbCode = nllbLanguageCode(input.targetLanguage);
    const startedAt = Date.now();
    try {
      const raw = await this.getWorker().request(
        {
          op: 'translate',
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          sourceNllbCode,
          targetNllbCode,
          sourceText: input.sourceText,
        },
        { timeoutMs: this.options.timeoutMs },
      );
      return {
        translatedText: parseNllb200Result(raw),
        providerName: this.name,
        modelId: this.options.modelId,
        providerLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw classifyNllb200Error(error);
    }
  }

  dispose(): void {
    this.worker?.dispose();
    this.worker = null;
  }

  private getWorker(): PythonWorkerLike {
    if (!this.worker) {
      this.worker = this.createWorker({
        command: this.options.pythonExecutable,
        args: [
          '-c',
          NLLB200_WORKER_SCRIPT,
          this.options.modelId,
          this.options.localPath ?? '',
          this.options.modelCacheDir ?? '',
          this.options.allowModelDownload ? '1' : '0',
        ],
        maxConcurrency: this.options.maxConcurrency,
        maxQueueLength: MAX_QUEUED_TRANSLATIONS,
        label: 'nllb200',
      });
    }
    return this.worker;
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

function parseOpusMtResult(raw: unknown): string {
  if (!isRecord(raw) || typeof raw['translatedText'] !== 'string') {
    throw new MediaIngestError(
      'OPUS-MT returned an invalid response shape.',
      'translation-failed',
      500,
    );
  }
  return raw['translatedText'];
}

function parseM2m100Result(raw: unknown): string {
  if (!isRecord(raw) || typeof raw['translatedText'] !== 'string') {
    throw new MediaIngestError(
      'M2M100 returned an invalid response shape.',
      'translation-failed',
      500,
    );
  }
  return raw['translatedText'];
}

function parseNllb200Result(raw: unknown): string {
  if (!isRecord(raw) || typeof raw['translatedText'] !== 'string') {
    throw new MediaIngestError(
      'NLLB-200 returned an invalid response shape.',
      'translation-failed',
      500,
    );
  }
  return raw['translatedText'];
}

/**
 * Set by the provider so a classified failure can still be traced.
 *
 * The classifier below maps a worker failure onto one of a handful of stable
 * messages, and `combined.includes('model')` is broad enough to swallow almost
 * anything: a real fault was reported as "OPUS-MT model is unavailable in the
 * configured local cache" while the model loaded perfectly by hand, as the
 * service user, in every configuration. Hours went into the wrong hypothesis
 * because the only evidence was the classifier's verdict. The raw text is now
 * emitted once, at debug, before any interpretation of it.
 */
let logOpusMtRaw: ((line: string, detail: Record<string, unknown>) => void) | null = null;

export function setOpusMtDiagnosticLogger(
  log: (line: string, detail: Record<string, unknown>) => void,
): void {
  logOpusMtRaw = log;
}

function classifyOpusMtError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  {
    const raw = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
    logOpusMtRaw?.('OPUS-MT worker failed (raw, before classification)', {
      name: (error as { name?: unknown })?.name ?? null,
      code: raw.code ?? null,
      signal: raw.signal ?? null,
      message: typeof raw.message === 'string' ? raw.message.slice(0, 400) : null,
      stderr: typeof raw.stderr === 'string' ? raw.stderr.slice(-800) : null,
    });
  }
  if (error instanceof PythonWorkerError && error.kind === 'queue-overflow') {
    return new MediaIngestError(
      'OPUS-MT translation concurrency limit reached.',
      'translation-delayed',
      429,
    );
  }
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

function classifyM2m100Error(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  if (error instanceof PythonWorkerError && error.kind === 'queue-overflow') {
    return new MediaIngestError(
      'M2M100 translation concurrency limit reached.',
      'translation-delayed',
      429,
    );
  }
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : 'M2M100 translation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      'Python executable not found for M2M100 translation.',
      'translation-python-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError('M2M100 translation timed out.', 'translation-timeout', 504);
  }
  if (
    combined.includes('no module named') ||
    combined.includes('transformers') ||
    combined.includes('sentencepiece') ||
    combined.includes('torch')
  ) {
    return new MediaIngestError(
      'Python M2M100 dependencies are unavailable.',
      'translation-python-unavailable',
      500,
    );
  }
  if (
    combined.includes('local_files_only') ||
    combined.includes('not a local folder') ||
    combined.includes('does not exist') ||
    combined.includes('couldn\'t connect')
  ) {
    return new MediaIngestError(
      'M2M100 model is unavailable in the configured local cache.',
      'translation-model-unavailable',
      500,
    );
  }
  return new MediaIngestError(`M2M100 translation failed. ${message}`, 'translation-failed', 500);
}

function classifyNllb200Error(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;
  if (error instanceof PythonWorkerError && error.kind === 'queue-overflow') {
    return new MediaIngestError(
      'NLLB-200 translation concurrency limit reached.',
      'translation-delayed',
      429,
    );
  }
  const err = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const message = typeof err.message === 'string' ? err.message : 'NLLB-200 translation failed.';
  const combined = `${message}\n${stderr}`.toLowerCase();

  if (err.code === 'ENOENT') {
    return new MediaIngestError(
      'Python executable not found for NLLB-200 translation.',
      'translation-python-unavailable',
      500,
    );
  }
  if (err.signal === 'SIGTERM' || combined.includes('timed out')) {
    return new MediaIngestError('NLLB-200 translation timed out.', 'translation-timeout', 504);
  }
  if (
    combined.includes('no module named') ||
    combined.includes('transformers') ||
    combined.includes('sentencepiece') ||
    combined.includes('torch')
  ) {
    return new MediaIngestError(
      'Python NLLB-200 dependencies are unavailable.',
      'translation-python-unavailable',
      500,
    );
  }
  if (
    combined.includes('local_files_only') ||
    combined.includes('not a local folder') ||
    combined.includes('does not exist') ||
    combined.includes('couldn\'t connect')
  ) {
    return new MediaIngestError(
      'NLLB-200 model is unavailable in the configured local cache.',
      'translation-model-unavailable',
      500,
    );
  }
  return new MediaIngestError(`NLLB-200 translation failed. ${message}`, 'translation-failed', 500);
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

/**
 * Persistent OPUS-MT worker: imports transformers once, loads each language
 * pair's Marian model on first use and caches it in-process, then serves
 * {"op": "translate"|"health", ...} requests over the shared JSON-lines loop.
 * The source text travels in the JSON payload (never argv).
 */
const OPUS_MT_WORKER_SCRIPT = `${PYTHON_WORKER_LOOP}\n${String.raw`
cache_dir = sys.argv[1] or None
allow_download = sys.argv[2] == "1"

from transformers import MarianMTModel, MarianTokenizer

_models = {}

def _load(local_path, local_files_only):
    cached = _models.get(local_path)
    if cached is not None:
        return cached
    kwargs = {"local_files_only": local_files_only}
    if cache_dir:
        kwargs["cache_dir"] = cache_dir
    tokenizer = MarianTokenizer.from_pretrained(local_path, **kwargs)
    model = MarianMTModel.from_pretrained(local_path, **kwargs)
    _models[local_path] = (tokenizer, model)
    return _models[local_path]

_iso3 = {"pt": "por", "fr": "fra", "es": "spa", "it": "ita", "ro": "ron", "ca": "cat", "gl": "glg", "de": "deu", "nl": "nld", "sv": "swe", "ar": "ara", "yo": "yor"}

# Languages whose multi-target Marian vocabularies use control tokens the
# generic 2-letter/iso3/"_br" probing misses (e.g. ">>cmn_Hans<<" on the
# en-zh model). Explicit candidates are probed first, in order.
_prefix_candidates = {"zh": ["cmn_Hans", "cmn", "zho", "zh"], "el": ["ell", "el"], "ru": ["rus", "ru"], "la": ["la", "lat"]}

def _target_prefix(tokenizer, target):
    # Multi-target Marian models (en-ROMANCE, tc-big) select the output language
    # with a ">>lang<<" control token; direct-pair models have no such tokens.
    if not target:
        return ""
    vocab = tokenizer.get_vocab()
    lowered = target.lower()
    candidates = list(_prefix_candidates.get(lowered, []))
    for cand in (lowered, _iso3.get(lowered), lowered + "_br"):
        if cand and cand not in candidates:
            candidates.append(cand)
    for cand in candidates:
        if (">>" + cand + "<<") in vocab:
            return ">>" + cand + "<< "
    return ""

def handle(payload):
    local_path = payload.get("localPath") or payload["modelId"]
    if payload.get("op") == "health":
        _load(local_path, True)
        return {"status": "ok"}
    tokenizer, model = _load(local_path, not allow_download)
    source_text = _target_prefix(tokenizer, payload.get("targetLanguage")) + payload["sourceText"]
    tokens = tokenizer([source_text], return_tensors="pt", padding=True, truncation=True)
    # Marian models already default to beam search; only block degenerate
    # n-gram loops rather than slowing decoding further.
    translated = model.generate(**tokens, no_repeat_ngram_size=3)
    text = tokenizer.batch_decode(translated, skip_special_tokens=True)[0]
    return {"translatedText": text}

run_worker_loop(handle)
`}`;

/**
 * Persistent M2M100 worker: loads the single multilingual model once on first
 * use, then serves {"op": "translate"|"health", ...} requests over the shared
 * JSON-lines loop. The source text travels in the JSON payload (never argv).
 */
const M2M100_WORKER_SCRIPT = `${PYTHON_WORKER_LOOP}\n${String.raw`
model_id = sys.argv[1]
local_path = sys.argv[2] or model_id
cache_dir = sys.argv[3] or None
allow_download = sys.argv[4] == "1"

from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer

_loaded = {}

def _load(local_files_only):
    cached = _loaded.get("model")
    if cached is not None:
        return cached
    kwargs = {"local_files_only": local_files_only}
    if cache_dir:
        kwargs["cache_dir"] = cache_dir
    tokenizer = M2M100Tokenizer.from_pretrained(local_path, **kwargs)
    # Stream weights during load: halves peak commit so the 2 GB model loads
    # even when Windows paging headroom is tight (os error 1455).
    model = M2M100ForConditionalGeneration.from_pretrained(local_path, low_cpu_mem_usage=True, **kwargs)
    _loaded["model"] = (tokenizer, model)
    return _loaded["model"]

def handle(payload):
    if payload.get("op") == "health":
        _load(True)
        return {"status": "ok"}
    tokenizer, model = _load(not allow_download)
    tokenizer.src_lang = payload["sourceLanguage"]
    tokens = tokenizer(payload["sourceText"], return_tensors="pt", truncation=True)
    # Beam search plus an n-gram repeat block: greedy M2M100 decoding
    # degenerates into repetition on low-resource targets (e.g. Yoruba).
    translated = model.generate(
        **tokens,
        forced_bos_token_id=tokenizer.get_lang_id(payload["targetLanguage"]),
        num_beams=4,
        no_repeat_ngram_size=3,
    )
    text = tokenizer.batch_decode(translated, skip_special_tokens=True)[0]
    return {"translatedText": text}

run_worker_loop(handle)
`}`;

/**
 * Persistent NLLB-200 worker: loads the single multilingual model once on
 * first use, then serves {"op": "translate"|"health", ...} requests over the
 * shared JSON-lines loop. The source text and pre-mapped FLORES-200 codes
 * travel in the JSON payload (never argv). NLLB-200 is licensed CC-BY-NC-4.0
 * (non-commercial use only).
 */
const NLLB200_WORKER_SCRIPT = `${PYTHON_WORKER_LOOP}\n${String.raw`
model_id = sys.argv[1]
local_path = sys.argv[2] or model_id
cache_dir = sys.argv[3] or None
allow_download = sys.argv[4] == "1"

from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

_loaded = {}

def _load(local_files_only):
    cached = _loaded.get("model")
    if cached is not None:
        return cached
    kwargs = {"local_files_only": local_files_only}
    if cache_dir:
        kwargs["cache_dir"] = cache_dir
    tokenizer = AutoTokenizer.from_pretrained(local_path, **kwargs)
    # Stream weights during load: halves peak commit so the model loads even
    # when Windows paging headroom is tight (os error 1455).
    model = AutoModelForSeq2SeqLM.from_pretrained(local_path, low_cpu_mem_usage=True, **kwargs)
    _loaded["model"] = (tokenizer, model)
    return _loaded["model"]

def handle(payload):
    if payload.get("op") == "health":
        _load(True)
        return {"status": "ok"}
    tokenizer, model = _load(not allow_download)
    tokenizer.src_lang = payload["sourceNllbCode"]
    tokens = tokenizer(payload["sourceText"], return_tensors="pt", truncation=True)
    # Settings validated empirically for Yoruba quality: beam search with an
    # n-gram repeat block keeps output fluent without degenerate loops.
    translated = model.generate(
        **tokens,
        forced_bos_token_id=tokenizer.convert_tokens_to_ids(payload["targetNllbCode"]),
        num_beams=4,
        no_repeat_ngram_size=3,
        max_new_tokens=256,
    )
    text = tokenizer.batch_decode(translated, skip_special_tokens=True)[0]
    return {"translatedText": text}

run_worker_loop(handle)
`}`;
