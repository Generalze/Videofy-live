/** @author masterzee001 */
/**
 * Source-language routing for live STT.
 *
 * This is deliberately a thin router around existing recognizers. It does not
 * normalize vendor events, mint segment identity, or rewrite stream options.
 * The selected provider still owns only recognizer-specific normalization; the
 * Videofy coordinator remains the only segment authority.
 */
import type {
  StreamingTranscriptionOptions,
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from './streaming-transcription-provider.js';

export const GOOGLE_STT_SOURCE_LANGUAGES = ['ha', 'ig', 'yo'] as const;
export const DEEPGRAM_STT_SOURCE_LANGUAGES = ['en', 'es', 'fr', 'pt'] as const;
export const UNSUPPORTED_STT_SOURCE_LANGUAGES = ['pcm'] as const;

export interface TranscriptionRouteObservation {
  readonly requestedLanguage: string;
  readonly matchedLanguage: string;
  readonly servedBy: string;
}

export interface LanguageRoutedTranscriptionOptions {
  readonly google: StreamingTranscriptionProvider;
  readonly deepgram: StreamingTranscriptionProvider;
  readonly onRoute?: (observation: TranscriptionRouteObservation) => void;
}

export function baseTranscriptionLanguage(tag: string | undefined): string {
  return (tag ?? '').trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

export function createLanguageRoutedTranscriptionProvider(
  options: LanguageRoutedTranscriptionOptions,
): StreamingTranscriptionProvider {
  const googleLanguages = new Set<string>(GOOGLE_STT_SOURCE_LANGUAGES);
  const deepgramLanguages = new Set<string>(DEEPGRAM_STT_SOURCE_LANGUAGES);
  const unsupportedLanguages = new Set<string>(UNSUPPORTED_STT_SOURCE_LANGUAGES);

  return {
    name:
      `routed-stt(${GOOGLE_STT_SOURCE_LANGUAGES.join(',')} -> ${options.google.name}; ` +
      `${DEEPGRAM_STT_SOURCE_LANGUAGES.join(',')} -> ${options.deepgram.name}; ` +
      `${UNSUPPORTED_STT_SOURCE_LANGUAGES.join(',')} -> unsupported)`,

    async openStream(
      streamOptions: StreamingTranscriptionOptions,
    ): Promise<StreamingTranscriptionSession> {
      const requestedLanguage = streamOptions.sourceLanguage?.trim() ?? '';
      const language = baseTranscriptionLanguage(requestedLanguage);
      if (language === '') {
        throw new Error(
          'Live STT source language is required when STREAMING_TRANSCRIPTION_PROVIDER=' +
            'deepgram-google-stt. Refusing to choose a recognizer without a source language.',
        );
      }
      if (unsupportedLanguages.has(language)) {
        throw new Error(
          `Live STT source language "${requestedLanguage}" is unsupported/unqualified for ` +
            'programme and call live surfaces.',
        );
      }

      const provider = googleLanguages.has(language)
        ? options.google
        : deepgramLanguages.has(language)
          ? options.deepgram
          : null;
      if (provider === null) {
        throw new Error(
          `Live STT source language "${requestedLanguage}" is not in the qualified routing ` +
            `table (${[...googleLanguages, ...deepgramLanguages].sort().join(', ')}).`,
        );
      }

      options.onRoute?.({
        requestedLanguage,
        matchedLanguage: language,
        servedBy: provider.name,
      });
      return provider.openStream(streamOptions);
    },
  };
}
