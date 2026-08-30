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
 * THE CONTRACT BELOW IS PUBLISHED, and the source is named. It comes from the
 * official `naijalingo` npm SDK (0.1.3): its README and its compiled
 * `dist/index.js`, both read on 2026-08-30. That is a stronger authority than
 * the public documentation page, which still does not state the host or the
 * authentication header:
 *
 *   base URL      https://api.9jalingo.org        (SDK `DEFAULT_BASE_URL`)
 *   auth          `X-API-Key: <key>`, NO scheme   (SDK `BaseClient`)
 *   speech        POST /v1/audio/speech
 *   streaming     POST /v1/audio/speech/stream
 *   health        GET  /v1/health
 *   speakers      GET  /v1/speakers
 *   model         9jalingo-tts-1                  (SDK `DEFAULT_MODEL_NAME`)
 *   languages     ha, ig, yo, pcm
 *   formats       wav | pcm | mp3 | flac | aac | alac | ogg
 *
 * THE PREVIOUS IMPLEMENTATION GUESSED THE HEADER AND WAS RIGHT BY ACCIDENT in
 * one place and wrong in another: it defaulted the host to nothing (a
 * deployment error that reads like a network outage) and it demanded a
 * configured sample rate. Both are corrected here, and the auth header default
 * is now evidence rather than a guess -- so when it fails, the error names the
 * header instead of leaving a 401 to be blamed on the key.
 *
 * WAV, NOT RAW PCM, AND THAT IS THE WHOLE POINT. The vendor still does not
 * publish the sample rate of its `pcm` output anywhere -- not on the docs page,
 * not in the SDK. A guessed PCM rate DOES NOT FAIL: audio arrives, the byte
 * count is plausible, and it plays at the wrong pitch and speed in a language
 * the reviewer may not speak. A WAV response carries its own rate in its RIFF
 * header, so asking for `wav` and reading the declared rate removes the guess
 * entirely rather than documenting it. `NAIJALINGO_SAMPLE_RATE` survives only
 * as the override a deployment forced onto raw `pcm` would need, and that path
 * refuses to run without it.
 *
 * A VOICE IS A SPEAKER ID, NEVER A LANGUAGE CODE. This is the SDK's own
 * documented trap -- it throws `'yo' is a language code, not a speaker ID` --
 * and it is easy to fall into because `lang` and `voice` are adjacent fields
 * holding similar-looking strings. Refused here with the same explicitness, so
 * a mis-mapped `NAIJALINGO_VOICE_IDS` is a named error rather than a 4xx from
 * a vendor.
 *
 * COMPLETE AUDIO, NOT STREAMED, and it says so. The streaming endpoint is now
 * published, but its chunk framing is not, and this adapter has never been run
 * against the vendor. It asks for the whole buffer and emits it as one chunk,
 * so `timeToFirstChunkMs` equals the total time and the metrics tell the truth
 * about that rather than flattering it.
 */
import { NIGERIAN_SPECIALIST_LANGUAGES } from '@videofy-live/ai-registry';
import { MediaIngestError } from '../../ingest-error.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../../streaming-speech-synthesis-provider.js';

/** The engine's format. Anything else has to be converted before it crosses. */
const ENGINE_SAMPLE_RATE = 16_000;

/**
 * The vendor's published host.
 *
 * A DEFAULT IS NOW CORRECT because the value is PUBLISHED -- the SDK ships it
 * as `DEFAULT_BASE_URL`. It was correct to refuse a default while the host was
 * unknown, and it is wrong to keep refusing one once the vendor has stated it:
 * that turns a solved problem into an operator's problem. Still overridable,
 * for a test double or a self-hosted instance.
 */
export const NAIJALINGO_DEFAULT_BASE_URL = 'https://api.9jalingo.org';

/** SDK `DEFAULT_MODEL_NAME`. The old `audio-speech-v1` was invented. */
export const NAIJALINGO_DEFAULT_MODEL = '9jalingo-tts-1';

/** SDK `BaseClient`: the raw key, unprefixed, in this header. */
export const NAIJALINGO_DEFAULT_AUTH_HEADER = 'x-api-key';

export const NAIJALINGO_SPEECH_PATH = '/v1/audio/speech';
export const NAIJALINGO_SPEECH_STREAM_PATH = '/v1/audio/speech/stream';
export const NAIJALINGO_HEALTH_PATH = '/v1/health';
export const NAIJALINGO_SPEAKERS_PATH = '/v1/speakers';

/**
 * The four languages, from ONE place.
 *
 * `@videofy-live/ai-registry` owns this list; media-ingest already depends on
 * that package (see `config.ts`), so the copy the previous revision kept here
 * was never necessary. Re-exported under the old name so callers do not have
 * to care which module states it -- but there is now exactly one that does.
 */
export const NAIJALINGO_LANGUAGES: readonly string[] = NIGERIAN_SPECIALIST_LANGUAGES;

/**
 * One PUBLISHED speaker id per language, so activation is one variable.
 *
 * SOURCE, NAMED. The SDK's README carries a "Supported Languages" table with
 * example speakers per code (`aisha_ha`, `adaeze_ig`, `adeola_yo`, `ada_pcm`),
 * and its quick-start uses two of them. That is a published value, and the same
 * reasoning that now permits a default base URL permits these: refusing to
 * default something the vendor states turns a solved problem into an operator's
 * problem on the night of a demo.
 *
 * IT IS STILL NOT A CLAIM ABOUT THE VOICE. A default speaker id is a value that
 * will be ACCEPTED, not one that has been listened to. `NAIJALINGO_VOICE_BY_LANGUAGE`
 * overrides any of them, and the preflight lists what this key can actually
 * use -- which is the only honest check, because a speaker id that has been
 * withdrawn fails as a 404 that reads like an outage.
 */
export const NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE: Readonly<Record<string, string>> = {
  ha: 'aisha_ha',
  ig: 'adaeze_ig',
  yo: 'adeola_yo',
  pcm: 'ada_pcm',
};

/**
 * Every string the vendor accepts as a language, lower case.
 *
 * Wider than `NAIJALINGO_LANGUAGES` on purpose: it exists to catch a language
 * NAME being sent as a voice, not to decide routing. The SDK's alias table is
 * the source.
 */
const LANGUAGE_WORDS: ReadonlySet<string> = new Set([
  'ha',
  'hau',
  'hausa',
  'ig',
  'ibo',
  'igbo',
  'yo',
  'yor',
  'yoruba',
  'pcm',
  'pidgin',
]);

/** Formats the vendor documents. `wav` is what this adapter asks for. */
export type NaijaLingoResponseFormat = 'wav' | 'pcm';

export interface NaijaLingoTtsConfig {
  /**
   * API host, including scheme. Defaults to the vendor's published host.
   */
  readonly baseUrl?: string | undefined;
  readonly apiKey: string;
  /**
   * How the key is presented. Defaults are EVIDENCE, not convention.
   *
   * `X-API-Key` with the raw key and no scheme, read from the official
   * `naijalingo` SDK (npm 0.1.3, `BaseClient`). The obvious guess was
   * `authorization: Bearer`, because the body is OpenAI-shaped, and it would
   * have failed every request with a 401 that a reader would blame on the key
   * rather than on the header. Overridable, because a vendor may change this
   * before the docs catch up.
   */
  readonly authHeaderName?: string | undefined;
  readonly authScheme?: string | undefined;
  /**
   * `wav` (default) or `pcm`.
   *
   * WAV IS THE DEFAULT BECAUSE THE PCM RATE IS UNPUBLISHED. A WAV response
   * declares its own rate in its RIFF header, so nothing has to be guessed and
   * nothing has to be configured. Raw `pcm` is available for a deployment that
   * has measured the rate itself and wants the smaller payload -- and it then
   * MUST supply `sampleRate`, because the alternative is silent wrong pitch.
   */
  readonly responseFormat?: NaijaLingoResponseFormat | undefined;
  /**
   * Sample rate override. Required ONLY when `responseFormat` is `pcm`.
   *
   * Ignored for `wav`, where the header is the authority: a configured value
   * that disagreed with the header would be a second guess overruling a fact.
   */
  readonly sampleRate?: number | undefined;
  readonly model?: string | undefined;
  /**
   * Videofy voiceId -> vendor SPEAKER ID (`adeola_yo`, `ada_pcm`, ...).
   *
   * Never a language code. The values are validated at request time, because a
   * template filled in with `yo` looks entirely reasonable and is the exact
   * mistake the vendor's own SDK raises an error for.
   */
  readonly voiceIds?: Readonly<Record<string, string>> | undefined;
  /** Default SPEAKER ID. Language-specific defaults take precedence. */
  readonly defaultVoice: string;
  /** Per-language default SPEAKER ID, e.g. `{ yo: 'adeola_yo' }`. */
  readonly defaultVoiceByLanguage?: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function requireConfigured(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new MediaIngestError(
      `9jaLingo needs ${name}.`,
      'unsupported-tts-provider',
      500,
    );
  }
  return trimmed;
}

/**
 * A speaker id, or a named refusal.
 *
 * THE VENDOR'S OWN TRAP. `voice` and `lang` sit next to each other and hold
 * similar strings, and the SDK throws for exactly this. Sending `yo` as the
 * voice does not obviously fail on our side -- it fails at the vendor, as a
 * 4xx that gets read as "the key is wrong" or "the service is down".
 */
export function assertSpeakerId(voice: string, language: string): string {
  const trimmed = voice.trim();
  if (trimmed.length === 0) {
    throw new MediaIngestError(
      '9jaLingo needs a speaker id and none is configured; set NAIJALINGO_DEFAULT_VOICE ' +
        'to a speaker id such as adeola_yo.',
      'unsupported-tts-voice',
      500,
    );
  }
  if (LANGUAGE_WORDS.has(trimmed.toLowerCase())) {
    throw new MediaIngestError(
      `9jaLingo was given '${trimmed}' as a voice, but that is a LANGUAGE CODE and not a ` +
        `speaker id. The language travels in 'lang' (here: '${language}'); the voice must be ` +
        "a speaker id such as adeola_yo, ada_pcm or adaeze_ig. Check NAIJALINGO_VOICE_IDS " +
        'and NAIJALINGO_DEFAULT_VOICE; run the preflight to list the speaker ids this key can use.',
      'unsupported-tts-voice',
      500,
    );
  }
  return trimmed;
}

export interface DecodedAudio {
  readonly samples: Int16Array;
  /** The rate the AUDIO DECLARED, never one this process assumed. */
  readonly sampleRate: number;
  readonly channels: number;
}

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Read a RIFF/WAVE buffer and return its samples AT THE RATE IT DECLARES.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. It is three dozen lines standing in for one
 * configuration variable, and it is worth every one of them: the variable was a
 * guess, and a wrong guess about a sample rate is the one vendor mistake that
 * produces no error anywhere. The header is a fact the vendor sends with every
 * response, so the rate cannot drift out from under a deployment.
 *
 * CHUNK-WALKED, not read at fixed offsets. Real WAV files carry `LIST`, `fact`
 * and other chunks between `fmt ` and `data`, and an encoder that adds one
 * would silently shift a fixed-offset reader onto metadata it would then play.
 */
export function parseWavPcm(buffer: ArrayBuffer): DecodedAudio {
  if (buffer.byteLength < 12) {
    throw new MediaIngestError(
      '9jaLingo returned a body too short to be a WAV file; the adapter asked for ' +
        'response_format=wav and must read the sample rate from its header.',
      'tts-failed',
      502,
    );
  }
  const view = new DataView(buffer);
  if (ascii(view, 0) !== 'RIFF' || ascii(view, 8) !== 'WAVE') {
    throw new MediaIngestError(
      '9jaLingo returned a body with no RIFF/WAVE header. The adapter asked for ' +
        'response_format=wav precisely so the sample rate is declared rather than guessed; ' +
        'it will not assume one. Set NAIJALINGO_RESPONSE_FORMAT=pcm with NAIJALINGO_SAMPLE_RATE ' +
        'only if the rate has actually been measured.',
      'tts-failed',
      502,
    );
  }

  let format: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= buffer.byteLength) {
    const id = ascii(view, cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'fmt ' && body + 16 <= buffer.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataStart = body;
      // A streamed WAV may declare 0 or 0xFFFFFFFF for a length it did not know
      // in advance. What actually arrived is the honest answer.
      dataLength = size === 0 || body + size > buffer.byteLength ? buffer.byteLength - body : size;
      break;
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    cursor = body + size + (size % 2);
  }

  if (format === null || sampleRate <= 0 || channels <= 0) {
    throw new MediaIngestError(
      '9jaLingo returned a WAV file with no readable fmt chunk, so its sample rate is ' +
        'unknown. Refusing rather than assuming one.',
      'tts-failed',
      502,
    );
  }
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still linear PCM in practice).
  if (format !== 1 && format !== 0xfffe) {
    throw new MediaIngestError(
      `9jaLingo returned WAV audio format ${format}, which is not linear PCM. This adapter ` +
        'decodes PCM only and will not reinterpret compressed samples as PCM.',
      'tts-failed',
      502,
    );
  }
  if (bitsPerSample !== 16) {
    throw new MediaIngestError(
      `9jaLingo returned ${bitsPerSample}-bit WAV audio; this adapter decodes 16-bit PCM. ` +
        'Reading it as 16-bit would produce noise, not quiet audio.',
      'tts-failed',
      502,
    );
  }
  if (dataStart < 0) {
    throw new MediaIngestError(
      '9jaLingo returned a WAV file with no data chunk.',
      'tts-failed',
      502,
    );
  }

  // A vendor buffer can end mid-frame, so the trailing partial frame is dropped
  // rather than read past the end.
  const frameBytes = 2 * channels;
  const usable = dataLength - (dataLength % frameBytes);
  const interleaved = new Int16Array(buffer.slice(dataStart, dataStart + usable));

  if (channels === 1) return { samples: interleaved, sampleRate, channels };

  // Downmix by averaging. The vendor's speakers are mono; this is here so a
  // stereo response degrades to mono rather than playing at double speed.
  const frames = interleaved.length / channels;
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      total += interleaved[frame * channels + channel] ?? 0;
    }
    mono[frame] = Math.round(total / channels);
  }
  return { samples: mono, sampleRate, channels };
}

/**
 * Signed 16-bit little-endian PCM to the engine's sample array.
 *
 * Only reachable on the raw-`pcm` path, which requires a measured rate.
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
 * not a windowed-sinc resampler.
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

// --- preflight ------------------------------------------------------------

export interface NaijaLingoPreflight {
  /** False when NAIJALINGO_API_KEY is absent. No request is attempted then. */
  readonly keyConfigured: boolean;
  /** True only when /v1/health answered 2xx. */
  readonly reachable: boolean;
  /** The vendor's own readiness flag; null when it did not answer. */
  readonly engineReady: boolean | null;
  readonly totalSpeakers: number | null;
  /** Speaker ids per language code, as the vendor listed them. */
  readonly speakerIdsByLanguage: Readonly<Record<string, readonly string[]>>;
  /** Routed languages the key can produce NO voice for. */
  readonly languagesWithoutSpeakers: readonly string[];
  /** Null when everything answered. Never contains a key or any value of one. */
  readonly problem: string | null;
}

export interface NaijaLingoPreflightConfig {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly authHeaderName?: string | undefined;
  readonly authScheme?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

function authHeaders(config: {
  apiKey: string;
  authHeaderName?: string | undefined;
  authScheme?: string | undefined;
}): Record<string, string> {
  const name = config.authHeaderName ?? NAIJALINGO_DEFAULT_AUTH_HEADER;
  const scheme = config.authScheme ?? '';
  return { [name]: scheme.length === 0 ? config.apiKey : `${scheme} ${config.apiKey}` };
}

/**
 * Ask the vendor two questions a deployment cannot answer from a template.
 *
 * WHAT THIS IS FOR. Activation is meant to be "paste the key", and the way that
 * goes wrong is quiet: a key that is valid but has no plan, a key whose
 * speakers do not cover Yoruba, a header the vendor changed. All three produce
 * a fallback that sounds like a working product to anyone who does not speak
 * the language. `GET /v1/health` says the engine is up; `GET /v1/speakers` says
 * which voices this key may actually use, per language.
 *
 * NEVER THROWS, and never names a value. It reports; the caller decides. A
 * preflight that could fail a boot would make a vendor outage into an outage
 * here, which is exactly the coupling the fallback exists to avoid. And an
 * ABSENT KEY IS REPORTED AS ABSENT rather than as a failed request: no network
 * call is made at all, so nothing in a log can be mistaken for a rejection.
 */
export async function preflightNaijaLingo(
  config: NaijaLingoPreflightConfig,
): Promise<NaijaLingoPreflight> {
  const empty: Readonly<Record<string, readonly string[]>> = {};
  const apiKey = config.apiKey?.trim() ?? '';
  if (apiKey.length === 0) {
    return {
      keyConfigured: false,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: empty,
      languagesWithoutSpeakers: NAIJALINGO_LANGUAGES,
      problem: 'NAIJALINGO_API_KEY is not set; no request was attempted.',
    };
  }

  const base = (config.baseUrl?.trim() ?? NAIJALINGO_DEFAULT_BASE_URL).replace(/\/+$/u, '');
  const doFetch = config.fetchImpl ?? fetch;
  const headers = authHeaders({
    apiKey,
    authHeaderName: config.authHeaderName,
    authScheme: config.authScheme,
  });

  const get = async (path: string): Promise<Record<string, unknown> | string> => {
    const response = await doFetch(`${base}${path}`, {
      method: 'GET',
      headers,
      signal: config.signal ?? null,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      /*
       * The status is named WITH the header, because a wrong header and a wrong
       * key produce the same 401 and only one of them is the operator's fault.
       */
      return (
        `${path} returned ${response.status}` +
        (response.status === 401 || response.status === 403
          ? ` (sent as the '${Object.keys(headers)[0] ?? ''}' header)`
          : '') +
        (body.length > 0 ? `: ${body.slice(0, 200)}` : '')
      );
    }
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  };

  let health: Record<string, unknown> | string;
  try {
    health = await get(NAIJALINGO_HEALTH_PATH);
  } catch (error) {
    return {
      keyConfigured: true,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: empty,
      languagesWithoutSpeakers: NAIJALINGO_LANGUAGES,
      problem: `${NAIJALINGO_HEALTH_PATH} unreachable: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
    };
  }
  if (typeof health === 'string') {
    return {
      keyConfigured: true,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: empty,
      languagesWithoutSpeakers: NAIJALINGO_LANGUAGES,
      problem: health,
    };
  }

  const engineReady =
    typeof health['engine_ready'] === 'boolean'
      ? (health['engine_ready'] as boolean)
      : typeof health['engineReady'] === 'boolean'
        ? (health['engineReady'] as boolean)
        : null;
  const totalSpeakers =
    typeof health['total_speakers'] === 'number'
      ? (health['total_speakers'] as number)
      : typeof health['totalSpeakers'] === 'number'
        ? (health['totalSpeakers'] as number)
        : null;

  let speakers: Record<string, unknown> | string;
  try {
    speakers = await get(NAIJALINGO_SPEAKERS_PATH);
  } catch (error) {
    return {
      keyConfigured: true,
      reachable: true,
      engineReady,
      totalSpeakers,
      speakerIdsByLanguage: empty,
      languagesWithoutSpeakers: NAIJALINGO_LANGUAGES,
      problem: `${NAIJALINGO_SPEAKERS_PATH} unreachable: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
    };
  }
  if (typeof speakers === 'string') {
    return {
      keyConfigured: true,
      reachable: true,
      engineReady,
      totalSpeakers,
      speakerIdsByLanguage: empty,
      languagesWithoutSpeakers: NAIJALINGO_LANGUAGES,
      problem: speakers,
    };
  }

  const byLanguage: Record<string, string[]> = {};
  const list = Array.isArray(speakers['speakers']) ? (speakers['speakers'] as unknown[]) : [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    const language = typeof record['language'] === 'string' ? record['language'].toLowerCase() : null;
    if (id === null || language === null) continue;
    (byLanguage[language] ??= []).push(id);
  }

  const missing = NAIJALINGO_LANGUAGES.filter(
    (language) => (byLanguage[language] ?? []).length === 0,
  );

  return {
    keyConfigured: true,
    reachable: true,
    engineReady,
    totalSpeakers,
    speakerIdsByLanguage: byLanguage,
    languagesWithoutSpeakers: missing,
    problem:
      missing.length === 0
        ? null
        : `this key lists no speaker for ${missing.join(', ')}; those languages will fall back.`,
  };
}

/**
 * The preflight as ONE line for a boot log. NAMES ONLY -- never a key.
 *
 * Deliberately blunt about the bad cases. "9jaLingo preflight: key absent" is
 * the sentence that saves a demo, and it only saves it if it is legible in a
 * log somebody skims.
 */
export function describeNaijaLingoPreflight(preflight: NaijaLingoPreflight): string {
  if (!preflight.keyConfigured) {
    return '9jaLingo preflight: NAIJALINGO_API_KEY absent -- ha/ig/yo/pcm will be served by the Azure fallback, which mispronounces them.';
  }
  if (!preflight.reachable) {
    return `9jaLingo preflight: NOT reachable -- ${preflight.problem ?? 'unknown'}`;
  }
  const counts = NAIJALINGO_LANGUAGES.map(
    (language) => `${language}=${(preflight.speakerIdsByLanguage[language] ?? []).length}`,
  ).join(' ');
  const ready = preflight.engineReady === false ? ' engine COLD' : '';
  return `9jaLingo preflight: reachable, speakers ${counts}${ready}${
    preflight.problem === null ? '' : ` -- ${preflight.problem}`
  }`;
}

// --- the provider ---------------------------------------------------------

export class NaijaLingoStreamingSynthesisProvider implements StreamingSpeechSynthesisProvider {
  readonly name: string;
  private readonly config: NaijaLingoTtsConfig;
  private readonly baseUrl: string;
  private readonly responseFormat: NaijaLingoResponseFormat;

  constructor(config: NaijaLingoTtsConfig) {
    this.baseUrl = (config.baseUrl?.trim() === undefined || config.baseUrl.trim().length === 0
      ? NAIJALINGO_DEFAULT_BASE_URL
      : config.baseUrl.trim()
    ).replace(/\/+$/u, '');
    requireConfigured(config.apiKey, 'NAIJALINGO_API_KEY');
    assertSpeakerId(requireConfigured(config.defaultVoice, 'NAIJALINGO_DEFAULT_VOICE'), 'any');
    this.responseFormat = config.responseFormat ?? 'wav';
    if (this.responseFormat === 'pcm' && !(Number.isFinite(config.sampleRate) && (config.sampleRate ?? 0) > 0)) {
      /*
       * Raw PCM carries no rate, and the vendor does not publish one. Asking for
       * `wav` instead removes this decision entirely, which is why it is the
       * default; a deployment that overrides it has taken on the measurement.
       */
      throw new MediaIngestError(
        'NAIJALINGO_RESPONSE_FORMAT=pcm needs NAIJALINGO_SAMPLE_RATE: raw PCM declares no rate, ' +
          'the vendor publishes none, and a wrong value does not fail -- it plays at the wrong ' +
          'pitch in a language the reviewer may not speak. Leave the format as wav and the rate ' +
          'is read from the header instead.',
        'unsupported-tts-provider',
        500,
      );
    }
    this.config = config;
    this.name = `naijalingo:${config.model ?? NAIJALINGO_DEFAULT_MODEL}`;
  }

  /** The preflight for THIS provider's configuration. Never throws. */
  async preflight(signal?: AbortSignal): Promise<NaijaLingoPreflight> {
    return preflightNaijaLingo({
      baseUrl: this.baseUrl,
      apiKey: this.config.apiKey,
      authHeaderName: this.config.authHeaderName,
      authScheme: this.config.authScheme,
      fetchImpl: this.config.fetchImpl,
      ...(signal === undefined ? {} : { signal }),
    });
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
   * Fire and forget, and deliberately so. Nothing waits on the result.
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

  private voiceFor(language: string, voiceId: string): string {
    const mapped = this.config.voiceIds?.[voiceId];
    const byLanguage = this.config.defaultVoiceByLanguage?.[language];
    return assertSpeakerId(mapped ?? byLanguage ?? this.config.defaultVoice, language);
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

    const voice = this.voiceFor(language, options.voiceId);

    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(`${this.baseUrl}${NAIJALINGO_SPEECH_PATH}`, {
        method: 'POST',
        headers: {
          ...authHeaders({
            apiKey: this.config.apiKey,
            authHeaderName: this.config.authHeaderName,
            authScheme: this.config.authScheme,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model ?? NAIJALINGO_DEFAULT_MODEL,
          input: options.text,
          // A SPEAKER ID. `lang` below is the language; conflating them is the
          // vendor's own documented trap and is refused above.
          voice,
          lang: language,
          response_format: this.responseFormat,
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
       * seconds.
       */
      if (response.status === 503 && /capacity|starting|idle/iu.test(body)) {
        throw new MediaIngestError(
          '9jaLingo is cold: inference capacity is starting after an idle period ' +
            'and takes minutes, not seconds. Nigerian-language audio falls to the ' +
            'Azure fallback until it is warm.',
          'tts-failed',
          503,
        );
      }
      /*
       * The header is NAMED on an auth failure. A wrong header and a wrong key
       * both return 401, and only one of them is the operator's to fix -- the
       * previous revision guessed this header, so an unexplained 401 is exactly
       * the failure worth pointing at.
       */
      if (response.status === 401 || response.status === 403) {
        throw new MediaIngestError(
          `9jaLingo rejected the credential with ${response.status}. The key is sent as the ` +
            `'${this.config.authHeaderName ?? NAIJALINGO_DEFAULT_AUTH_HEADER}' header with ` +
            `${(this.config.authScheme ?? '').length === 0 ? 'no scheme' : 'a scheme'}; if the ` +
            'vendor has changed that, set NAIJALINGO_AUTH_HEADER/NAIJALINGO_AUTH_SCHEME. ' +
            `Vendor said: ${body.slice(0, 200)}`,
          'tts-failed',
          502,
        );
      }
      throw new MediaIngestError(
        `9jaLingo returned ${response.status}: ${body.slice(0, 400)}`,
        'tts-failed',
        502,
      );
    }

    const buffer = await response.arrayBuffer();
    const decoded: DecodedAudio =
      this.responseFormat === 'wav'
        ? parseWavPcm(buffer)
        : {
            samples: pcmToSamples(buffer),
            // Non-null on this branch: the constructor refuses `pcm` without it.
            sampleRate: this.config.sampleRate ?? 0,
            channels: 1,
          };

    const samples = resampleToEngineRate(decoded.samples, decoded.sampleRate);

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
     * over at once.
     */
    return { samples: samples.length, timeToFirstChunkMs: elapsed, totalMs: elapsed, aborted: false };
  }
}
