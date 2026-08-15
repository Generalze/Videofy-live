import { Socket, io } from 'socket.io-client';
import type {
  GeneratedAudioEvent,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TimestampedTranslationEvent,
  TranscriptionEvent,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import type { IngestConfig } from './config.js';
import { MockProvider, type MediaProvider } from './providers/index.js';
import { logger } from './logger.js';
import {
  ProcessingSessionStore,
  type MicrophoneChunkInput,
  type MicrophoneSessionInput,
  type ProcessingSession,
  type UploadedMediaFile,
  type WebRtcChunkInput,
  type WebRtcSessionInput,
} from './media-session.js';
import { createTranscriptionProvider } from './transcription-provider.js';
import {
  checkOpusMtAvailability,
  type LanguagePairAvailability,
} from './model-availability.js';
import {
  CompositeTimestampedTranslationProvider,
  M2m100TimestampedTranslationProvider,
  Nllb200TimestampedTranslationProvider,
  createTimestampedTranslationProvider,
  type M2m100Config,
  type Nllb200Config,
  type TimestampedTranslationProvider,
} from './translation-provider.js';
import { createTextToSpeechProvider } from './text-to-speech-provider.js';
import {
  buildTargetLanguageOutputs,
  capRecentEvents,
  capRecentEventsPerLanguage,
} from './target-language-outputs.js';

export function buildPiperVoiceIdsByLanguage(
  voices: IngestConfig['piperVoices'],
): Map<string, string> {
  const voiceIds = new Map<string, string>();
  for (const voice of voices) {
    if (!voiceIds.has(voice.language)) {
      voiceIds.set(voice.language, voice.voiceId);
    }
  }
  return voiceIds;
}

export function resolvePiperSupportedLanguages(voices: IngestConfig['piperVoices']): string[] {
  return [...new Set(voices.map((voice) => voice.language))];
}

export type TextToSpeechWiringConfig = Pick<
  IngestConfig,
  'textToSpeechProvider' | 'textToSpeechSupportedLanguages' | 'piperVoices' | 'mmsTtsVoices'
>;

export function resolveTextToSpeechLanguages(config: TextToSpeechWiringConfig): string[] {
  if (config.textToSpeechProvider === 'piper') {
    return resolvePiperSupportedLanguages(config.piperVoices);
  }
  if (config.textToSpeechProvider === 'piper+mms') {
    return [
      ...new Set([
        ...resolvePiperSupportedLanguages(config.piperVoices),
        ...config.mmsTtsVoices.map((voice) => voice.language),
      ]),
    ];
  }
  return config.textToSpeechSupportedLanguages;
}

export function buildTextToSpeechVoiceIdsByLanguage(
  config: Pick<IngestConfig, 'textToSpeechProvider' | 'piperVoices' | 'mmsTtsVoices'>,
): Map<string, string> {
  const voiceIds = buildPiperVoiceIdsByLanguage(config.piperVoices);
  if (config.textToSpeechProvider !== 'piper+mms') {
    return voiceIds;
  }
  // Piper voices win when both engines cover a language; MMS fills the rest,
  // using the model id as the voice id.
  for (const voice of config.mmsTtsVoices) {
    if (!voiceIds.has(voice.language)) {
      voiceIds.set(voice.language, voice.modelId);
    }
  }
  return voiceIds;
}

export type TranslationWiringConfig = Pick<
  IngestConfig,
  | 'translationProvider'
  | 'translationFallbackProvider'
  | 'translationTimeoutMs'
  | 'translationSupportedTargetLanguages'
  | 'argosPythonExecutable'
  | 'argosPackageDir'
  | 'opusMtPythonExecutable'
  | 'opusMtModelCacheDir'
  | 'opusMtMaxConcurrency'
  | 'opusMtAllowModelDownload'
  | 'opusMtLanguageModels'
  | 'm2m100PythonExecutable'
  | 'm2m100ModelId'
  | 'm2m100LocalPath'
  | 'm2m100ModelCacheDir'
  | 'm2m100MaxConcurrency'
  | 'm2m100AllowModelDownload'
  | 'nllb200PythonExecutable'
  | 'nllb200ModelId'
  | 'nllb200LocalPath'
  | 'nllb200ModelCacheDir'
  | 'nllb200MaxConcurrency'
  | 'nllb200AllowModelDownload'
>;

export interface WarmableProviders {
  transcription?: { warmUp?: () => Promise<void> };
  translation?: { healthCheck?: () => Promise<unknown> };
}

/**
 * Loads AI models ahead of the first real request. Without warm-up, the first
 * upload after service start pays the model loads inside the per-stage
 * pipeline timeouts and can fail where an identical retry later succeeds.
 * Failures are logged, never fatal: warm-up is an optimisation.
 */
export async function warmUpAiProviders(providers: WarmableProviders): Promise<void> {
  const startedAt = Date.now();
  const warmups: Array<[string, Promise<unknown> | undefined]> = [
    ['transcription', providers.transcription?.warmUp?.()],
    ['translation', providers.translation?.healthCheck?.()],
  ];
  for (const [stage, pending] of warmups) {
    if (!pending) continue;
    try {
      await pending;
      logger.info('AI provider warmed', { stage, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      logger.warn('AI provider warm-up failed (will load on first use)', {
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function translationFallbackActive(config: TranslationWiringConfig): boolean {
  return (
    config.translationProvider === 'opus-mt' && config.translationFallbackProvider !== 'none'
  );
}

function translationFallbackModelId(config: TranslationWiringConfig): string {
  return config.translationFallbackProvider === 'nllb200'
    ? config.nllb200ModelId
    : config.m2m100ModelId;
}

function opusMtCoveredLanguages(config: TranslationWiringConfig): string[] {
  return config.translationSupportedTargetLanguages.filter((language) =>
    config.opusMtLanguageModels.some((model) => model.targetLanguage === language),
  );
}

export function resolveTranslationLanguages(config: TranslationWiringConfig): string[] {
  // The multilingual fallback restores the full configured bound: coverage is
  // the union of OPUS-MT pairs and the massively multilingual fallback set
  // (M2M100 or NLLB-200).
  if (config.translationProvider !== 'opus-mt' || translationFallbackActive(config)) {
    return config.translationSupportedTargetLanguages;
  }
  return opusMtCoveredLanguages(config);
}

export function buildTranslationModelIds(config: TranslationWiringConfig): Map<string, string> {
  const modelIds = new Map(
    config.translationProvider === 'm2m100'
      ? resolveTranslationLanguages(config).map(
          (language) => [language, config.m2m100ModelId] as const,
        )
      : config.opusMtLanguageModels.map((model) => [model.targetLanguage, model.modelId] as const),
  );
  if (translationFallbackActive(config)) {
    for (const language of resolveTranslationLanguages(config)) {
      if (!modelIds.has(language)) modelIds.set(language, translationFallbackModelId(config));
    }
  }
  return modelIds;
}

export function buildTranslationProvider(
  config: TranslationWiringConfig,
): TimestampedTranslationProvider {
  const translationLanguages = resolveTranslationLanguages(config);
  const m2m100Config: M2m100Config = {
    pythonExecutable: config.m2m100PythonExecutable,
    modelId: config.m2m100ModelId,
    localPath: config.m2m100LocalPath,
    modelCacheDir: config.m2m100ModelCacheDir,
    supportedTargetLanguages: translationLanguages,
    timeoutMs: config.translationTimeoutMs,
    maxConcurrency: config.m2m100MaxConcurrency,
    allowModelDownload: config.m2m100AllowModelDownload,
  };
  const primary = createTimestampedTranslationProvider({
    providerName: config.translationProvider,
    supportedTargetLanguages: translationLanguages,
    argos: {
      pythonExecutable: config.argosPythonExecutable,
      packageDir: config.argosPackageDir,
      supportedTargetLanguages: translationLanguages,
      timeoutMs: config.translationTimeoutMs,
    },
    opusMt: {
      pythonExecutable: config.opusMtPythonExecutable,
      modelCacheDir: config.opusMtModelCacheDir,
      // The primary keeps its own coverage so uncovered pairs fail fast with
      // `unsupported-language` and the composite reroutes them.
      supportedTargetLanguages: translationFallbackActive(config)
        ? opusMtCoveredLanguages(config)
        : translationLanguages,
      languageModels: config.opusMtLanguageModels,
      timeoutMs: config.translationTimeoutMs,
      maxConcurrency: config.opusMtMaxConcurrency,
      allowModelDownload: config.opusMtAllowModelDownload,
    },
    m2m100: m2m100Config,
  });
  if (!translationFallbackActive(config)) {
    return primary;
  }
  if (config.translationFallbackProvider === 'nllb200') {
    // NLLB-200 (CC-BY-NC-4.0, non-commercial use only) replaces M2M100 where
    // its output degenerates (empirically: Yoruba repetition loops).
    const nllb200Config: Nllb200Config = {
      pythonExecutable: config.nllb200PythonExecutable,
      modelId: config.nllb200ModelId,
      localPath: config.nllb200LocalPath,
      modelCacheDir: config.nllb200ModelCacheDir,
      supportedTargetLanguages: translationLanguages,
      timeoutMs: config.translationTimeoutMs,
      maxConcurrency: config.nllb200MaxConcurrency,
      allowModelDownload: config.nllb200AllowModelDownload,
    };
    return new CompositeTimestampedTranslationProvider({
      primary,
      fallback: new Nllb200TimestampedTranslationProvider(nllb200Config),
    });
  }
  return new CompositeTimestampedTranslationProvider({
    primary,
    fallback: new M2m100TimestampedTranslationProvider(m2m100Config),
  });
}

export function programmeTimestampMs(
  events: readonly TranscriptionEvent[],
  previousMs = 0,
): number {
  let positionMs = previousMs;
  for (const event of events) {
    if (event.status === 'transcribed' || event.status === 'failed') {
      positionMs = Math.max(positionMs, event.endMs);
    }
  }
  return positionMs;
}

export class IngestService {
  private socket: Socket | null = null;
  /**
   * Whether the gateway socket is currently usable. Reported by /health because
   * everything this service produces leaves through that socket: without it the
   * process is running and accepting work whose output can never be delivered,
   * and "ok" would be a lie told to whoever is trying to diagnose silence.
   */
  private gatewayConnected = false;
  private languagePairAvailability: LanguagePairAvailability[] = [];
  private provider: MediaProvider;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private streamStatus: MediaStateEvent['streamStatus'] = 'created';
  private currentSession: ProcessingSession | null = null;
  private readonly sessions: ProcessingSessionStore;

  constructor(private readonly config: IngestConfig) {
    this.provider = new MockProvider();
    const translationLanguages = resolveTranslationLanguages(config);
    const translationModelIds = buildTranslationModelIds(config);
    const transcriptionProvider = createTranscriptionProvider({
        providerName: config.transcriptionProvider,
        sourceLanguage: config.transcriptionSourceLanguage,
        timeoutMs: config.transcriptionTimeoutMs,
        fasterWhisper: {
          pythonExecutable: config.fasterWhisperPythonExecutable,
          ffmpegExecutable: config.fasterWhisperFfmpegExecutable,
          modelSize: config.fasterWhisperModelSize,
          device: config.fasterWhisperDevice,
          computeType: config.fasterWhisperComputeType,
          modelCacheDir: config.fasterWhisperModelCacheDir,
          allowGpuFallback: config.fasterWhisperAllowGpuFallback,
          timeoutMs: config.transcriptionTimeoutMs,
        },
      });
    const translationProvider = buildTranslationProvider(config);
    this.sessions = new ProcessingSessionStore({
      outputBaseDir: config.audioChunkDir,
      webRtcStagingDir: config.webrtcAudioChunkStagingDir,
      transcriptionProvider,
      transcriptionTimeoutMs: config.transcriptionTimeoutMs,
      translationProvider,
      translationTimeoutMs: config.translationTimeoutMs,
      translationTargetLanguage: config.translationTargetLanguage,
      translationSupportedTargetLanguages: translationLanguages,
      translationModelIds,
      textToSpeechProvider: createTextToSpeechProvider({
        providerName: config.textToSpeechProvider,
        timeoutMs: config.textToSpeechTimeoutMs,
        supportedLanguages: config.textToSpeechSupportedLanguages,
        defaultVoiceId: config.textToSpeechDefaultVoiceId,
        piper: {
          executable: config.piperExecutable,
          ffmpegExecutable: config.piperFfmpegExecutable,
          timeoutMs: config.textToSpeechTimeoutMs,
          voices: config.piperVoices,
        },
        mms: {
          pythonExecutable: config.mmsTtsPythonExecutable,
          ffmpegExecutable: config.piperFfmpegExecutable,
          voices: config.mmsTtsVoices,
          modelCacheDir: config.mmsTtsModelCacheDir,
          allowModelDownload: config.mmsTtsAllowModelDownload,
          timeoutMs: config.textToSpeechTimeoutMs,
        },
      }),
      textToSpeechTimeoutMs: config.textToSpeechTimeoutMs,
      textToSpeechVoiceId: config.textToSpeechDefaultVoiceId,
      textToSpeechVoiceIds: buildTextToSpeechVoiceIdsByLanguage(config),
      textToSpeechSupportedLanguages: resolveTextToSpeechLanguages(config),
      renderViewerReadyMediaOnCompletion: false,
      // Service start warms transcription only. Each OPUS-MT pair and Piper
      // voice still loads lazily, which made the opening exchange of every call
      // the slowest part of it; warming per call moves that cost off the wire.
      warmUpCallModels: true,
      onSessionChange: (session) => {
        this.currentSession = session;
        this.streamStatus = session.state;
        this.emitState();
      },
      onTranscriptionEvent: (event) => this.emitTranscriptionEvent(event),
      onTranslationEvent: (event) => this.emitTranslationEvent(event),
      onGeneratedAudioReady: (event, session) => this.emitGeneratedAudioReady(event, session),
    });
    void warmUpAiProviders({
      transcription: transcriptionProvider,
      translation: translationProvider,
    });
  }

  /**
   * True when transcriptions, translations and generated audio can actually
   * reach participants. False means the service is working and delivering
   * nothing.
   */
  get connectedToGateway(): boolean {
    return this.gatewayConnected;
  }

  /**
   * Per-pair translation readiness, resolved once at startup. A dead pair is
   * invisible at call level — speech is still recognised and the speaker still
   * sees their own captions — so it has to be reported somewhere an operator
   * looks before a call rather than discovered by a listener hearing nothing.
   */
  get translationPairAvailability(): LanguagePairAvailability[] {
    return this.languagePairAvailability;
  }

  async start(): Promise<void> {
    logger.info('Media ingest starting', { videoSource: this.config.videoSource });

    this.languagePairAvailability = checkOpusMtAvailability({
      languageModels: this.config.opusMtLanguageModels,
      modelCacheDir: this.config.opusMtModelCacheDir,
      allowModelDownload: this.config.opusMtAllowModelDownload,
    });
    for (const pair of this.languagePairAvailability) {
      if (pair.available) continue;
      logger.error('Translation language pair is unavailable', {
        pair: pair.pair,
        modelId: pair.modelId,
        reason: pair.reason,
      });
    }

    this.socket = io(this.config.gatewayUrl, {
      query: { role: 'ingest' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      // Deliberately unbounded. This socket is the ONLY route by which
      // transcriptions, translations and generated audio reach participants:
      // without it the service still accepts chunks, still transcribes them,
      // and still answers /health with 200 while nothing it produces can reach
      // anyone. A bounded count (it was 10, so ~20 seconds) meant a gateway
      // restart that outlasted the window left ingest permanently deaf with no
      // outward sign — the failure looks like "captions stopped", which is the
      // most expensive kind of bug this project has had.
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      // Backs off to a minute so an extended gateway outage does not turn into
      // a reconnect flood, while still recovering on its own.
      reconnectionDelayMax: 60_000,
    });

    this.socket.on(SOCKET_EVENTS.CONNECTED, () => {
      logger.info('Connected to gateway');
      this.gatewayConnected = true;
      this.socket?.emit(SOCKET_EVENTS.INGEST_HEALTH, { status: 'healthy' });
      this.emitState();
      this.emitGeneratedAudioReadySnapshot();
    });

    this.socket.on(SOCKET_EVENTS.DISCONNECTED, () => {
      logger.warn('Disconnected from gateway');
      this.gatewayConnected = false;
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.error('Gateway connection error', { message: err.message });
      this.gatewayConnected = false;
    });

    this.socket.on(SOCKET_EVENTS.INGEST_START_STREAM, () => {
      logger.info('Operator requested mock stream start');
      void this.startMockStream();
    });

    this.socket.on(SOCKET_EVENTS.INGEST_STOP_STREAM, () => {
      logger.info('Operator requested mock stream stop');
      void this.stopMockStream();
    });

    if (this.config.videoSource === 'mock') {
      await this.startMockStream();
    }

    this.ticker = setInterval(() => {
      this.emitState();
    }, this.config.mockTickMs);
  }

  async createProcessingSession(upload: UploadedMediaFile): Promise<ProcessingSession> {
    const session = await this.sessions.createFromUpload(upload);
    logger.info('Processing session ready', {
      sessionId: session.id,
      streamId: session.streamId,
      filename: session.media?.filename,
      chunkCount: session.audioExtraction.chunkCount,
      targetLanguage: session.targetLanguage,
    });
    return session;
  }

  async createMicrophoneSession(input: MicrophoneSessionInput): Promise<ProcessingSession> {
    const session = await this.sessions.createMicrophoneSession(input);
    logger.info('Microphone capture session started', {
      sessionId: session.id,
      streamId: session.streamId,
      deviceLabel: session.microphoneCapture.deviceLabel,
      targetLanguage: session.targetLanguage,
    });
    return session;
  }

  async createWebRtcSession(input: WebRtcSessionInput): Promise<ProcessingSession> {
    const session = await this.sessions.createWebRtcSession(input);
    logger.info('WebRTC transcription session ready', {
      sessionId: session.id,
      streamId: session.streamId,
      sourceKind: session.sourceKind,
      revision: session.webrtcTranscriptionBridge?.revision,
    });
    return session;
  }

  async ingestMicrophoneChunk(
    sessionId: string,
    input: MicrophoneChunkInput,
  ): Promise<ProcessingSession> {
    const session = await this.sessions.ingestMicrophoneChunk(sessionId, input);
    logger.info('Microphone chunk processed', {
      sessionId: session.id,
      chunkCount: session.microphoneCapture.chunkCount,
      transcription: session.transcription.status,
      translation: session.translation.status,
    });
    return session;
  }

  async ingestWebRtcChunk(
    sessionId: string,
    input: WebRtcChunkInput,
  ): Promise<ProcessingSession> {
    const session = await this.sessions.ingestWebRtcChunk(sessionId, input);
    logger.info('WebRTC transcription chunk processed', {
      sessionId: session.id,
      chunkCount: session.webrtcTranscriptionBridge?.chunkCount,
      transcription: session.transcription.status,
    });
    return session;
  }

  stopMicrophoneSession(sessionId: string): ProcessingSession {
    const session = this.sessions.stopMicrophoneSession(sessionId);
    logger.info('Microphone capture session stopped', {
      sessionId: session.id,
      chunkCount: session.microphoneCapture.chunkCount,
    });
    return session;
  }

  stopWebRtcSession(sessionId: string): ProcessingSession {
    const session = this.sessions.stopWebRtcSession(sessionId);
    logger.info('WebRTC transcription session stopped', {
      sessionId: session.id,
      chunkCount: session.webrtcTranscriptionBridge?.chunkCount,
    });
    return session;
  }

  async removeCallSession(sessionId: string): Promise<boolean> {
    const removed = await this.sessions.removeCallSession(sessionId);
    if (removed) {
      logger.info('Native-call ingest session removed', { sessionId });
    }
    return removed;
  }

  failMicrophoneDeviceDisconnected(sessionId: string): ProcessingSession {
    const session = this.sessions.failMicrophoneDeviceDisconnected(sessionId);
    logger.warn('Microphone device disconnected', { sessionId });
    return session;
  }

  async retryAudioExtraction(sessionId: string): Promise<ProcessingSession> {
    const session = await this.sessions.retryAudioExtraction(sessionId);
    logger.info('Audio extraction retry finished', {
      sessionId: session.id,
      state: session.state,
      chunkCount: session.audioExtraction.chunkCount,
    });
    return session;
  }

  async cleanupFailedAudio(sessionId: string): Promise<ProcessingSession> {
    const session = await this.sessions.cleanupFailedAudio(sessionId);
    logger.info('Failed audio extraction artifacts cleaned', { sessionId: session.id });
    return session;
  }

  pauseSession(sessionId: string): ProcessingSession {
    const session = this.sessions.pauseSession(sessionId);
    logger.info('Processing session paused', { sessionId: session.id });
    return session;
  }

  resumeSession(sessionId: string): ProcessingSession {
    const session = this.sessions.resumeSession(sessionId);
    logger.info('Processing session resumed', { sessionId: session.id });
    return session;
  }

  cancelSession(sessionId: string): ProcessingSession {
    const session = this.sessions.cancelSession(sessionId);
    logger.info('Processing session cancelled', { sessionId: session.id });
    return session;
  }

  async retryTranscriptionChunk(sessionId: string, chunkId: string): Promise<ProcessingSession> {
    const session = await this.sessions.retryTranscriptionChunk(sessionId, chunkId);
    logger.info('Transcription chunk retry finished', {
      sessionId: session.id,
      chunkId,
      state: session.state,
    });
    return session;
  }

  exportTranscript(sessionId: string): string {
    return this.sessions.exportTranscript(sessionId);
  }

  async retryTranslationSegment(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<ProcessingSession> {
    const session = await this.sessions.retryTranslationSegment(
      sessionId,
      segmentId,
      targetLanguage,
    );
    logger.info('Translation segment retry finished', {
      sessionId: session.id,
      segmentId,
      state: session.state,
    });
    return session;
  }

  exportPairedTranslation(sessionId: string): string {
    return this.sessions.exportPairedTranslation(sessionId);
  }

  async retryGeneratedAudioSegment(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<ProcessingSession> {
    const session = await this.sessions.retryGeneratedAudioSegment(
      sessionId,
      segmentId,
      targetLanguage,
    );
    logger.info('Generated audio segment retry finished', {
      sessionId: session.id,
      segmentId,
      state: session.state,
    });
    return session;
  }

  updateSourceLanguageControl(
    sessionId: string,
    input: Parameters<ProcessingSessionStore['updateSourceLanguageControl']>[1],
  ): ProcessingSession {
    const session = this.sessions.updateSourceLanguageControl(sessionId, input);
    logger.info('Source language control updated', {
      sessionId: session.id,
      activeLanguage: session.sourceLanguageControl.activeLanguage,
      revision: session.sourceLanguageControl.revision,
      status: session.sourceLanguageControl.status,
    });
    return session;
  }

  async getGeneratedAudioFile(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): ReturnType<ProcessingSessionStore['getGeneratedAudioFile']> {
    return await this.sessions.getGeneratedAudioFile(sessionId, segmentId, targetLanguage);
  }

  async getSourceMediaFile(
    sessionId: string,
  ): ReturnType<ProcessingSessionStore['getSourceMediaFile']> {
    return await this.sessions.getSourceMediaFile(sessionId);
  }

  async getViewerReadyMediaFile(
    sessionId: string,
  ): ReturnType<ProcessingSessionStore['getViewerReadyMediaFile']> {
    return await this.sessions.getViewerReadyMediaFile(sessionId);
  }

  private async startMockStream(): Promise<void> {
    await this.provider.start();
    this.currentSession = null;
    this.streamStatus = 'processing';
    this.emitState();
    logger.info('Mock video source started');
  }

  private async stopMockStream(): Promise<void> {
    this.currentSession = null;
    this.streamStatus = 'completed';
    this.emitState();
    await this.provider.stop();
    logger.info('Mock video source stopped');
  }

  private programmeClockSessionId: string | null = null;
  private programmeClockMs = 0;

  private currentProgrammeTimestampMs(session: ProcessingSession): number {
    if (this.programmeClockSessionId !== session.id) {
      this.programmeClockSessionId = session.id;
      this.programmeClockMs = 0;
    }
    this.programmeClockMs = programmeTimestampMs(
      session.transcription.events,
      this.programmeClockMs,
    );
    return this.programmeClockMs;
  }

  private emitState(): void {
    if (!this.socket?.connected) return;

    // Incrementally maintained per-language counters avoid rescanning the full
    // event history on every broadcast; the emitted event arrays are capped to
    // the most recent slice per type/language (listeners merge incrementally
    // and rely on the aggregate counts for totals).
    const tallies = this.currentSession
      ? this.sessions.getTargetLanguageOutputTallies(this.currentSession.id)
      : null;
    const state: MediaStateEvent = this.currentSession
      ? {
          eventId: this.currentSession.streamId,
          streamId: this.currentSession.streamId,
          processingSessionId: this.currentSession.id,
          streamStatus: this.currentSession.state,
          videoSource:
            this.currentSession.sourceKind === 'microphone'
              ? 'microphone'
              : this.currentSession.sourceKind === 'webrtc'
                ? 'webrtc'
                : 'local-file',
          ...(this.currentSession.media ? { media: this.currentSession.media } : {}),
          audioExtraction: this.currentSession.audioExtraction,
          microphoneCapture: this.currentSession.microphoneCapture,
          ...(this.currentSession.webrtcTranscriptionBridge
            ? { webrtcTranscriptionBridge: this.currentSession.webrtcTranscriptionBridge }
            : {}),
          transcription: {
            ...this.currentSession.transcription,
            events: capRecentEvents(this.currentSession.transcription.events),
          },
          translation: {
            ...this.currentSession.translation,
            events: capRecentEventsPerLanguage(this.currentSession.translation.events),
          },
          generatedAudio: {
            ...this.currentSession.generatedAudio,
            events: capRecentEventsPerLanguage(this.currentSession.generatedAudio.events),
          },
          sourceLanguageControl: this.currentSession.sourceLanguageControl,
          targetLanguageCatalogue: this.currentSession.targetLanguageCatalogue,
          targetLanguageOutputs: buildTargetLanguageOutputs({
            selectedLanguages: this.currentSession.targetLanguages,
            catalogue: this.currentSession.targetLanguageCatalogue,
            translation: this.currentSession.translation,
            generatedAudio: this.currentSession.generatedAudio,
            ...(tallies ? { tallies } : {}),
          }),
          aiProviderStatus: this.currentSession.aiProviderStatus,
          monitoring: this.currentSession.monitoring,
          videoTimestampMs: this.currentProgrammeTimestampMs(this.currentSession),
          sourceAudioActive:
            this.currentSession.sourceKind === 'microphone'
              ? this.currentSession.microphoneCapture.status === 'capturing'
              : this.currentSession.sourceKind === 'webrtc'
                ? this.currentSession.webrtcTranscriptionBridge?.status === 'processing' ||
                  this.currentSession.webrtcTranscriptionBridge?.status === 'chunking'
              : (this.currentSession.media?.hasAudio ?? false),
          translatedLanguages: this.currentSession.targetLanguages,
          connectedListeners: 0,
          createdAt: new Date().toISOString(),
        }
      : {
          eventId: this.config.eventId,
          streamStatus: this.streamStatus,
          videoSource: this.config.videoSource,
          videoTimestampMs: this.provider.getVideoTimestampMs(),
          sourceAudioActive: this.provider.isAudioActive(),
          translatedLanguages: this.config.translatedLanguages,
          targetLanguageCatalogue: this.sessions.getTargetLanguageCatalogue(),
          connectedListeners: 0,
          createdAt: new Date().toISOString(),
        };

    this.socket.emit(SOCKET_EVENTS.INGEST_STATE, state);
    logger.debug('Media state emitted', {
      streamStatus: state.streamStatus,
      videoTimestampMs: state.videoTimestampMs,
    });
  }

  private emitTranscriptionEvent(event: TranscriptionEvent): void {
    if (!this.socket?.connected) return;
    this.socket.emit(SOCKET_EVENTS.INGEST_TRANSCRIPTION, event);
    logger.debug('Transcription event emitted', {
      sessionId: event.sessionId,
      chunkId: event.chunkId,
      status: event.status,
    });
  }

  private emitTranslationEvent(event: TimestampedTranslationEvent): void {
    if (!this.socket?.connected) return;
    this.socket.emit(SOCKET_EVENTS.INGEST_TRANSLATION, event);
    logger.debug('Timestamped translation event emitted', {
      sessionId: event.sessionId,
      segmentId: event.segmentId,
      status: event.status,
    });
  }

  private emitGeneratedAudioReady(event: GeneratedAudioEvent, session: ProcessingSession): void {
    if (!this.socket?.connected || event.status !== 'generated' || event.durationMs === null) return;
    const readyEvent: GeneratedAudioReadyEvent = {
      ...event,
      sessionId: session.id,
      streamId: session.streamId,
      durationMs: event.durationMs,
      audioUrl: this.generatedAudioUrl(session.id, event.segmentId, event.targetLanguage),
    };
    this.socket.emit(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, readyEvent);
    logger.info('Generated audio ready event emitted', {
      sessionId: event.sessionId,
      segmentId: event.segmentId,
      sequence: event.sequence,
      targetLanguage: event.targetLanguage,
    });
  }

  private emitGeneratedAudioReadySnapshot(): void {
    if (!this.currentSession) return;
    for (const event of this.currentSession.generatedAudio.events
      .filter((item) => item.status === 'generated')
      .sort((a, b) => a.sequence - b.sequence)) {
      this.emitGeneratedAudioReady(event, this.currentSession);
    }
  }

  private generatedAudioUrl(
    sessionId: string,
    segmentId: string,
    targetLanguage: string,
  ): string {
    const baseUrl = this.config.ingestPublicUrl.replace(/\/+$/, '');
    return `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/generated-audio/segments/${encodeURIComponent(segmentId)}/audio?language=${encodeURIComponent(targetLanguage)}`;
  }

  async stop(): Promise<void> {
    logger.info('Media ingest stopping');
    this.streamStatus = 'completed';
    this.emitState();

    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    await this.provider.stop();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    logger.info('Media ingest stopped');
  }
}
