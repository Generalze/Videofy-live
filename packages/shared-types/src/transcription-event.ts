export type TranscriptionStatus = 'queued' | 'transcribing' | 'transcribed' | 'failed' | 'retrying';

export interface TranscriptionEvent {
  sessionId: string;
  streamId: string;
  chunkId: string;
  sequence: number;
  sourceText: string;
  detectedLanguage: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  providerLatencyMs?: number | null;
  status: TranscriptionStatus;
  error?: string;
  createdAt: string;
}

export interface TranscriptionSessionMetadata {
  status: TranscriptionStatus;
  progressPct: number;
  totalChunks: number;
  transcribedChunks: number;
  failedChunks: number;
  detectedLanguage: string | null;
  events: TranscriptionEvent[];
  error?: string;
}
