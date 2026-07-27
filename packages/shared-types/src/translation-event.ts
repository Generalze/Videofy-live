/**
 * TranslationEvent – represents a single translated phrase with full latency metadata.
 *
 * Each event links a translated phrase to a position in the live video stream so the
 * system can later align interpreted audio with the video timeline.
 */
export interface LatencyBreakdown {
  /** Time from audio capture to arriving in the speech worker (ms). */
  audioCaptureMs: number;
  /** Time taken by the speech-recognition step (ms). */
  transcriptionMs: number;
  /** Time taken by the translation step (ms). */
  translationMs: number;
  /** Time taken by text-to-speech generation (ms). */
  speechGenerationMs: number;
  /** Time from translated result to delivery at the listener (ms). */
  deliveryMs: number;
  /**
   * Positive value means interpreted audio lags behind the live video.
   * Negative value means interpreted audio leads the live video (rare).
   */
  synchronizationOffsetMs: number;
}

export type AudioFormat = 'mp3' | 'ogg' | 'wav' | 'webm' | null;

export type StreamStatus =
  | 'created'
  | 'validating'
  | 'ready'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type VideoSource =
  | 'mock'
  | 'local-file'
  | 'microphone'
  | 'webcam'
  | 'zoom'
  | 'teams'
  | 'meet'
  | 'obs'
  | 'rtmp'
  | 'webrtc'
  | 'hls';

export type AudioMode = 'interpretation' | 'replacement';

/**
 * A single translated phrase event flowing from the speech worker through the
 * realtime gateway to listener clients.
 */
export interface TranslationEvent {
  /** Stable identifier for the live event (e.g. "demo-event"). */
  eventId: string;
  /** Monotonically increasing counter used to detect gaps and duplicates. */
  sequence: number;
  /** BCP-47 language tag of the original speech (e.g. "en"). */
  sourceLanguage: string;
  /** BCP-47 language tag of the translated output (e.g. "fr"). */
  targetLanguage: string;
  /** Original recognised text. */
  sourceText: string;
  /** Translated text ready for display as a subtitle or phrase card. */
  translatedText: string;
  /**
   * URL or data-URI of the generated translated audio file.
   * Null when audio has not yet been generated.
   */
  audioUrl: string | null;
  /** MIME format of the audio at audioUrl. Null when audioUrl is null. */
  audioFormat: AudioFormat;
  /** Duration of the audio file in milliseconds. Null when no audio. */
  audioDurationMs: number | null;
  /**
   * True when this phrase is final and should not be replaced by a later segment.
   * False for interim/partial transcription results.
   */
  final: boolean;
  /**
   * Position in the live video stream (ms from stream start) at which the
   * original speaker uttered this phrase.
   */
  videoTimestampMs: number;
  /** ISO-8601 timestamp when this event was created by the speech worker. */
  createdAt: string;
  latency: LatencyBreakdown;
}

/**
 * A subset of TranslationEvent used when sending new events to the gateway
 * before the gateway stamps delivery timestamps.
 */
export type TranslationEventInput = Omit<TranslationEvent, 'createdAt'> & {
  createdAt?: string;
};
