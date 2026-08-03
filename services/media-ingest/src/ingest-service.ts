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
import { createTimestampedTranslationProvider } from './translation-provider.js';
import { createTextToSpeechProvider } from './text-to-speech-provider.js';
import { buildTargetLanguageOutputs } from './target-language-outputs.js';

export class IngestService {
  private socket: Socket | null = null;
  private provider: MediaProvider;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private streamStatus: MediaStateEvent['streamStatus'] = 'created';
  private currentSession: ProcessingSession | null = null;
  private readonly sessions: ProcessingSessionStore;

  constructor(private readonly config: IngestConfig) {
    this.provider = new MockProvider();
    const translationLanguages =
      config.translationProvider === 'opus-mt'
        ? config.translationSupportedTargetLanguages.filter((language) =>
            config.opusMtLanguageModels.some((model) => model.targetLanguage === language),
          )
        : config.translationSupportedTargetLanguages;
    const translationModelIds = new Map(
      config.opusMtLanguageModels.map((model) => [model.targetLanguage, model.modelId]),
    );
    this.sessions = new ProcessingSessionStore({
      outputBaseDir: config.audioChunkDir,
      webRtcStagingDir: config.webrtcAudioChunkStagingDir,
      transcriptionProvider: createTranscriptionProvider({
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
      }),
      transcriptionTimeoutMs: config.transcriptionTimeoutMs,
      translationProvider: createTimestampedTranslationProvider({
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
          supportedTargetLanguages: translationLanguages,
          languageModels: config.opusMtLanguageModels,
          timeoutMs: config.translationTimeoutMs,
          maxConcurrency: config.opusMtMaxConcurrency,
          allowModelDownload: config.opusMtAllowModelDownload,
        },
      }),
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
          voices: [
            {
              voiceId: config.piperVoiceId,
              language: config.piperVoiceLanguage,
              modelPath: config.piperModelPath,
              configPath: config.piperConfigPath,
            },
          ],
        },
      }),
      textToSpeechTimeoutMs: config.textToSpeechTimeoutMs,
      textToSpeechVoiceId: config.textToSpeechDefaultVoiceId,
      textToSpeechVoiceIds: new Map([
        [config.piperVoiceLanguage, config.piperVoiceId],
      ]),
      textToSpeechSupportedLanguages:
        config.textToSpeechProvider === 'piper'
          ? [config.piperVoiceLanguage]
          : config.textToSpeechSupportedLanguages,
      renderViewerReadyMediaOnCompletion: false,
      onSessionChange: (session) => {
        this.currentSession = session;
        this.streamStatus = session.state;
        this.emitState();
      },
      onTranscriptionEvent: (event) => this.emitTranscriptionEvent(event),
      onTranslationEvent: (event) => this.emitTranslationEvent(event),
      onGeneratedAudioReady: (event, session) => this.emitGeneratedAudioReady(event, session),
    });
  }

  async start(): Promise<void> {
    logger.info('Media ingest starting', { videoSource: this.config.videoSource });

    this.socket = io(this.config.gatewayUrl, {
      query: { role: 'ingest' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: 10,
    });

    this.socket.on(SOCKET_EVENTS.CONNECTED, () => {
      logger.info('Connected to gateway');
      this.socket?.emit(SOCKET_EVENTS.INGEST_HEALTH, { status: 'healthy' });
      this.emitState();
      this.emitGeneratedAudioReadySnapshot();
    });

    this.socket.on(SOCKET_EVENTS.DISCONNECTED, () => {
      logger.warn('Disconnected from gateway');
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.error('Gateway connection error', { message: err.message });
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

  private emitState(): void {
    if (!this.socket?.connected) return;

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
          transcription: this.currentSession.transcription,
          translation: this.currentSession.translation,
          generatedAudio: this.currentSession.generatedAudio,
          sourceLanguageControl: this.currentSession.sourceLanguageControl,
          targetLanguageCatalogue: this.currentSession.targetLanguageCatalogue,
          targetLanguageOutputs: buildTargetLanguageOutputs({
            selectedLanguages: this.currentSession.targetLanguages,
            catalogue: this.currentSession.targetLanguageCatalogue,
            translation: this.currentSession.translation,
            generatedAudio: this.currentSession.generatedAudio,
          }),
          aiProviderStatus: this.currentSession.aiProviderStatus,
          monitoring: this.currentSession.monitoring,
          videoTimestampMs: 0,
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
