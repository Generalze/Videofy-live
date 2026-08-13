import type { AudioMixPreferences } from '@videofy-live/shared-types';

export interface ChangedMixPreferences {
  mode: boolean;
  originalVolume: boolean;
  translatedVolume: boolean;
  subtitlesEnabled: boolean;
}

export function changedMixPreferences(
  previous: AudioMixPreferences | null,
  next: AudioMixPreferences,
): ChangedMixPreferences {
  return {
    mode: previous === null || previous.mode !== next.mode,
    originalVolume: previous === null || previous.originalVolume !== next.originalVolume,
    translatedVolume: previous === null || previous.translatedVolume !== next.translatedVolume,
    subtitlesEnabled: previous === null || previous.subtitlesEnabled !== next.subtitlesEnabled,
  };
}
