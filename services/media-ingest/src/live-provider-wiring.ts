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
import { GoogleCloudSttStreamingProvider } from './providers/google/streaming-stt.js';
import { AzureStreamingSynthesisProvider } from './providers/azure/streaming-tts.js';
import { createFallbackSpeechSynthesisProvider } from './fallback-speech-synthesis-provider.js';
import { createLanguageRoutedTranscriptionProvider } from './language-routed-transcription-provider.js';
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
  type NigerianVoicePreflight,
} from './nigerian-synthesis-route.js';
import { createLanguageRoutedSynthesisProvider } from './language-routed-synthesis-provider.js';
import { createWarmKeeper, type WarmKeeper } from './providers/naijalingo/warm-keeper.js';
import {
  describeNigerianVoicePreflight,
  preflightElevenLabsVoices,
} from './providers/elevenlabs/preflight.js';
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
  NIGERIAN_SPECIALIST_PROVIDER_ID,
  NIGERIAN_TTS_ROUTE_ORDER,
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
  type StreamingSynthesisOptions,
  type StreamingSynthesisResult,
} from './streaming-speech-synthesis-provider.js';
import { WebSocket } from 'ws';
import { createDeepgramWebSocketFactory } from './providers/deepgram/transport.js';
import type { IngestConfig } from './config.js';

export interface LiveProviderEnv {
  readonly deepgramApiKey?: string | undefined;
  readonly deepgramModel?: string | undefined;
  readonly googleSttProjectId?: string | undefined;
  readonly googleSttLocation?: string | undefined;
  readonly googleSttRecognizer?: string | undefined;
  readonly googleSttModel?: string | undefined;
  readonly googleCloudQuotaProject?: string | undefined;
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
    googleSttProjectId: optional(env['GOOGLE_STT_PROJECT_ID']),
    googleSttLocation: optional(env['GOOGLE_STT_LOCATION']),
    googleSttRecognizer: optional(env['GOOGLE_STT_RECOGNIZER']),
    googleSttModel: optional(env['GOOGLE_STT_MODEL']),
    googleCloudQuotaProject: optional(env['GOOGLE_CLOUD_QUOTA_PROJECT']),
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
    case 'deepgram-nova':
      return buildDeepgramNovaTranscription(env, 'deepgram-nova');
    case 'deepgram-flux':
      return buildDeepgramFluxTranscription(env, 'deepgram-flux');
    case 'deepgram-google-stt': {
      const deepgram = buildDeepgramGeneralTranscription(env, 'deepgram-google-stt');
      const google = new GoogleCloudSttStreamingProvider({
        projectId: requireCredential(
          env.googleSttProjectId,
          'GOOGLE_STT_PROJECT_ID',
          'deepgram-google-stt',
        ),
        location: requireCredential(
          env.googleSttLocation,
          'GOOGLE_STT_LOCATION',
          'deepgram-google-stt',
        ),
        recognizer: requireCredential(
          env.googleSttRecognizer,
          'GOOGLE_STT_RECOGNIZER',
          'deepgram-google-stt',
        ),
        model: requireCredential(env.googleSttModel, 'GOOGLE_STT_MODEL', 'deepgram-google-stt'),
        quotaProjectId: env.googleCloudQuotaProject ?? null,
      });
      return createLanguageRoutedTranscriptionProvider({ deepgram, google });
    }
  }
}

function buildDeepgramNovaTranscription(
  env: LiveProviderEnv,
  selector: string,
): DeepgramNovaStreamingProvider {
  const nova: DeepgramNovaStreamingConfig = {
    apiKey: requireCredential(env.deepgramApiKey, 'DEEPGRAM_API_KEY', selector),
    model: env.deepgramModel ?? 'nova-3',
    sockets: createDeepgramWebSocketFactory(WebSocket),
  };
  return new DeepgramNovaStreamingProvider(nova);
}

function buildDeepgramFluxTranscription(
  env: LiveProviderEnv,
  selector: string,
): DeepgramFluxStreamingProvider {
  const flux: DeepgramFluxStreamingConfig = {
    apiKey: requireCredential(env.deepgramApiKey, 'DEEPGRAM_API_KEY', selector),
    model: env.deepgramModel ?? 'flux-general-en',
    sockets: createDeepgramWebSocketFactory(WebSocket),
  };
  return new DeepgramFluxStreamingProvider(flux);
}

function buildDeepgramGeneralTranscription(
  env: LiveProviderEnv,
  selector: string,
): StreamingTranscriptionProvider {
  if ((env.deepgramModel ?? '').startsWith('flux')) {
    return buildDeepgramFluxTranscription(env, selector);
  }
  return buildDeepgramNovaTranscription(env, selector);
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
    recordPreflight(preflight: NigerianVoicePreflight): void;
    /**
     * Whether capacity is being kept awake continuously.
     *
     * ITS OWN FACT, not folded into health. A scale-to-zero deployment is
     * healthy when probed -- the probe is what woke it -- and returns 503 to
     * the first real request after it has gone back to sleep. That request is
     * the one that opens a broadcast, so a readiness ladder that treated a
     * successful probe as warmth would report the very deployment that fails a
     * demo as ready.
     */
    readonly warm: boolean;
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
 *
 * IT ASKS WHOEVER IS APPROVED, not a fixed vendor, and that is the fix. It used
 * to ask 9jaLingo unconditionally, so after the 2026-09-18 ruling the boot log
 * would have reported at length on the health of a vendor no sentence could
 * reach -- a check that verifies nothing, stated confidently, which the memory
 * already records as its own class of defect.
 */
export async function preflightNigerianSpecialist(
  env: LiveProviderEnv = readLiveProviderEnv(),
  fetchImpl?: typeof fetch,
): Promise<NigerianVoicePreflight> {
  if (NIGERIAN_SPECIALIST_PROVIDER_ID === 'naijalingo') {
    const preflight = await preflightNaijaLingo({
      baseUrl: env.naijaLingoBaseUrl,
      apiKey: env.naijaLingoApiKey,
      authHeaderName: env.naijaLingoAuthHeader,
      authScheme: env.naijaLingoAuthScheme,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    // 9jaLingo's preflight DOES read the speaker catalogue, so that check
    // genuinely happened when this vendor is the one selected.
    /*
     * 9jaLingo's preflight DOES read the speaker catalogue, and it has no
     * synthesis probe of its own -- so "can it speak" is honestly unknown
     * here rather than assumed. Null, never true: this vendor is not the one
     * that silently stopped speaking on 2 Oct 2026, and claiming a check
     * nobody ran is how the next one hides.
     */
    return {
      providerId: NIGERIAN_SPECIALIST_PROVIDER_ID,
      voiceCatalogueChecked: true,
      canSynthesise: null,
      synthesisProblem: null,
      ...preflight,
    };
  }

  return preflightElevenLabsVoices({
    apiKey: env.elevenLabsApiKey,
    defaultVoiceId: env.elevenLabsVoiceId,
    mappedVoiceIds: Object.values(parseVoiceIdMap(env.elevenLabsVoiceIds)),
    languages: NIGERIAN_SPECIALIST_LANGUAGES,
    providerId: NIGERIAN_SPECIALIST_PROVIDER_ID,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

export { describeNaijaLingoPreflight, describeNigerianVoicePreflight };

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
 * Hausa, Igbo, Yoruba and Nigerian Pidgin go to the APPROVED voice; everything
 * else carries on exactly as before.
 *
 * WHY THIS WRAPS RATHER THAN JOINS THE SWITCH. The general vendors are chosen
 * for coverage across ninety languages, and the approved Nigerian voice is a
 * per-language decision. Adding it as another `case` would make it a
 * whole-deployment choice and force a deployment to pick between good Yoruba
 * and good everything-else. Routing is per language, so both are true at once.
 *
 * WHO THE APPROVED VOICE IS COMES FROM `ai-registry`, AND THAT IS THE FIX HERE.
 * This function used to name 9jaLingo and Azure itself while its own comment
 * claimed "nothing here restates them" -- the LANGUAGES were imported and the
 * VENDOR was restated. So the founder ruling of 2026-09-18, which made
 * ElevenLabs the approved voice, changed the constant, passed every test, was
 * deployed, and moved nothing: production went on speaking Yoruba with the
 * vendor the ruling had just rejected. That is the unwired-seam pattern in its
 * purest form, and the whole point of reading `NIGERIAN_TTS_ROUTE_ORDER` below
 * is that there is now exactly one place to change.
 *
 * SILENCE IS AN OUTCOME THIS IS ALLOWED TO PRODUCE. With the approved voice
 * unconfigured, these four languages are NOT quietly handed to a general vendor
 * -- they fail, loudly and by name. Audio that plays and mispronounces the
 * language is worse than no audio, because only a speaker can hear it and
 * every server signal says success.
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

/**
 * A vendor this service knows how to build for the Nigerian languages.
 *
 * A MAP, not a branch, because the entry that matters is the one that is NOT
 * currently selected. `NIGERIAN_SPECIALIST_PROVIDER_ID` has changed once
 * already and the change did not reach this file; the only structure that
 * makes the next change reach it is one where selecting a vendor is a lookup
 * rather than an edit.
 */
interface NigerianVoiceBuild {
  readonly provider: StreamingSpeechSynthesisProvider;
  /**
   * Non-null ONLY for a vendor whose capacity scales to zero.
   *
   * It is not a general nicety. A keeper against a vendor that is always up is
   * an unread request every four minutes on somebody's bill, forever, and it
   * would report warmth as something this deployment achieved rather than
   * something the vendor never lacked.
   */
  readonly warmKeeper: WarmKeeper | null;
}

interface NigerianVoiceVendor {
  /** Every variable that must be set. NAMED in warnings, never valued. */
  readonly requires: readonly string[];
  readonly configured: (env: LiveProviderEnv) => boolean;
  readonly build: (env: LiveProviderEnv, fetchImpl?: typeof fetch) => NigerianVoiceBuild;
}

export const NIGERIAN_VOICE_VENDORS: Readonly<Record<string, NigerianVoiceVendor>> = {
  /*
   * THE APPROVED VOICE SINCE 2026-09-18. The founder listened to it speak
   * Hausa, Igbo and Yoruba and judged it better than the previous specialist.
   * That is a qualification decision made by a person, which is the only kind
   * this repository accepts for these four languages -- no endpoint can make
   * it, because every vendor returns 200 either way.
   */
  elevenlabs: {
    requires: ['ELEVENLABS_API_KEY', 'ELEVENLABS_DEFAULT_VOICE_ID'],
    configured: (env) => env.elevenLabsApiKey !== undefined && env.elevenLabsVoiceId !== undefined,
    build: (env, fetchImpl) => ({
      /*
       * ITS OWN INSTANCE, deliberately not the general chain -- even though the
       * general chain usually starts with this same vendor. The general chain
       * falls through to Azure, and Azure speaking Yoruba is the exact outcome
       * the ruling forbids. Sharing the object would make these four languages
       * inherit a fall-through nobody chose for them.
       */
      provider: buildElevenLabsSynthesis(env, fetchImpl),
      warmKeeper: null,
    }),
  },

  /*
   * NEVER SELECTED TODAY, and kept buildable on purpose. Azure is the vendor
   * `isDegradedNigerianSynthesis` exists to RECOGNISE: it returns 200 and
   * plausible audio and pronounces these languages wrongly. Keeping it here
   * costs nothing and means a future ruling that puts a second entry in
   * `NIGERIAN_TTS_ROUTE_ORDER` is a one-line change rather than a rewrite.
   */
  azure: {
    requires: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'AZURE_DEFAULT_VOICE_ID'],
    configured: (env) =>
      env.azureSpeechKey !== undefined &&
      env.azureSpeechRegion !== undefined &&
      env.azureDefaultVoiceId !== undefined,
    build: (env, fetchImpl) => ({
      provider: buildAzureSynthesis(env, fetchImpl),
      warmKeeper: null,
    }),
  },

  /*
   * THE PREVIOUS SPECIALIST, KEPT AND UNROUTED -- a deliberate decision, not
   * an oversight.
   *
   * The founder ruling of 2026-09-18 is that it does not work, so nothing
   * reaches it while `NIGERIAN_SPECIALIST_PROVIDER_ID` names another vendor.
   * The adapter, its warm keeper and its preflight stay because they are the
   * only working implementation this repository has of a vendor whose capacity
   * SCALES TO ZERO, and that shape is not hypothetical: it cost a measured
   * staging programme on 2026-08-31, when every routing decision was correct
   * and the founder still heard the wrong voice for five minutes. Deleting it
   * would delete the lesson along with the code.
   */
  naijalingo: {
    requires: ['NAIJALINGO_API_KEY'],
    configured: (env) => env.naijaLingoApiKey !== undefined,
    build: buildNaijaLingoVoice,
  },
};

type NigerianVoiceSelection =
  | { readonly kind: 'built'; readonly build: NigerianVoiceBuild }
  | { readonly kind: 'unconfigured'; readonly missing: readonly string[] };

/**
 * Build the vendor the ruling names, or say exactly what is missing.
 *
 * A NAMED VENDOR THIS SERVICE CANNOT BUILD THROWS, and that is the file's rule
 * rather than an exception to it: an unknown id is a programming error --
 * somebody changed the constant and did not add the builder -- and the failure
 * mode of tolerating it is these four languages silently rejoining the general
 * chain, which is the defect this whole seam exists to close.
 */
export function selectNigerianVoice(
  providerId: string,
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): NigerianVoiceSelection {
  const vendor = NIGERIAN_VOICE_VENDORS[providerId];
  if (vendor === undefined) {
    throw new Error(
      `ai-registry names '${providerId}' as the approved voice for ` +
        `${NIGERIAN_SPECIALIST_LANGUAGES.join('/')}, but media-ingest has no builder for it. ` +
        `Add one to NIGERIAN_VOICE_VENDORS; known: ${Object.keys(NIGERIAN_VOICE_VENDORS).join(', ')}.`,
    );
  }
  if (!vendor.configured(env)) {
    return { kind: 'unconfigured', missing: vendor.requires };
  }
  return { kind: 'built', build: vendor.build(env, fetchImpl) };
}

/**
 * What stands behind the approved voice, read from the ruling's own order.
 *
 * NULL IS THE CORRECT ANSWER TODAY. `NIGERIAN_TTS_ROUTE_ORDER` has one entry,
 * so there is nothing behind it and silence is the intended outcome when it
 * cannot answer. An entry that IS named but not configured is different and is
 * warned about: that one is a deployment mistake.
 */
function buildNigerianChainBehind(
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): StreamingSpeechSynthesisProvider | null {
  const behind: StreamingSpeechSynthesisProvider[] = [];
  for (const providerId of NIGERIAN_TTS_ROUTE_ORDER.slice(1)) {
    const selection = selectNigerianVoice(providerId, env, fetchImpl);
    if (selection.kind === 'unconfigured') {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          service: 'media-ingest',
          level: 'warn',
          message:
            'a vendor named in NIGERIAN_TTS_ROUTE_ORDER is not configured, so it is missing from ' +
            'the chain behind the approved voice',
          providerId,
          requires: selection.missing,
        }),
      );
      continue;
    }
    behind.push(selection.build.provider);
  }
  if (behind.length === 0) return null;
  if (behind.length === 1) return behind[0] ?? null;
  return createFallbackSpeechSynthesisProvider({ providers: behind });
}

/**
 * The provider these four languages get when the approved voice is unavailable:
 * one that refuses, by name, and produces no audio.
 *
 * IT IS NOT A BUG THAT THIS MAKES A SENTENCE FAIL. The alternative that was
 * here until 2026-09-18 handed the sentence to Azure, which spoke it fluently
 * and wrongly and reported success to every signal a server has. A failure
 * somebody can read beats a success nobody can check.
 */
function refusingNigerianVoice(
  providerId: string,
  missing: readonly string[],
): StreamingSpeechSynthesisProvider {
  const reason =
    `${providerId} is the approved voice for ${NIGERIAN_SPECIALIST_LANGUAGES.join('/')} but ` +
    `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, and ` +
    `${NIGERIAN_FALLBACK_PROVIDER_ID} is not permitted to speak these languages`;
  return {
    name: `nigerian(NO APPROVED VOICE: ${providerId} unconfigured)`,
    async synthesize(request: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
      request.onError(new Error(`${reason}. This sentence was NOT spoken.`));
      // Zero samples is a failure by this contract's own definition, which is
      // what makes it visible upstream rather than a quiet gap in the audio.
      return { samples: 0, timeToFirstChunkMs: null, totalMs: 0, aborted: false };
    },
  };
}

/** The previous specialist, with the warm keeper its scale-to-zero capacity needs. */
function buildNaijaLingoVoice(env: LiveProviderEnv, fetchImpl?: typeof fetch): NigerianVoiceBuild {
  const apiKey = env.naijaLingoApiKey ?? '';
  const responseFormat = parseResponseFormat(env.naijaLingoResponseFormat);
  const sampleRate =
    env.naijaLingoSampleRate === undefined ? undefined : Number(env.naijaLingoSampleRate);

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
    defaultVoice: env.naijaLingoDefaultVoice ?? NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE['yo'] ?? '',
    defaultVoiceByLanguage: {
      ...NAIJALINGO_PUBLISHED_SPEAKER_BY_LANGUAGE,
      ...NAIJALINGO_SELECTED_VOICE_BY_LANGUAGE,
      ...parseVoiceIdMap(env.naijaLingoVoiceByLanguage),
    },
    authHeaderName: env.naijaLingoAuthHeader,
    authScheme: env.naijaLingoAuthScheme,
    model: env.naijaLingoModel,
    voiceIds: { ...NAIJALINGO_SELECTED_VOICE_IDS, ...parseVoiceIdMap(env.naijaLingoVoiceIds) },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

  // Warmed at wiring time, not at first use: the capacity behind this vendor
  // scales to zero and takes minutes to come back.
  specialist.warmUp();

  const warmKeeper = createWarmKeeper({
    warm: () => specialist.warmUp(),
    intervalMs: readPositiveMs(env.naijaLingoWarmIntervalMs, 4 * 60_000),
    // Comfortably longer than a programme, so a session cannot go cold beneath
    // itself between one segment and the next.
    idleAfterMs: readPositiveMs(env.naijaLingoWarmIdleAfterMs, 45 * 60_000),
    alwaysOn: (env.naijaLingoWarmAlwaysOn ?? '').trim().toLowerCase() === 'true',
  });

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

  return { provider: specialist, warmKeeper };
}

function withNigerianSpecialist(
  general: StreamingSpeechSynthesisProvider,
  env: LiveProviderEnv,
  fetchImpl?: typeof fetch,
): LiveSynthesis {
  const providerId = NIGERIAN_SPECIALIST_PROVIDER_ID;
  const approved = selectNigerianVoice(providerId, env, fetchImpl);

  if (approved.kind === 'unconfigured') {
    /*
     * ON THE RECORD AND AT WARN, and the level is the decision. The approved
     * voice is the INTENDED configuration, so its absence is a deviation from
     * it rather than a settled commercial choice -- and it is the single most
     * likely reason a demo's Yoruba is missing. A line nobody sees is a line
     * that does not exist.
     */
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        service: 'media-ingest',
        level: 'warn',
        message:
          `the approved Nigerian voice (${providerId}) is NOT configured, so every ` +
          'ha/ig/yo/pcm sentence FAILS rather than being spoken. They are deliberately not ' +
          `routed to ${NIGERIAN_FALLBACK_PROVIDER_ID}, which returns 200 and mispronounces ` +
          'them in a way only a speaker of the language can hear.',
        languages: NIGERIAN_SPECIALIST_LANGUAGES,
        requires: approved.missing,
      }),
    );

    const nigerianState = absentSpecialistState();
    let recorded: NigerianVoicePreflight | null = null;
    const refusing = refusingNigerianVoice(providerId, approved.missing);

    return {
      /*
       * STILL ROUTED, even with no approved voice. These languages reach a
       * provider that refuses by name rather than the general chain, so that
       * configuring the credential later changes WHO answers and nothing else
       * about the path -- and so no general vendor inherits them by accident.
       */
      provider: createLanguageRoutedSynthesisProvider({
        routes: new Map(NIGERIAN_SPECIALIST_LANGUAGES.map((language) => [language, refusing])),
        fallback: general,
      }),
      nigerian: {
        state: () => ({ ...nigerianState, preflight: recorded }),
        recordPreflight: (preflight) => {
          recorded = preflight;
        },
        // Nothing is kept awake because there is nothing to keep awake.
        warm: false,
      },
    };
  }

  const { provider: approvedProvider, warmKeeper } = approved.build;
  const behind = buildNigerianChainBehind(env, fetchImpl);

  /*
   * Said at boot, because the whole chain for these four languages is otherwise
   * invisible until somebody speaks one of them -- which on most days is never,
   * and on the day it matters is in front of an audience.
   */
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: 'media-ingest',
      message: 'Nigerian-language chain ready',
      languages: NIGERIAN_SPECIALIST_LANGUAGES,
      approvedVoice: providerId,
      behind: behind?.name ?? null,
      note:
        behind === null
          ? `nothing stands behind ${providerId}: a failure is SILENCE, which the founder ruling ` +
            'of 2026-09-18 prefers to audio that mispronounces the language'
          : `a failure falls through to ${behind.name}, which is marked DEGRADED on every sentence`,
    }),
  );

  const route = createNigerianSynthesisRoute({
    specialist: approvedProvider,
    fallback: behind,
    onOutcome: (outcome) => {
      // Demand, observed rather than guessed: this fires once per sentence the
      // approved voice was asked for, whether or not it answered.
      warmKeeper?.noteUsed();
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
            message: 'DEGRADED Nigerian-language synthesis: the approved voice did not answer',
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
    nigerian: {
      state: () => route.state(),
      recordPreflight: (preflight) => route.recordPreflight(preflight),
      /*
       * TRUE WHEN THERE IS NOTHING TO BE COLD, and that is a claim rather than
       * a default. `liveRouteEligibility` blocks a live Nigerian route unless
       * warmth is guaranteed, so reporting false for a vendor that does not
       * scale to zero would block every Nigerian programme forever for a risk
       * that cannot occur. Where a keeper exists it answers instead -- warmth
       * has to come from the thing actually doing the keeping.
       */
      get warm() {
        return warmKeeper === null ? true : warmKeeper.active;
      },
    },
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
