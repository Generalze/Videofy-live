import type { TimestampedTranslationEvent } from '@videofy-live/shared-types';
import type { ListenerCaptionPhrase } from './listenerLanguageSelection';

const ORIGINAL_LANGUAGE_SELECTION = 'original';
const MAX_MERGED_CAPTION_PHRASES = 500;
const MIN_CAPTION_DISPLAY_MS = 1_500;
const MAX_CAPTION_DISPLAY_MS = 7_000;

export function captionPhraseId(
  sessionId: string,
  segmentId: string,
  selectedLanguage: string,
): string {
  const languageSuffix =
    selectedLanguage === ORIGINAL_LANGUAGE_SELECTION
      ? ORIGINAL_LANGUAGE_SELECTION
      : selectedLanguage;
  return `${sessionId}-${segmentId}-${languageSuffix}`;
}

export function phraseFromTimestampedEvent(
  event: TimestampedTranslationEvent,
  selectedLanguage: string,
): ListenerCaptionPhrase {
  const viewingOriginal = selectedLanguage === ORIGINAL_LANGUAGE_SELECTION;
  return {
    id: captionPhraseId(event.sessionId, event.segmentId, selectedLanguage),
    translatedText: viewingOriginal ? event.sourceText : event.translatedText,
    sourceText: viewingOriginal ? '' : event.sourceText,
    sequence: event.sequence,
    startMs: event.startMs,
    endMs: event.endMs,
    receivedAt: Date.parse(event.createdAt),
  };
}

export function mergeCaptionPhrases(
  existing: readonly ListenerCaptionPhrase[],
  incoming: readonly ListenerCaptionPhrase[],
): ListenerCaptionPhrase[] {
  const phrasesById = new Map<string, ListenerCaptionPhrase>();
  for (const phrase of existing) {
    phrasesById.set(phrase.id, phrase);
  }
  for (const phrase of incoming) {
    phrasesById.set(phrase.id, phrase);
  }
  return [...phrasesById.values()]
    .sort((a, b) => a.sequence - b.sequence || a.startMs - b.startMs)
    .slice(-MAX_MERGED_CAPTION_PHRASES);
}

export function filterCaptionPhrasesForLanguage(
  phrases: readonly ListenerCaptionPhrase[],
  selectedLanguage: string,
): ListenerCaptionPhrase[] {
  // captionPhraseId embeds the language as the trailing "-<language>" segment,
  // so a language switch can drop every phrase that belongs to another
  // channel (original-channel entries survive only the original selection).
  const languageSuffix = `-${selectedLanguage}`;
  return phrases.filter((phrase) => phrase.id.endsWith(languageSuffix));
}

export function captionDisplayEndMs(
  phrase: Pick<ListenerCaptionPhrase, 'startMs' | 'endMs'>,
): number {
  return Math.max(
    phrase.startMs + MIN_CAPTION_DISPLAY_MS,
    Math.min(phrase.endMs, phrase.startMs + MAX_CAPTION_DISPLAY_MS),
  );
}

export function selectActiveCaption(
  phrases: readonly ListenerCaptionPhrase[],
  clockMs: number,
): ListenerCaptionPhrase | null {
  let active: ListenerCaptionPhrase | null = null;
  for (const phrase of phrases) {
    if (clockMs < phrase.startMs || clockMs > captionDisplayEndMs(phrase)) {
      continue;
    }
    if (!active || phrase.startMs >= active.startMs) {
      active = phrase;
    }
  }
  return active;
}
