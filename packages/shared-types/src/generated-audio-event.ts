export type TextToSpeechStatus = 'queued' | 'generating' | 'generated' | 'failed' | 'retrying';

export interface GeneratedAudioEvent {
  sessionId: string;
  streamId: string;
  segmentId: string;
  sequence: number;
  targetLanguage: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  voiceId: string;
  audioFilename: string;
  durationMs: number | null;
  providerLatencyMs: number | null;
  status: TextToSpeechStatus;
  error?: string;
  createdAt: string;
}

export interface GeneratedAudioReadyEvent {
  sessionId: string;
  streamId: string;
  segmentId: string;
  sequence: number;
  targetLanguage: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  voiceId: string;
  durationMs: number;
  providerLatencyMs: number | null;
  audioUrl: string;
  createdAt: string;
}

export interface TextToSpeechSessionMetadata {
  status: TextToSpeechStatus;
  providerName?: string;
  providerStatus?: 'idle' | 'ready' | 'generating' | 'failed' | 'text-only';
  progressPct: number;
  totalSegments: number;
  generatedSegments: number;
  failedSegments: number;
  targetLanguage: string;
  targetLanguages?: string[];
  voiceId: string;
  textOnlyLanguages?: string[];
  outputFormat: {
    container: 'wav';
    codec: 'pcm_s16le';
  };
  events: GeneratedAudioEvent[];
  error?: string;
}
