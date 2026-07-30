/**
 * AudioSyncDescriptor – metadata required to align a translated audio clip
 * with the live video timeline.
 *
 * NOTE: Perfect real-time synchronisation is not attempted in the proof of
 * concept. Interpreted audio naturally plays several seconds behind the
 * original speaker because it must first pass through speech recognition,
 * translation, and text-to-speech. The video should later be buffered to
 * close this gap.
 */
export interface AudioSyncDescriptor {
  /** Stable identifier for the live event. */
  eventId: string;
  /** Monotonically increasing counter matching the translation event. */
  sequence: number;
  /** ISO-8601 timestamp when the audio was captured or generated. */
  sourceTimestamp: string;
  /** Position in the live video stream (ms) that the audio corresponds to. */
  videoTimestampMs: number;
  /** Duration of the translated audio clip (ms). Null when not yet generated. */
  translatedAudioDurationMs: number | null;
  /** ISO-8601 timestamp when the audio was queued for delivery. */
  deliveryTimestamp: string;
  /**
   * Positive = interpreted audio lags video.
   * Negative = interpreted audio leads video (rare).
   */
  synchronizationOffsetMs: number;
}

/**
 * AudioMode preferences used by listener-local controls and operator-directed
 * preview mixing.
 *
 * interpretation – translated voice is primary; original speaker is audible at
 *                 reduced volume alongside music and ambience.
 *
 * replacement    – original speech is muted; translated speech plays alone;
 *                 music and ambience can optionally remain.
 */
export interface AudioModePreferences {
  mode: 'interpretation' | 'replacement';
  /** 0–1 gain for the original audio channel. */
  originalVolume: number;
  /** 0–1 gain for the translated audio channel. */
  translatedVolume: number;
  /** Whether to display translated subtitles. */
  subtitlesEnabled: boolean;
}

/** Operator-directed mix defaults applied to connected listener clients. */
export type AudioMixPreferences = Omit<AudioModePreferences, 'mode'>;
