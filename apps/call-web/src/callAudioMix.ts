import type { CallAudioMode } from './callTypes';

export interface CallAudioMixInputs {
  audioMode: CallAudioMode;
  /** Original-audio slider (0..1). Duck level in interpretation, listening level in original mode. */
  originalVolume: number;
  /** Translated-audio slider (0..1). */
  translatedVolume: number;
  /** True while a generated (translated) audio segment is audibly playing. */
  translatedSpeechActive: boolean;
  /**
   * False when the remote speaker's language equals this listener's hear
   * language: no translation will ever arrive for that direction, so the
   * original voice IS the delivery and must not be suppressed by
   * translated/interpretation semantics. Defaults to true (translation pair).
   */
  remoteTranslationExpected?: boolean;
}

export interface CallAudioMixDecision {
  /** Volume to apply to the remote original-audio element. */
  originalVolume: number;
  /** Volume to apply to generated translated audio. */
  translatedVolume: number;
  /** Whether generated audio should play at all in this mode. */
  playGenerated: boolean;
}

export const DEFAULT_ORIGINAL_DUCK_LEVEL = 0.2;
export const DEFAULT_TRANSLATED_LEVEL = 1;

/**
 * Mix policy (mirrors listener-web semantics):
 * - `original`: the real voice plays at the original slider level; generated
 *   audio never plays.
 * - `translated`: replacement semantics — the original is fully suppressed
 *   while the mode is active and the translation carries the call.
 * - `interpretation`: the original plays at full level and ducks down to the
 *   original slider level while translated speech is audible.
 */
export function resolveCallAudioMix(inputs: CallAudioMixInputs): CallAudioMixDecision {
  const original = clampLevel(inputs.originalVolume);
  const translated = clampLevel(inputs.translatedVolume);

  if (inputs.remoteTranslationExpected === false) {
    // Same-language direction (found in the owner's first live call): captions
    // flow but no generated audio ever will, so replacement semantics would
    // deliver silence. The original voice is the delivery.
    return { originalVolume: original, translatedVolume: 0, playGenerated: false };
  }

  if (inputs.audioMode === 'original') {
    return { originalVolume: original, translatedVolume: 0, playGenerated: false };
  }

  if (inputs.audioMode === 'translated') {
    return { originalVolume: 0, translatedVolume: translated, playGenerated: true };
  }

  return {
    originalVolume: inputs.translatedSpeechActive ? original : 1,
    translatedVolume: translated,
    playGenerated: true,
  };
}

/**
 * Slider seed when the audio mode changes: interpretation treats the original
 * slider as a duck level, every other mode as a direct listening level.
 */
export function defaultOriginalVolumeForMode(audioMode: CallAudioMode): number {
  return audioMode === 'interpretation' ? DEFAULT_ORIGINAL_DUCK_LEVEL : 1;
}

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Primary BCP-47 subtag, matching the gateway's same-language comparison. */
export function primaryLanguageSubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * P6.4-W3.1 — is THIS speaker's original voice suppressed for THIS listener?
 *
 * The per-call master volume was structurally wrong at conference size. With
 * one flag for the whole call, a listener in Translated mode either lost the
 * original voice of a SAME-language speaker (whose original IS the delivery —
 * nothing else carries them), or kept hearing a cross-language speaker's
 * original underneath their translation. calm-tide-33 showed the third
 * symptom: the flag keyed off an arbitrary "first other participant", so the
 * fr listener's per-speaker mute/volume governed audio the mode had silenced —
 * controls that moved and did nothing.
 *
 * Suppression is a property of the PAIR (their language, my hear language),
 * not of the call:
 *
 *   translated mode, they speak my language      → original audible (delivery)
 *   translated mode, they speak another language → original suppressed (TTS is
 *                                                  the delivery)
 *   interpretation / original modes              → never suppressed here;
 *                                                  interpretation DUCKING is
 *                                                  W4 policy, not this rule
 */
export function speakerOriginalSuppressed(
  audioMode: CallAudioMode,
  speakerLanguage: string | undefined,
  hearLanguage: string,
): boolean {
  if (audioMode !== 'translated') return false;
  if (!speakerLanguage) return false;
  return primaryLanguageSubtag(speakerLanguage) !== primaryLanguageSubtag(hearLanguage);
}

/**
 * Does ANY remote speaker need translating for this listener?
 *
 * Replaces the two-party residue that consulted only the FIRST other
 * participant — at N>2 that silently keyed the whole mix to whoever happened
 * to sort first. Safe to generalise now that original suppression is
 * per-speaker: this flag only governs whether generated playback is expected
 * at all.
 */
export function anyRemoteTranslationExpected(
  participants: readonly { participantId: string; speakLanguage?: string }[],
  selfParticipantId: string,
  hearLanguage: string,
): boolean {
  const remotes = participants.filter((p) => p.participantId !== selfParticipantId);
  if (remotes.length === 0) return true; // nobody yet: assume a translation pair
  return remotes.some(
    (p) =>
      !p.speakLanguage ||
      primaryLanguageSubtag(p.speakLanguage) !== primaryLanguageSubtag(hearLanguage),
  );
}
