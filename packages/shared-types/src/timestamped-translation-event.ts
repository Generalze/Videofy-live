export type TimestampedTranslationStatus =
  'queued' | 'translating' | 'translated' | 'failed' | 'retrying';

export interface TimestampedTranslationLatency {
  queuedMs: number;
  providerMs: number;
  totalMs: number;
}

export interface TimestampedTranslationEvent {
  sessionId: string;
  streamId: string;
  segmentId: string;
  sequence: number;
  sourceLanguage: string;
  sourceLanguageRevision?: number;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  status: TimestampedTranslationStatus;
  latency: TimestampedTranslationLatency;
  error?: string;
  createdAt: string;
}

export interface TranslationSessionMetadata {
  status: TimestampedTranslationStatus;
  providerName?: string;
  providerStatus?: 'idle' | 'ready' | 'translating' | 'failed';
  progressPct: number;
  totalSegments: number;
  translatedSegments: number;
  failedSegments: number;
  sourceLanguage: string | null;
  sourceLanguageRevision?: number;
  targetLanguage: string;
  targetLanguages?: string[];
  events: TimestampedTranslationEvent[];
  error?: string;
}
