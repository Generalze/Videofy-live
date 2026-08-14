/** @owner masterzee001 */
import type { TargetLanguageCapability, TargetLanguageOutput } from '@videofy-live/shared-types';

import {
  resolveRecipientOutputDecision,
  type RecipientOutputDecision,
  type RecipientOutputAvailability,
} from './recipient-output-policy.js';

/** Actual legacy listener state only; canonical participant identity is intentionally absent. */
export interface LegacyProgrammeListenerOutputInput {
  readonly sourceLanguage: string;
  readonly selectedLanguage: string;
  readonly subtitlesEnabled: boolean;
  readonly mix: {
    readonly mode: 'interpretation' | 'replacement';
    readonly originalVolume: number;
    readonly translatedVolume: number;
  };
  readonly originalMediaAvailable: boolean;
  readonly originalCaptionsAvailable: boolean;
  readonly capability?:
    Pick<TargetLanguageCapability, 'voiceAvailable' | 'textOnly' | 'voiceId'> | undefined;
  readonly output?: Pick<TargetLanguageOutput, 'captionsAvailable' | 'audioAvailable'> | undefined;
  readonly deliveredGeneratedAudio?: { readonly voiceId: string } | undefined;
}

export interface LegacyProgrammeListenerOutputDecision {
  readonly fallbackPath: RecipientOutputDecision['path'];
  readonly originalAudioRequired: boolean;
  readonly expectsGeneratedAudio: boolean;
  readonly deliverCaption: boolean;
  readonly caption: RecipientOutputDecision['captions'];
  readonly selectedVoiceId: string | null;
}

/**
 * Programme-listener compatibility adapter. It maps legacy readiness metadata
 * into the shared recipient engine without creating call identities/revisions.
 */
export function resolveLegacyProgrammeListenerOutputPolicy(
  input: LegacyProgrammeListenerOutputInput,
): LegacyProgrammeListenerOutputDecision {
  const isOriginal = isSameLanguage(input.selectedLanguage, 'original');
  const hasTranslatedText =
    input.output?.captionsAvailable === true || input.deliveredGeneratedAudio !== undefined;
  const standardVoiceId =
    input.deliveredGeneratedAudio?.voiceId ?? input.capability?.voiceId ?? undefined;
  const availability: RecipientOutputAvailability = {
    originalMediaAvailable: input.originalMediaAvailable,
    originalCaptionsAvailable: input.originalCaptionsAvailable,
    translatedTextAvailable: hasTranslatedText,
    generatedAudioEgressAvailable: input.output?.audioAvailable === true,
    personalVoice: { available: false },
    standardVoice: {
      available:
        standardVoiceId !== undefined &&
        (input.capability?.voiceAvailable === true || input.deliveredGeneratedAudio !== undefined),
      ...(standardVoiceId === undefined ? {} : { voiceId: standardVoiceId }),
    },
  };
  const decision = resolveRecipientOutputDecision({
    sourceLanguage: input.sourceLanguage,
    targetLanguage: isOriginal ? input.sourceLanguage : input.selectedLanguage,
    captionLanguage: isOriginal ? input.sourceLanguage : input.selectedLanguage,
    captionsEnabled: input.subtitlesEnabled,
    includeOriginal: isOriginal,
    audio: {
      mode: input.mix.mode === 'replacement' ? 'translated' : 'interpretation',
      originalAudioLevel: input.mix.originalVolume,
      translatedAudioLevel: input.mix.translatedVolume,
    },
    voice: {
      mode: 'standard',
      ...(standardVoiceId === undefined ? {} : { standardVoiceId }),
    },
    availability,
  });

  return {
    fallbackPath: decision.path,
    originalAudioRequired: !decision.generatedEnabled,
    expectsGeneratedAudio: decision.generatedEnabled,
    deliverCaption: decision.captions !== null,
    caption: decision.captions,
    selectedVoiceId: decision.selectedVoiceId,
  };
}

function isSameLanguage(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right;
}
