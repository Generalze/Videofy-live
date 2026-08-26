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
  NAIJALINGO_LANGUAGES,
  NaijaLingoStreamingSynthesisProvider,
} from './providers/naijalingo/streaming-tts.js';
import { createLanguageRoutedSynthesisProvider } from './language-routed-synthesis-provider.js';
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
  const general = buildGeneralSynthesis(config, env);
  if (general === null) return null;
  return withNigerianSpecialist(general, env);
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
 * TWO PLACES NOW STATE THIS RULE, and that is worth knowing about.
 * `ai-registry`'s `resolveCommercialRoute` already puts 9jaLingo ahead of the
 * primary for exactly these languages -- correctly, and with better refusal
 * reporting than this has. Nothing in the live path calls it: it is a planning
 * module no service consumes, which is why the specialist it routes to was
 * never reached. Unifying them means giving media-ingest a dependency on the
 * registry service, which is a larger change than this one and should be made
 * deliberately rather than as a side effect. Until then, a change to the
 * language list belongs in BOTH files.
 *
 * THE SPECIALIST HAS THE GENERAL CHAIN BEHIND IT, which is the same call as
 * crediting a downgraded premium user rather than failing them: if 9jaLingo is
 * down, a listener hearing imperfect Yoruba is better served than a listener
 * hearing nothing. The fall-through is logged, so a specialist that has quietly
 * stopped answering does not stay hidden behind audio that still plays.
 */
function withNigerianSpecialist(
  general: StreamingSpeechSynthesisProvider,
  env: LiveProviderEnv,
): StreamingSpeechSynthesisProvider {
  const baseUrl = env.naijaLingoBaseUrl;
  const apiKey = env.naijaLingoApiKey;

  if (baseUrl === undefined || apiKey === undefined) {
    /*
     * ON THE RECORD, BUT NOT AN ALARM, and the level is the decision.
     *
     * These languages ARE served worse than the rest -- a listening test on
     * 2026-08-26 confirmed both general vendors mispronounce them while
     * returning 200 -- so saying nothing would hide a real limitation. But
     * running without a specialist is now a deliberate commercial choice
     * (9jaLingo answered in 7-11s against 270ms, and exhausted its plan quota
     * after three sentences), and warning every boot about a settled decision
     * is how teams learn to scroll past warnings that matter. Stated once, as
     * fact, at info.
     */
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'media-ingest',
        message:
          'No Nigerian-language specialist configured; ha/ig/yo/pcm are served by the general vendor and are known to be mispronounced.',
        languages: NAIJALINGO_LANGUAGES,
      }),
    );
    return general;
  }

  const specialist = new NaijaLingoStreamingSynthesisProvider({
    baseUrl,
    apiKey,
    sampleRate: Number(env.naijaLingoSampleRate),
    defaultVoice: requireCredential(env.naijaLingoDefaultVoice, 'NAIJALINGO_DEFAULT_VOICE', 'naijalingo'),
    authHeaderName: env.naijaLingoAuthHeader,
    authScheme: env.naijaLingoAuthScheme,
    model: env.naijaLingoModel,
    voiceIds: parseVoiceIdMap(env.naijaLingoVoiceIds),
  });

  /*
   * Warmed at wiring time, not at first use. The capacity behind this vendor
   * scales to zero and takes minutes to come back, so the first Nigerian-
   * language sentence after an idle period would otherwise be served by the
   * general vendor that mispronounces it. Nothing waits on this.
   */
  specialist.warmUp();

  const specialistChain = createFallbackSpeechSynthesisProvider({
    providers: [specialist, general],
    onObservation: (observation) => {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          service: 'media-ingest',
          message: 'Nigerian-language synthesis served',
          servedBy: observation.servedBy,
          fellThrough: observation.fellThrough,
          timeToFirstChunkMs: observation.timeToFirstChunkMs,
        }),
      );
    },
  });

  const routes = new Map<string, StreamingSpeechSynthesisProvider>(
    NAIJALINGO_LANGUAGES.map((language) => [language, specialistChain]),
  );

  return createLanguageRoutedSynthesisProvider({
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
  });
}

function buildGeneralSynthesis(
  config: Pick<IngestConfig, 'streamingSynthesisProvider'>,
  env: LiveProviderEnv,
): StreamingSpeechSynthesisProvider | null {
  switch (config.streamingSynthesisProvider) {
    case 'off':
      return null;
    case 'mock':
      return new MockStreamingSynthesisProvider();
    case 'azure':
      return buildAzureSynthesis(env);
    /*
     * ELEVENLABS FIRST, AZURE BEHIND IT. The order is a cost and latency
     * decision the deployment can revisit by swapping this list -- what it must
     * not become is a silent preference expressed in five places.
     */
    case 'chain':
      return createFallbackSpeechSynthesisProvider({
        providers: [buildElevenLabsSynthesis(env), buildAzureSynthesis(env)],
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
            }),
          );
        },
      });
    case 'elevenlabs':
      return buildElevenLabsSynthesis(env);
  }
}

function buildAzureSynthesis(env: LiveProviderEnv): StreamingSpeechSynthesisProvider {
  return new AzureStreamingSynthesisProvider({
    apiKey: requireCredential(env.azureSpeechKey, 'AZURE_SPEECH_KEY', 'azure'),
    region: requireCredential(env.azureSpeechRegion, 'AZURE_SPEECH_REGION', 'azure'),
    voiceIds: parseVoiceIdMap(env.azureVoiceIds),
    defaultVoiceId: requireCredential(
      env.azureDefaultVoiceId,
      'AZURE_DEFAULT_VOICE_ID',
      'azure',
    ),
  });
}

function buildElevenLabsSynthesis(env: LiveProviderEnv): StreamingSpeechSynthesisProvider {
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
