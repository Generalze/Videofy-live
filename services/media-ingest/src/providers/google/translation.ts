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
 * CREDENTIALS ARE NOT ACQUIRED HERE. `authorize` is injected. Application
 * Default Credentials resolves differently in every environment -- a key file
 * locally, a metadata server on a VM, a workload identity in a cluster -- and
 * an adapter that hard-coded one of those would be an adapter that only works
 * on the machine it was written on. Nothing here reads a credential from disk
 * or environment.
 *
 * THE AUTHORIZER RETURNS HEADERS, NOT A TOKEN, and that is the C-AI1.1F fix.
 * ADC resolves a token AND the project whose quota and billing the call is
 * attributed to. Asking it only for the token discarded the second, the
 * `x-goog-user-project` header went unsent, and Google answered 403 -- a
 * permissions error for a caller whose permissions were fine. See
 * `./authorization.ts` for why the resource project and the quota project are
 * two different things.
 */
import { MediaIngestError } from '../../ingest-error.js';
import {
  createAdcAuthorizer,
  googleRequestHeaders,
  type GoogleAuthorizer,
} from './authorization.js';
import type {
  ProviderHealthCheck,
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from '../../translation-provider.js';

export interface GoogleTranslationConfig {
  /**
   * The RESOURCE project: whose Translation resources are addressed. Appears
   * in the URL. Not necessarily the project that pays -- see `quotaProjectId`.
   */
  readonly projectId: string;
  /** Application Default Credentials, resolved upstream. Returns headers. */
  readonly authorize: GoogleAuthorizer;
  /**
   * The QUOTA project, when the deployment wants to state it rather than
   * inherit whatever the credential carries. Wins over the credential's own.
   */
  readonly quotaProjectId?: string | null;
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
      const authorization = await this.config.authorize();
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          ...googleRequestHeaders(authorization, this.config.quotaProjectId),
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
        // Google's body names the actual problem -- a disabled API, a missing
        // quota project, the wrong service. A bare status code sends whoever
        // reads it guessing, which is exactly what happened with the 403 this
        // wave exists to fix.
        `Google translation returned ${response.status}: ${body.slice(0, 400)}`,
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
      await this.config.authorize();
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

/**
 * The documented way to construct this adapter from the environment.
 *
 * Exists so the two projects are named in one place rather than being
 * rediscovered at each call site:
 *
 *   GOOGLE_TRANSLATE_PROJECT_ID   the RESOURCE project, required
 *   GOOGLE_CLOUD_QUOTA_PROJECT    the QUOTA project, optional. Unset means
 *                                 "use whatever the credential carries", which
 *                                 is right on a laptop and usually wrong in a
 *                                 deployment that bills a specific project.
 *
 * Returns null rather than throwing when the resource project is absent: a
 * provider that has not been configured is not an error, it is a provider that
 * was not selected.
 */
export function createGoogleTranslationProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  authorize: GoogleAuthorizer = createAdcAuthorizer({
    quotaProjectId: env['GOOGLE_CLOUD_QUOTA_PROJECT'] ?? null,
  }),
): GoogleTimestampedTranslationProvider | null {
  const projectId = env['GOOGLE_TRANSLATE_PROJECT_ID'];
  if (projectId === undefined || projectId === '') return null;
  return new GoogleTimestampedTranslationProvider({
    projectId,
    authorize,
    quotaProjectId: env['GOOGLE_CLOUD_QUOTA_PROJECT'] ?? null,
  });
}
