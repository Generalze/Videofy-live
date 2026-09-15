/** @author masterzee001 */
/**
 * Google STT repo wiring, with no Google account, credential file or network.
 *
 * These tests prove the live recognizer path exists and is configured for the
 * currently supported Google live candidates: Hausa and Yoruba through
 * Speech-to-Text V2 / Chirp 3.
 *
 * Igbo remains a declared live-STT gap and must fail closed until a qualified
 * real-time recognizer exists. Accuracy, latency and route approval remain
 * separate qualification work.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  buildStreamingTranscriptionProvider,
  readLiveProviderEnv,
} from '../live-provider-wiring.js';
import {
  GOOGLE_STT_ENV_NAMES,
  GOOGLE_STT_LIVE_MODEL,
  GOOGLE_STT_SUPPORTED_LOCALES,
  GoogleCloudSttStreamingProvider,
  buildGoogleStreamingRecognitionConfig,
  createGoogleCloudSttProviderFromEnv,
  normalizeGoogleSttLocale,
  type GoogleSpeechStream,
  type GoogleSpeechStreamingClient,
} from '../providers/google/streaming-stt.js';
import type { protos } from '@google-cloud/speech';
import type { StreamingTranscriptionSignal } from '../streaming-transcription-provider.js';

type GoogleStreamingRecognizeRequest = protos.google.cloud.speech.v2.IStreamingRecognizeRequest;

type GoogleStreamingRecognizeResponse = protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

class FakeGoogleSpeechStream extends EventEmitter implements GoogleSpeechStream {
  readonly writes: GoogleStreamingRecognizeRequest[] = [];
  ended = false;
  destroyed = false;

  write(data: GoogleStreamingRecognizeRequest): boolean {
    this.writes.push(data);
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit('end');
  }

  destroy(error?: Error): void {
    this.destroyed = true;

    if (error !== undefined) {
      this.emit('error', error);
    }

    this.emit('close');
  }

  on(event: 'data', listener: (response: GoogleStreamingRecognizeResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close' | 'end', listener: () => void): this;

  // EventEmitter's implementation accepts an untyped variadic listener.
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emitResponse(response: GoogleStreamingRecognizeResponse): void {
    this.emit('data', response);
  }
}

class FakeGoogleSpeechClient implements GoogleSpeechStreamingClient {
  readonly stream = new FakeGoogleSpeechStream();

  openStreamingRecognize(): GoogleSpeechStream {
    return this.stream;
  }

  recognizerPath(project: string, location: string, recognizer: string): string {
    return `projects/${project}/locations/${location}/recognizers/${recognizer}`;
  }
}

function providerWith(fake: FakeGoogleSpeechClient): GoogleCloudSttStreamingProvider {
  return new GoogleCloudSttStreamingProvider({
    projectId: 'speech-project',
    location: 'us',
    recognizer: '_',
    model: 'chirp_3',
    quotaProjectId: 'quota-project',
    client: fake,
  });
}

describe('Google Cloud Speech-to-Text V2 / Chirp 3 live STT configuration', () => {
  it('declares only Hausa and Yoruba as Google live candidate locales', () => {
    expect(GOOGLE_STT_SUPPORTED_LOCALES).toEqual(['ha-NG', 'yo-NG']);

    expect(normalizeGoogleSttLocale('ha')).toBe('ha-NG');
    expect(normalizeGoogleSttLocale('ha-NG')).toBe('ha-NG');

    expect(normalizeGoogleSttLocale('yo')).toBe('yo-NG');
    expect(normalizeGoogleSttLocale('YO_ng')).toBe('yo-NG');
  });

  it('refuses Igbo rather than claiming unsupported Google live coverage', () => {
    expect(() => normalizeGoogleSttLocale('ig')).toThrow(/ha-NG and yo-NG only/u);

    expect(() => normalizeGoogleSttLocale('ig-NG')).toThrow(/ha-NG and yo-NG only/u);
  });

  it('keeps Pidgin unresolved and refuses unsupported source languages', async () => {
    const provider = providerWith(new FakeGoogleSpeechClient());

    await expect(
      provider.openStream({
        sessionId: 's1',
        streamId: 'st1',
        sourceLanguage: 'pcm',
        onSignal: () => {},
        onError: () => {},
      }),
    ).rejects.toThrow(/ha-NG and yo-NG only/u);
  });

  it('pins the current Google live model', () => {
    expect(GOOGLE_STT_LIVE_MODEL).toBe('chirp_3');
  });

  it('refuses a non-Chirp-3 model', () => {
    expect(
      () =>
        new GoogleCloudSttStreamingProvider({
          projectId: 'speech-project',
          location: 'us',
          recognizer: '_',
          model: 'chirp_2',
          client: new FakeGoogleSpeechClient(),
        }),
    ).toThrow(/GOOGLE_STT_MODEL=chirp_3/u);
  });

  it.each([
    ['ha-NG', 'ha-NG'],
    ['yo-NG', 'yo-NG'],
  ] as const)('builds a Chirp 3 streaming config for %s', (_source, expectedLocale) => {
    const config = buildGoogleStreamingRecognitionConfig({
      model: 'chirp_3',
      languageCode: expectedLocale,
      requestEndpointing: true,
    });

    expect(config.config?.languageCodes).toEqual([expectedLocale]);

    expect(config.config?.model).toBe('chirp_3');

    expect(config.config?.explicitDecodingConfig).toEqual({
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      audioChannelCount: 1,
    });

    expect(config.config?.features).toMatchObject({
      enableAutomaticPunctuation: true,
      maxAlternatives: 1,
    });

    expect(config.config?.features).not.toHaveProperty('enableWordConfidence');

    expect(config.streamingFeatures).toMatchObject({
      interimResults: true,
      enableVoiceActivityEvents: true,
    });
  });

  it('normalizes Google responses without inventing segment identity', async () => {
    const fake = new FakeGoogleSpeechClient();
    const signals: StreamingTranscriptionSignal[] = [];

    const session = await providerWith(fake).openStream({
      sessionId: 'sess_1',
      streamId: 'stream_1',
      sourceLanguage: 'yo',
      requestEndpointing: true,

      onSignal: (signal) => {
        signals.push(signal);
      },

      onError: (error) => {
        throw error;
      },
    });

    fake.stream.emitResponse({
      results: [
        {
          alternatives: [
            {
              transcript: 'mo ki yin',
              confidence: 0.87,
            },
          ],
          isFinal: false,
          resultEndOffset: {
            seconds: 1,
            nanos: 500_000_000,
          },
          languageCode: 'yo-NG',
        },
      ],
    });

    fake.stream.emitResponse({
      results: [
        {
          alternatives: [
            {
              transcript: 'mo ki yin',
              confidence: 0.91,
            },
          ],
          isFinal: true,
          resultEndOffset: {
            seconds: 2,
            nanos: 0,
          },
          languageCode: 'yo-NG',
        },
      ],
      speechEventType: 'SPEECH_ACTIVITY_END',
      speechEventOffset: {
        seconds: 2,
        nanos: 0,
      },
    });

    expect(signals).toEqual([
      {
        kind: 'partial',
        text: 'mo ki yin',
        providerEndMs: 1500,
        confidence: 0.87,
        detectedLanguage: 'yo-NG',
      },

      {
        kind: 'endpoint',
        providerEndMs: 2000,
      },

      {
        kind: 'final',
        text: 'mo ki yin',
        providerEndMs: 2000,
        confidence: 0.91,
        detectedLanguage: 'yo-NG',
      },
    ]);

    expect('segmentId' in signals[0]!).toBe(false);
    expect('revision' in signals[0]!).toBe(false);

    await session.close('done');

    expect(fake.stream.destroyed).toBe(true);
  });

  it('sends recognizer/config first, then platform PCM as little-endian LINEAR16 bytes', async () => {
    const fake = new FakeGoogleSpeechClient();

    const session = await providerWith(fake).openStream({
      sessionId: 'sess_1',
      streamId: 'stream_1',
      sourceLanguage: 'ha',
      onSignal: () => {},
      onError: () => {},
    });

    expect(fake.stream.writes[0]).toMatchObject({
      recognizer: 'projects/speech-project/locations/us/recognizers/_',

      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },

          model: 'chirp_3',
          languageCodes: ['ha-NG'],

          features: {
            enableAutomaticPunctuation: true,
            maxAlternatives: 1,
          },
        },

        streamingFeatures: {
          interimResults: true,
          enableVoiceActivityEvents: false,
        },
      },
    });

    await session.pushAudio({
      samples: Int16Array.from([1, -2, 256]),
      sampleRate: 16000,
      channelCount: 1,
      platformTimestampMs: 20,
    });

    expect([...((fake.stream.writes[1]?.audio as Uint8Array | undefined) ?? [])]).toEqual([
      1, 0, 254, 255, 0, 1,
    ]);

    await session.finish();

    expect(fake.stream.ended).toBe(true);
  });
});

describe('Google STT live provider wiring', () => {
  it('reads only non-secret Google STT config names from the live provider env', () => {
    const env = readLiveProviderEnv({
      GOOGLE_STT_PROJECT_ID: ' speech-project ',
      GOOGLE_STT_LOCATION: ' us ',
      GOOGLE_STT_RECOGNIZER: ' _ ',
      GOOGLE_STT_MODEL: ' chirp_3 ',
      GOOGLE_CLOUD_QUOTA_PROJECT: ' quota-project ',
    } as NodeJS.ProcessEnv);

    expect(env.googleSttProjectId).toBe('speech-project');
    expect(env.googleSttLocation).toBe('us');
    expect(env.googleSttRecognizer).toBe('_');
    expect(env.googleSttModel).toBe('chirp_3');
    expect(env.googleCloudQuotaProject).toBe('quota-project');

    expect(GOOGLE_STT_ENV_NAMES).toEqual([
      'GOOGLE_STT_PROJECT_ID',
      'GOOGLE_STT_LOCATION',
      'GOOGLE_STT_RECOGNIZER',
      'GOOGLE_STT_MODEL',
      'GOOGLE_CLOUD_QUOTA_PROJECT',
    ]);
  });

  it('builds the Deepgram/Google routed recognizer without replacing Deepgram selectors', () => {
    const provider = buildStreamingTranscriptionProvider(
      {
        streamingTranscriptionProvider: 'deepgram-google-stt',
      },

      readLiveProviderEnv({
        DEEPGRAM_API_KEY: 'test-key',
        GOOGLE_STT_PROJECT_ID: 'speech-project',
        GOOGLE_STT_LOCATION: 'us',
        GOOGLE_STT_RECOGNIZER: '_',
        GOOGLE_STT_MODEL: 'chirp_3',
      } as NodeJS.ProcessEnv),
    );

    expect(provider?.name).toContain('ha,yo -> google-cloud-stt:chirp_3');

    expect(provider?.name).toContain('en,es,fr,pt -> deepgram:nova-3');

    expect(provider?.name).toContain('ig,pcm -> unsupported');

    expect(
      buildStreamingTranscriptionProvider(
        {
          streamingTranscriptionProvider: 'deepgram-nova',
        },

        readLiveProviderEnv({
          DEEPGRAM_API_KEY: 'test-key',
        } as NodeJS.ProcessEnv),
      )?.name,
    ).toBe('deepgram:nova-3');
  });

  it('requires explicit Google STT project, location, recognizer and model when selected', () => {
    expect(() =>
      buildStreamingTranscriptionProvider(
        {
          streamingTranscriptionProvider: 'deepgram-google-stt',
        },

        readLiveProviderEnv({
          DEEPGRAM_API_KEY: 'test-key',
          GOOGLE_STT_PROJECT_ID: 'speech-project',
          GOOGLE_STT_LOCATION: 'us',
          GOOGLE_STT_RECOGNIZER: '_',
        } as NodeJS.ProcessEnv),
      ),
    ).toThrow(/GOOGLE_STT_MODEL/u);
  });

  it('refuses an unsupported Google model in the routed provider', () => {
    expect(() =>
      buildStreamingTranscriptionProvider(
        {
          streamingTranscriptionProvider: 'deepgram-google-stt',
        },

        readLiveProviderEnv({
          DEEPGRAM_API_KEY: 'test-key',
          GOOGLE_STT_PROJECT_ID: 'speech-project',
          GOOGLE_STT_LOCATION: 'us',
          GOOGLE_STT_RECOGNIZER: '_',
          GOOGLE_STT_MODEL: 'chirp_2',
        } as NodeJS.ProcessEnv),
      ),
    ).toThrow(/GOOGLE_STT_MODEL=chirp_3/u);
  });

  it('requires Deepgram for general live STT when the routed recognizer is selected', () => {
    expect(() =>
      buildStreamingTranscriptionProvider(
        {
          streamingTranscriptionProvider: 'deepgram-google-stt',
        },

        readLiveProviderEnv({
          GOOGLE_STT_PROJECT_ID: 'speech-project',
          GOOGLE_STT_LOCATION: 'us',
          GOOGLE_STT_RECOGNIZER: '_',
          GOOGLE_STT_MODEL: 'chirp_3',
        } as NodeJS.ProcessEnv),
      ),
    ).toThrow(/DEEPGRAM_API_KEY/u);
  });

  it('keeps the configured Deepgram adapter family for the routed general recognizer', () => {
    const provider = buildStreamingTranscriptionProvider(
      {
        streamingTranscriptionProvider: 'deepgram-google-stt',
      },

      readLiveProviderEnv({
        DEEPGRAM_API_KEY: 'test-key',
        DEEPGRAM_MODEL: 'flux-general-en',
        GOOGLE_STT_PROJECT_ID: 'speech-project',
        GOOGLE_STT_LOCATION: 'eu',
        GOOGLE_STT_RECOGNIZER: '_',
        GOOGLE_STT_MODEL: 'chirp_3',
      } as NodeJS.ProcessEnv),
    );

    expect(provider?.name).toContain('ha,yo -> google-cloud-stt:chirp_3');

    expect(provider?.name).toContain('en,es,fr,pt -> deepgram:flux-general-en');
  });

  it('constructs the provider from env only when the resource project is present', () => {
    expect(createGoogleCloudSttProviderFromEnv({} as NodeJS.ProcessEnv)).toBeNull();

    expect(
      createGoogleCloudSttProviderFromEnv({
        GOOGLE_STT_PROJECT_ID: 'speech-project',
        GOOGLE_STT_LOCATION: 'us',
        GOOGLE_STT_RECOGNIZER: '_',
        GOOGLE_STT_MODEL: 'chirp_3',
      } as NodeJS.ProcessEnv)?.name,
    ).toBe('google-cloud-stt:chirp_3');
  });
});
