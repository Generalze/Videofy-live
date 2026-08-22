/** @author masterzee001 */
/**
 * Google Cloud Translation v3, against the existing MT contract.
 *
 * EVIDENCE (read 2026-08-22):
 *   POST https://translation.googleapis.com/v3/projects/{PROJECT}:translateText
 *   body: contents[], targetLanguageCode, sourceLanguageCode (optional), mimeType
 *   response: translations[].translatedText
 *   auth: Application Default Credentials is the documented recommendation
 *   v3 = Advanced; v2 = Basic
 *   -- docs.cloud.google.com/translate/docs/translate-text
 *
 * NO STREAMING. The API is request/response, and the registry records
 * `translation.streaming: 'no'` for exactly that reason. Incremental
 * translation of a growing clause is a thing we might want later; pretending
 * this endpoint provides it would be inventing a capability.
 *
 * CREDENTIALS ARE NOT ACQUIRED HERE. `getAccessToken` is injected. Application
 * Default Credentials resolves differently in every environment -- a key file
 * locally, a metadata server on a VM, a workload identity in a cluster -- and
 * an adapter that hard-coded one of those would be an adapter that only works
 * on the machine it was written on. The composition layer supplies it in
 * C-AI1.1D; nothing here reads a credential from disk or environment.
 */
import { MediaIngestError } from '../../ingest-error.js';
import type {
  ProviderHealthCheck,
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../../translation-provider.js';

export interface GoogleTranslationConfig {
  readonly projectId: string;
  /** Returns a bearer token. Application Default Credentials, resolved upstream. */
  readonly getAccessToken: () => Promise<string>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Cloud Translation location. `global` unless a data-region policy says otherwise. */
  readonly location?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class GoogleTimestampedTranslationProvider implements TimestampedTranslationProvider {
  readonly name = 'google-cloud:translate-v3';

  constructor(private readonly config: GoogleTranslationConfig) {}

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    const started = Date.now();
    const location = this.config.location ?? 'global';
    const base = this.config.baseUrl ?? 'https://translation.googleapis.com';
    const url = `${base}/v3/projects/${encodeURIComponent(this.config.projectId)}/locations/${location}:translateText`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 10_000);
    let response: Response;
    try {
      const token = await this.config.getAccessToken();
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contents: [input.sourceText],
          // Sent explicitly rather than relying on detection: the platform
          // already knows the speaker's language, and letting the vendor guess
          // would make one more thing able to disagree with session policy.
          sourceLanguageCode: input.sourceLanguage,
          targetLanguageCode: input.targetLanguage,
          mimeType: 'text/plain',
        }),
        signal: abort.signal,
      });
    } catch (error) {
      throw new MediaIngestError(
        `Google translation request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'translation-failed',
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 400 for an unsupported pair is a routing fact the composite provider
      // acts on, so it gets its own code rather than a generic failure.
      const code = response.status === 400 ? 'unsupported-language' : 'translation-failed';
      throw new MediaIngestError(
        `Google translation returned ${response.status}: ${body.slice(0, 200)}`,
        code,
        response.status === 400 ? 400 : 502,
      );
    }

    const payload = (await response.json()) as {
      translations?: { translatedText?: string }[];
    };
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
      modelId: 'translate-v3-translateText',
      providerLatencyMs: Date.now() - started,
    };
  }

  async healthCheck(): Promise<ProviderHealthCheck> {
    // Deliberately does NOT translate anything: a health check that spends money
    // on every probe is one that gets disabled, and then nothing is checked.
    try {
      await this.config.getAccessToken();
      return {
        provider: this.name,
        status: 'ready',
        modelId: 'translate-v3-translateText',
        latencyMs: null,
        error: null,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: 'failed',
        modelId: 'translate-v3-translateText',
        latencyMs: null,
        error: error instanceof Error ? error.message : 'unknown',
      };
    }
  }
}
