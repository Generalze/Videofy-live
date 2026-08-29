/** @owner masterzee001 */
import {
  resolveLegacyProgrammeListenerOutputPolicy,
  type LegacyProgrammeListenerOutputDecision,
} from '@videofy-live/language-router';
import { lookupLanguage } from '@videofy-live/language-catalogue';
import type {
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TargetLanguageCapability,
  TargetLanguageOutput,
  TargetLanguageOutputStatus,
} from '@videofy-live/shared-types';
import { phraseFromTimestampedEvent } from './listenerCaptions';

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
  /** Endonym, when known; the picker shows it beside the English name. */
  nativeName?: string;
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
    ...uniqueCodes.map((code) => {
      const nativeName = viewerLanguageNativeName(code, catalogue);
      return {
        code,
        label: viewerLanguageLabel(code, catalogue),
        ...(nativeName === undefined ? {} : { nativeName }),
      };
    }),
  ];
}

/**
 * Names come from the shared catalogue, the same source the server's own
 * catalogue labels are built from, so the picker and the operator console
 * never disagree about what a code is called. A server-supplied label still
 * wins: a deployment may narrow a name ("Espanol (Latinoamerica)"). Codes the
 * catalogue does not know fall through to the browser's own display names,
 * and last of all to the code itself, so a viewer is never shown nothing.
 */

export function viewerLanguageLabel(
  code: string,
  catalogue?: readonly ViewerLanguageOption[],
): string {
  const catalogueLabel = catalogue?.find((entry) => entry.code === code)?.label;
  if (catalogueLabel) return catalogueLabel;
  const sharedName = lookupLanguage(code)?.englishName;
  if (sharedName) return sharedName;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function viewerLanguageNativeName(
  code: string,
  catalogue?: readonly ViewerLanguageOption[],
): string | undefined {
  const served = catalogue?.find((entry) => entry.code === code)?.nativeName;
  if (served) return served;
  return lookupLanguage(code)?.nativeName;
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

/**
 * The session's own target list. There is no built-in fallback language any
 * more: before the session reports its targets the viewer has only the
 * original channel, and the first ENABLED target is adopted when it arrives
 * (see listenerDefaults). A caller that still wants a placeholder passes one.
 */
export function targetLanguagesForSession(
  state: MediaStateEvent | null,
  fallback?: string,
): string[] {
  if (state?.translatedLanguages && state.translatedLanguages.length > 0) {
    return state.translatedLanguages;
  }
  return fallback === undefined ? [] : [fallback];
}
