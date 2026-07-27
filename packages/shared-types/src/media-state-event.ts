import type { StreamStatus, VideoSource } from './translation-event.js';
import type { SessionMonitoringMetadata } from './session-monitoring.js';
import type { TranslationSessionMetadata } from './timestamped-translation-event.js';
import type { TextToSpeechSessionMetadata } from './generated-audio-event.js';
import type { TranscriptionSessionMetadata } from './transcription-event.js';
import type { MicrophoneCaptureMetadata } from './microphone-capture.js';

export interface MediaCodecInfo {
  type: 'audio' | 'video';
  codecName: string;
  codecLongName?: string;
  profile?: string;
}

export interface MediaFileMetadata {
  filename: string;
  fileSizeBytes: number;
  mimeType: string;
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codecs: MediaCodecInfo[];
}

export type AudioChunkStatus = 'ready' | 'failed';

export interface AudioChunkMetadata {
  chunkId: string;
  index: number;
  filename: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: AudioChunkStatus;
}

export type AudioExtractionStatus =
  'pending' | 'extracting' | 'chunking' | 'validating' | 'completed' | 'failed' | 'cleaned';

export interface AudioExtractionMetadata {
  status: AudioExtractionStatus;
  progressPct: number;
  chunkCount: number;
  chunkDurationMs: number;
  outputFormat: {
    container: 'wav';
    codec: 'pcm_s16le';
    sampleRateHz: 16000;
    channels: 1;
  };
  chunks: AudioChunkMetadata[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type WebRtcTranscriptionBridgeStatus =
  | 'idle'
  | 'ready'
  | 'chunking'
  | 'processing'
  | 'stopped'
  | 'failed';

export interface WebRtcTranscriptionBridgeMetadata {
  status: WebRtcTranscriptionBridgeStatus;
  broadcastId: string;
  webRtcSessionId: string;
  broadcasterPeerId: string;
  revision: number;
  chunkCount: number;
  processingChunks: number;
  transcribedChunks: number;
  failedChunks: number;
  latestTranscript: string | null;
  lastError: string | null;
  startedAt?: string;
  stoppedAt?: string;
}

/**
 * MediaStateEvent - broadcast by the media-ingest service to describe the
 * current state of the live stream.
 */
export interface MediaStateEvent {
  /** Stable identifier for the live event. */
  eventId: string;
  /** Unique stream identifier generated when local media is accepted. */
  streamId?: string;
  /** Unique processing-session identifier for the accepted media. */
  processingSessionId?: string;
  /** Current lifecycle state of the video stream. */
  streamStatus: StreamStatus;
  /** Where the video feed originates from. */
  videoSource: VideoSource;
  /** Extracted local media metadata when a file-backed session exists. */
  media?: MediaFileMetadata;
  /** Audio extraction and chunking status when a file-backed session exists. */
  audioExtraction?: AudioExtractionMetadata;
  /** Browser microphone capture status when an operator capture session exists. */
  microphoneCapture?: MicrophoneCaptureMetadata;
  /** Browser WebRTC audio-to-transcription bridge status when backend media ingest is active. */
  webrtcTranscriptionBridge?: WebRtcTranscriptionBridgeMetadata;
  /** Timestamped transcription status when extracted chunks are being transcribed. */
  transcription?: TranscriptionSessionMetadata;
  /** Timestamped translation status when transcribed segments are being translated. */
  translation?: TranslationSessionMetadata;
  /** Generated translated-audio status. Audio is not delivered to listeners in P3.1. */
  generatedAudio?: TextToSpeechSessionMetadata;
  /** Unified monitoring and recovery metadata for the file-backed processing session. */
  monitoring?: SessionMonitoringMetadata;
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
