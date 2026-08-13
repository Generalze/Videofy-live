export type SessionProcessingStage =
  | 'created'
  | 'validating'
  | 'microphone-capture'
  | 'audio-extraction'
  | 'transcription'
  | 'translation'
  | 'text-to-speech'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SessionRecoveryAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry-transcription'
  | 'retry-translation'
  | 'retry-tts'
  | 'set-source-language';

export type SessionRecoveryEventKind = 'operator-action' | 'recovery-event';
export type SessionRecoveryEventStatus = 'accepted' | 'rejected' | 'succeeded' | 'failed';

export interface SessionRecoveryEvent {
  id: string;
  kind: SessionRecoveryEventKind;
  action: SessionRecoveryAction;
  status: SessionRecoveryEventStatus;
  message: string;
  segmentId?: string;
  createdAt: string;
}

export interface SessionMonitoringMetadata {
  currentStage: SessionProcessingStage;
  overallProgressPct: number;
  failedSegmentCount: number;
  averageLatencyMs: number | null;
  latestLatencyMs: number | null;
  lastError: string | null;
  events: SessionRecoveryEvent[];
}
