/** @owner masterzee001 */
import type { RecipientOutputPlan, RecipientOutputRequest } from '@videofy-live/call-contracts';

/** Runtime output availability is supplied by the session/voice services, never inferred here. */
export interface RecipientOutputAvailability {
  readonly originalMediaAvailable: boolean;
  readonly originalCaptionsAvailable: boolean;
  readonly translatedTextAvailable: boolean;
  readonly generatedAudioEgressAvailable: boolean;
  readonly personalVoice: { readonly available: boolean; readonly voiceId?: string };
  readonly standardVoice: { readonly available: boolean; readonly voiceId?: string };
}

/**
 * `request.recipientPreferences` is the single recipient authority defined by
 * call-contracts. The router reads it but never changes manual language state.
 */
export interface RecipientOutputPolicyInput {
  readonly sourceLanguage: string;
  readonly request: RecipientOutputRequest;
  readonly availability: RecipientOutputAvailability;
}

export type RecipientOutputPath = RecipientOutputPlan['fallbackPath'];

/** Identity-free decision input shared by canonical and legacy adapters. */
export interface RecipientOutputDecisionInput {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly captionLanguage: string;
  readonly captionsEnabled: boolean;
  readonly includeOriginal: boolean;
  readonly audio: {
    readonly mode: 'translated' | 'interpretation' | 'original';
    readonly originalAudioLevel: number;
    readonly translatedAudioLevel: number;
  };
  readonly voice: {
    readonly mode: 'standard' | 'personal' | 'original-only';
    readonly standardVoiceId?: string | undefined;
    readonly voiceProfileId?: string | undefined;
    readonly fallbackVoiceId?: string | undefined;
  };
  readonly availability: RecipientOutputAvailability;
}

export interface RecipientOutputDecision {
  readonly path: RecipientOutputPath;
  readonly originalAudioTreatment: RecipientOutputPlan['originalAudioTreatment'];
  readonly originalEnabled: boolean;
  readonly originalVolume: number;
  readonly generatedEnabled: boolean;
  readonly generatedVolume: number;
  readonly selectedVoiceMode: RecipientOutputPlan['selectedVoiceMode'];
  readonly selectedVoiceId: string | null;
  readonly voice: 'personal' | 'standard' | null;
  readonly captions: CaptionDecision;
}

/** A contract-valid plan enriched with recipient-local mix/caption detail. */
export interface RecipientOutputPolicyPlan extends RecipientOutputPlan {
  readonly path: RecipientOutputPath;
  readonly audio: {
    readonly original: { readonly enabled: boolean; readonly volume: number };
    readonly generated: {
      readonly enabled: boolean;
      readonly volume: number;
      readonly egressOnly: true;
      readonly voice: 'personal' | 'standard' | null;
    };
  };
  readonly captions: {
    readonly language: string | null;
    readonly content: 'original' | 'translated' | null;
  };
}

const DEFAULT_DUCKED_ORIGINAL_VOLUME = 0.25;

/**
 * Produces one deterministic recipient plan. Generated audio is represented
 * only as egress and no input object or manual language authority is mutated.
 */
export function resolveRecipientOutputPolicy(
  input: RecipientOutputPolicyInput,
): RecipientOutputPolicyPlan {
  const preferences = input.request.recipientPreferences;
  return createPlan(
    input,
    resolveRecipientOutputDecision({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: preferences.language.preferredLanguage,
      captionLanguage: preferences.language.captionLanguage,
      captionsEnabled: preferences.caption.enabled,
      includeOriginal: preferences.caption.includeOriginal,
      audio: preferences.audio,
      voice: preferences.voice,
      availability: input.availability,
    }),
  );
}

/** Shared pure engine used by canonical recipient plans and legacy listener compatibility. */
export function resolveRecipientOutputDecision(
  input: RecipientOutputDecisionInput,
): RecipientOutputDecision {
  const { availability } = input;
  const captions = selectCaptions(input);
  const sameLanguage = isSameLanguage(input.sourceLanguage, input.targetLanguage);

  if (sameLanguage) {
    if (!availability.originalMediaAvailable && captions?.content !== 'original') {
      return captions?.content === 'translated'
        ? translatedTextDecision(input, captions)
        : originalOrUnavailableDecision(input, null);
    }
    return {
      path: 'same-language-original',
      originalAudioTreatment: availability.originalMediaAvailable ? 'primary' : 'suppressed',
      originalEnabled: availability.originalMediaAvailable,
      originalVolume: availability.originalMediaAvailable
        ? level(input.audio.originalAudioLevel, 1)
        : 0,
      generatedEnabled: false,
      generatedVolume: 0,
      selectedVoiceMode: 'original-only',
      selectedVoiceId: null,
      voice: null,
      captions,
    };
  }

  if (input.audio.mode === 'original' || input.voice.mode === 'original-only') {
    return originalOrUnavailableDecision(input, captions);
  }

  const canGenerate =
    availability.generatedAudioEgressAvailable && availability.translatedTextAvailable;
  const personalVoiceId = selectedPersonalVoiceId(input.voice, availability);
  if (canGenerate && input.voice.mode === 'personal' && personalVoiceId !== null) {
    return translatedAudioDecision(input, 'personal', personalVoiceId, captions);
  }

  const standardVoiceId = selectedStandardVoiceId(input.voice, availability);
  if (canGenerate && standardVoiceId !== null) {
    return translatedAudioDecision(input, 'standard', standardVoiceId, captions);
  }

  if (captions?.content === 'translated') {
    return translatedTextDecision(input, captions);
  }

  return originalOrUnavailableDecision(input, captions);
}

function translatedTextDecision(
  input: RecipientOutputDecisionInput,
  captions: Extract<CaptionDecision, { content: 'translated' }>,
): RecipientOutputDecision {
  const { availability } = input;
  return {
    path: 'translated-text',
    originalAudioTreatment: availability.originalMediaAvailable ? 'primary' : 'suppressed',
    originalEnabled: availability.originalMediaAvailable,
    originalVolume: availability.originalMediaAvailable
      ? level(input.audio.originalAudioLevel, 1)
      : 0,
    generatedEnabled: false,
    generatedVolume: 0,
    selectedVoiceMode: 'original-only',
    selectedVoiceId: null,
    voice: null,
    captions,
  };
}

function translatedAudioDecision(
  input: RecipientOutputDecisionInput,
  voice: 'personal' | 'standard',
  voiceId: string,
  captions: CaptionDecision,
): RecipientOutputDecision {
  const { availability } = input;
  const interpretation = input.audio.mode === 'interpretation';
  return {
    path: voice,
    originalAudioTreatment:
      interpretation && availability.originalMediaAvailable ? 'ducked' : 'suppressed',
    originalEnabled: interpretation && availability.originalMediaAvailable,
    originalVolume:
      interpretation && availability.originalMediaAvailable
        ? level(input.audio.originalAudioLevel, DEFAULT_DUCKED_ORIGINAL_VOLUME)
        : 0,
    generatedEnabled: true,
    generatedVolume: level(input.audio.translatedAudioLevel, 1),
    selectedVoiceMode: voice,
    selectedVoiceId: voiceId,
    voice,
    captions,
  };
}

function originalOrUnavailableDecision(
  input: RecipientOutputDecisionInput,
  captions: CaptionDecision,
): RecipientOutputDecision {
  const { availability } = input;
  const originalAvailable = availability.originalMediaAvailable;
  return {
    path: originalAvailable ? 'original-media' : 'unavailable',
    originalAudioTreatment: originalAvailable ? 'primary' : 'suppressed',
    originalEnabled: originalAvailable,
    originalVolume: originalAvailable ? level(input.audio.originalAudioLevel, 1) : 0,
    generatedEnabled: false,
    generatedVolume: 0,
    selectedVoiceMode: 'original-only',
    selectedVoiceId: null,
    voice: null,
    captions,
  };
}

type CaptionDecision =
  | { readonly language: string; readonly content: 'original' }
  | { readonly language: string; readonly content: 'translated' }
  | null;

/** Selects requested caption language, then falls back only to actually available output. */
function selectCaptions(input: RecipientOutputDecisionInput): CaptionDecision {
  if (!input.captionsEnabled) return null;

  const wantsOriginal =
    input.includeOriginal || isSameLanguage(input.captionLanguage, input.sourceLanguage);
  if (wantsOriginal && input.availability.originalCaptionsAvailable) {
    return { language: input.sourceLanguage, content: 'original' };
  }
  if (!wantsOriginal && input.availability.translatedTextAvailable) {
    return { language: input.captionLanguage, content: 'translated' };
  }
  if (input.availability.originalCaptionsAvailable) {
    return { language: input.sourceLanguage, content: 'original' };
  }
  if (input.availability.translatedTextAvailable) {
    return { language: input.captionLanguage, content: 'translated' };
  }
  return null;
}

function selectedPersonalVoiceId(
  preference: RecipientOutputDecisionInput['voice'],
  availability: RecipientOutputAvailability,
): string | null {
  if (!availability.personalVoice.available || !preference.voiceProfileId) return null;
  return availability.personalVoice.voiceId ?? preference.voiceProfileId ?? null;
}

function selectedStandardVoiceId(
  preference: RecipientOutputDecisionInput['voice'],
  availability: RecipientOutputAvailability,
): string | null {
  if (
    !availability.standardVoice.available ||
    (!preference.standardVoiceId && !preference.fallbackVoiceId)
  ) {
    return null;
  }
  return (
    availability.standardVoice.voiceId ??
    preference.standardVoiceId ??
    preference.fallbackVoiceId ??
    null
  );
}

function createPlan(
  input: RecipientOutputPolicyInput,
  decision: RecipientOutputDecision,
): RecipientOutputPolicyPlan {
  const { request } = input;
  return {
    sessionId: request.sessionId,
    recipientParticipantId: request.recipientParticipantId,
    speakerParticipantId: request.speakerParticipantId,
    mediaRevision: request.mediaRevision,
    languageRevision: request.languageRevision,
    sourceSequence: request.sourceSequence,
    targetLanguage: request.recipientPreferences.language.preferredLanguage,
    captionLanguage: decision.captions?.language ?? null,
    deliverCaption: decision.captions !== null,
    deliverGeneratedAudio: decision.generatedEnabled,
    generatedAudioEgressOnly: true,
    originalAudioTreatment: decision.originalAudioTreatment,
    selectedVoiceMode: decision.selectedVoiceMode,
    selectedVoiceId: decision.selectedVoiceId,
    fallbackPath: decision.path,
    path: decision.path,
    audio: {
      original: { enabled: decision.originalEnabled, volume: decision.originalVolume },
      generated: {
        enabled: decision.generatedEnabled,
        volume: decision.generatedVolume,
        egressOnly: true,
        voice: decision.voice,
      },
    },
    captions: decision.captions ?? { language: null, content: null },
  };
}

/** Clamp hostile/stale values at the router boundary before they reach a mixer. */
function level(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function isSameLanguage(left: string, right: string): boolean {
  return primaryLanguageSubtag(left) === primaryLanguageSubtag(right);
}

function primaryLanguageSubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}
