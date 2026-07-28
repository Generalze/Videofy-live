import type {
  AiProviderStatusMetadata,
  SourceLanguageControlMetadata,
  SourceLanguageMode,
  TargetLanguageCapability,
} from '@videofy-live/shared-types';
import { MediaIngestError } from './ingest-error.js';

export interface SourceLanguageControlInput {
  sourceLanguage?: string;
  sourceLanguageMode?: SourceLanguageMode;
  sourceLanguageLocked?: boolean;
  confidenceThreshold?: number;
}

export type SourceLanguageAction =
  | 'confirm'
  | 'reject'
  | 'override'
  | 'lock'
  | 'unlock'
  | 'detect-again';

export interface SourceLanguageActionInput {
  action: SourceLanguageAction;
  language?: string;
}

export interface DetectionInput {
  language: string;
  confidence: number | null;
}

export function createInitialSourceLanguageControl(
  input: SourceLanguageControlInput = {},
): SourceLanguageControlMetadata {
  const language = normalizeLanguage(input.sourceLanguage ?? 'en');
  const mode = input.sourceLanguageMode ?? 'manual';
  const now = new Date().toISOString();
  return {
    defaultLanguage: 'en',
    activeLanguage: language,
    mode,
    status: input.sourceLanguageLocked ? 'locked' : mode === 'manual' ? 'manual' : 'detecting',
    detectedLanguage: null,
    detectionConfidence: null,
    confirmedLanguage: mode === 'manual' ? language : null,
    rejectedLanguage: null,
    locked: input.sourceLanguageLocked ?? false,
    revision: 0,
    confidenceThreshold: clampConfidence(input.confidenceThreshold ?? 0.82),
    updatedAt: now,
  };
}

export function applySourceLanguageDetection(
  current: SourceLanguageControlMetadata,
  detection: DetectionInput,
): SourceLanguageControlMetadata {
  if (current.locked || current.mode === 'manual') return current;
  const detectedLanguage = normalizeLanguage(detection.language || 'und');
  const confidence =
    typeof detection.confidence === 'number' && Number.isFinite(detection.confidence)
      ? clampConfidence(detection.confidence)
      : null;
  if (detectedLanguage === 'und') {
    return {
      ...current,
      detectedLanguage,
      detectionConfidence: confidence,
      status: 'detecting',
      updatedAt: new Date().toISOString(),
    };
  }
  if (confidence !== null && confidence < current.confidenceThreshold) {
    return {
      ...current,
      detectedLanguage,
      detectionConfidence: confidence,
      status: 'needs-confirmation',
      updatedAt: new Date().toISOString(),
    };
  }
  return confirmSourceLanguage(current, detectedLanguage, confidence);
}

export function applySourceLanguageAction(
  current: SourceLanguageControlMetadata,
  input: SourceLanguageActionInput,
): SourceLanguageControlMetadata {
  switch (input.action) {
    case 'confirm':
      return confirmSourceLanguage(current, input.language ?? current.detectedLanguage ?? current.activeLanguage, current.detectionConfidence);
    case 'reject':
      return {
        ...current,
        rejectedLanguage: normalizeLanguage(input.language ?? current.detectedLanguage ?? current.activeLanguage),
        status: 'rejected',
        updatedAt: new Date().toISOString(),
      };
    case 'override':
      return manualOverrideSourceLanguage(current, requireActionLanguage(input));
    case 'lock':
      return {
        ...current,
        locked: true,
        status: 'locked',
        updatedAt: new Date().toISOString(),
      };
    case 'unlock':
      return {
        ...current,
        locked: false,
        mode: 'auto-detect',
        status: 'detecting',
        updatedAt: new Date().toISOString(),
      };
    case 'detect-again':
      return {
        ...current,
        mode: 'auto-detect',
        locked: false,
        status: 'detecting',
        detectedLanguage: null,
        detectionConfidence: null,
        updatedAt: new Date().toISOString(),
      };
    default:
      throw new MediaIngestError('Unsupported source-language action.', 'invalid-transition', 400);
  }
}

export function buildTargetLanguageCatalogue(input: {
  supportedTranslationLanguages: readonly string[];
  supportedVoiceLanguages: readonly string[];
  opusMtModelIds?: ReadonlyMap<string, string>;
  voiceIds?: ReadonlyMap<string, string>;
}): TargetLanguageCapability[] {
  return TARGET_LANGUAGE_CANDIDATES.map((candidate) => {
    const translationAvailable = input.supportedTranslationLanguages.includes(candidate.language);
    const voiceAvailable = input.supportedVoiceLanguages.includes(candidate.language);
    const textOnly = translationAvailable && !voiceAvailable;
    return {
      ...candidate,
      translationAvailable,
      voiceAvailable,
      textOnly,
      availability: voiceAvailable
        ? 'voice-available'
        : textOnly
          ? 'text-only'
          : translationAvailable
            ? 'translation-available'
            : candidate.experimental
              ? 'experimental'
              : 'unavailable',
      translationModel: input.opusMtModelIds?.get(candidate.language) ?? null,
      voiceId: input.voiceIds?.get(candidate.language) ?? null,
    };
  });
}

export function defaultAiProviderStatus(): AiProviderStatusMetadata {
  return {
    worker: 'ready',
    vad: 'fallback',
    transcription: 'ready',
    translation: 'ready',
    textToSpeech: 'ready',
    lastError: null,
  };
}

function confirmSourceLanguage(
  current: SourceLanguageControlMetadata,
  language: string,
  confidence: number | null,
): SourceLanguageControlMetadata {
  const nextLanguage = normalizeLanguage(language);
  const changed = nextLanguage !== current.activeLanguage;
  return {
    ...current,
    activeLanguage: nextLanguage,
    detectedLanguage: nextLanguage,
    detectionConfidence: confidence,
    confirmedLanguage: nextLanguage,
    rejectedLanguage: null,
    status: current.locked ? 'locked' : 'confirmed',
    revision: changed ? current.revision + 1 : current.revision,
    updatedAt: new Date().toISOString(),
  };
}

function manualOverrideSourceLanguage(
  current: SourceLanguageControlMetadata,
  language: string,
): SourceLanguageControlMetadata {
  const nextLanguage = normalizeLanguage(language);
  const changed = nextLanguage !== current.activeLanguage || current.mode !== 'manual';
  return {
    ...current,
    activeLanguage: nextLanguage,
    mode: 'manual',
    status: current.locked ? 'locked' : 'manual',
    detectedLanguage: current.detectedLanguage,
    confirmedLanguage: nextLanguage,
    rejectedLanguage: null,
    revision: changed ? current.revision + 1 : current.revision,
    updatedAt: new Date().toISOString(),
  };
}

function requireActionLanguage(input: SourceLanguageActionInput): string {
  if (!input.language?.trim()) {
    throw new MediaIngestError('Source-language override requires a language.', 'invalid-transition', 400);
  }
  return input.language;
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(normalized) && normalized !== 'und') {
    throw new MediaIngestError(`Unsupported source language: ${language}.`, 'unsupported-language', 400);
  }
  return normalized;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const TARGET_LANGUAGE_CANDIDATES = [
  {
    language: 'yo',
    label: 'Yoruba',
    experimental: true,
    license: 'Model-dependent; validate before partner use',
    commercialUse: 'unknown' as const,
  },
  {
    language: 'pt',
    label: 'Portuguese',
    experimental: true,
    license: 'OPUS-MT / Piper model-dependent',
    commercialUse: 'unknown' as const,
  },
  {
    language: 'es',
    label: 'Spanish',
    experimental: false,
    license: 'OPUS-MT / Piper model-dependent',
    commercialUse: 'unknown' as const,
  },
  {
    language: 'fr',
    label: 'French',
    experimental: false,
    license: 'OPUS-MT / Piper model-dependent',
    commercialUse: 'unknown' as const,
  },
] as const;
