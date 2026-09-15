/** @author masterzee001 */
/**
 * Google Cloud Speech-to-Text V2 / Chirp, normalized into Videofy's live STT
 * contract.
 *
 * This is the REPO-SIDE live path only. It proves the runtime can construct a
 * Google STT stream for Hausa, Igbo and Yoruba with ADC-backed authentication
 * and explicit non-secret resource/model configuration. It does not benchmark
 * accuracy and does not approve any route.
 *
 * Google V2 streaming uses gRPC, not REST. The production boundary is the
 * official `@google-cloud/speech` V2 client; tests inject the tiny stream shape
 * below so they never contact Google or read credentials.
 */
import type { protos, v2 } from '@google-cloud/speech';
import type {
  StreamingTranscriptionFrame,
  StreamingTranscriptionOptions,
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from '../../streaming-transcription-provider.js';
import { CLOUD_PLATFORM_SCOPE } from './authorization.js';

type GoogleStreamingRecognitionConfig =
  protos.google.cloud.speech.v2.IStreamingRecognitionConfig;
type GoogleStreamingRecognizeRequest =
  protos.google.cloud.speech.v2.IStreamingRecognizeRequest;
type GoogleStreamingRecognizeResponse =
  protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

export const GOOGLE_STT_SUPPORTED_LOCALES = ['ha-NG', 'ig-NG', 'yo-NG'] as const;
export type GoogleSttSupportedLocale = (typeof GOOGLE_STT_SUPPORTED_LOCALES)[number];

export const GOOGLE_STT_ENV_NAMES = [
  'GOOGLE_STT_PROJECT_ID',
  'GOOGLE_STT_LOCATION',
  'GOOGLE_STT_RECOGNIZER',
  'GOOGLE_STT_MODEL',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
] as const;

export interface GoogleSpeechStream {
  write(data: GoogleStreamingRecognizeRequest): boolean;
  end(): void;
  destroy(error?: Error): void;
  on(event: 'data', listener: (response: GoogleStreamingRecognizeResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close' | 'end', listener: () => void): this;
}

export interface GoogleSpeechStreamingClient {
  openStreamingRecognize(): GoogleSpeechStream;
  recognizerPath(project: string, location: string, recognizer: string): string;
}

export interface GoogleCloudSttConfig {
  /** Resource project containing the Speech recognizer. */
  readonly projectId: string;
  readonly location: string;
  /** Recognizer id. `_` is the V2 implicit recognizer, when explicitly selected. */
  readonly recognizer: string;
  /** Chirp model id, e.g. `chirp_2` or a deployment-selected Chirp successor. */
  readonly model: string;
  /** Optional quota/billing project. No credential value is ever read here. */
  readonly quotaProjectId?: string | null;
  readonly client?: GoogleSpeechStreamingClient;
  readonly createClient?: (config: GoogleSpeechClientConfig) => Promise<GoogleSpeechStreamingClient>;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface GoogleSpeechClientConfig {
  readonly quotaProjectId?: string | null;
  readonly location: string;
}

export class GoogleCloudSttStreamingProvider implements StreamingTranscriptionProvider {
  readonly name: string;

  constructor(private readonly config: GoogleCloudSttConfig) {
    assertPresent(config.projectId, 'GOOGLE_STT_PROJECT_ID');
    assertPresent(config.location, 'GOOGLE_STT_LOCATION');
    assertPresent(config.recognizer, 'GOOGLE_STT_RECOGNIZER');
    assertPresent(config.model, 'GOOGLE_STT_MODEL');
    this.name = `google-cloud-stt:${config.model}`;
  }

  async openStream(options: StreamingTranscriptionOptions): Promise<StreamingTranscriptionSession> {
    const languageCode = normalizeGoogleSttLocale(options.sourceLanguage);
    const client =
      this.config.client ??
      (await (this.config.createClient ?? createGoogleSpeechStreamingClient)({
        quotaProjectId: this.config.quotaProjectId ?? null,
        location: this.config.location,
      }));
    const recognizer = client.recognizerPath(
      this.config.projectId,
      this.config.location,
      this.config.recognizer,
    );
    const stream = client.openStreamingRecognize();
    const session = new GoogleCloudSttSession(stream, options, recognizer, this.name, this.config.log);
    session.start(
      buildGoogleStreamingRecognitionConfig({
        model: this.config.model,
        languageCode,
        ...(options.requestEndpointing === undefined
          ? {}
          : { requestEndpointing: options.requestEndpointing }),
      }),
    );
    return session;
  }
}

export function normalizeGoogleSttLocale(sourceLanguage: string | undefined): GoogleSttSupportedLocale {
  const base = (sourceLanguage ?? '').trim().toLowerCase().split(/[-_]/u)[0];
  switch (base) {
    case 'ha':
      return 'ha-NG';
    case 'ig':
      return 'ig-NG';
    case 'yo':
      return 'yo-NG';
    default:
      throw new Error(
        `google-stt is configured for ha-NG, ig-NG and yo-NG only; received ` +
          `"${sourceLanguage ?? 'unset'}". Use Deepgram or another approved recognizer for other languages.`,
      );
  }
}

export function buildGoogleStreamingRecognitionConfig(options: {
  readonly model: string;
  readonly languageCode: GoogleSttSupportedLocale;
  readonly requestEndpointing?: boolean;
}): GoogleStreamingRecognitionConfig {
  return {
    config: {
      explicitDecodingConfig: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        audioChannelCount: 1,
      },
      model: options.model,
      languageCodes: [options.languageCode],
      features: {
        enableAutomaticPunctuation: true,
        enableWordConfidence: true,
        maxAlternatives: 1,
      },
    },
    streamingFeatures: {
      interimResults: true,
      enableVoiceActivityEvents: options.requestEndpointing === true,
    },
  };
}

export async function createGoogleSpeechStreamingClient(
  config: GoogleSpeechClientConfig,
): Promise<GoogleSpeechStreamingClient> {
  const { v2: speechV2 } = await import('@google-cloud/speech');
  const Client = speechV2.SpeechClient;
  const clientOptions: ConstructorParameters<typeof Client>[0] = {
    scopes: [CLOUD_PLATFORM_SCOPE],
    ...(config.quotaProjectId === undefined ||
    config.quotaProjectId === null ||
    config.quotaProjectId === ''
      ? {}
      : { quotaProjectId: config.quotaProjectId }),
    ...(config.location === 'global' ? {} : { apiEndpoint: `${config.location}-speech.googleapis.com` }),
  };
  const client: v2.SpeechClient = new Client(clientOptions);
  return {
    openStreamingRecognize: () =>
      client._streamingRecognize() as unknown as GoogleSpeechStream,
    recognizerPath: (project, location, recognizer) =>
      client.recognizerPath(project, location, recognizer),
  };
}

export function createGoogleCloudSttProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleCloudSttStreamingProvider | null {
  const projectId = optional(env['GOOGLE_STT_PROJECT_ID']);
  if (projectId === undefined) return null;
  return new GoogleCloudSttStreamingProvider({
    projectId,
    location: requiredOptional(env, 'GOOGLE_STT_LOCATION'),
    recognizer: requiredOptional(env, 'GOOGLE_STT_RECOGNIZER'),
    model: requiredOptional(env, 'GOOGLE_STT_MODEL'),
    quotaProjectId: optional(env['GOOGLE_CLOUD_QUOTA_PROJECT']) ?? null,
  });
}

class GoogleCloudSttSession implements StreamingTranscriptionSession {
  private closed = false;
  private lastFinalText = '';

  constructor(
    private readonly stream: GoogleSpeechStream,
    options: StreamingTranscriptionOptions,
    private readonly recognizer: string,
    private readonly providerName: string,
    private readonly log?: (line: string, detail?: Record<string, unknown>) => void,
  ) {
    this.stream.on('data', (response) => this.onResponse(response, options));
    this.stream.on('error', (error) => options.onError(error));
    this.stream.on('close', () => {
      this.closed = true;
      options.onDisconnected?.('google-stt stream closed');
    });
    this.stream.on('end', () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  start(streamingConfig: GoogleStreamingRecognitionConfig): void {
    this.stream.write({ recognizer: this.recognizer, streamingConfig });
  }

  async pushAudio(frame: StreamingTranscriptionFrame): Promise<void> {
    if (this.closed) throw new Error('pushAudio after close');
    if (frame.discontinuity === true) {
      this.log?.('google stt observed a platform discontinuity', {
        provider: this.providerName,
        recognizer: this.recognizer,
      });
    }
    this.stream.write({ audio: pcmBytes(frame.samples) });
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.stream.end();
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
    this.log?.('google stt session closed', {
      provider: this.providerName,
      reason,
      recognizer: this.recognizer,
    });
  }

  private onResponse(
    response: GoogleStreamingRecognizeResponse,
    options: StreamingTranscriptionOptions,
  ): void {
    if (isSpeechActivityEnd(response.speechEventType)) {
      options.onSignal({
        kind: 'endpoint',
        providerEndMs: durationToMs(response.speechEventOffset),
      });
    }

    for (const result of response.results ?? []) {
      const alternative = result.alternatives?.[0];
      const text = alternative?.transcript?.trim() ?? '';
      if (text === '') continue;

      const signal = {
        text,
        providerEndMs: durationToMs(result.resultEndOffset),
        confidence: alternative?.confidence ?? null,
        ...(result.languageCode === undefined || result.languageCode === null || result.languageCode === ''
          ? {}
          : { detectedLanguage: result.languageCode }),
      };
      if (result.isFinal === true) {
        this.lastFinalText = text;
        options.onSignal({ kind: 'final', ...signal });
      } else if (text !== this.lastFinalText) {
        options.onSignal({ kind: 'partial', ...signal });
      }
    }
  }
}

function assertPresent(value: string, name: string): void {
  if (value.trim() === '') {
    throw new Error(`${name} is required when Google STT is selected for live transcription`);
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function requiredOptional(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env[name]);
  if (value === undefined) {
    throw new Error(`${name} is required when Google STT is selected for live transcription`);
  }
  return value;
}

function pcmBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index]!, true);
  }
  return out;
}

function durationToMs(
  duration:
    | {
        seconds?: unknown;
        nanos?: unknown;
      }
    | null
    | undefined,
): number | null {
  if (duration === null || duration === undefined) return null;
  const seconds = durationSeconds(duration.seconds);
  const nanos = typeof duration.nanos === 'number' ? duration.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  return Math.round(seconds * 1000 + nanos / 1_000_000);
}

function durationSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10);
  if (value && typeof value === 'object') {
    const candidate = value as { toNumber?: () => number; toString?: () => string };
    if (typeof candidate.toNumber === 'function') return candidate.toNumber();
    if (typeof candidate.toString === 'function') return Number.parseInt(candidate.toString(), 10);
  }
  return 0;
}

function isSpeechActivityEnd(value: unknown): boolean {
  return value === 'SPEECH_ACTIVITY_END' || value === 3;
}
