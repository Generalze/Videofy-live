import type { AudioMixPreferences, AudioModePreferences } from '@videofy-live/shared-types';

export interface AudioMixBroadcastInput {
  connected: boolean;
  /**
   * True only after an explicit operator interaction with the mix controls
   * (sliders, audio-mode toggle, subtitles checkbox, or the demo preset).
   */
  operatorHasAdjustedMix: boolean;
  mode: AudioModePreferences['mode'];
  originalVolume: number;
  translatedVolume: number;
  subtitlesEnabled: boolean;
}

/**
 * Decides whether operator audio-mode preferences should be broadcast to
 * listeners. Broadcasting is only allowed after an explicit operator
 * interaction, never automatically on socket connect or console mount:
 * a reloaded operator console starts with default values and must not reset
 * the mix listeners already have.
 */
export function buildAudioMixBroadcast(input: AudioMixBroadcastInput): AudioMixPreferences | null {
  if (!input.connected || !input.operatorHasAdjustedMix) return null;
  return {
    mode: input.mode,
    originalVolume: input.originalVolume,
    translatedVolume: input.translatedVolume,
    subtitlesEnabled: input.subtitlesEnabled,
  };
}
