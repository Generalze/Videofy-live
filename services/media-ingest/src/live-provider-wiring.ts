/** @author masterzee001 */
/**
 * Turning configuration into the live path's providers.
 *
 * One place, so the answer to "what is actually transcribing this call" is a
 * file rather than an archaeology exercise across three constructors.
 *
 * REFUSES RATHER THAN DEFAULTS. Every unknown value throws at startup. A
 * deployment that silently fell back to a mock recogniser would run, accept
 * audio, emit confident nonsense, and pass every health check -- which is the
 * worst failure mode this pipeline has, because it looks exactly like success.
 */
import {
  DeepgramNovaStreamingProvider,
  type DeepgramNovaStreamingConfig,
} from './providers/deepgram/nova-streaming-stt.js';
import {
  DeepgramFluxStreamingProvider,
  type DeepgramFluxStreamingConfig,
} from './providers/deepgram/flux-streaming-stt.js';
import { AzureStreamingSynthesisProvider } from './providers/azure/streaming-tts.js';
import { createFallbackSpeechSynthesisProvider } from './fallback-speech-synthesis-provider.js';
import {
  NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
  NAIJALINGO_SELECTED_VOICE_BY_LANGUAGE,
  NAIJALINGO_SELECTED_VOICE_IDS,
  NaijaLingoStreamingSynthesisProvider,
  describeNaijaLingoPreflight,
  preflightNaijaLingo,
  type NaijaLingoPreflight,
  type NaijaLingoResponseFormat,
} from './providers/naijalingo/streaming-tts.js';
import {
  absentSpecialistState,
  createNigerianSynthesisRoute,
  type NigerianSynthesisState,
} from './nigerian-synthesis-route.js';
import { createLanguageRoutedSynthesisProvider } from './language-routed-synthesis-provider.js';
import { createWarmKeeper } from './providers/naijalingo/warm-keeper.js';
/*
 * THE SINGLE SOURCE OF THE NIGERIAN RULE, imported rather than restated.
 *
 * `ai-registry`'s `commercial-routing` owns which languages the specialist
 * serves and who the one named fallback is. This service already depends on
 * that package (see `config.ts` and the naijalingo adapter), so the copy this
 * file used to keep -- and the comment that told the next reader to remember to
 * edit both -- were never necessary. A rule a human has to remember to apply
 * twice is a rule that drifts; the memory calls this the unwired-seam pattern
 * and it has cost this repository four seams in one session.
 */
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
} from '@videofy-live/ai-registry';
import {
  ElevenLabsStreamingSynthesisProvider,
  type ElevenLabsTtsConfig,
} from './providers/elevenlabs/tts.js';
import {
  MockStreamingTranscriptionProvider,
  type StreamingTranscriptionProvider,
} from './streaming-transcription-provider.js';
import {
  MockStreamingSynthesisProvider,
  type StreamingSpeechSynthesisProvider,
} from './streaming-speech-synthesis-provider.js';
import { WebSocket } from 'ws';
import { createDeepgramWebSocketFactory } from './providers/deepgram/transport.js';
import type { IngestConfig } from './config.js';

export interface LiveProviderEnv {
  readonly deepgramApiKey?: string | undefined;
  readonly deepgramModel?: string | undefined;
  readonly naijaLingoBaseUrl?: string | undefined;
  readonly naijaLingoApiKey?: string | undefined;
  readonly naijaLingoSampleRate?: string | undefined;
  readonly naijaLingoDefaultVoice?: string | undefined;
  readonly naijaLingoAuthHeader?: string | undefined;
  readonly naijaLingoAuthScheme?: string | undefined;
  readonly naijaLingoModel?: string | undefined;
  readonly naijaLingoVoiceIds?: string | undefined;
  /** `wav` (default) or `pcm`. `pcm` additionally requires the rate. */
  readonly naijaLingoResponseFormat?: string | undefined;
  /** `yo=adeola_yo,ig=adaeze_ig` — per-language SPEAKER ids, never codes. */
  readonly naijaLingoVoiceByLanguage?: string | undefined;
  /**
   * Keep the specialist's capacity awake even when nobody is using it.
   *
   * Off by default because always-warm has a real bill. A deployment that is
   * about to be DEMONSTRATED should turn it on: the vendor scales to zero and
   * takes about five minutes to come back, and during those minutes every
   * Nigerian-language sentence is spoken by the fallback that mispronounces it.
   */
  readonly naijaLingoWarmAlwaysOn?: string | undefined;
  readonly naijaLingoWarmIntervalMs?: string | undefined;
  readonly naijaLingoWarmIdleAfterMs?: string | undefined;
  readonly azureSpeechKey?: string | undefined;
  readonly azureSpeechRegion?: string | undefined;
  readonly azureVoiceIds?: string | undefined;
  readonly azureDefaultVoiceId?: string | undefined;
  readonly elevenLabsApiKey?: string | undefined;
  readonly elevenLabsModel?: string | undefined;
  readonly elevenLabsVoiceId?: string | undefined;
  /** `platformVoiceId=vendorVoiceId,...` — see parseVoiceIdMap. */
  readonly elevenLabsVoiceIds?: string | undefined;
}

/**
 * The platform's voice ids mapped to the vendor's.
 *
 * Without this every platform voice fell through to a single default, so a
 * speaker who chose a female translated voice was spoken by whichever one
 * voice the deployment had configured -- and every participant in every
 * language shared it. The choice was computed correctly all the way to the
 * vendor boundary and discarded there.
 *
 * Parsed leniently on purpose: a malformed pair is skipped rather than taking
 * the service down, because the consequence is one voice falling back to the
 * default rather than a call that cannot happen.
 */
export function parseVoiceIdMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const platform = pair.slice(0, index).trim();
    const vendor = pair.slice(index + 1).trim();
    if (platform.length === 0 || vendor.length === 0) continue;
    map[platform] = vendor;
  }
  return map;
}

/**
 * EMPTY IS ABSENT.
 *
 * A deployment template declares every variable it supports and leaves the
 * values blank, so `DEEPGRAM_MODEL=` is the NORMAL state of an unconfigured
 * box -- not a deliberate choice of the empty-string model. Read raw, it
 * survives `?? 'flux-general-en'` (which only replaces null and undefined),
 * reaches the provider as a model named "", and crash-loops the service with
 * `" is not a Flux model"`. Whitespace does the same, and is harder to see in
 * a file nobody can print.
 */
function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function readLiveProviderEnv(env: NodeJS.ProcessEnv = process.env): LiveProviderEnv {
  // NAMES only. No secret is ever written to a log line, a doc, or a default.
  return {
    deepgramApiKey: optional(env['DEEPGRAM_API_KEY']),
    deepgramModel: optional(env['DEEPGRAM_MODEL']),
    naijaLingoBaseUrl: optional(env['NAIJALINGO_BASE_URL']),
    naijaLingoApiKey: optional(env['NAIJALINGO_API_KEY']),
    naijaLingoSampleRate: optional(env['NAIJALINGO_SAMPLE_RATE']),
    naijaLingoDefaultVoice: optional(env['NAIJALINGO_DEFAULT_VOICE']),
    naijaLingoAuthHeader: optional(env['NAIJALINGO_AUTH_HEADER']),
    naijaLingoAuthScheme: optional(env['NAIJALINGO_AUTH_SCHEME']),
    naijaLingoModel: optional(env['NAIJALINGO_MODEL']),
    naijaLingoVoiceIds: optional(env['NAIJALINGO_VOICE_IDS']),
    naijaLingoResponseFormat: optional(env['NAIJALINGO_RESPONSE_FORMAT']),
    naijaLingoVoiceByLanguage: optional(env['NAIJALINGO_VOICE_BY_LANGUAGE']),
    naijaLingoWarmAlwaysOn: optional(env['NAIJALINGO_WARM_ALWAYS_ON']),
    naijaLingoWarmIntervalMs: optional(env['NAIJALINGO_WARM_INTERVAL_MS']),
    naijaLingoWarmIdleAfterMs: optional(env['NAIJALINGO_WARM_IDLE_AFTER_MS']),
    azureSpeechKey: optional(env['AZURE_SPEECH_KEY']),
    azureSpeechRegion: optional(env['AZURE_SPEECH_REGION']),
    azureVoiceIds: optional(env['AZURE_VOICE_IDS']),
    azureDefaultVoiceId: optional(env['AZURE_DEFAULT_VOICE_ID']),
    elevenLabsApiKey: optional(env['ELEVENLABS_API_KEY']),
    elevenLabsModel: optional(env['ELEVENLABS_MODEL']),
    elevenLabsVoiceId: optional(env['ELEVENLABS_DEFAULT_VOICE_ID']),
    elevenLabsVoiceIds: optional(env['ELEVENLABS_VOICE_IDS']),
  };
}

function requireCredential(value: string | undefined, name: string, provider: string): string {
  if (value === undefined || value === '') {
    throw new Error(
      `${provider} is selected for the live path but ${name} is not set. ` +
        'Set it, or set the provider to "off" to keep the batch route.',
    );
  }
  return value;
}

export function buildStreamingTranscriptionProvider(
  config: Pick<IngestConfig, 'streamingTranscriptionProvider'>,
  env: LiveProviderEnv = readLiveProviderEnv(),
): StreamingTranscriptionProvider | null {
  switch (config.streamingTranscriptionProvider) {
    case 'off':
      return null;
    case 'mock':
      return new MockStreamingTranscriptionProvider();
    case 'deepgram-nova': {
      const nova: DeepgramNovaStreamingConfig = {
        apiKey: requireCredential(env.deepgramApiKey, 'DEEPGRAM_API_KEY', 'deepgram-nova'),
        model: env.deepgramModel ?? 'nova-3',
        sockets: createDeepgramWebSocketFactory(WebSocket),
      };
      return new DeepgramNovaStreamingProvider(nova);
    }
    case 'deepgram-flux': {
      const flux: DeepgramFluxStreamingConfig = {
        apiKey: requireCredential(env.deepgramApiKey, 'DEEPGRAM_API_KEY', 'deepgram-flux'),
        model: env.deepgramModel ?? 'flux-general-en',
        sockets: createDeepgramWebSocketFactory(WebSocket),
      };
      return new DeepgramFluxStreamingProvider(flux);
    }
  }
}

export function buildStreamingSynthesisProvider(
  config: Pick<IngestConfig, 'streamingSynthesisProvider'>,
  env: LiveProviderEnv = readLiveProviderEnv(),
): StreamingSpeechSynthesisProvider | null {
  return buildLiveSynthesis(config, env).provider;
}

/** The synthesis provider AND what it will honestly say about ha/ig/yo/pcm. */
export interface LiveSynthesis {
  readonly provider: StreamingSpeechSynthesisProvider | null;
  /**
   * Null only when synthesis is off entirely. Otherwise it always answers,
   * including when the specialist is absent -- "no key" is a state to report,
   * not a reason to report nothing.
   */
  readonly nigerian: {
    state(): NigerianSynthesisState;
    recordPreflight(preflight: NaijaLingoPreflight): void;
  } | null;
}

/**
 * Everything the live path needs to synthesise, in one call.
 *
 * SEPARATE FROM `buildStreamingSynthesisProvider` so that the many callers who
 * only ever wanted a provider keep the signature they had, while the boot path
 * -- the one place that has to report the truth about these four languages on
 * /health -- can reach the state as well.
 */
export function buildLiveSynthesis(
  config: Pick<IngestConfig, 'streamingSynthesisProvider'>,
  env: LiveProviderEnv = readLiveProviderEnv(),
  /**
   * The transport for EVERY vendor in this chain, and it exists for one reason.
   *
   * The specialist warms itself up the moment it is built -- that is what stops
   * the first Yoruba sentence of a session being served by the vendor that
   * mispronounces it -- and a warm-up is a real request. Without an injection
   * point, merely constructing this in a test would reach the vendor, which
   * these lanes forbid and which would make the suite depend on somebody else's
   * uptime. Production passes nothing and gets `fetch`.
   *
   * IT REACHED ONLY THE SPECIALIST UNTIL NOW, and the consequence was exactly
   * what the paragraph above says must not happen: a test that made the
   * specialist fail fell through to the general chain, which used the global
   * fetch and made a real request to ElevenLabs with a fixture key. It passed,
   * slowly, and then timed out under load in a full run -- a flake whose real
   * cause was an outbound call nobody meant to make.
   */
  fetchImpl?: typeof fetch,
): LiveSynthesis {
  const general = buildGeneralSynthesis(config, env, fetchImpl);
  if (general === null) return { provider: null, nigerian: null };
  return withNigerianSpecialist(general, env, fetchImpl);
}

/**
 * Run the vendor preflight for THIS deployment's configuration.
 *
 * Exported so the boot path and any operational check ask the same question of
 * the same values. Never throws, never names a value: an absent key is reported
 * as absent rather than as a rejected request, because those need opposite
 * actions and a log line that confuses them costs an afternoon.
 */
export async function preflightNigerianSpecialist(
  env: LiveProviderEnv = readLiveProviderEnv(),
  fetchImpl?: typeof fetch,
): Promise<NaijaLingoPreflight> {
  return preflightNaijaLingo({
    baseUrl: env.naijaLingoBaseUrl,
    apiKey: env.naijaLingoApiKey,
    authHeaderName: env.naijaLingoAuthHeader,
    authScheme: env.naijaLingoAuthScheme,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

export { describeNaijaLingoPreflight };

function parseResponseFormat(raw: string | undefined): NaijaLingoResponseFormat | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'wav' || value === 'pcm') return value;
  throw new Error(
    `NAIJALINGO_RESPONSE_FORMAT must be 'wav' or 'pcm'; got '${value}'. Leave it unset for wav, ` +
      'which declares its own sample rate in its RIFF header and so needs nothing configured.',
  );
}

/**
 * Hausa, Igbo, Yoruba and Nigerian Pidgin go to the specialist; everything else
 * carries on exactly as before.
 *
 * WHY THIS WRAPS RATHER THAN JOINS THE SWITCH. The general vendors are chosen
 * for coverage across ninety languages, and the specialist covers four. Adding
 * it as another `case` would make it a whole-deployment choice and force a
 * deployment to pick between good Yoruba and good everything-else. Routing is
 * per language, so both are true at once.
 *
 * THE CHAIN IS 9jaLINGO, THEN AZURE, THEN NOTHING. Founder ruling of
 * 2026-08-30, and it is narrower than what this file used to do -- it put the
 * whole general chain behind the specialist, leaving ElevenLabs in it.
 * ElevenLabs answers these languages with confident, wrong audio, so its
 * presence bought a second wrong rendering rather than a second chance. The
 * language list and the fallback id both come from `ai-registry`; nothing here
 * restates them.
 *
 * ACTIVATION IS ONE VARIABLE, and that is a correction. This function used to
 * require NAIJALINGO_BASE_URL as well, which was right while the host was
 * unknown and became wrong the moment the vendor's own SDK published it: it
 * turned a solved problem into a second thing an operator could get wrong on
 * the night of a demo. Paste NAIJALINGO_API_KEY; everything else has a
 * published default and an override.
 */
/**
 * A positive millisecond count from an environment string, or the default.
 *
 * Zero or negative would make `setInterval` a busy loop against somebody
 * else's API, and a typo must not be able to do that.
 */
function readPositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withNigerianSpecialist(
  general: StreamingSpeechSynthesisProvider,
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): LiveSynthesis {
  /*
   * AZURE OR NOTHING, decided before the specialist is even built.
   *
   * A deployment with no Azure credential gets a one-provider chain rather than
   * the general chain, because the alternative is ElevenLabs quietly inheriting
   * these four languages -- which is precisely the outcome the ruling forbids.
   * Silence is a worse listener experience than mispronunciation, but a THIRD
   * vendor nobody chose is worse than either, because nobody would know.
   */
  const azure = env.azureSpeechKey === undefined ? null : buildAzureSynthesis(env);
  const apiKey = env.naijaLingoApiKey;

  if (apiKey === undefined) {
    /*
     * ON THE RECORD AND AT WARN, and the level is the decision.
     *
     * The previous revision logged this at info, reasoning that running without
     * a specialist was a settled commercial choice. The founder ruling of
     * 2026-08-30 reverses that: 9jaLingo is to be ACTIVE, so its absence is now
     * a deviation from the intended configuration rather than the intended
     * configuration. It is also the single most likely reason an investor
     * demo's Yoruba sounds wrong, and a line nobody sees is a line that does
     * not exist.
     */
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        service: 'media-ingest',
        level: 'warn',
        message:
          'NAIJALINGO_API_KEY is not set: the Nigerian-language specialist is OFF and every ' +
          'ha/ig/yo/pcm sentence is a DEGRADED rendering by the fallback, which returns 200 ' +
          'and mispronounces them. Only a speaker of the language can hear it.',
        languages: NIGERIAN_SPECIALIST_LANGUAGES,
        servedBy: azure === null ? general.name : NIGERIAN_FALLBACK_PROVIDER_ID,
      }),
    );

    const nigerianState = absentSpecialistState();
    let recorded: NaijaLingoPreflight | null = null;

    /*
     * STILL ROUTED, even with no specialist. These languages go to the named
     * fallback rather than to the general chain, so that switching the key on
     * later changes WHO answers and nothing else about the path.
     */
    const provider =
      azure === null
        ? general
        : createLanguageRoutedSynthesisProvider({
            routes: new Map(NIGERIAN_SPECIALIST_LANGUAGES.map((language) => [language, azure])),
            fallback: general,
          });

    return {
      provider,
      nigerian: {
        state: () => ({
          ...nigerianState,
          preflight: recorded,
        }),
        recordPreflight: (preflight) => {
          recorded = preflight;
        },
      },
    };
  }

  const responseFormat = parseResponseFormat(env.naijaLingoResponseFormat);
  const sampleRate = env.naijaLingoSampleRate === undefined
    ? undefined
    : Number(env.naijaLingoSampleRate);

  const specialist = new NaijaLingoStreamingSynthesisProvider({
    apiKey,
    /*
     * Undefined means "use the vendor's published host". Passing the raw
     * optional through is deliberate: an empty NAIJALINGO_BASE_URL= line in a
     * template is the NORMAL state of an unconfigured box, and `optional`
     * already turned it into undefined.
     */
    baseUrl: env.naijaLingoBaseUrl,
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    /*
     * A PUBLISHED SPEAKER ID, not a required variable. The SDK's README lists
     * an example speaker per language, so a default is evidence rather than a
     * guess -- and the preflight lists what this key can actually use, which is
     * the honest check that a default cannot provide. Overridable per language
     * and per platform voice.
     */
    defaultVoice: env.naijaLingoDefaultVoice ?? NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE['yo'] ?? '',
    defaultVoiceByLanguage: {
      // Published example, then the founder's chosen voice, then the
      // deployment's own word: each layer only speaks where the next has
      // nothing to say.
      ...NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
      ...NAIJALINGO_SELECTED_VOICE_BY_LANGUAGE,
      ...parseVoiceIdMap(env.naijaLingoVoiceByLanguage),
    },
    authHeaderName: env.naijaLingoAuthHeader,
    authScheme: env.naijaLingoAuthScheme,
    model: env.naijaLingoModel,
    // `<language>:<gender>` reaches either voice of a chosen pair; the
    // account already records a person's voiceGender, and wiring that
    // preference through to synthesis is the remaining seam.
    voiceIds: { ...NAIJALINGO_SELECTED_VOICE_IDS, ...parseVoiceIdMap(env.naijaLingoVoiceIds) },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  /*
   * Warmed at wiring time, not at first use. The capacity behind this vendor
   * scales to zero and takes minutes to come back, so the first Nigerian-
   * language sentence after an idle period would otherwise be served by the
   * fallback that mispronounces it. Nothing waits on this.
   */
  specialist.warmUp();

  /*
   * AND KEEP IT AWAKE. One warm-up at boot is not enough on its own: the
   * capacity behind this vendor scales back to zero after an idle period, so a
   * service that started this morning is cold again by the afternoon.
   *
   * MEASURED, 31 Aug 2026. A programme was uploaded to staging and all twelve
   * segments -- ha, ig and yo -- were spoken by the fallback. `GET /v1/health`
   * said `engine_ready: false, status: starting` and synthesis answered 503
   * "capacity is starting after an idle period, retry in about 5 minutes". The
   * routing, the labelling and the audio were all correct; the specialist was
   * simply asleep, and the founder heard Azure's Yoruba.
   *
   * `createWarmKeeper` was written for exactly this and nothing had ever
   * imported it. It is wired here, at the one place that holds the specialist.
   */
  const warmKeeper = createWarmKeeper({
    warm: () => specialist.warmUp(),
    intervalMs: readPositiveMs(env.naijaLingoWarmIntervalMs, 4 * 60_000),
    // Comfortably longer than a programme, so a session cannot go cold beneath
    // itself between one segment and the next.
    idleAfterMs: readPositiveMs(env.naijaLingoWarmIdleAfterMs, 45 * 60_000),
    alwaysOn: (env.naijaLingoWarmAlwaysOn ?? '').trim().toLowerCase() === 'true',
  });

  /*
   * Said at boot, because "always-on" is the difference between a demo that
   * sounds right and one that does not, and it is invisible otherwise.
   */
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: 'media-ingest',
      message: 'Nigerian specialist warm-keeper ready',
      alwaysOn: warmKeeper.active,
      note: warmKeeper.active
        ? 'capacity kept awake continuously'
        : 'warms only while in use; the FIRST sentence after an idle period may be a ' +
          'degraded fallback. Set NAIJALINGO_WARM_ALWAYS_ON=true before a demo.',
    }),
  );

  if (azure === null) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        service: 'media-ingest',
        level: 'warn',
        message:
          'AZURE_SPEECH_KEY is not set: the Nigerian-language chain has no fallback, so a cold ' +
          'or failing specialist means SILENCE in ha/ig/yo/pcm rather than a degraded voice.',
        languages: NIGERIAN_SPECIALIST_LANGUAGES,
      }),
    );
  }

  const route = createNigerianSynthesisRoute({
    specialist,
    // Azure by name. NULL when it is absent, so the chain is the specialist
    // alone -- honest about there being nothing behind it, and never calling a
    // cold vendor twice for one sentence.
    fallback: azure,
    onOutcome: (outcome) => {
      // Demand, observed rather than guessed: this fires once per sentence the
      // specialist was asked for, whether or not it answered. A cold vendor is
      // exactly when keeping the pings going matters most.
      warmKeeper.noteUsed();
      if (outcome.degradation !== null) {
        /*
         * WARN, NAMING THE LANGUAGE AND THE REASON. This is the line the whole
         * wave exists to produce. Silence here is the failure: the audio plays,
         * every server signal is green, and the only person who can tell is a
         * speaker of the language who is not reading logs.
         */
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            service: 'media-ingest',
            level: 'warn',
            message: 'DEGRADED Nigerian-language synthesis: the specialist did not answer',
            language: outcome.degradation.language,
            expectedProvider: outcome.degradation.expectedProvider,
            servedBy: outcome.degradation.servedBy,
            reason: outcome.degradation.reason,
          }),
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          service: 'media-ingest',
          message: 'Nigerian-language synthesis served',
          language: outcome.language,
          rendering: outcome.rendering,
          servedBy: outcome.servedBy,
          fellThrough: outcome.fellThrough,
        }),
      );
    },
  });

  const routes = new Map<string, StreamingSpeechSynthesisProvider>(
    NIGERIAN_SPECIALIST_LANGUAGES.map((language) => [language, route.provider]),
  );

  return {
    provider: createLanguageRoutedSynthesisProvider({
      routes,
      fallback: general,
      onRoute: (observation) => {
        if (observation.matchedLanguage === null) return;
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            service: 'media-ingest',
            message: 'Routed to language specialist',
            language: observation.matchedLanguage,
            servedBy: observation.servedBy,
          }),
        );
      },
    }),
    nigerian: route,
  };
}

function buildGeneralSynthesis(
  config: Pick<IngestConfig, 'streamingSynthesisProvider'>,
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): StreamingSpeechSynthesisProvider | null {
  switch (config.streamingSynthesisProvider) {
    case 'off':
      return null;
    case 'mock':
      return new MockStreamingSynthesisProvider();
    case 'azure':
      return buildAzureSynthesis(env, fetchImpl);
    /*
     * ELEVENLABS FIRST, AZURE BEHIND IT. The order is a cost and latency
     * decision the deployment can revisit by swapping this list -- what it must
     * not become is a silent preference expressed in five places.
     */
    case 'chain':
      return createFallbackSpeechSynthesisProvider({
        providers: [buildElevenLabsSynthesis(env, fetchImpl), buildAzureSynthesis(env, fetchImpl)],
        onObservation: (observation) => {
          /*
           * Logged EVERY time, not only on failure. A chain that works hides an
           * outage -- the listener hears audio either way, so a primary that has
           * quietly stopped answering is invisible until the bill or the latency
           * changes.
           */
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              service: 'media-ingest',
              message: 'Synthesis served',
              servedBy: observation.servedBy,
              fellThrough: observation.fellThrough,
              timeToFirstChunkMs: observation.timeToFirstChunkMs,
              /*
               * BOTH CLOCKS, because they disagree exactly when it matters.
               * `timeToFirstChunkMs` starts at the SERVING provider; during a
               * measured fall-through it read 62 ms while the listener had
               * waited 527 ms. Logging only that one made a chain paying ~330 ms
               * for a failed primary look as fast as a healthy one.
               */
              listenerWaitedMs: observation.listenerWaitedMs,
            }),
          );
        },
      });
    case 'elevenlabs':
      return buildElevenLabsSynthesis(env);
  }
}

function buildAzureSynthesis(
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): StreamingSpeechSynthesisProvider {
  return new AzureStreamingSynthesisProvider({
    apiKey: requireCredential(env.azureSpeechKey, 'AZURE_SPEECH_KEY', 'azure'),
    region: requireCredential(env.azureSpeechRegion, 'AZURE_SPEECH_REGION', 'azure'),
    voiceIds: parseVoiceIdMap(env.azureVoiceIds),
    defaultVoiceId: requireCredential(
      env.azureDefaultVoiceId,
      'AZURE_DEFAULT_VOICE_ID',
      'azure',
    ),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

function buildElevenLabsSynthesis(
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): StreamingSpeechSynthesisProvider {
  const voiceId = requireCredential(
    env.elevenLabsVoiceId,
    'ELEVENLABS_DEFAULT_VOICE_ID',
    'elevenlabs',
  );
  const eleven: ElevenLabsTtsConfig = {
    apiKey: requireCredential(env.elevenLabsApiKey, 'ELEVENLABS_API_KEY', 'elevenlabs'),
    modelId: env.elevenLabsModel ?? 'eleven_flash_v2_5',
    // The platform's voice ids map to the vendor's HERE. A vendor id reaching a
    // session config would make the vendor's catalogue into Videofy's voice
    // identity.
    //
    // Empty means every voice becomes defaultVoiceId, which silently discards
    // the speaker's male/female choice and gives every participant the same
    // voice in every language.
    voiceIds: parseVoiceIdMap(env.elevenLabsVoiceIds),
    defaultVoiceId: voiceId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
  return new ElevenLabsStreamingSynthesisProvider(eleven);
}

/** What is actually behind a live call's translation, in words an operator can act on. */
export interface LiveEngineDescription {
  readonly transcription: string;
  readonly synthesis: string;
  readonly translation: string;
  /**
   * True only when speech genuinely becomes recognised text, translated text
   * and spoken audio. Anything mocked or switched off makes this false.
   */
  readonly real: boolean;
  /** Empty when `real`. Otherwise what is standing in for a real provider. */
  readonly stubbed: readonly string[];
}

/**
 * Whether this deployment can actually translate speech.
 *
 * The mock providers exist for tests and local work, and they are convincing
 * from the outside: sessions open, health is green, no error is logged
 * anywhere. A staging box configured this way accepted audio for weeks while
 * the call surface said "Hearing translated voice" and produced silence. The
 * providers were not broken -- there simply were none, and nothing in the
 * running system ever said so.
 *
 * So the truth is computed in one place and reported in three: the startup
 * log, /health, and (through the gateway) the participants themselves. A
 * product that cannot translate must say so rather than present silence as
 * translation.
 */
export function describeLiveEngine(
  config: Pick<
    IngestConfig,
    'streamingTranscriptionProvider' | 'streamingSynthesisProvider' | 'translationProvider'
  >,
): LiveEngineDescription {
  const transcription = config.streamingTranscriptionProvider;
  const synthesis = config.streamingSynthesisProvider;
  const translation = config.translationProvider;

  const stubbed: string[] = [];
  if (transcription === 'mock' || transcription === 'off') {
    stubbed.push(`speech recognition (${transcription})`);
  }
  if (synthesis === 'mock' || synthesis === 'off') {
    stubbed.push(`speech synthesis (${synthesis})`);
  }
  if (translation === 'mock') stubbed.push('translation (mock)');

  return {
    transcription,
    synthesis,
    translation,
    real: stubbed.length === 0,
    stubbed,
  };
}
