/** @owner masterzee001 */
import {
  resolveLegacyProgrammeListenerOutputPolicy,
  type LegacyProgrammeListenerOutputDecision,
} from '@videofy-live/language-router';
import type {
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TargetLanguageCapability,
  TargetLanguageOutput,
  TargetLanguageOutputStatus,
} from '@videofy-live/shared-types';
import { phraseFromTimestampedEvent } from './listenerCaptions';

export const VIEWER_LANGUAGE_CATALOGUE = [
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'la', label: 'Latin' },
] as const;

export const ORIGINAL_LANGUAGE_SELECTION = 'original';

export const ORIGINAL_VIEWER_LANGUAGE = {
  code: ORIGINAL_LANGUAGE_SELECTION,
  label: 'Original',
} as const;

export interface ListenerCaptionPhrase {
  id: string;
  translatedText: string;
  sourceText: string;
  sequence: number;
  startMs: number;
  endMs: number;
  receivedAt: number;
}

export function phrasesForLanguage(
  mediaState: MediaStateEvent | null,
  targetLanguage: string,
): ListenerCaptionPhrase[] {
  const events = mediaState?.translation?.events ?? [];
  if (isOriginalLanguageSelection(targetLanguage)) {
    const uniqueSegments = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.status === 'translated' && !uniqueSegments.has(event.segmentId)) {
        uniqueSegments.set(event.segmentId, event);
      }
    }
    return [...uniqueSegments.values()]
      .map((event) => phraseFromTimestampedEvent(event, targetLanguage))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, 100);
  }
  return events
    .filter(
      (event) =>
        event.targetLanguage === targetLanguage && event.status === 'translated',
    )
    .map((event) => phraseFromTimestampedEvent(event, targetLanguage))
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, 100);
}

export interface ViewerLanguageOption {
  code: string;
  label: string;
}

export function availableViewerLanguages(
  targetLanguages: readonly string[],
  catalogue?: readonly ViewerLanguageOption[],
): ViewerLanguageOption[] {
  const uniqueCodes = [...new Set(targetLanguages)].filter(
    (code) => !isOriginalLanguageSelection(code),
  );
  return [
    ORIGINAL_VIEWER_LANGUAGE,
    ...uniqueCodes.map((code) => ({
      code,
      label: viewerLanguageLabel(code, catalogue),
    })),
  ];
}

function viewerLanguageLabel(
  code: string,
  catalogue: readonly ViewerLanguageOption[] | undefined,
): string {
  const catalogueLabel = catalogue?.find((entry) => entry.code === code)?.label;
  if (catalogueLabel) return catalogueLabel;
  const staticLabel = VIEWER_LANGUAGE_CATALOGUE.find(
    (entry) => entry.code === code,
  )?.label;
  if (staticLabel) return staticLabel;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function isOriginalLanguageSelection(language: string): boolean {
  return language === ORIGINAL_LANGUAGE_SELECTION;
}

export function requiresOriginalAudio(
  capability: TargetLanguageCapability | undefined,
  output: TargetLanguageOutput | undefined,
): boolean {
  return capability?.textOnly === true || output?.audioAvailable !== true;
}

/** Bridges real legacy listener state into the shared recipient policy engine. */
export function resolveLegacyListenerOutputDecision(input: {
  sourceLanguage: string;
  selectedLanguage: string;
  subtitlesEnabled: boolean;
  mix: { mode: 'interpretation' | 'replacement'; originalVolume: number; translatedVolume: number };
  originalMediaAvailable: boolean;
  originalCaptionsAvailable: boolean;
  capability: TargetLanguageCapability | undefined;
  output: TargetLanguageOutput | undefined;
  deliveredAudio: GeneratedAudioReadyEvent | undefined;
}): LegacyProgrammeListenerOutputDecision {
  return resolveLegacyProgrammeListenerOutputPolicy({
    sourceLanguage: input.sourceLanguage,
    selectedLanguage: input.selectedLanguage,
    subtitlesEnabled: input.subtitlesEnabled,
    mix: input.mix,
    originalMediaAvailable: input.originalMediaAvailable,
    originalCaptionsAvailable: input.originalCaptionsAvailable,
    capability: input.capability,
    output: input.output,
    ...(input.deliveredAudio === undefined
      ? {}
      : { deliveredGeneratedAudio: { voiceId: input.deliveredAudio.voiceId } }),
  });
}

export function shouldMergeGeneratedCaption(
  selectedLanguage: string,
  eventTargetLanguage: string,
): boolean {
  // Same language gate the generated-audio enqueue uses: a caption for
  // another listener's language must never enter this viewer's phrase list.
  // The original channel accepts every language because it captions the
  // shared source text, deduplicated by segment id.
  return (
    isOriginalLanguageSelection(selectedLanguage) ||
    eventTargetLanguage === selectedLanguage
  );
}

export function generatedAudioForLanguage(
  events: readonly GeneratedAudioReadyEvent[],
  targetLanguage: string,
): GeneratedAudioReadyEvent[] {
  return events.filter((event) => event.targetLanguage === targetLanguage);
}

export function describeLanguageOutput(status: TargetLanguageOutputStatus): string {
  switch (status) {
    case 'ready':
      return 'Audio and captions ready';
    case 'captions-ready':
      return 'Captions only';
    case 'generating-audio':
      return 'Preparing translated audio';
    case 'translating':
      return 'Preparing captions';
    case 'failed':
      return 'Unavailable for this programme';
    case 'unavailable':
      return 'Not configured';
    default:
      return 'Queued';
  }
}

export function targetLanguagesForSession(
  state: MediaStateEvent | null,
  fallback: string,
): string[] {
  return state?.translatedLanguages && state.translatedLanguages.length > 0
    ? state.translatedLanguages
    : [fallback];
}
