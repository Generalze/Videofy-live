import type { CallAudioMode } from './callTypes';

export interface CallAudioMixInputs {
  audioMode: CallAudioMode;
  /** Original-audio slider (0..1). Duck level in interpretation, listening level in original mode. */
  originalVolume: number;
  /** Translated-audio slider (0..1). */
  translatedVolume: number;
  /** True while a generated (translated) audio segment is audibly playing. */
  translatedSpeechActive: boolean;
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
