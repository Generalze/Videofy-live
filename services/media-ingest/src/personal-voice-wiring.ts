/** @owner masterzee001 */
/**
 * The two functions that connect personal voice to the media pipeline (P6.3).
 *
 * This exists as its own module for one reason: it is the part that has been
 * wrong every time. The provider was correct, the router was correct, and the
 * running service used neither — twice — because the connecting code lived
 * inline in `index.ts` where no test could reach it. Composition that only the
 * production entrypoint can see is composition nothing verifies.
 *
 * So `index.ts` calls this, and the acceptance tests call this. If it changes,
 * both change together.
 *
 * The pair is deliberately split by responsibility:
 *
 *   resolvePersonalVoiceId — WHETHER this speaker has a usable voice right now
 *   wrapTextToSpeechProvider — HOW to speak in it, and what to do when that fails
 *
 * Neither caches. `usableForOwner` and `voiceAssetRef` are both read at the
 * moment of speaking, which is what makes revoke, delete and re-record take
 * effect on the next utterance rather than the next call.
 */
import type { IngestServiceDependencies } from './ingest-service.js';
import {
  createPersonalVoiceRoutingProvider,
  personalVoiceId,
  profileIdFromPersonalVoiceId,
} from './openvoice-personal-voice.js';
import type { TextToSpeechProviderInput } from './text-to-speech-provider.js';
import type { VoiceProfileStore } from './voice-profile-store.js';

export interface PersonalVoiceWiringOptions {
  /** Where enrollment state lives; the authority on what is usable. */
  readonly voiceProfileStore: VoiceProfileStore;
  /** The engine. Null when none is configured — see `createPersonalVoiceWiring`. */
  readonly engine: {
    synthesize(input: {
      text: string;
      targetLanguage: string;
      voiceAssetRef: string;
    }): Promise<{ ok: true; audio: Uint8Array } | { ok: false; reason: string }>;
  };
  /** Last-resort voice, used only when a session somehow selected none. */
  readonly defaultVoiceId: string;
  readonly writeAudio: (outputPath: string, audio: Uint8Array) => Promise<void>;
  readonly onFallback?: (reason: string, input: TextToSpeechProviderInput) => void;
}

/**
 * Build the dependencies IngestService needs to speak in a personal voice.
 *
 * Returning `IngestServiceDependencies` rather than two loose functions is the
 * point: a caller cannot wire one half and forget the other, which is exactly
 * the state the service shipped in when the router was installed and never
 * given an owner to resolve.
 */
export function createPersonalVoiceWiring(
  options: PersonalVoiceWiringOptions,
): Required<IngestServiceDependencies> {
  return {
    resolvePersonalVoiceId: (ownerId) => {
      // usableForOwner already excludes revoked, deleted and not-yet-ready
      // profiles, so "no usable voice" and "never enrolled" arrive identically.
      // Both mean the standard voice, which is the correct answer to each.
      const profile = options.voiceProfileStore.usableForOwner(ownerId);
      return profile ? personalVoiceId(profile.voiceProfileId) : null;
    },

    wrapTextToSpeechProvider: (standard) =>
      createPersonalVoiceRoutingProvider({
        standard,
        personal: options.engine,
        assetRefFor: (voiceId) => {
          const profileId = profileIdFromPersonalVoiceId(voiceId);
          if (!profileId) return null;
          return options.voiceProfileStore.get(profileId)?.profile.voiceAssetRef ?? null;
        },
        // The standard voice THIS session selected, handed down with the
        // request. The service-wide default is a last resort only: on an
        // English→Spanish call it would answer with an English voice reading
        // Spanish, which is worse than the failure it is recovering from.
        fallbackVoiceId: (input) => input.standardVoiceId ?? options.defaultVoiceId,
        writeAudio: options.writeAudio,
        ...(options.onFallback ? { onFallback: options.onFallback } : {}),
      }),
  };
}
