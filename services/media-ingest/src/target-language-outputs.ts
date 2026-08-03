import type {
  TargetLanguageCapability,
  TargetLanguageOutput,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';

export function buildTargetLanguageOutputs(input: {
  selectedLanguages: readonly string[];
  catalogue: readonly TargetLanguageCapability[];
  translation: TranslationSessionMetadata;
  generatedAudio: TextToSpeechSessionMetadata;
}): TargetLanguageOutput[] {
  return input.selectedLanguages.map((language) => {
    const capability = input.catalogue.find((item) => item.language === language);
    const translationEvents = input.translation.events.filter(
      (event) => event.targetLanguage === language,
    );
    const translatedCount = translationEvents.filter(
      (event) => event.status === 'translated',
    ).length;
    const translationFailures = translationEvents.filter(
      (event) => event.status === 'failed',
    );
    const translationActive = translationEvents.some(
      (event) => event.status === 'translating' || event.status === 'retrying',
    );
    const audioEvents = input.generatedAudio.events.filter(
      (event) => event.targetLanguage === language,
    );
    const generatedCount = audioEvents.filter((event) => event.status === 'generated').length;
    const audioFailures = audioEvents.filter((event) => event.status === 'failed');
    const audioActive = audioEvents.some(
      (event) => event.status === 'generating' || event.status === 'retrying',
    );
    const translationTotal = translationEvents.length;
    const audioTotal = audioEvents.length;
    const captionsAvailable = translatedCount > 0;
    const audioAvailable = generatedCount > 0;
    const error = translationFailures[0]?.error ?? audioFailures[0]?.error ?? null;

    let status: TargetLanguageOutput['status'] = 'queued';
    if (!capability?.translationAvailable) {
      status = 'unavailable';
    } else if (translationFailures.length > 0 || audioFailures.length > 0) {
      status = 'failed';
    } else if (translationActive) {
      status = 'translating';
    } else if (translationTotal > 0 && translatedCount === translationTotal) {
      if (!capability.voiceAvailable) {
        status = 'captions-ready';
      } else if (audioTotal > 0 && generatedCount === audioTotal) {
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
      translationProgressPct: percentage(translatedCount, translationTotal),
      audioProgressPct: capability?.voiceAvailable
        ? percentage(generatedCount, audioTotal)
        : 0,
      captionsAvailable,
      audioAvailable,
      error,
    };
  });
}

function percentage(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}
