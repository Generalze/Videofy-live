/** @author masterzee001 */
/**
 * Azure AI Speech text-to-speech, as a streaming comparator behind ElevenLabs.
 *
 * EVIDENCE (read 2026-08-22, learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech):
 *   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *   headers: `Ocp-Apim-Subscription-Key` (or `Authorization: Bearer` via
 *            issueToken), `Content-Type: application/ssml+xml`,
 *            `X-Microsoft-OutputFormat`, `User-Agent` -- all four REQUIRED
 *   body:    SSML
 *   streaming output formats include `raw-16khz-16bit-mono-pcm`
 *
 * WHY THIS IS WORTH HAVING. `raw-16khz-16bit-mono-pcm` is the engine's own
 * format exactly, as `pcm_16000` is for ElevenLabs: no resample, no transcode,
 * no container to strip. That makes Azure a drop-in comparator rather than an
 * integration project, which is the only kind of fallback worth carrying.
 *
 * `Ocp-Apim-Subscription-Key` is used rather than the STS bearer flow. The
 * documentation is explicit that bearer tokens are scoped to the endpoint that
 * issued them and expire in ten minutes, and that the subscription key works
 * against all endpoint formats. A ten-minute token refresh loop is real
 * machinery to maintain, and it buys nothing here.
 *
 * WHAT IS NOT IMPLEMENTED, and why rather than silently:
 *   real-time STT   Azure's streaming recognition is the Speech SDK's own
 *                   WebSocket protocol. The published REST surface is
 *                   short-audio (<=60 s) and batch, neither of which is
 *                   streaming transcription. Writing a WebSocket client against
 *                   an unpublished framing would be inventing a protocol.
 *   translation     Azure Translator is a DIFFERENT service on a different host
 *                   with different credentials (not AZURE_SPEECH_KEY). It is
 *                   not reachable with what this provider record declares.
 * Both are recorded as deferred rather than stubbed.
 */
import { MediaIngestError } from '../../ingest-error.js';
import { Pcm16Decoder } from '../pcm16-decoder.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../../streaming-speech-synthesis-provider.js';

/** The engine's own format. Documented as a STREAMING output format. */
export const AZURE_ENGINE_OUTPUT_FORMAT = 'raw-16khz-16bit-mono-pcm';

export interface AzureStreamingTtsConfig {
  readonly apiKey: string;
  /** Selects the endpoint host. Configuration, not a secret. */
  readonly region: string;
  /** Videofy voiceId -> Azure voice ShortName, e.g. `es-ES-ElviraNeural`. */
  readonly voiceIds: Readonly<Record<string, string>>;
  readonly defaultVoiceId: string;
  /** Required by the API. Named here so it is one value, not a scattered guess. */
  readonly userAgent?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

/**
 * XML escaping for SSML.
 *
 * Not optional politeness: the body IS XML, and a translated sentence
 * containing `&` or `<` would either break the request or, worse, be
 * interpreted as markup. "Marks & Spencer" is an ordinary thing to say.
 */
export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSsml(text: string, voiceShortName: string, language: string): string {
  return (
    `<speak version='1.0' xml:lang='${escapeSsmlText(language)}'>` +
    `<voice xml:lang='${escapeSsmlText(language)}' name='${escapeSsmlText(voiceShortName)}'>` +
    escapeSsmlText(text) +
    '</voice></speak>'
  );
}

export class AzureStreamingSynthesisProvider implements StreamingSpeechSynthesisProvider {
  readonly name: string;

  constructor(private readonly config: AzureStreamingTtsConfig) {
    this.name = `azure-speech:tts-${config.region}`;
  }

  async synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
    const voice = this.config.voiceIds[options.voiceId] ?? this.config.defaultVoiceId;
    const base =
      this.config.baseUrl ?? `https://${this.config.region}.tts.speech.microsoft.com`;
    const url = `${base}/cognitiveservices/v1`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 30_000);
    const onCallerAbort = (): void => abort.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const started = Date.now();
    let timeToFirstChunkMs: number | null = null;
    let samples = 0;

    try {
      let response: Response;
      try {
        response = await (this.config.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: {
            'ocp-apim-subscription-key': this.config.apiKey,
            'content-type': 'application/ssml+xml',
            'x-microsoft-outputformat': AZURE_ENGINE_OUTPUT_FORMAT,
            // Documented as REQUIRED. Omitting it returns 400 with a message
            // about headers, which reads like a different problem entirely.
            'user-agent': this.config.userAgent ?? 'videofy-live',
          },
          body: buildSsml(options.text, voice, options.targetLanguage),
          signal: abort.signal,
        });
      } catch (error) {
        if (options.signal?.aborted === true) {
          return { samples: 0, timeToFirstChunkMs: null, totalMs: Date.now() - started, aborted: true };
        }
        throw new MediaIngestError(
          `Azure speech request failed: ${error instanceof Error ? error.message : 'unknown'}`,
          'tts-failed',
          502,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new MediaIngestError(
          // The body carries the actual complaint. A bare status hid a missing
          // quota header from us for a whole validation session once already.
          //
          // EXCEPT ON A REJECTED VOICE, where Azure sends status 400 and
          // nothing else -- no body, no explanatory header, `server:
          // istio-envoy` and that is the whole response. Repeating the empty
          // string back is not a diagnosis, so name the cause the wire refuses
          // to: a voice the region does not host. Azure's own portal offers
          // voices it will then reject here, which is how
          // `en-US-Ava:DragonHDLatestNeural` reached northeurope, where zero
          // DragonHD voices exist, and failed every request identically.
          response.status === 400 && body.length === 0
            ? `Azure speech rejected voice "${voice}" in region ${this.config.region} ` +
              '(400, empty body -- Azure sends no reason). The usual cause is a voice ' +
              'the region does not host: check it against ' +
              `https://${this.config.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`
            : `Azure speech returned ${response.status}: ${body.slice(0, 400)}`,
          'tts-failed',
          502,
        );
      }
      if (response.body === null) {
        throw new MediaIngestError('Azure speech returned no audio stream.', 'tts-failed', 502);
      }

      const decoder = new Pcm16Decoder();
      const reader = response.body.getReader();
      for (;;) {
        if (options.signal?.aborted === true) {
          await reader.cancel('superseded').catch(() => {});
          return { samples, timeToFirstChunkMs, totalMs: Date.now() - started, aborted: true };
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const decoded = decoder.push(value);
        if (decoded.length === 0) continue;
        if (timeToFirstChunkMs === null) timeToFirstChunkMs = Date.now() - started;
        samples += decoded.length;
        options.onChunk({ samples: decoded });
      }

      if (samples === 0) {
        throw new MediaIngestError('Azure speech returned no audio bytes.', 'tts-failed', 502);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }

    const totalMs = Date.now() - started;
    this.config.log?.('azure synthesis', { region: this.config.region, timeToFirstChunkMs, samples });
    return { samples, timeToFirstChunkMs, totalMs, aborted: false };
  }
}
