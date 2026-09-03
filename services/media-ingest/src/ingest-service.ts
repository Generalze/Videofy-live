import { Socket, io } from 'socket.io-client';
import type {
  GeneratedAudioEvent,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TargetLanguageCapability,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  ProgrammeMediaDelivery,
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
import {
  createTextToSpeechProvider,
  type TextToSpeechProvider,
} from './text-to-speech-provider.js';
import { GatedTranslationProvider, type GateObserver } from './gated-translation-provider.js';
import { buildTranslationGate, type GateWiring } from './translation-gate-wiring.js';
import type { StreamingBackedTextToSpeechOptions } from './streaming-backed-text-to-speech-provider.js';
import type { StreamingSpeechSynthesisProvider } from './streaming-speech-synthesis-provider.js';
import {
  buildTargetLanguageOutputs,
  capRecentEvents,
  capRecentEventsPerLanguage,
} from './target-language-outputs.js';
import type { TranscriptEvent } from './transcript-event.js';
import { planSpeechTargets, type LiveSpeechPlan } from './live-session-host.js';

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

/**
 * Optional assembly hooks.
 *
 * The seam exists so personal voice can be routed at synthesis time WITHOUT
 * this service learning that voice profiles, enrollment storage or any
 * particular engine exist. It receives the standard provider it already built
 * and may return a replacement; whoever supplies the wrapper owns that
 * knowledge, not the media pipeline.
 */
export interface IngestServiceDependencies {
  wrapTextToSpeechProvider?: (standard: TextToSpeechProvider) => TextToSpeechProvider;
  /**
   * The owner's CURRENT personal voice, or null. Called per utterance.
   *
   * The second half of the same seam: the wrapper knows how to SPEAK in a
   * personal voice, this knows WHETHER there is one to speak in right now.
   * Both are injected, so this service still has no idea voice profiles exist.
   */
  resolvePersonalVoiceId?: (ownerId: string) => string | null;
  /**
   * The live synthesis stack, for TEXT_TO_SPEECH_PROVIDER=streaming.
   *
   * Uploaded programmes and live calls speak with one voice stack or they drift
   * apart, and they had: the specialist routing that keeps Yoruba out of a
   * general vendor's mouth existed only on the live side, so an uploaded
   * programme reached none of it. Injected rather than built here because
   * building it warms a vendor.
   */
  streamingSynthesisProvider?: StreamingSpeechSynthesisProvider;
  /** Injected in tests; production builds it from the route document. */
  translationGate?: GateWiring;
  /** Told every gate decision, so billing and /health see what the caller saw. */
  onTranslationOutcome?: GateObserver;
  /** Told when an uploaded segment was served by a fallback vendor. */
  onSynthesisDegraded?: StreamingBackedTextToSpeechOptions['onDegraded'];
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
  /** The same translation provider the batch path uses. See the constructor. */
  private readonly liveTranslationProvider: TimestampedTranslationProvider;
  /** For /health and the boot line: which directions this deployment may translate. */
  private readonly translationGateWiring: GateWiring;

  /**
   * The standard provider, optionally wrapped.
   *
   * With no wrapper supplied the returned provider is exactly what
   * createTextToSpeechProvider produced, so the existing Piper/MMS path is
   * unchanged rather than merely equivalent.
   */
  private buildTextToSpeechProvider(
    options: Parameters<typeof createTextToSpeechProvider>[0],
  ): TextToSpeechProvider {
    const standard = createTextToSpeechProvider(options);
    return this.deps.wrapTextToSpeechProvider?.(standard) ?? standard;
  }

  constructor(
    private readonly config: IngestConfig,
    private readonly deps: IngestServiceDependencies = {},
  ) {
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
    /*
     * THE GATE WRAPS THE PROVIDER, so every execution path gets it.
     *
     * There are two paths today -- the live pipeline and the internal-text
     * route -- and adding a check to each would leave the rule true only until
     * somebody adds a third. Wrapping the provider makes the gate unavoidable:
     * to translate you must hold a provider, and the provider you hold asks the
     * registry first. Refused routes never reach the engine at all.
     *
     * SCOPE. This gate is `programme-live`. A call-scoped session is therefore
     * REFUSED by it rather than silently approved under a programme's approval
     * -- fail-closed, and the honest state until call scope is wired
     * separately. Approving one scope with another's evidence is the exact
     * thing the directional registry exists to prevent.
     */
    const rawTranslationProvider = buildTranslationProvider(config);
    const gateWiring =
      deps.translationGate ??
      buildTranslationGate({
        scope: 'programme-live',
        ...(config.translationRoutesDocument
          ? { documentPath: config.translationRoutesDocument }
          : {}),
      });
    const translationProvider = new GatedTranslationProvider({
      inner: rawTranslationProvider,
      gate: gateWiring.gate,
      ...(deps.onTranslationOutcome ? { onOutcome: deps.onTranslationOutcome } : {}),
    });
    this.translationGateWiring = gateWiring;
    // Held so the LIVE path can use the same instance. A second provider would
    // mean two model loads, two warm-up costs, and two sets of behaviour to
    // reason about for one product.
    this.liveTranslationProvider = translationProvider;
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
      textToSpeechProvider: this.buildTextToSpeechProvider({
        providerName: config.textToSpeechProvider,
        ...(deps.streamingSynthesisProvider === undefined
          ? {}
          : { streaming: deps.streamingSynthesisProvider }),
        ...(deps.onSynthesisDegraded === undefined
          ? {}
          : { onDegraded: deps.onSynthesisDegraded }),
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
      ...(deps.resolvePersonalVoiceId
        ? { resolvePersonalVoiceId: deps.resolvePersonalVoiceId }
        : {}),
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
   * Tell the gateway how a programme run's original media reaches its audience.
   *
   * A dedicated announcement rather than a field on the next state snapshot,
   * because the gateway needs this BEFORE it decides whether to relay a
   * broadcaster's tracks to a joining listener -- a decision that happens on a
   * join, not on the next tick.
   *
   * Silently dropped while the socket is down. The gateway's own default is to
   * refuse the realtime relay for a run it has heard nothing about, so a lost
   * announcement costs a protected programme its audience rather than costing
   * a protected programme its protection.
   */
  publishProgrammeDelivery(delivery: ProgrammeMediaDelivery): void {
    if (!this.socket?.connected) return;
    this.socket.emit(SOCKET_EVENTS.INGEST_PROGRAMME_DELIVERY, delivery);
    logger.info('Programme delivery announced', {
      runId: delivery.programmeRunId,
      mode: delivery.mode,
      readiness: delivery.readiness,
      ...(delivery.reason === null ? {} : { reason: delivery.reason }),
    });
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

  /**
   * The deployment's target-language catalogue with every language's
   * capability state, BEFORE any programme exists. The same rows a media
   * state carries; here so the operator console can show the catalogue
   * without waiting for a processing session (founder directive, 30 Aug
   * 2026: "the catalogue must be available before a programme starts
   * through a real capability-catalogue read").
   */
  get targetLanguageCatalogue(): TargetLanguageCapability[] {
    return this.sessions.getTargetLanguageCatalogue();
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

  async createMediaSession(input: WebRtcSessionInput): Promise<ProcessingSession> {
    const session = await this.sessions.createMediaSession(input);
    logger.info('WebRTC transcription session ready', {
      sessionId: session.id,
      streamId: session.streamId,
      sourceKind: session.sourceKind,
      revision: session.webrtcTranscriptionBridge?.revision,
      // WHAT THIS SESSION IS FOR. A session with no target languages produces
      // captions and nothing else -- correctly, since there is nobody to
      // translate for. That state is indistinguishable from broken synthesis
      // unless it is stated here: "no translated audio" and "nothing to
      // translate" look identical from a participant's seat.
      targetLanguages: session.targetLanguages,
      willTranslate: session.targetLanguages.length > 0,
      // A target with no voice is skipped by planSpeechTargets, so targets
      // alone do not mean anything will be spoken. Names only, never a
      // participant's personal voice material.
      voicedLanguages: Object.keys(session.voiceIdsByLanguage ?? {}),
      textOnlyLanguages: session.generatedAudio?.textOnlyLanguages ?? [],
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

  async ingestMediaChunk(
    sessionId: string,
    input: WebRtcChunkInput,
  ): Promise<ProcessingSession> {
    const session = await this.sessions.ingestMediaChunk(sessionId, input);
    logger.info('WebRTC transcription chunk processed', {
      sessionId: session.id,
      chunkCount: session.webrtcTranscriptionBridge?.chunkCount,
      transcription: session.transcription.status,
    });
    return session;
  }

  // --- the live path's seams -------------------------------------------
  //
  // Three narrow accessors rather than handing the whole service to the
  // ingress. What the live path may do here is exactly this: reuse the
  // translation provider, ask what a session wants spoken, and hand back a
  // transcript. It cannot reach into session state, and so cannot grow into a
  // second, divergent copy of the pipeline.

  get liveTranslation(): TimestampedTranslationProvider {
    return this.liveTranslationProvider;
  }

  /**
   * Every language this session wants SPOKEN, one plan per distinct language.
   *
   * Plural, and that is the point. The singular version returned the FIRST
   * non-text-only target, so a conference with Spanish and French listeners
   * progressively spoke Spanish and silently never spoke French -- while every
   * component reported success, because nothing was broken. It was simply a
   * contract that could not express the product.
   *
   * An empty list is a real answer, not a failure: captions only.
   */
  liveSpeechPlansFor(sessionId: string): LiveSpeechPlan[] {
    /**
     * Looked up BY ID, not taken from `currentSession`.
     *
     * `currentSession` is whichever session last changed state -- a single
     * slot, meaningful for the programme path where one stream is being
     * processed. A call has one session PER PARTICIPANT, so at most one of
     * them could ever match, and the other silently got no speech plans: no
     * translation pipeline was built for it, nothing was synthesised, and the
     * caller heard their partner's original voice with no translated audio at
     * all. Captions still worked, because they travel a different path, which
     * is what made this look like a synthesis problem rather than a lookup.
     */
    const session = this.sessions.get(sessionId);
    if (session === null) return [];
    /*
     * Voices resolve through the SAME rule the batch path uses -- session
     * override, per-language map, provider default -- because the live
     * providers are multilingual: the default voice speaks Spanish as
     * Spanish. Consulting only the session's own override map (which
     * programme sessions never carry) made every target "a language with no
     * voice", and planSpeechTargets correctly, silently, planned nothing.
     */
    const voiceIdsByLanguage: Record<string, string> = {};
    for (const targetLanguage of session.targetLanguages) {
      const voiceId = this.sessions.voiceIdForLanguage(session, targetLanguage);
      if (voiceId) voiceIdsByLanguage[targetLanguage] = voiceId;
    }
    // The rule itself lives in `planSpeechTargets`, which is pure and pinned.
    return planSpeechTargets({
      targetLanguages: session.targetLanguages,
      textOnlyLanguages: session.generatedAudio?.textOnlyLanguages,
      voiceIdsByLanguage,
    });
  }

  /** A platform transcript from the live path, on its way to the gateway. */
  acceptLiveTranscript(event: TranscriptEvent): void {
    if (!this.socket?.connected) return;
    this.socket.emit(SOCKET_EVENTS.INGEST_LIVE_TRANSCRIPT, event);
  }

  stopMicrophoneSession(sessionId: string): ProcessingSession {
    const session = this.sessions.stopMicrophoneSession(sessionId);
    logger.info('Microphone capture session stopped', {
      sessionId: session.id,
      chunkCount: session.microphoneCapture.chunkCount,
    });
    return session;
  }

  stopMediaSession(sessionId: string): ProcessingSession {
    const session = this.sessions.stopMediaSession(sessionId);
    logger.info('WebRTC transcription session stopped', {
      sessionId: session.id,
      chunkCount: session.webrtcTranscriptionBridge?.chunkCount,
      // Languages and counts only, never text: the record that says how many
      // captions deliberately produced no clip (P6.4 text-only targets).
      skippedSynthesisByLanguage: this.sessions.skippedSynthesisCounts(session.id),
    });
    return session;
  }

  /**
   * Destroy audio already generated in a personal voice.
   *
   * Called when consent is withdrawn. Nothing is logged but the count: naming
   * the voice would put the thing being withdrawn into the log that outlives it.
   */
  async purgePersonalVoiceAudio(personalVoiceId: string): Promise<number> {
    const removed = await this.sessions.purgePersonalVoiceAudio(personalVoiceId);
    if (removed > 0) {
      logger.info('Generated personal-voice audio destroyed after withdrawal', { removed });
    }
    return removed;
  }

  async removeCallSession(sessionId: string): Promise<boolean> {
    // Read before removal: the skip counters are torn down with the session.
    const skippedSynthesisByLanguage = this.sessions.skippedSynthesisCounts(sessionId);
    const removed = await this.sessions.removeCallSession(sessionId);
    if (removed) {
      logger.info('Native-call ingest session removed', {
        sessionId,
        skippedSynthesisByLanguage,
      });
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
