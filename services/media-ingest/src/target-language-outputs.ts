import type {
  TargetLanguageCapability,
  TargetLanguageOutput,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';

/**
 * Per-language aggregate of output events. Maintained incrementally by the
 * session store where events transition so broadcast-time consumers do not
 * have to rescan the full event history on every emit.
 */
export interface TargetLanguageOutputTally {
  totalSegments: number;
  completedSegments: number;
  failedSegments: number;
  activeSegments: number;
  lastError: string | null;
}

export interface SessionTargetLanguageTallies {
  translation: ReadonlyMap<string, TargetLanguageOutputTally>;
  generatedAudio: ReadonlyMap<string, TargetLanguageOutputTally>;
}

export function emptyTargetLanguageOutputTally(): TargetLanguageOutputTally {
  return {
    totalSegments: 0,
    completedSegments: 0,
    failedSegments: 0,
    activeSegments: 0,
    lastError: null,
  };
}

/**
 * Broadcast MEDIA_STATE events carry only the most recent slice of the event
 * history; listeners merge incrementally and rely on the aggregate counts for
 * totals. The full history stays available on the session record itself.
 */
export const MEDIA_STATE_EVENT_HISTORY_LIMIT = 200;

/** Keeps the most recent `limit` events (events are ordered oldest-first). */
export function capRecentEvents<T>(
  events: readonly T[],
  limit = MEDIA_STATE_EVENT_HISTORY_LIMIT,
): T[] {
  return events.length <= limit ? [...events] : events.slice(-limit);
}

/**
 * Keeps the most recent `limit` events per target language while preserving
 * the original ordering (events are ordered oldest-first).
 */
export function capRecentEventsPerLanguage<T extends { targetLanguage: string }>(
  events: readonly T[],
  limit = MEDIA_STATE_EVENT_HISTORY_LIMIT,
): T[] {
  if (events.length <= limit) return [...events];
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const count = counts.get(event.targetLanguage) ?? 0;
    if (count < limit) {
      counts.set(event.targetLanguage, count + 1);
      kept.push(event);
    }
  }
  return kept.reverse();
}

export function buildTargetLanguageOutputs(input: {
  selectedLanguages: readonly string[];
  catalogue: readonly TargetLanguageCapability[];
  translation: TranslationSessionMetadata;
  generatedAudio: TextToSpeechSessionMetadata;
  /**
   * Incrementally maintained per-language counters. When provided the output
   * is derived in O(languages) without rescanning the event arrays.
   */
  tallies?: SessionTargetLanguageTallies;
}): TargetLanguageOutput[] {
  return input.selectedLanguages.map((language) => {
    const capability = input.catalogue.find((item) => item.language === language);
    const translationTally = input.tallies
      ? (input.tallies.translation.get(language) ?? emptyTargetLanguageOutputTally())
      : tallyTranslationEvents(input.translation, language);
    const audioTally = input.tallies
      ? (input.tallies.generatedAudio.get(language) ?? emptyTargetLanguageOutputTally())
      : tallyGeneratedAudioEvents(input.generatedAudio, language);
    const translationActive = translationTally.activeSegments > 0;
    const audioActive = audioTally.activeSegments > 0;
    const captionsAvailable = translationTally.completedSegments > 0;
    const audioAvailable = audioTally.completedSegments > 0;
    const error =
      translationTally.failedSegments > 0
        ? translationTally.lastError
        : audioTally.failedSegments > 0
          ? audioTally.lastError
          : null;

    let status: TargetLanguageOutput['status'] = 'queued';
    if (!capability?.translationAvailable) {
      status = 'unavailable';
    } else if (translationTally.failedSegments > 0 || audioTally.failedSegments > 0) {
      status = 'failed';
    } else if (translationActive) {
      status = 'translating';
    } else if (
      translationTally.totalSegments > 0 &&
      translationTally.completedSegments === translationTally.totalSegments
    ) {
      if (!capability.voiceAvailable) {
        status = 'captions-ready';
      } else if (
        audioTally.totalSegments > 0 &&
        audioTally.completedSegments === audioTally.totalSegments
      ) {
        status = 'ready';
      } else {
        status = 'generating-audio';
      }
    } else if (audioActive) {
      status = 'generating-audio';
    }

    return {
      language,
      status,
      translationProgressPct: percentage(
        translationTally.completedSegments,
        translationTally.totalSegments,
      ),
      audioProgressPct: capability?.voiceAvailable
        ? percentage(audioTally.completedSegments, audioTally.totalSegments)
        : 0,
      captionsAvailable,
      audioAvailable,
      error,
    };
  });
}

function tallyTranslationEvents(
  translation: TranslationSessionMetadata,
  language: string,
): TargetLanguageOutputTally {
  const tally = emptyTargetLanguageOutputTally();
  for (const event of translation.events) {
    if (event.targetLanguage !== language) continue;
    tally.totalSegments += 1;
    if (event.status === 'translated') tally.completedSegments += 1;
    else if (event.status === 'failed') {
      tally.failedSegments += 1;
      if (tally.lastError === null) tally.lastError = event.error ?? null;
    } else if (event.status === 'translating' || event.status === 'retrying') {
      tally.activeSegments += 1;
    }
  }
  return tally;
}

function tallyGeneratedAudioEvents(
  generatedAudio: TextToSpeechSessionMetadata,
  language: string,
): TargetLanguageOutputTally {
  const tally = emptyTargetLanguageOutputTally();
  for (const event of generatedAudio.events) {
    if (event.targetLanguage !== language) continue;
    tally.totalSegments += 1;
    if (event.status === 'generated') tally.completedSegments += 1;
    else if (event.status === 'failed') {
      tally.failedSegments += 1;
      if (tally.lastError === null) tally.lastError = event.error ?? null;
    } else if (event.status === 'generating' || event.status === 'retrying') {
      tally.activeSegments += 1;
    }
  }
  return tally;
}

function percentage(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}
