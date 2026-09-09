/** @author masterzee001 */
/**
 * Google Cloud Translation v3, against the existing MT contract.
 *
 * Uses the official `@google-cloud/translate` v3 client. It remains a
 * request/response text translator only: no STT, no TTS, no streaming audio.
 * The caller selects it through the route registry and the Nigerian MT router;
 * this adapter does not widen any language route by itself.
 */
import { GOOGLE_CLOUD_TRANSLATION_MODEL_ID } from '@videofy-live/translation-routes';
import { MediaIngestError } from '../../ingest-error.js';
import type {
  ProviderHealthCheck,
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../../translation-provider.js';

export interface GoogleTranslateTextRequest {
  parent: string;
  contents: string[];
  sourceLanguageCode?: string;
  targetLanguageCode: string;
  mimeType: string;
}

export interface GoogleTranslateCallOptions {
  timeout?: number;
  otherArgs?: { headers?: Record<string, string> };
}

export interface GoogleTranslateClient {
  locationPath(projectId: string, location: string): string;
  translateText(
    request: GoogleTranslateTextRequest,
    options?: GoogleTranslateCallOptions,
  ): Promise<[{ translations?: Array<{ translatedText?: string | null }> }]>;
  getProjectId?(): Promise<string> | string;
  close?(): Promise<void> | void;
}

export interface GoogleTranslateClientOptions {
  projectId: string;
  keyFilename?: string;
  quotaProjectId?: string;
}

export interface GoogleTranslationConfig {
  /**
   * The RESOURCE project: whose Translation resources are addressed. Not
   * necessarily the quota project.
   */
  readonly projectId: string;
  /** Service-account key file path. Null uses Application Default Credentials. */
  readonly credentialsFile?: string | null;
  /** Explicit quota project, when it must not be inherited from the credential. */
  readonly quotaProjectId?: string | null;
  /** Cloud Translation location. `global` unless a data-region policy says otherwise. */
  readonly location?: string;
  readonly timeoutMs?: number;
  readonly client?: GoogleTranslateClient;
  readonly createClient?: (
    options: GoogleTranslateClientOptions,
  ) => GoogleTranslateClient | Promise<GoogleTranslateClient>;
}

type GoogleTranslateModule = {
  v3: {
    TranslationServiceClient: new (options: GoogleTranslateClientOptions) => GoogleTranslateClient;
  };
};

export class GoogleTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = GOOGLE_CLOUD_TRANSLATION_MODEL_ID;
  private clientPromise: Promise<GoogleTranslateClient> | null = null;

  constructor(private readonly config: GoogleTranslationConfig) {}

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    const started = Date.now();
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    const client = await this.resolveClient();
    const request: GoogleTranslateTextRequest = {
      parent: client.locationPath(this.config.projectId, this.config.location ?? 'global'),
      contents: [input.sourceText],
      sourceLanguageCode: input.sourceLanguage,
      targetLanguageCode: input.targetLanguage,
      mimeType: 'text/plain',
    };

    try {
      const [payload] = await client.translateText(request, this.callOptions(timeoutMs));
      const translatedText = payload.translations?.[0]?.translatedText;
      if (typeof translatedText !== 'string') {
        throw new MediaIngestError(
          'Google translation response contained no translatedText.',
          'translation-failed',
          502,
        );
      }
      return {
        translatedText,
        providerName: this.name,
        modelId: GOOGLE_CLOUD_TRANSLATION_MODEL_ID,
        providerLatencyMs: Date.now() - started,
      };
    } catch (error) {
      throw classifyGoogleTranslationError(error);
    }
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    const started = Date.now();
    try {
      const client = await this.resolveClient();
      if (client.getProjectId) await client.getProjectId();
      return {
        provider: this.name,
        status: 'ready',
        modelId: GOOGLE_CLOUD_TRANSLATION_MODEL_ID,
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      const classified = classifyGoogleTranslationError(error);
      return {
        provider: this.name,
        status: 'failed',
        modelId: GOOGLE_CLOUD_TRANSLATION_MODEL_ID,
        latencyMs: Date.now() - started,
        error: classified.message,
      };
    }
  }

  dispose(): void {
    const close = async (): Promise<void> => {
      const client = this.config.client ?? (this.clientPromise ? await this.clientPromise : null);
      await client?.close?.();
    };
    void close();
    this.clientPromise = null;
  }

  private async resolveClient(): Promise<GoogleTranslateClient> {
    if (this.config.client) return this.config.client;
    if (!this.clientPromise) {
      const createClient = this.config.createClient ?? createDefaultGoogleTranslateClient;
      this.clientPromise = Promise.resolve(createClient(this.clientOptions()));
    }
    return await this.clientPromise;
  }

  private clientOptions(): GoogleTranslateClientOptions {
    return {
      projectId: this.config.projectId,
      ...(this.config.credentialsFile ? { keyFilename: this.config.credentialsFile } : {}),
      ...(this.config.quotaProjectId ? { quotaProjectId: this.config.quotaProjectId } : {}),
    };
  }

  private callOptions(timeoutMs: number): GoogleTranslateCallOptions {
    return {
      timeout: timeoutMs,
      ...(this.config.quotaProjectId
        ? { otherArgs: { headers: { 'x-goog-user-project': this.config.quotaProjectId } } }
        : {}),
    };
  }
}

async function createDefaultGoogleTranslateClient(
  options: GoogleTranslateClientOptions,
): Promise<GoogleTranslateClient> {
  const translate = (await import('@google-cloud/translate')) as unknown as GoogleTranslateModule;
  return new translate.v3.TranslationServiceClient(options);
}

function classifyGoogleTranslationError(error: unknown): MediaIngestError {
  if (error instanceof MediaIngestError) return error;

  const detail = safeGoogleErrorDetail(error);
  const lower = detail.toLowerCase();
  const status = googleStatus(error);
  const code = googleCode(error);

  if (status === 400 || code === 3 || lower.includes('invalid argument')) {
    return new MediaIngestError(
      `Google translation rejected the language pair or request: ${detail}`,
      'unsupported-language',
      400,
    );
  }
  if (
    status === 429 ||
    code === 8 ||
    lower.includes('quota') ||
    lower.includes('resource exhausted')
  ) {
    return new MediaIngestError(
      `Google translation quota is unavailable: ${detail}`,
      'translation-quota-exceeded',
      429,
    );
  }
  if (
    lower.includes('api has not been used') ||
    lower.includes('api is disabled') ||
    lower.includes('it is disabled')
  ) {
    return new MediaIngestError(
      `Google translation API is unavailable: ${detail}`,
      'translation-api-unavailable',
      502,
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    code === 16 ||
    lower.includes('credential') ||
    lower.includes('authentication') ||
    lower.includes('permission denied') ||
    lower.includes('key file') ||
    lower.includes('enoent')
  ) {
    return new MediaIngestError(
      `Google translation credentials are unavailable or invalid: ${detail}`,
      'translation-credentials-unavailable',
      503,
    );
  }
  if (
    status === 408 ||
    status === 504 ||
    code === 4 ||
    lower.includes('deadline') ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  ) {
    return new MediaIngestError(`Google translation timed out: ${detail}`, 'translation-timeout', 504);
  }
  if (
    (status !== null && status >= 500) ||
    code === 14 ||
    lower.includes('unavailable') ||
    lower.includes('econn') ||
    lower.includes('network')
  ) {
    return new MediaIngestError(
      `Google translation API is unavailable: ${detail}`,
      'translation-api-unavailable',
      502,
    );
  }
  return new MediaIngestError(`Google translation failed: ${detail}`, 'translation-failed', 502);
}

function googleStatus(error: unknown): number | null {
  const value = (error as { status?: unknown; statusCode?: unknown })?.status;
  if (typeof value === 'number') return value;
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return typeof statusCode === 'number' ? statusCode : null;
}

function googleCode(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/u.test(code)) return Number(code);
  return null;
}

function safeGoogleErrorDetail(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown Google translation failure';
  return message
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
      '[redacted private key]',
    )
    .replace(/"private_key"\s*:\s*"[^"]+"/giu, '"private_key":"[redacted]"')
    .slice(0, 400);
}

/**
 * The documented environment construction for the official client.
 *
 *   GOOGLE_TRANSLATE_PROJECT_ID         resource project, required
 *   GOOGLE_TRANSLATE_CREDENTIALS_FILE   service account key file, optional
 *   GOOGLE_APPLICATION_CREDENTIALS      ADC key file fallback, optional
 *   GOOGLE_CLOUD_QUOTA_PROJECT          quota project, optional
 *   GOOGLE_TRANSLATE_LOCATION           location, default global
 */
export function createGoogleTranslationProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleTimestampedTranslationProvider | null {
  const projectId = env['GOOGLE_TRANSLATE_PROJECT_ID']?.trim();
  if (!projectId) return null;
  const timeoutMs = parseTimeout(env['GOOGLE_TRANSLATE_TIMEOUT_MS']);
  return new GoogleTimestampedTranslationProvider({
    projectId,
    credentialsFile:
      env['GOOGLE_TRANSLATE_CREDENTIALS_FILE']?.trim() ||
      env['GOOGLE_APPLICATION_CREDENTIALS']?.trim() ||
      null,
    quotaProjectId: env['GOOGLE_CLOUD_QUOTA_PROJECT']?.trim() || null,
    location: env['GOOGLE_TRANSLATE_LOCATION']?.trim() || 'global',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
