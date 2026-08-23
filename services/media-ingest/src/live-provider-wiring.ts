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
  readonly elevenLabsApiKey?: string | undefined;
  readonly elevenLabsModel?: string | undefined;
  readonly elevenLabsVoiceId?: string | undefined;
}

export function readLiveProviderEnv(env: NodeJS.ProcessEnv = process.env): LiveProviderEnv {
  // NAMES only. No secret is ever written to a log line, a doc, or a default.
  return {
    deepgramApiKey: env['DEEPGRAM_API_KEY'],
    deepgramModel: env['DEEPGRAM_MODEL'],
    elevenLabsApiKey: env['ELEVENLABS_API_KEY'],
    elevenLabsModel: env['ELEVENLABS_MODEL'],
    elevenLabsVoiceId: env['ELEVENLABS_DEFAULT_VOICE_ID'],
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
    case 'elevenlabs': {
      const voiceId = requireCredential(
        env.elevenLabsVoiceId,
        'ELEVENLABS_DEFAULT_VOICE_ID',
        'elevenlabs',
      );
      const eleven: ElevenLabsTtsConfig = {
        apiKey: requireCredential(env.elevenLabsApiKey, 'ELEVENLABS_API_KEY', 'elevenlabs'),
        modelId: env.elevenLabsModel ?? 'eleven_flash_v2_5',
        // The platform's voice ids map to the vendor's HERE. A vendor id
        // reaching a session config would make the vendor's catalogue into
        // Videofy's voice identity.
        voiceIds: {},
        defaultVoiceId: voiceId,
      };
      return new ElevenLabsStreamingSynthesisProvider(eleven);
    }
  }
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
