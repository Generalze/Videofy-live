import type { AudioChunkMetadata } from './media-state-event.js';

export type MicrophoneCaptureStatus =
  | 'idle'
  | 'capturing'
  | 'paused'
  | 'stopped'
  | 'failed'
  | 'cancelled';

export interface MicrophoneCaptureChunkMetadata extends AudioChunkMetadata {
  receivedAt: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MicrophoneCaptureMetadata {
  status: MicrophoneCaptureStatus;
  deviceId: string | null;
  deviceLabel: string | null;
  durationMs: number;
  chunkCount: number;
  chunks: MicrophoneCaptureChunkMetadata[];
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}
