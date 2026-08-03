import type {
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TargetLanguageCapability,
  TargetLanguageOutput,
  TargetLanguageOutputStatus,
} from '@videofy-live/shared-types';

export const VIEWER_LANGUAGE_CATALOGUE = [
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'la', label: 'Latin' },
] as const;

export function availableViewerLanguages(targetLanguages: readonly string[]) {
  return VIEWER_LANGUAGE_CATALOGUE.filter((language) =>
    targetLanguages.includes(language.code),
  );
}

export function requiresOriginalAudio(
  capability: TargetLanguageCapability | undefined,
  output: TargetLanguageOutput | undefined,
): boolean {
  return capability?.textOnly === true || output?.audioAvailable !== true;
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
