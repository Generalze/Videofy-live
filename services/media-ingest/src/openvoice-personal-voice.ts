/** @owner masterzee001 */
/**
 * The real personal-voice provider and its synthesis routing (P6.3).
 *
 * Everything OpenVoice-shaped stops here. Above this file a caller sees a
 * voiceId, an audio file and a reason — never an embedding, checkpoint, model
 * name, service URL or filesystem path.
 *
 * The load-bearing rule is the fallback. A profile can resolve successfully and
 * the engine can die milliseconds later during synthesis, so failure is handled
 * at BOTH moments and always converges on the selected standard voice. No
 * utterance is dropped because a personal voice was unavailable: the words were
 * already translated, and the listener is owed them in some voice.
 */
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
  TextToSpeechProviderResult,
} from './text-to-speech-provider.js';
import type {
  DescribedVoiceProfileProvider,
  PersonalVoiceProviderInfo,
} from './personal-voice-provider.js';
import type { VoiceProfileResolution } from './voice-profile-provider.js';

/** Reads enrollment bytes without the provider learning where they live. */
export type EnrollmentReader = (recordingRef: string) => Promise<Uint8Array | null>;

export interface OpenVoiceProviderOptions {
  readonly serviceUrl: string;
  readonly readEnrollment: EnrollmentReader;
  /** Languages the engine has base voices for. */
  readonly supportedLanguages?: readonly string[];
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_LANGUAGES = ['en', 'es', 'fr'] as const;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The opaque personal voice identity Call sees.
 *
 * Deliberately not the engine's asset reference: Call should be able to carry
 * this around, log it and compare it without holding a handle to somebody's
 * derived voice data.
 */
export function personalVoiceId(voiceProfileId: string): string {
  return `personal:${voiceProfileId}`;
}

export function isPersonalVoiceId(voiceId: string): boolean {
  return voiceId.startsWith('personal:');
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenVoicePersonalVoiceProvider(
  options: OpenVoiceProviderOptions,
): DescribedVoiceProfileProvider & {
  synthesize(input: {
    text: string;
    targetLanguage: string;
    voiceAssetRef: string;
  }): Promise<{ ok: true; audio: Uint8Array } | { ok: false; reason: string }>;
} {
  const languages = new Set(
    (options.supportedLanguages ?? DEFAULT_LANGUAGES).map((l) => l.toLowerCase()),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    info(): PersonalVoiceProviderInfo {
      return {
        providerId: 'openvoice-v2',
        // B4 accepted this for development-demo at roughly 7/10. It has not
        // earned any stronger word, and saying one here is how a prototype
        // quietly becomes a production claim.
        approval: 'development-unvalidated',
        note:
          'Personal voice runs on a locally hosted engine approved for development ' +
          'demonstration only. Output is watermarked and is not production certified.',
      };
    },

    async createAsset(input) {
      const audio = await options.readEnrollment(input.enrollmentRecordingRef);
      if (!audio || audio.byteLength === 0) {
        return { ok: false as const, reason: 'enrollment-recording-unreadable' };
      }
      try {
        const response = await withTimeout(
          (signal) =>
            doFetch(`${options.serviceUrl}/voice-assets`, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: audio,
              signal,
            }),
          timeoutMs,
        );
        // Only a real creation may make a profile usable. Anything else and the
        // caller keeps the standard voice.
        if (response.status !== 201) return { ok: false as const, reason: 'asset-creation-failed' };
        const body = (await response.json()) as { voiceAssetRef?: string };
        if (!body.voiceAssetRef) return { ok: false as const, reason: 'asset-creation-failed' };
        return { ok: true as const, voiceAssetRef: body.voiceAssetRef };
      } catch {
        return { ok: false as const, reason: 'provider-unavailable' };
      }
    },

    async resolve(input): Promise<VoiceProfileResolution> {
      if (!languages.has(input.targetLanguage.toLowerCase())) {
        return { ok: false, reason: 'unsupported-target-language' };
      }
      if (!input.voiceAssetRef) return { ok: false, reason: 'asset-missing' };
      try {
        const response = await withTimeout(
          (signal) => doFetch(`${options.serviceUrl}/health`, { signal }),
          timeoutMs,
        );
        if (!response.ok) return { ok: false, reason: 'provider-unavailable' };
      } catch {
        return { ok: false, reason: 'provider-unavailable' };
      }
      return { ok: true, voiceId: personalVoiceId(input.voiceProfileId) };
    },

    async synthesize(input) {
      try {
        const response = await withTimeout(
          (signal) =>
            doFetch(`${options.serviceUrl}/synthesize`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                text: input.text,
                targetLanguage: input.targetLanguage,
                voiceAssetRef: input.voiceAssetRef,
              }),
              signal,
            }),
          timeoutMs,
        );
        if (!response.ok) return { ok: false as const, reason: `synthesis-failed-${response.status}` };
        const audio = new Uint8Array(await response.arrayBuffer());
        if (audio.byteLength === 0) return { ok: false as const, reason: 'synthesis-empty' };
        return { ok: true as const, audio };
      } catch {
        return { ok: false as const, reason: 'provider-unavailable' };
      }
    },
  };
}

export interface PersonalVoiceRoutingOptions {
  /** Where a personal voice comes from. */
  readonly personal: {
    synthesize(input: {
      text: string;
      targetLanguage: string;
      voiceAssetRef: string;
    }): Promise<{ ok: true; audio: Uint8Array } | { ok: false; reason: string }>;
  };
  /** Everything else, unchanged. */
  readonly standard: TextToSpeechProvider;
  /** Maps an opaque personal voiceId back to the engine's asset. */
  readonly assetRefFor: (voiceId: string) => string | null;
  /** The standard voice to use when personal synthesis cannot be delivered. */
  readonly fallbackVoiceId: (input: TextToSpeechProviderInput) => string;
  readonly writeAudio: (outputPath: string, audio: Uint8Array) => Promise<void>;
  readonly onFallback?: (reason: string, input: TextToSpeechProviderInput) => void;
}

/**
 * A TextToSpeechProvider that speaks in a personal voice when one is selected,
 * and in the standard voice whenever it cannot.
 *
 * The interface is unchanged, so nothing upstream learns that personal voice
 * exists as a separate mechanism — it is simply a voiceId that happens to route
 * elsewhere.
 */
export function createPersonalVoiceRoutingProvider(
  options: PersonalVoiceRoutingOptions,
): TextToSpeechProvider {
  return {
    name: 'personal-voice-routing',

    async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
      if (!isPersonalVoiceId(input.voiceId)) {
        return options.standard.generate(input);
      }

      const assetRef = options.assetRefFor(input.voiceId);
      if (assetRef) {
        const startedAt = Date.now();
        const result = await options.personal.synthesize({
          text: input.translatedText,
          targetLanguage: input.targetLanguage,
          voiceAssetRef: assetRef,
        });
        if (result.ok) {
          await options.writeAudio(input.outputPath, result.audio);
          return {
            audioPath: input.outputPath,
            providerLatencyMs: Date.now() - startedAt,
          };
        }
        options.onFallback?.(result.reason, input);
      } else {
        options.onFallback?.('asset-missing', input);
      }

      // The words were already translated. Losing the utterance because a voice
      // engine failed would punish the listener for an infrastructure problem.
      return options.standard.generate({
        ...input,
        voiceId: options.fallbackVoiceId(input),
      });
    },
  };
}
