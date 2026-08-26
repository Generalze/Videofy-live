/** @author masterzee001 */
/**
 * 9jaLingo: Hausa, Igbo, Yoruba and Nigerian Pidgin.
 *
 * WHY A SPECIALIST AT ALL. Both general vendors accept these languages and
 * return HTTP 200 with audio. A listening test found the audio wrong -- a
 * multilingual voice reading unfamiliar orthography with the phonology it
 * already has. Nothing on the server can see that: the status is 200, the byte
 * count is plausible, the latency is normal. Only a speaker of the language
 * can tell, which is why a specialist is routed to by language rather than
 * chosen by a health check.
 *
 * WHAT IS DOCUMENTED, AND WHAT IS NOT. The published contract covers
 * `POST /v1/audio/speech` with `input`, a voice, a `lang` drawn from
 * {ha, ig, yo, pcm}, and a `response_format` that includes `pcm`. It does NOT
 * publish the API host, the authentication header, the PCM sample rate, or any
 * streaming framing.
 *
 * THREE OF THOSE FOUR ARE NOW KNOWN, and none came from the documentation. The
 * official `naijalingo` SDK carries `DEFAULT_BASE_URL = https://api.9jalingo.org`
 * and sends `X-API-Key`; it also exposes `POST /v1/audio/speech/stream`, so the
 * streaming the registry recorded as unverified does exist. Reading a vendor's
 * own client is worth more than reading its documentation page, and cost one
 * lookup against a guess that would have failed silently.
 *
 * THE SAMPLE RATE IS NOT PUBLISHED ANYWHERE, including in the SDK, which is why
 * it stays required configuration. It was established by asking for `wav` once
 * and reading the RIFF header: **22050 Hz, mono, 16-bit** as measured on
 * 2026-08-26. That is the technique to repeat if it ever seems wrong, and it is
 * why this is a declared value rather than a constant -- a vendor that changes
 * it would otherwise break pitch silently.
 *
 * 22050 IS NOT THE ENGINE RATE, so every response is resampled down to 16 kHz.
 * That path is therefore not an edge case here, it is the normal one.
 *
 * NOTHING HERE INVENTS THE MISSING HALF. Every undocumented value is required
 * configuration, and the provider refuses to construct without it. Guessing a
 * host would produce a connection error blamed on the network; guessing a
 * sample rate is worse, because it succeeds -- audio plays at the wrong pitch
 * and speed, in languages the people reviewing it may not speak.
 *
 * COMPLETE AUDIO, NOT STREAMED, and it says so. The registry records streaming
 * as unverified because the framing is not specified. This asks for the whole
 * buffer and emits it as one chunk, so `timeToFirstChunkMs` equals the total
 * time and the metrics tell the truth about that rather than flattering it. If
 * streaming is documented later, only this file changes.
 */
import { MediaIngestError } from '../../ingest-error.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../../streaming-speech-synthesis-provider.js';

/** The engine's format. Anything else has to be converted before it crosses. */
const ENGINE_SAMPLE_RATE = 16_000;

/** Exactly the values the published contract lists for `lang`. */
export const NAIJALINGO_LANGUAGES: readonly string[] = ['ha', 'ig', 'yo', 'pcm'];

export interface NaijaLingoTtsConfig {
  /**
   * API host, including scheme. NOT published -- supplied per deployment.
   *
   * There is no default and there must not be one: a default would be a guess,
   * and a wrong guess here fails as a network error that reads like an outage.
   */
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * How the key is presented. Defaults are EVIDENCE, not convention.
   *
   * `X-API-Key` with the raw key and no scheme, read from the official
   * `naijalingo` SDK (npm 0.1.3, `client.ts`), which is the authority the
   * public documentation page is not -- that page never states the header at
   * all. The obvious guess was `authorization: Bearer`, because the body is
   * OpenAI-shaped, and it would have failed every request: "compatible" is a
   * claim about the payload, not the handshake. Still overridable, because a
   * vendor may change this before the docs catch up.
   */
  readonly authHeaderName?: string | undefined;
  readonly authScheme?: string | undefined;
  /**
   * Sample rate of the returned PCM. NOT published, so it is declared.
   *
   * The most dangerous of the undocumented values, because getting it wrong
   * does not fail. Audio arrives, plays at the wrong speed and pitch, and the
   * languages affected are ones the reviewer may not speak.
   */
  readonly sampleRate: number;
  readonly model?: string | undefined;
  /** Videofy voiceId -> vendor voice. The platform owns the mapping. */
  readonly voiceIds?: Readonly<Record<string, string>> | undefined;
  readonly defaultVoice: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

function requireConfigured(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new MediaIngestError(
      `9jaLingo needs ${name}; it is not published and has no safe default.`,
      'unsupported-tts-provider',
      500,
    );
  }
  return trimmed;
}

/**
 * Signed 16-bit little-endian PCM to the engine's sample array.
 *
 * A vendor buffer can end mid-sample, so the odd trailing byte is dropped
 * rather than read past the end -- one sample of silence beats a RangeError, and
 * beats the garbage value that reading a half-sample would produce.
 */
function pcmToSamples(buffer: ArrayBuffer): Int16Array {
  const usable = buffer.byteLength - (buffer.byteLength % 2);
  return new Int16Array(buffer.slice(0, usable));
}

/**
 * Convert to 16 kHz when the vendor does not already speak it.
 *
 * DELIBERATELY MODEST, and flagged as such. Downsampling averages the samples
 * that collapse into each output sample, which is a crude low-pass and a real
 * improvement on dropping them -- naive decimation aliases, and aliasing on
 * speech sounds like harshness a listener will attribute to the voice. It is
 * not a windowed-sinc resampler. If a deployment finds this vendor returns
 * something other than 16 kHz in practice, that is the point to replace this
 * function, not to widen it.
 */
export function resampleToEngineRate(samples: Int16Array, fromRate: number): Int16Array {
  if (fromRate === ENGINE_SAMPLE_RATE || samples.length === 0) return samples;

  const ratio = fromRate / ENGINE_SAMPLE_RATE;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Int16Array(outputLength);

  if (ratio > 1) {
    // Downsampling: average the span each output sample stands for.
    for (let index = 0; index < outputLength; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
      let total = 0;
      for (let cursor = start; cursor < end; cursor += 1) total += samples[cursor] ?? 0;
      output[index] = Math.round(total / Math.max(1, end - start));
    }
    return output;
  }

  // Upsampling: linear interpolation between neighbours.
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[index] = Math.round((samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight);
  }
  return output;
}

export class NaijaLingoStreamingSynthesisProvider implements StreamingSpeechSynthesisProvider {
  readonly name: string;
  private readonly config: NaijaLingoTtsConfig;
  private readonly baseUrl: string;

  constructor(config: NaijaLingoTtsConfig) {
    this.baseUrl = requireConfigured(config.baseUrl, 'NAIJALINGO_BASE_URL').replace(/\/+$/u, '');
    requireConfigured(config.apiKey, 'NAIJALINGO_API_KEY');
    requireConfigured(config.defaultVoice, 'NAIJALINGO_DEFAULT_VOICE');
    if (!Number.isFinite(config.sampleRate) || config.sampleRate <= 0) {
      throw new MediaIngestError(
        '9jaLingo needs NAIJALINGO_SAMPLE_RATE; the vendor does not publish it and a wrong value plays at the wrong pitch without failing.',
        'unsupported-tts-provider',
        500,
      );
    }
    this.config = config;
    this.name = `naijalingo:${config.model ?? 'audio-speech-v1'}`;
  }

  /**
   * Wake the inference endpoint without waiting for a listener to need it.
   *
   * WHY THIS EXISTS. The capacity behind this vendor scales to zero, and the
   * first request after an idle period is refused for minutes. On a live call
   * that is the worst possible moment to discover it: the chain falls through,
   * and the Yoruba speaker hears the mispronouncing general vendor -- the exact
   * outcome this provider was added to prevent, arriving precisely when
   * somebody first needs it.
   *
   * Fire and forget, and deliberately so. Nothing waits on the result: a
   * warm-up that fails must not delay a boot or fail a session, because the
   * fallback already covers the case where it did not work.
   */
  warmUp(): void {
    void this.synthesize({
      text: 'ok',
      targetLanguage: 'yo',
      voiceId: 'voice_warmup',
      onChunk: () => {},
      onError: () => {},
    }).catch(() => undefined);
  }

  async synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
    const started = Date.now();
    const language = options.targetLanguage.toLowerCase().split(/[-_]/u)[0] ?? '';

    /*
     * Refused rather than attempted. This provider is routed to BY language;
     * being asked for one it does not serve means the routing is wrong, and a
     * clear error is how that gets found instead of being absorbed.
     */
    if (!NAIJALINGO_LANGUAGES.includes(language)) {
      throw new MediaIngestError(
        `9jaLingo does not serve ${options.targetLanguage}; it covers ${NAIJALINGO_LANGUAGES.join(', ')}.`,
        'unsupported-tts-language',
        502,
      );
    }

    const voice = this.config.voiceIds?.[options.voiceId] ?? this.config.defaultVoice;
    const headerName = this.config.authHeaderName ?? 'x-api-key';
    // Empty by default: this vendor takes the raw key, unprefixed.
    const scheme = this.config.authScheme ?? '';

    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          [headerName]: scheme.length === 0 ? this.config.apiKey : `${scheme} ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model ?? 'audio-speech-v1',
          input: options.text,
          voice,
          lang: language,
          response_format: 'pcm',
        }),
        signal: options.signal ?? null,
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        return { samples: 0, timeToFirstChunkMs: null, totalMs: Date.now() - started, aborted: true };
      }
      throw new MediaIngestError(
        `9jaLingo request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'tts-failed',
        502,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      /*
       * COLD IS NOT BROKEN, and conflating them wastes an outage investigation.
       * This vendor runs on inference capacity that scales to zero: after an
       * idle period the first request is refused with 503 and a message saying
       * capacity is starting, and the endpoint needs minutes rather than
       * seconds. Named distinctly so a log reader sees a warm-up in progress
       * rather than a vendor that has fallen over.
       */
      if (response.status === 503 && /capacity|starting|idle/iu.test(body)) {
        throw new MediaIngestError(
          '9jaLingo is cold: inference capacity is starting after an idle period ' +
            'and takes minutes, not seconds. Nigerian-language audio falls to a ' +
            'general vendor until it is warm.',
          'tts-failed',
          503,
        );
      }
      throw new MediaIngestError(
        `9jaLingo returned ${response.status}: ${body.slice(0, 400)}`,
        'tts-failed',
        502,
      );
    }

    const samples = resampleToEngineRate(
      pcmToSamples(await response.arrayBuffer()),
      this.config.sampleRate,
    );

    if (samples.length === 0) {
      // Zero samples is a failure, not a quiet success -- the chain above reads
      // it as grounds to fall through, and it must be able to.
      return { samples: 0, timeToFirstChunkMs: null, totalMs: Date.now() - started, aborted: false };
    }

    options.onChunk({ samples });
    const elapsed = Date.now() - started;

    /*
     * First-chunk time EQUALS total time, and that is reported honestly rather
     * than flattered. Nothing streamed; the whole buffer arrived and was handed
     * over at once. A latency comparison against a streaming vendor has to be
     * able to see that difference.
     */
    return { samples: samples.length, timeToFirstChunkMs: elapsed, totalMs: elapsed, aborted: false };
  }
}
