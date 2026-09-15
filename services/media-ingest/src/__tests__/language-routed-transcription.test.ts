/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  DEEPGRAM_STT_SOURCE_LANGUAGES,
  GOOGLE_STT_SOURCE_LANGUAGES,
  UNSUPPORTED_STT_SOURCE_LANGUAGES,
  createLanguageRoutedTranscriptionProvider,
} from '../language-routed-transcription-provider.js';
import type {
  StreamingTranscriptionOptions,
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from '../streaming-transcription-provider.js';

class FakeSession implements StreamingTranscriptionSession {
  readonly isClosed = false;

  async pushAudio(): Promise<void> {}

  async finish(): Promise<void> {}

  async close(): Promise<void> {}
}

class FakeProvider implements StreamingTranscriptionProvider {
  readonly opened: StreamingTranscriptionOptions[] = [];

  constructor(readonly name: string) {}

  async openStream(options: StreamingTranscriptionOptions): Promise<StreamingTranscriptionSession> {
    this.opened.push(options);
    return new FakeSession();
  }
}

function request(sourceLanguage?: string): StreamingTranscriptionOptions {
  return {
    sessionId: 'session-1',
    streamId: 'stream-1',
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    sourceLanguageMode: 'manual',
    onSignal: () => {},
    onError: () => {},
  };
}

describe('language-routed live transcription provider', () => {
  it('publishes the corrected routing tables', () => {
    expect(GOOGLE_STT_SOURCE_LANGUAGES).toEqual(['ha', 'yo']);

    expect(DEEPGRAM_STT_SOURCE_LANGUAGES).toEqual(['en', 'es', 'fr', 'pt']);

    expect(UNSUPPORTED_STT_SOURCE_LANGUAGES).toEqual(['ig', 'pcm']);
  });

  it.each(['ha', 'ha-NG', 'yo', 'YO_ng'])('routes %s to Google STT', async (sourceLanguage) => {
    const deepgram = new FakeProvider('deepgram:nova-3');

    const google = new FakeProvider('google-cloud-stt:chirp_3');

    const routed = createLanguageRoutedTranscriptionProvider({
      deepgram,
      google,
    });

    const options = request(sourceLanguage);

    await routed.openStream(options);

    expect(google.opened).toEqual([options]);
    expect(deepgram.opened).toEqual([]);
  });

  it.each(['en', 'en-US', 'es', 'fr-FR', 'pt_BR'])(
    'keeps %s on the existing Deepgram recognizer',
    async (sourceLanguage) => {
      const deepgram = new FakeProvider('deepgram:nova-3');

      const google = new FakeProvider('google-cloud-stt:chirp_3');

      const routed = createLanguageRoutedTranscriptionProvider({
        deepgram,
        google,
      });

      const options = request(sourceLanguage);

      await routed.openStream(options);

      expect(deepgram.opened).toEqual([options]);
      expect(google.opened).toEqual([]);
    },
  );

  it.each(['ig', 'ig-NG', 'pcm', 'pcm-NG', 'de', ''])(
    'refuses unsupported source language %s without opening either provider',
    async (sourceLanguage) => {
      const deepgram = new FakeProvider('deepgram:nova-3');

      const google = new FakeProvider('google-cloud-stt:chirp_3');

      const routed = createLanguageRoutedTranscriptionProvider({
        deepgram,
        google,
      });

      await expect(routed.openStream(request(sourceLanguage))).rejects.toThrow(
        /unsupported|qualified routing table|source language is required/u,
      );

      expect(deepgram.opened).toEqual([]);
      expect(google.opened).toEqual([]);
    },
  );

  it('refuses an absent source language instead of choosing a fallback recognizer', async () => {
    const deepgram = new FakeProvider('deepgram:nova-3');

    const google = new FakeProvider('google-cloud-stt:chirp_3');

    const routed = createLanguageRoutedTranscriptionProvider({
      deepgram,
      google,
    });

    await expect(routed.openStream(request())).rejects.toThrow(/source language is required/u);

    expect(deepgram.opened).toEqual([]);
    expect(google.opened).toEqual([]);
  });

  it('publishes the exact routing table in the provider name', () => {
    const deepgram = new FakeProvider('deepgram:nova-3');

    const google = new FakeProvider('google-cloud-stt:chirp_3');

    const routed = createLanguageRoutedTranscriptionProvider({
      deepgram,
      google,
    });

    expect(routed.name).toContain(
      `${GOOGLE_STT_SOURCE_LANGUAGES.join(',')} -> google-cloud-stt:chirp_3`,
    );

    expect(routed.name).toContain(`${DEEPGRAM_STT_SOURCE_LANGUAGES.join(',')} -> deepgram:nova-3`);

    expect(routed.name).toContain(`${UNSUPPORTED_STT_SOURCE_LANGUAGES.join(',')} -> unsupported`);
  });
});
