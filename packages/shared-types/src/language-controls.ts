export type SourceLanguageMode = 'manual' | 'auto-detect';
export type SourceLanguageStatus =
  | 'manual'
  | 'detecting'
  | 'detected'
  | 'needs-confirmation'
  | 'confirmed'
  | 'rejected'
  | 'locked';

export interface SourceLanguageControlMetadata {
  defaultLanguage: string;
  activeLanguage: string;
  mode: SourceLanguageMode;
  status: SourceLanguageStatus;
  detectedLanguage: string | null;
  detectionConfidence: number | null;
  confirmedLanguage: string | null;
  rejectedLanguage: string | null;
  locked: boolean;
  revision: number;
  confidenceThreshold: number;
  updatedAt: string;
}

export type TargetLanguageAvailability =
  | 'translation-available'
  | 'voice-available'
  | 'text-only'
  | 'unavailable'
  | 'experimental';

export interface TargetLanguageCapability {
  language: string;
  label: string;
  translationAvailable: boolean;
  voiceAvailable: boolean;
  textOnly: boolean;
  experimental: boolean;
  availability: TargetLanguageAvailability;
  translationModel: string | null;
  voiceId: string | null;
  license: string;
  commercialUse: 'allowed' | 'unknown' | 'restricted';
}

export type TargetLanguageOutputStatus =
  | 'unavailable'
  | 'queued'
  | 'translating'
  | 'captions-ready'
  | 'generating-audio'
  | 'ready'
  | 'failed';

export interface TargetLanguageOutput {
  language: string;
  status: TargetLanguageOutputStatus;
  translationProgressPct: number;
  audioProgressPct: number;
  captionsAvailable: boolean;
  audioAvailable: boolean;
  error: string | null;
}

export interface AiProviderStatusMetadata {
  worker: 'offline' | 'ready' | 'processing' | 'delayed' | 'failed';
  vad: 'inactive' | 'active' | 'fallback' | 'failed';
  transcription: 'idle' | 'loading' | 'ready' | 'processing' | 'failed';
  translation: 'idle' | 'loading' | 'ready' | 'processing' | 'failed';
  textToSpeech: 'idle' | 'loading' | 'ready' | 'text-only' | 'processing' | 'failed';
  lastError: string | null;
}
