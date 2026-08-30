// Repository owner: masterzee001.
import type {
  AiProviderStatusMetadata,
  SourceLanguageControlMetadata,
  SourceLanguageMode,
  TargetLanguageCapability,
} from '@videofy-live/shared-types';
import {
  SELF_HOSTED_ENGINES,
  resolveLanguageCapabilities,
  type LanguageCapability,
} from '@videofy-live/ai-registry';
import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
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

/**
 * Which capability providers this deployment actually has, by ID.
 *
 * NAMES AND IDS ONLY. This reads whether a variable is SET; it never reads,
 * returns or logs a value, and no caller can obtain one through it.
 *
 * It exists because the resolver is pure and must stay pure, while the answer
 * the console needs is deployment-specific in exactly one place that matters:
 * without NAIJALINGO_API_KEY, Hausa, Igbo, Yoruba and Nigerian Pidgin are
 * served by a general voice vendor that returns confident, wrong audio. The
 * resolver can only mark that as degraded if somebody tells it which providers
 * are really there, and the environment is the only thing that knows.
 *
 * Local engines are listed unconditionally: they ship inside the image, so the
 * thing that can be missing is a credential, not a model.
 */
export function configuredCapabilityProviderIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const set = (name: string): boolean => (env[name]?.trim() ?? '') !== '';
  const configured: string[] = SELF_HOSTED_ENGINES.map((engine) => engine.engineId);
  if (set('DEEPGRAM_API_KEY')) configured.push('deepgram');
  if (set('ELEVENLABS_API_KEY')) configured.push('elevenlabs');
  if (set('AZURE_SPEECH_KEY') && set('AZURE_SPEECH_REGION')) configured.push('azure');
  if (set('NAIJALINGO_API_KEY')) configured.push('naijalingo');
  if (set('GOOGLE_TRANSLATE_PROJECT_ID')) configured.push('google-cloud');
  return configured;
}

export function buildTargetLanguageCatalogue(input: {
  supportedTranslationLanguages: readonly string[];
  supportedVoiceLanguages: readonly string[];
  opusMtModelIds?: ReadonlyMap<string, string>;
  voiceIds?: ReadonlyMap<string, string>;
  /**
   * Provider ids this deployment has configured. Defaults to reading which
   * credential NAMES are set, so a catalogue built without thinking about it
   * still tells the truth about the specialist.
   */
  configuredProviderIds?: readonly string[];
}): TargetLanguageCapability[] {
  const chain = new Map(
    resolveLanguageCapabilities({
      configuredProviderIds: input.configuredProviderIds ?? configuredCapabilityProviderIds(),
    }).map((capability) => [capability.code, capability]),
  );
  return listTargetLanguages(input).map((candidate) => {
    const evidence = chain.get(candidate.language);
    const translationAvailable = input.supportedTranslationLanguages.includes(candidate.language);
    const voiceAvailable = input.supportedVoiceLanguages.includes(candidate.language);
    const textOnly = translationAvailable && !voiceAvailable;
    const experimental = isExperimentalTarget(candidate.language, evidence);
    return {
      language: candidate.language,
      label: candidate.label,
      ...(candidate.nativeName === undefined ? {} : { nativeName: candidate.nativeName }),
      state: evidence?.state ?? 'unavailable',
      ...(evidence === undefined
        ? {}
        : {
            sourceState: evidence.sourceState,
            targetState: evidence.targetState,
            captionsOnly: evidence.captionsOnly,
          }),
      ...(evidence?.degraded === true ? { degraded: true } : {}),
      providers: evidence?.providers ?? {},
      ...(evidence?.reason === undefined ? {} : { reason: evidence.reason }),
      translationAvailable,
      voiceAvailable,
      textOnly,
      experimental,
      availability: voiceAvailable
        ? 'voice-available'
        : textOnly
          ? 'text-only'
          : translationAvailable
            ? 'translation-available'
            : experimental
              ? 'experimental'
              : 'unavailable',
      translationModel: input.opusMtModelIds?.get(candidate.language) ?? null,
      voiceId: input.voiceIds?.get(candidate.language) ?? null,
      license: TARGET_LICENSE_NOTES[candidate.language] ?? DEFAULT_TARGET_LICENSE_NOTE,
      commercialUse: 'unknown',
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

/**
 * Why the catalogue and not a private list: the ten-entry candidate table
 * that lived here was one of three drifting answers to "which languages can a
 * programme be translated into" (see ai-registry's resolver header). Every
 * catalogue language is now emitted so a picker can SHOW a language and refuse
 * to SELECT it; `availability` stays the deployment's own answer (env CSVs,
 * opus-mt routes, voice ids) and `state` carries the live chain's evidence.
 *
 * Two kinds of target sit outside the catalogue and still appear, after it:
 * anything this deployment's env enables that the catalogue does not list
 * (a configured language must never vanish from the picker), and Latin -- a
 * partner-preview target since P6.1 that a catalogue ranked by living-speaker
 * reach will never carry. Both are pinned by tests.
 */
interface TargetLanguageCandidate {
  readonly language: string;
  readonly label: string;
  readonly nativeName?: string;
}

const OUTSIDE_CATALOGUE_TARGETS: readonly TargetLanguageCandidate[] = [
  { language: 'la', label: 'Latin', nativeName: 'Latina' },
];

function listTargetLanguages(input: {
  supportedTranslationLanguages: readonly string[];
  supportedVoiceLanguages: readonly string[];
}): TargetLanguageCandidate[] {
  const candidates: TargetLanguageCandidate[] = LANGUAGE_CATALOGUE.map((language) => ({
    language: language.code,
    label: language.englishName,
    nativeName: language.nativeName,
  }));
  const seen = new Set(candidates.map((candidate) => candidate.language));
  for (const extra of OUTSIDE_CATALOGUE_TARGETS) {
    if (seen.has(extra.language)) continue;
    seen.add(extra.language);
    candidates.push(extra);
  }
  for (const language of [...input.supportedTranslationLanguages, ...input.supportedVoiceLanguages]) {
    if (seen.has(language)) continue;
    seen.add(language);
    candidates.push({ language, label: language });
  }
  return candidates;
}

/**
 * `experimental` marks a language a partner may evaluate before this
 * deployment enables it. The P6.1 preview set keeps its flag (it is what the
 * partner tests were written against); beyond it, a language the live chain
 * has at least a vendor claim for is worth a look, and one with no provider
 * at any stage is plainly unavailable. English, Spanish and French were never
 * flagged: when unconfigured they are unavailable, not experimental.
 */
const NEVER_EXPERIMENTAL: ReadonlySet<string> = new Set(['en', 'es', 'fr']);
const PREVIEW_EXPERIMENTAL: ReadonlySet<string> = new Set(['yo', 'pt', 'zh', 'ar', 'ru', 'el', 'la']);

function isExperimentalTarget(language: string, evidence: LanguageCapability | undefined): boolean {
  if (NEVER_EXPERIMENTAL.has(language)) return false;
  if (PREVIEW_EXPERIMENTAL.has(language)) return true;
  return evidence !== undefined && evidence.state !== 'unavailable';
}

const DEFAULT_TARGET_LICENSE_NOTE = 'Translation and voice model-dependent; validate before partner use';

const TARGET_LICENSE_NOTES: Readonly<Record<string, string>> = {
  en: 'OPUS-MT (Apache-2.0); current English Piper voices CC-BY-NC-SA-4.0 — development/demo only',
  yo: 'Model-dependent; validate before partner use',
  pt: 'OPUS-MT / Piper model-dependent',
  es: 'OPUS-MT / Piper model-dependent',
  fr: 'OPUS-MT / Piper model-dependent',
  zh: 'Translation and voice model-dependent',
  ar: 'OPUS-MT (Apache-2.0/CC) model-dependent; validate before partner use',
  ru: 'OPUS-MT / NLLB-200 (CC-BY-NC-4.0) model-dependent; validate before partner use',
  el: 'OPUS-MT / NLLB-200 (CC-BY-NC-4.0) model-dependent; validate before partner use',
  la: 'Translation and voice model-dependent',
};
