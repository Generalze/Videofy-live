import type { StreamStatus, VideoSource } from './translation-event.js';

/**
 * MediaStateEvent – broadcast by the media-ingest service to describe the
 * current state of the live stream.
 */
export interface MediaStateEvent {
  /** Stable identifier for the live event. */
  eventId: string;
  /** Current lifecycle state of the video stream. */
  streamStatus: StreamStatus;
  /** Where the video feed originates from. */
  videoSource: VideoSource;
  /** Current playback position in the mock or live video (ms from start). */
  videoTimestampMs: number;
  /** Whether the source audio is currently active and being processed. */
  sourceAudioActive: boolean;
  /** List of BCP-47 language tags for which translation channels are active. */
  translatedLanguages: string[];
  /** Number of listener clients currently connected to the gateway. */
  connectedListeners: number;
  /** ISO-8601 timestamp when this state snapshot was generated. */
  createdAt: string;
}
