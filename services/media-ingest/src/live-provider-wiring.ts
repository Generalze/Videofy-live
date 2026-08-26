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
