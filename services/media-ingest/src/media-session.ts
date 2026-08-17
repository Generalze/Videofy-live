import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AiProviderStatusMetadata,
  AudioChunkMetadata,
  AudioExtractionMetadata,
  GeneratedAudioEvent,
  MediaCodecInfo,
  MediaFileMetadata,
  MicrophoneCaptureMetadata,
  MicrophoneCaptureChunkMetadata,
  SourceLanguageControlMetadata,
  SourceLanguageMode,
  SessionMonitoringMetadata,
  SessionRecoveryAction,
  SessionRecoveryEventKind,
  SessionRecoveryEventStatus,
  StreamStatus,
  TimestampedTranslationEvent,
  TimestampedTranslationLatency,
  TimestampedTranslationStatus,
  TextToSpeechSessionMetadata,
  TextToSpeechStatus,
  TranslationSessionMetadata,
  TranscriptionEvent,
  TranscriptionSessionMetadata,
  TranscriptionStatus,
  WebRtcTranscriptionBridgeMetadata,
  TargetLanguageCapability,
} from '@videofy-live/shared-types';
import {
  cleanupAudioChunks,
  emptyAudioExtraction,
  extractAudioChunks,
  safeSessionOutputDir,
  type AudioExtractionInput,
} from './audio-extraction.js';
import { parseVoiceOwnerId } from '@videofy-live/participant-contracts';
import { createRepetitionFilter, type RepetitionFilter } from './speech-confidence.js';
import { MediaIngestError } from './ingest-error.js';
import {
  MockTranscriptionProvider,
  transcribeWithTimeout,
  type TranscriptionProvider,
  type TranscriptionProviderResult,
} from './transcription-provider.js';
import {
  MockTimestampedTranslationProvider,
  translateWithTimeout,
  type TimestampedTranslationProvider,
} from './translation-provider.js';
import {
  MockTextToSpeechProvider,
  generateSpeechWithTimeout,
  type TextToSpeechProvider,
} from './text-to-speech-provider.js';
import {
  defaultViewerReadyMediaRenderer,
  type ViewerReadyMediaRenderer,
  type ViewerReadyMediaRenderSegment,
} from './viewer-ready-media-renderer.js';
import {
  applySourceLanguageAction,
  applySourceLanguageDetection,
  buildTargetLanguageCatalogue,
  createInitialSourceLanguageControl,
  defaultAiProviderStatus,
  type SourceLanguageActionInput,
} from './language-controls.js';
import {
  emptyTargetLanguageOutputTally,
  type SessionTargetLanguageTallies,
  type TargetLanguageOutputTally,
} from './target-language-outputs.js';

const execFileAsync = promisify(execFile);

export { MediaIngestError } from './ingest-error.js';

export const APPROVED_STREAM_STATES: readonly StreamStatus[] = [
  'created',
  'validating',
  'ready',
  'processing',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

export type SupportedMediaExtension = 'mp4' | 'mov' | 'mp3' | 'wav';
export type MediaKind = 'audio' | 'video';

export interface UploadedMediaFile {
  path: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  requestedSessionId?: string;
  targetLanguage?: string;
  targetLanguages?: string[];
  sourceLanguage?: string;
  sourceLanguageMode?: SourceLanguageMode;
}

export interface MicrophoneSessionInput {
  deviceId?: string;
  deviceLabel?: string;
  targetLanguage?: string;
  targetLanguages?: string[];
  sourceLanguage?: string;
  sourceLanguageMode?: SourceLanguageMode;
}

export interface MicrophoneChunkInput {
  sequence: number;
  startMs: number;
  endMs: number;
  mimeType: string;
  sizeBytes: number;
  sourcePath?: string;
}

export interface WebRtcSessionInput {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  targetLanguage?: string;
  targetLanguages?: string[];
  sourceLanguage?: string;
  sourceLanguageMode?: SourceLanguageMode;
  /**
   * P6.1B per-session standard-voice selection (language -> registered voiceId).
   * Overrides the configured per-language voice for this session only; unknown
   * voice IDs fail at generation time exactly like a misconfigured registry.
   */
  voiceIdsByLanguage?: Record<string, string>;
  /**
   * P6.3 personal voice: whose voice may be spoken in this session.
   *
   * The OWNER, deliberately not a resolved voice id. The current usable profile
   * is looked up per utterance, which is what makes revoking, deleting or
   * re-recording a voice take effect on the next thing said rather than on the
   * next call. Held privately — see `voiceOwnersBySession`.
   */
  voiceOwnerId?: string;
  /**
   * 'natural' keeps translated speech at the voice's own pace and full length
   * (native calls); default fits clips into the source segment window
   * (programme lip-fit).
   */
  generatedAudioPacing?: 'natural' | 'fit-window';
}

export interface WebRtcChunkInput {
  sequence: number;
  startMs: number;
  endMs: number;
  sampleRate: 16000;
  channelCount: 1;
  pcmFormat: 'pcm_s16le';
  discontinuity?: boolean;
  endOfStream?: boolean;
  mimeType: 'audio/wav';
  sizeBytes: number;
  sourcePath: string;
  /**
   * P6 streaming captions (Architecture V3 §22.1): this chunk is an INTERIM
   * slice of an utterance that is still being spoken. It carries the same
   * `sequence` and `startMs` as the FINAL chunk that will arrive when the
   * speaker pauses, and `endMs` is the current speech position. Interim chunks
   * are call-only, never join the durable audio timeline, and never produce
   * generated audio.
   */
  partial?: boolean;
  /** 0-based index of this interim chunk inside the current utterance. */
  partialSequence?: number;
}

/**
 * Streaming-caption marker carried by transcription/translation events that
 * describe an utterance still in progress.
 *
 * The programme contracts (`TranscriptionEvent`, `TimestampedTranslationEvent`
 * in `@videofy-live/shared-types`) have no partial flag, so media-ingest adds
 * these two OPTIONAL fields structurally rather than changing the shared
 * interfaces. Consumers that ignore them see exactly today's shape.
 *
 * Contract: **absence of `isFinal` means the event is final.** Every event
 * produced by the final-chunk pipeline is emitted unchanged; only interim
 * events carry `isFinal: false`. A partial reuses the sequence and the
 * `<chunkId>-s<index>` identity that the eventual final event will use, so a
 * caption renderer replaces the partial in place when the final arrives.
 */
export interface PartialEventMarker {
  /** Always `false` on interim events; absent on final events. */
  isFinal?: false;
  /** 0-based index of the interim chunk inside the current utterance. */
  partialSequence?: number;
}

export type PartialTranscriptionEvent = TranscriptionEvent & PartialEventMarker;
export type PartialTimestampedTranslationEvent = TimestampedTranslationEvent & PartialEventMarker;

export interface ProcessingSession {
  id: string;
  streamId: string;
  state: StreamStatus;
  sourceKind: 'upload' | 'microphone' | 'webrtc';
  media: MediaFileMetadata | null;
  audioExtraction: AudioExtractionMetadata;
  microphoneCapture: MicrophoneCaptureMetadata;
  webrtcTranscriptionBridge?: WebRtcTranscriptionBridgeMetadata;
  transcription: TranscriptionSessionMetadata;
  translation: TranslationSessionMetadata;
  generatedAudio: TextToSpeechSessionMetadata;
  monitoring: SessionMonitoringMetadata;
  targetLanguage: string;
  targetLanguages: string[];
  sourceLanguageControl: SourceLanguageControlMetadata;
  targetLanguageCatalogue: TargetLanguageCapability[];
  aiProviderStatus: AiProviderStatusMetadata;
  /** P6.1B per-session standard-voice overrides (language -> registered voiceId). */
  voiceIdsByLanguage?: Record<string, string>;
  /** P6.1B: 'natural' disables the programme window-fit for generated call audio. */
  generatedAudioPacing?: 'natural' | 'fit-window';
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface ProbeResult {
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codecs: MediaCodecInfo[];
}

export interface SourceMediaFile {
  mediaPath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ViewerReadyMediaFile {
  mediaPath: string;
  mimeType: 'video/mp4';
  sizeBytes: number;
}

export type MediaProbe = (filePath: string) => Promise<ProbeResult>;
export type AudioExtractor = (input: AudioExtractionInput) => Promise<AudioExtractionMetadata>;
export type AudioCleanup = (outputBaseDir: string, sessionId: string) => Promise<void>;

export interface ProcessingSessionStoreOptions {
  outputBaseDir: string;
  webRtcStagingDir?: string;
  onSessionChange?: (session: ProcessingSession) => void;
  onTranscriptionEvent?: (event: TranscriptionEvent) => void;
  onTranslationEvent?: (event: TimestampedTranslationEvent) => void;
  onGeneratedAudioReady?: (event: GeneratedAudioEvent, session: ProcessingSession) => void;
  extractAudio?: AudioExtractor;
  cleanupAudio?: AudioCleanup;
  transcriptionProvider?: TranscriptionProvider;
  transcriptionTimeoutMs?: number;
  translationProvider?: TimestampedTranslationProvider;
  translationTimeoutMs?: number;
  translationTargetLanguage?: string;
  translationSupportedTargetLanguages?: readonly string[];
  translationModelIds?: ReadonlyMap<string, string>;
  textToSpeechProvider?: TextToSpeechProvider;
  textToSpeechTimeoutMs?: number;
  textToSpeechVoiceId?: string;
  textToSpeechVoiceIds?: ReadonlyMap<string, string>;
  /**
   * The owner's CURRENT personal voice, or null when they have none usable.
   *
   * A callback rather than a value, and consulted on every utterance rather
   * than once per session. Caching the answer anywhere is precisely how
   * revoke, delete and re-record would stop taking effect until a restart.
   *
   * Left unset the pipeline behaves exactly as it did before personal voice
   * existed, so this cannot regress a deployment that has no voice engine.
   */
  resolvePersonalVoiceId?: (ownerId: string) => string | null;
  textToSpeechSupportedLanguages?: readonly string[];
  renderViewerReadyMedia?: ViewerReadyMediaRenderer;
  renderViewerReadyMediaOnCompletion?: boolean;
  sourceLanguageConfidenceThreshold?: number;
  /**
   * Pre-load the translation and voice models a native call will actually use,
   * as soon as its session is created, so the first utterance is not the one
   * that pays for loading them (see `warmUpCallModels`).
   *
   * Off by default: it costs a real translate and a real synthesis per call, so
   * it is opted into by the production wiring rather than imposed on every
   * embedder and test.
   */
  warmUpCallModels?: boolean;
}

export interface GeneratedAudioFile {
  sessionId: string;
  segmentId: string;
  sequence: number;
  targetLanguage: string;
  voiceId: string;
  durationMs: number;
  providerLatencyMs: number | null;
  audioPath: string;
  sizeBytes: number;
}

const SUPPORTED_MEDIA: Record<
  SupportedMediaExtension,
  { kind: MediaKind; mimeTypes: readonly string[] }
> = {
  mp4: { kind: 'video', mimeTypes: ['video/mp4', 'application/mp4'] },
  mov: { kind: 'video', mimeTypes: ['video/quicktime'] },
  mp3: { kind: 'audio', mimeTypes: ['audio/mpeg', 'audio/mp3'] },
  wav: { kind: 'audio', mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/vnd.wave'] },
};

/**
 * Text used only to make a translation pair or a voice model load (see
 * `warmUpCallModels`). Short, so warming costs little, and a real word rather
 * than punctuation because some engines short-circuit on empty input and would
 * then never load the model at all.
 */
const WARM_UP_PROBE_TEXT = 'Hello.';

const DUPLICATE_PROTECTED_STATES = new Set<StreamStatus>([
  'created',
  'validating',
  'ready',
  'processing',
  'paused',
]);

const ALLOWED_TRANSITIONS: Record<StreamStatus, readonly StreamStatus[]> = {
  created: ['validating', 'cancelled'],
  validating: ['ready', 'failed', 'cancelled'],
  ready: ['processing', 'failed', 'cancelled'],
  processing: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['processing', 'failed', 'cancelled'],
  completed: [],
  failed: ['ready', 'processing', 'cancelled'],
  cancelled: [],
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
  };
  streams?: FfprobeStream[];
}

export function resolveSupportedMedia(
  filename: string,
  mimeType: string,
): {
  extension: SupportedMediaExtension;
  kind: MediaKind;
} {
  assertSafeOriginalFilename(filename);

  const extension = extname(filename).slice(1).toLowerCase();
  if (!isSupportedExtension(extension)) {
    throw new MediaIngestError(
      'Unsupported media type. Upload MP4, MOV, MP3, or WAV.',
      'unsupported-extension',
      400,
    );
  }

  const normalizedMime = normalizeMimeType(mimeType);
  const supported = SUPPORTED_MEDIA[extension];
  if (
    normalizedMime &&
    normalizedMime !== 'application/octet-stream' &&
    !supported.mimeTypes.includes(normalizedMime)
  ) {
    throw new MediaIngestError(
      `Unsupported MIME type for .${extension}: ${mimeType}.`,
      'unsupported-mime',
      400,
    );
  }

  return { extension, kind: supported.kind };
}

export async function ffprobeMedia(filePath: string): Promise<ProbeResult> {
  let stdout = '';
  try {
    const result = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,codec_long_name,profile',
      '-of',
      'json',
      filePath,
    ]);
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown ffprobe error';
    throw new MediaIngestError(`Invalid or corrupt media: ${message}`, 'invalid-media', 400);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new MediaIngestError(
      'Invalid or corrupt media: ffprobe returned invalid metadata.',
      'invalid-media',
      400,
    );
  }

  const durationSeconds = Number(parsed.format?.duration);
  const streams = parsed.streams ?? [];
  const codecs = streams
    .filter((stream) => stream.codec_type === 'audio' || stream.codec_type === 'video')
    .map((stream): MediaCodecInfo | null => {
      if (!stream.codec_name || (stream.codec_type !== 'audio' && stream.codec_type !== 'video')) {
        return null;
      }
      const codec: MediaCodecInfo = {
        type: stream.codec_type,
        codecName: stream.codec_name,
      };
      if (stream.codec_long_name) codec.codecLongName = stream.codec_long_name;
      if (stream.profile) codec.profile = stream.profile;
      return codec;
    })
    .filter((codec): codec is MediaCodecInfo => codec !== null);

  const hasAudio = codecs.some((codec) => codec.type === 'audio');
  const hasVideo = codecs.some((codec) => codec.type === 'video');

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaIngestError(
      'Invalid media: duration could not be determined.',
      'invalid-media',
      400,
    );
  }

  return {
    durationMs: Math.round(durationSeconds * 1000),
    hasAudio,
    hasVideo,
    codecs,
  };
}

export class ProcessingSessionStore {
  private readonly sessions = new Map<string, ProcessingSession>();
  private readonly fingerprints = new Map<string, string>();
  private readonly resumeWaiters = new Map<string, Set<() => void>>();
  private readonly activeMicrophoneChunkSessions = new Set<string>();
  private readonly activeWebRtcChunkSessions = new Set<string>();
  private readonly outputBaseDir: string;
  private readonly webRtcStagingDir: string;
  private readonly onSessionChange: (session: ProcessingSession) => void;
  private readonly extractAudio: AudioExtractor;
  private readonly cleanupAudio: AudioCleanup;
  private readonly transcriptionProvider: TranscriptionProvider;
  private readonly transcriptionTimeoutMs: number;
  private readonly onTranscriptionEvent: (event: TranscriptionEvent) => void;
  private readonly translationProvider: TimestampedTranslationProvider;
  private readonly translationTimeoutMs: number;
  private readonly defaultTranslationTargetLanguage: string;
  private readonly translationSupportedTargetLanguages: readonly string[];
  private readonly onTranslationEvent: (event: TimestampedTranslationEvent) => void;
  private readonly textToSpeechProvider: TextToSpeechProvider;
  private readonly textToSpeechTimeoutMs: number;
  private readonly textToSpeechVoiceId: string;
  private readonly textToSpeechVoiceIds: ReadonlyMap<string, string>;
  private readonly resolvePersonalVoiceId: (ownerId: string) => string | null;
  /**
   * Session id -> voice owner, held OUTSIDE ProcessingSession on purpose.
   *
   * ProcessingSession is emitted to the operator dashboard and returned from
   * HTTP routes; an owner id placed on it would travel to every one of those
   * surfaces. It identifies whose voice may be spoken, so it stays here and
   * reaches nothing but the synthesis lookup.
   */
  private readonly voiceOwnersBySession = new Map<string, string>();
  private readonly textToSpeechSupportedLanguages: readonly string[];
  private readonly renderViewerReadyMedia: ViewerReadyMediaRenderer;
  private readonly renderViewerReadyMediaOnCompletion: boolean;
  private readonly sourceLanguageConfidenceThreshold: number;
  private readonly warmUpCallModelsEnabled: boolean;
  /** Language pairs and voices already warmed, so a call only pays once. */
  private readonly warmedTranslationPairs = new Set<string>();
  private readonly warmedVoices = new Set<string>();
  private readonly targetLanguageCatalogue: TargetLanguageCapability[];
  private readonly onGeneratedAudioReady: (event: GeneratedAudioEvent, session: ProcessingSession) => void;
  private readonly generatedAudioReadyKeysBySession = new Map<string, Set<string>>();
  private readonly transcriptionSequences = new Map<string, number>();
  /**
   * Per-session loop detection for the recogniser.
   *
   * Whisper repeats the same sentence chunk after chunk when a speaker stops
   * talking, so a live caller's own cloned voice recites one line until they
   * mute. Kept per session because a loop is a property of one conversation.
   */
  private readonly repetitionFilters = new Map<string, RepetitionFilter>();
  private readonly viewerReadyRenders = new Map<string, Promise<void>>();
  private readonly targetLanguageTallies = new Map<string, MutableSessionLanguageTallies>();

  constructor(options: ProcessingSessionStoreOptions) {
    this.outputBaseDir = options.outputBaseDir;
    this.webRtcStagingDir = options.webRtcStagingDir ?? resolve(process.cwd(), '../../uploads/webrtc-staging');
    this.onSessionChange = options.onSessionChange ?? (() => undefined);
    this.onTranscriptionEvent = options.onTranscriptionEvent ?? (() => undefined);
    this.onTranslationEvent = options.onTranslationEvent ?? (() => undefined);
    this.onGeneratedAudioReady = options.onGeneratedAudioReady ?? (() => undefined);
    this.extractAudio = options.extractAudio ?? extractAudioChunks;
    this.cleanupAudio = options.cleanupAudio ?? cleanupAudioChunks;
    this.transcriptionProvider =
      options.transcriptionProvider ?? new MockTranscriptionProvider('en');
    this.transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? 30_000;
    this.translationProvider =
      options.translationProvider ??
      new MockTimestampedTranslationProvider(['fr', 'es', 'de', 'pt', 'it', 'ja', 'zh', 'ar']);
    this.translationTimeoutMs = options.translationTimeoutMs ?? 30_000;
    this.translationSupportedTargetLanguages = normalizeSupportedTargetLanguages(
      options.translationSupportedTargetLanguages ?? [
        'fr',
        'es',
        'de',
        'pt',
        'it',
        'ja',
        'zh',
        'ar',
      ],
    );
    this.defaultTranslationTargetLanguage = this.resolveConfiguredTargetLanguage(
      options.translationTargetLanguage ?? 'fr',
    );
    this.textToSpeechSupportedLanguages = normalizeSupportedTargetLanguages(
      options.textToSpeechSupportedLanguages ?? this.translationSupportedTargetLanguages,
    );
    this.textToSpeechProvider =
      options.textToSpeechProvider ??
      new MockTextToSpeechProvider(this.textToSpeechSupportedLanguages);
    this.textToSpeechTimeoutMs = options.textToSpeechTimeoutMs ?? 30_000;
    this.textToSpeechVoiceId = normalizeVoiceId(options.textToSpeechVoiceId ?? 'mock-voice');
    this.textToSpeechVoiceIds = new Map(
      this.textToSpeechSupportedLanguages.map((language) => [
        language,
        normalizeVoiceId(options.textToSpeechVoiceIds?.get(language) ?? this.textToSpeechVoiceId),
      ]),
    );
    // Default: nobody has a personal voice. A deployment without a voice engine
    // keeps the standard path untouched rather than acquiring a new branch.
    this.resolvePersonalVoiceId = options.resolvePersonalVoiceId ?? (() => null);
    this.renderViewerReadyMedia =
      options.renderViewerReadyMedia ?? defaultViewerReadyMediaRenderer;
    this.renderViewerReadyMediaOnCompletion = options.renderViewerReadyMediaOnCompletion ?? false;
    this.sourceLanguageConfidenceThreshold = options.sourceLanguageConfidenceThreshold ?? 0.82;
    this.warmUpCallModelsEnabled = options.warmUpCallModels ?? false;
    this.targetLanguageCatalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: this.translationSupportedTargetLanguages,
      supportedVoiceLanguages: this.textToSpeechSupportedLanguages,
      ...(options.translationModelIds
        ? { opusMtModelIds: options.translationModelIds }
        : {}),
      voiceIds: new Map(
        this.textToSpeechSupportedLanguages.map((language) => [
          language,
          this.textToSpeechVoiceIds.get(language) ?? this.textToSpeechVoiceId,
        ]),
      ),
    });
  }

  async createFromUpload(
    upload: UploadedMediaFile,
    probe: MediaProbe = ffprobeMedia,
  ): Promise<ProcessingSession> {
    const supported = resolveSupportedMedia(upload.originalName, upload.mimeType);
    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(upload.sourceLanguage ? { sourceLanguage: upload.sourceLanguage } : {}),
      ...(upload.sourceLanguageMode ? { sourceLanguageMode: upload.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
    const targetLanguage = this.resolveSessionTargetLanguage(upload.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(
      upload.targetLanguages,
      targetLanguage,
      sourceLanguageControl.activeLanguage,
    );
    if (upload.requestedSessionId) {
      assertSafeRequestedSessionId(upload.requestedSessionId);
      const existing = this.sessions.get(upload.requestedSessionId);
      if (existing) {
        throw new MediaIngestError(
          `Processing session ${upload.requestedSessionId} already exists.`,
          'duplicate-processing',
          409,
          { ...existing },
        );
      }
    }
    const duplicate = this.findDuplicate(upload);
    if (duplicate) {
      throw new MediaIngestError(
        `Duplicate submission rejected for ${upload.originalName}.`,
        'duplicate-submission',
        409,
        duplicate,
      );
    }
    if (!upload.requestedSessionId) {
      // Idempotent reattach: a byte-identical re-upload of media that already
      // completed processing returns the existing session instead of creating
      // a new one and re-running the whole pipeline. A failed prior session
      // still gets a fresh session below.
      const completedDuplicate = this.findCompletedDuplicate(upload);
      if (completedDuplicate) {
        if (upload.path && upload.path !== completedDuplicate.sourcePath) {
          await rm(upload.path, { force: true });
        }
        return completedDuplicate;
      }
    }

    const now = new Date().toISOString();
    const session: ProcessingSession = {
      id: upload.requestedSessionId ?? `ps_${randomUUID()}`,
      streamId: `stream_${randomUUID()}`,
      state: 'created',
      sourceKind: 'upload',
      media: null,
      audioExtraction: emptyAudioExtraction('pending'),
      microphoneCapture: emptyMicrophoneCapture('idle'),
      transcription: emptyTranscription('queued'),
      translation: emptyTranslation('queued', targetLanguage, this.translationProvider.name),
      generatedAudio: emptyGeneratedAudio(
        'queued',
        targetLanguage,
        this.textToSpeechVoiceId,
        this.textToSpeechProvider.name,
      ),
      monitoring: emptyMonitoring(),
      targetLanguage,
      targetLanguages,
      sourceLanguageControl,
      targetLanguageCatalogue: this.targetLanguageCatalogue,
      aiProviderStatus: defaultAiProviderStatus(),
      sourcePath: upload.path,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.sessions.set(session.id, session);
    this.fingerprints.set(session.id, fileFingerprint(upload));
    this.emitSession(session);

    this.transition(session.id, 'validating');

    try {
      const probeResult = await probe(upload.path);
      this.validateProbeResult(supported.kind, probeResult);
      const media: MediaFileMetadata = {
        filename: upload.originalName,
        fileSizeBytes: upload.sizeBytes,
        mimeType: normalizeMimeType(upload.mimeType) || 'application/octet-stream',
        durationMs: probeResult.durationMs,
        hasAudio: probeResult.hasAudio,
        hasVideo: probeResult.hasVideo,
        codecs: probeResult.codecs,
      };
      session.media = media;
      this.transition(session.id, 'ready');
      return await this.startAudioExtraction(session.id);
    } catch (error) {
      return this.failSession(session, error, 'Media validation failed.');
    }
  }

  async createMicrophoneSession(input: MicrophoneSessionInput = {}): Promise<ProcessingSession> {
    const duplicate = this.findActiveMicrophoneSession();
    if (duplicate) {
      throw new MediaIngestError(
        `Duplicate microphone capture rejected for active session ${duplicate.id}.`,
        'duplicate-processing',
        409,
        duplicate,
      );
    }

    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.sourceLanguageMode ? { sourceLanguageMode: input.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
    const targetLanguage = this.resolveSessionTargetLanguage(input.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(
      input.targetLanguages,
      targetLanguage,
      sourceLanguageControl.activeLanguage,
    );
    const now = new Date().toISOString();
    const session: ProcessingSession = {
      id: `ps_${randomUUID()}`,
      streamId: `stream_${randomUUID()}`,
      state: 'created',
      sourceKind: 'microphone',
      media: null,
      audioExtraction: {
        ...emptyAudioExtraction('completed'),
        completedAt: now,
      },
      microphoneCapture: {
        ...emptyMicrophoneCapture('capturing'),
        deviceId: normalizeOptionalDeviceField(input.deviceId),
        deviceLabel: normalizeOptionalDeviceField(input.deviceLabel),
        startedAt: now,
      },
      transcription: emptyTranscription('queued'),
      translation: emptyTranslation('queued', targetLanguage, this.translationProvider.name),
      generatedAudio: emptyGeneratedAudio(
        'queued',
        targetLanguage,
        this.textToSpeechVoiceId,
        this.textToSpeechProvider.name,
      ),
      monitoring: emptyMonitoring(),
      targetLanguage,
      targetLanguages,
      sourceLanguageControl,
      targetLanguageCatalogue: this.targetLanguageCatalogue,
      aiProviderStatus: defaultAiProviderStatus(),
      sourcePath: '',
      createdAt: now,
      updatedAt: now,
      error: null,
    };

    this.sessions.set(session.id, session);
    this.emitSession(session);
    this.transition(session.id, 'validating');
    this.transition(session.id, 'ready');
    this.transition(session.id, 'processing');
    return { ...session };
  }

  async createWebRtcSession(input: WebRtcSessionInput): Promise<ProcessingSession> {
    assertSafeWebRtcSessionInput(input);
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (existing.sourceKind !== 'webrtc') {
        throw new MediaIngestError(
          `WebRTC processing session ${input.sessionId} already exists for another source.`,
          'duplicate-processing',
          409,
          { ...existing },
        );
      }
      if (existing.webrtcTranscriptionBridge?.revision === input.revision) {
        return { ...existing };
      }
      if (existing.state === 'processing' || existing.state === 'paused') {
        throw new MediaIngestError(
          `WebRTC processing session ${input.sessionId} is still active for revision ${existing.webrtcTranscriptionBridge?.revision}.`,
          'duplicate-processing',
          409,
          { ...existing },
        );
      }
      await rm(safeSessionOutputDir(this.outputBaseDir, existing.id), {
        recursive: true,
        force: true,
      });
      this.sessions.delete(existing.id);
      this.transcriptionSequences.delete(existing.id);
      this.generatedAudioReadyKeysBySession.delete(existing.id);
      this.viewerReadyRenders.delete(existing.id);
      this.targetLanguageTallies.delete(existing.id);
      this.voiceOwnersBySession.delete(existing.id);
      this.repetitionFilters.delete(existing.id);
    }

    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.sourceLanguageMode ? { sourceLanguageMode: input.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
    const targetLanguage = this.resolveSessionTargetLanguage(input.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(
      input.targetLanguages,
      targetLanguage,
      sourceLanguageControl.activeLanguage,
      isSourceLanguageKnown(sourceLanguageControl),
    );
    const now = new Date().toISOString();
    const session: ProcessingSession = {
      id: input.sessionId,
      streamId: input.broadcastId,
      state: 'created',
      sourceKind: 'webrtc',
      media: null,
      audioExtraction: {
        ...emptyAudioExtraction('completed'),
        completedAt: now,
      },
      microphoneCapture: emptyMicrophoneCapture('idle'),
      webrtcTranscriptionBridge: {
        status: 'ready',
        broadcastId: input.broadcastId,
        webRtcSessionId: input.sessionId,
        broadcasterPeerId: input.broadcasterPeerId,
        revision: input.revision,
        chunkCount: 0,
        processingChunks: 0,
        transcribedChunks: 0,
        failedChunks: 0,
        latestTranscript: null,
        lastError: null,
        startedAt: now,
      },
      transcription: emptyTranscription('queued'),
      translation: emptyTranslation('queued', targetLanguage, this.translationProvider.name),
      generatedAudio: emptyGeneratedAudio(
        'queued',
        targetLanguage,
        this.textToSpeechVoiceId,
        this.textToSpeechProvider.name,
      ),
      monitoring: emptyMonitoring(),
      targetLanguage,
      targetLanguages,
      sourceLanguageControl,
      targetLanguageCatalogue: this.targetLanguageCatalogue,
      aiProviderStatus: defaultAiProviderStatus(),
      ...(input.voiceIdsByLanguage && Object.keys(input.voiceIdsByLanguage).length > 0
        ? { voiceIdsByLanguage: { ...input.voiceIdsByLanguage } }
        : {}),
      ...(input.generatedAudioPacing ? { generatedAudioPacing: input.generatedAudioPacing } : {}),
      sourcePath: '',
      createdAt: now,
      updatedAt: now,
      error: null,
    };

    // Privately, alongside the session rather than on it: everything on
    // ProcessingSession is emitted to the operator dashboard and returned by
    // the HTTP routes, and this belongs on none of those.
    if (input.voiceOwnerId) {
      this.voiceOwnersBySession.set(session.id, input.voiceOwnerId);
    } else {
      this.voiceOwnersBySession.delete(session.id);
    }

    this.sessions.set(session.id, session);
    this.emitSession(session);
    this.transition(session.id, 'validating');
    this.transition(session.id, 'ready');
    this.transition(session.id, 'processing');
    // Deliberately not awaited: the call must start the instant it is created,
    // and warming is an optimisation the first utterance can safely race with.
    this.warmUpCallModels(session);
    return { ...session };
  }

  async ingestMicrophoneChunk(
    sessionId: string,
    input: MicrophoneChunkInput,
  ): Promise<ProcessingSession> {
    const session = this.requireMicrophoneSession(sessionId);
    if (this.activeMicrophoneChunkSessions.has(session.id)) {
      throw new MediaIngestError(
        `A microphone chunk is already being processed for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    this.activeMicrophoneChunkSessions.add(session.id);
    try {
      this.assertMicrophoneChunkAccepted(session, input);
      const chunk = await this.storeMicrophoneChunk(session, input);
      session.audioExtraction = {
        ...session.audioExtraction,
        status: 'completed',
        progressPct: 100,
        chunkCount: session.audioExtraction.chunks.length,
        chunks: session.audioExtraction.chunks,
        completedAt: new Date().toISOString(),
      };
      const { error: _captureError, ...captureWithoutError } = session.microphoneCapture;
      session.microphoneCapture = {
        ...captureWithoutError,
        status: 'capturing',
        durationMs: chunk.endMs,
        chunkCount: session.microphoneCapture.chunks.length,
      };
      session.error = null;
      this.emitSession(session);

      const transcriptionEvent = this.createTranscriptionEvent(
        session,
        chunk.chunkId,
        chunk.index,
        '',
        'und',
        null,
        'queued',
      );
      session.transcription.events = [...session.transcription.events, transcriptionEvent].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.updateTranscriptionProgress(session);
      this.onTranscriptionEvent(transcriptionEvent);
      this.emitSession(session);
      return await this.processMicrophoneTranscriptionEvent(session, transcriptionEvent);
    } catch (error) {
      if (input.sourcePath) {
        await rm(input.sourcePath, { force: true });
      }
      return this.failMicrophoneSession(session, error, 'Microphone chunk ingest failed.');
    } finally {
      this.activeMicrophoneChunkSessions.delete(session.id);
    }
  }

  async ingestWebRtcChunk(sessionId: string, input: WebRtcChunkInput): Promise<ProcessingSession> {
    const session = this.requireWebRtcSession(sessionId);
    if (input.partial) {
      return await this.ingestWebRtcPartialChunk(session, input);
    }
    if (this.activeWebRtcChunkSessions.has(session.id)) {
      throw new MediaIngestError(
        `A WebRTC transcription chunk is already being processed for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    this.activeWebRtcChunkSessions.add(session.id);
    try {
      this.assertWebRtcChunkAccepted(session, input);
      const chunk = await this.storeWebRtcChunk(session, input);
      session.audioExtraction = {
        ...session.audioExtraction,
        status: 'completed',
        progressPct: 100,
        chunkCount: session.audioExtraction.chunks.length,
        chunks: session.audioExtraction.chunks,
        completedAt: new Date().toISOString(),
      };
      this.updateWebRtcBridgeMetadata(session);
      session.error = null;
      this.emitSession(session);

      const transcriptionEvent = this.createTranscriptionEvent(
        session,
        chunk.chunkId,
        chunk.index,
        '',
        'und',
        null,
        'queued',
      );
      session.transcription.events = [...session.transcription.events, transcriptionEvent].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.updateTranscriptionProgress(session);
      this.updateWebRtcBridgeMetadata(session);
      this.onTranscriptionEvent(transcriptionEvent);
      this.emitSession(session);
      return await this.processWebRtcTranscriptionEvent(session, transcriptionEvent);
    } catch (error) {
      await rm(input.sourcePath, { force: true });
      if (isRealtimeCallSession(session)) {
        // A native call must survive a bad chunk: failing the session would
        // reject every later utterance for the rest of the call while the raw
        // voice kept flowing (owner-reported "translation is not persistent").
        return this.recordWebRtcChunkFailure(session, error);
      }
      return this.failWebRtcSession(session, error, 'WebRTC transcription chunk ingest failed.');
    } finally {
      this.activeWebRtcChunkSessions.delete(session.id);
    }
  }

  /**
   * P6 streaming captions: ingest an INTERIM chunk of an utterance that is
   * still being spoken, so a caption can appear before the speaker pauses.
   *
   * A partial is a preview, never a record:
   * - it is not appended to `session.audioExtraction.chunks` (that array is the
   *   final timeline that sequence/gap validation is built on),
   * - its audio lives under a distinct `webrtc-partial-*.wav` name and is
   *   deleted as soon as transcription is done,
   * - its events are delivered through the `onTranscriptionEvent` /
   *   `onTranslationEvent` callbacks only, never persisted into
   *   `session.transcription.events` / `session.translation.events`, so
   *   progress counters and the durable record stay owned by the finals,
   *   and no text-to-speech is generated,
   * - it can never fail the call: a bad partial is dropped and recorded the
   *   same way a dropped chunk is.
   */
  private async ingestWebRtcPartialChunk(
    session: ProcessingSession,
    input: WebRtcChunkInput,
  ): Promise<ProcessingSession> {
    if (!isRealtimeCallSession(session)) {
      // Programme sessions keep the contiguous, strictly-ordered timeline they
      // have today; accepting an interim chunk there would consume the final
      // chunk's sequence and reject the real audio that follows.
      await rm(input.sourcePath, { force: true });
      throw new MediaIngestError(
        'Partial WebRTC chunks are only accepted for native call sessions.',
        'invalid-transition',
        409,
        { ...session },
      );
    }
    if (this.isWebRtcChunkInFlight(session)) {
      // Superseded before it started: newer audio for this same utterance is
      // already on its way, so dropping the partial loses nothing and keeps the
      // final chunk's turn free.
      await rm(input.sourcePath, { force: true });
      return { ...session };
    }

    this.activeWebRtcChunkSessions.add(session.id);
    const partialSequence = input.partialSequence ?? 0;
    let audioPath: string | null = null;
    try {
      this.assertWebRtcPartialChunkAccepted(session, input);
      const stored = await this.storeWebRtcPartialChunk(session, input, partialSequence);
      audioPath = stored.audioPath;
      await this.processWebRtcPartialChunk(session, stored.chunk, audioPath, partialSequence);
      return { ...session };
    } catch (error) {
      // NOT recordWebRtcChunkFailure: that counter means speech was lost, and
      // a failed preview loses nothing — the final chunk still carries this
      // audio. Previews are frequent and transcribing half an utterance is the
      // likeliest thing to time out, so folding them into failedChunks would
      // bury real speech loss in expected noise on the one surface used to
      // diagnose it.
      return this.recordWebRtcPartialChunkFailure(session, error);
    } finally {
      // Partial audio never outlives its own transcription, on every path.
      await rm(input.sourcePath, { force: true });
      if (audioPath) await rm(audioPath, { force: true });
      this.activeWebRtcChunkSessions.delete(session.id);
    }
  }

  /**
   * True while a chunk of this session is being processed. Partial chunks are
   * dropped rather than queued when this holds, so streaming captions never
   * delay or displace the final utterance.
   */
  private isWebRtcChunkInFlight(session: ProcessingSession): boolean {
    return (
      this.activeWebRtcChunkSessions.has(session.id) ||
      session.transcription.events.some(
        (event) => event.status === 'transcribing' || event.status === 'retrying',
      )
    );
  }

  /**
   * Validation for an interim chunk: every format, size and path rule that a
   * final chunk must satisfy, minus the two ordering rules that compare against
   * stored final chunks. A partial deliberately repeats the pending final's
   * `sequence` and `startMs`, so "sequence must increase" and "no gap/overlap"
   * would reject every partial by construction. Those rules are untouched for
   * finals.
   */
  private assertWebRtcPartialChunkAccepted(
    session: ProcessingSession,
    input: WebRtcChunkInput,
  ): void {
    if (session.state !== 'processing') {
      throw new MediaIngestError(
        `WebRTC transcription chunks can only be accepted while the session is processing.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    if (!Number.isInteger(input.sequence) || input.sequence < 0) {
      throw new MediaIngestError(
        'WebRTC chunk sequence must be a non-negative integer.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    if (
      input.partialSequence !== undefined &&
      (!Number.isInteger(input.partialSequence) || input.partialSequence < 0)
    ) {
      throw new MediaIngestError(
        'WebRTC partial chunk sequence must be a non-negative integer.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    if (
      !Number.isInteger(input.startMs) ||
      !Number.isInteger(input.endMs) ||
      input.startMs < 0 ||
      input.endMs <= input.startMs ||
      input.endMs - input.startMs > 30_000
    ) {
      throw new MediaIngestError(
        'WebRTC chunk timestamps are invalid.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    if (
      input.sampleRate !== 16000 ||
      input.channelCount !== 1 ||
      input.pcmFormat !== 'pcm_s16le' ||
      input.mimeType !== 'audio/wav'
    ) {
      throw new MediaIngestError(
        'WebRTC chunk format must be WAV mono 16 kHz PCM 16-bit.',
        'invalid-media',
        400,
        { ...session },
      );
    }
    if (input.sizeBytes <= 44 || !Number.isInteger(input.sizeBytes)) {
      throw new MediaIngestError('WebRTC chunk is empty or invalid.', 'invalid-media', 400, {
        ...session,
      });
    }
    if (!isPathInside(this.webRtcStagingDir, input.sourcePath)) {
      throw new MediaIngestError('Unsafe WebRTC chunk path rejected.', 'unsafe-filename', 400, {
        ...session,
      });
    }
  }

  /**
   * Stages interim audio under a name that can never collide with the final
   * chunk that reuses the same sequence. The metadata is returned to the
   * caller instead of being appended to `session.audioExtraction.chunks`.
   */
  private async storeWebRtcPartialChunk(
    session: ProcessingSession,
    input: WebRtcChunkInput,
    partialSequence: number,
  ): Promise<{ chunk: MicrophoneCaptureChunkMetadata; audioPath: string }> {
    const outputDir = safeSessionOutputDir(this.outputBaseDir, session.id);
    await mkdir(outputDir, { recursive: true });
    const filename = `webrtc-partial-${String(input.sequence).padStart(6, '0')}-${String(
      partialSequence,
    ).padStart(4, '0')}.wav`;
    const audioPath = resolve(outputDir, filename);
    await rename(input.sourcePath, audioPath);

    return {
      chunk: {
        chunkId: `${this.webRtcChunkId(session, input.sequence)}:p${partialSequence}`,
        index: input.sequence,
        filename,
        startMs: input.startMs,
        endMs: input.endMs,
        durationMs: input.endMs - input.startMs,
        status: 'ready',
        receivedAt: new Date().toISOString(),
        mimeType: 'audio/wav',
        sizeBytes: input.sizeBytes,
      },
      audioPath,
    };
  }

  /**
   * Transcribes interim audio and, when it carries text, translates it into the
   * session's target languages. Everything is emitted through the event
   * callbacks marked `isFinal: false`; nothing is written to the session, and
   * no speech is generated — the final chunk owns the durable record and the
   * audio clip.
   */
  private async processWebRtcPartialChunk(
    session: ProcessingSession,
    chunk: MicrophoneCaptureChunkMetadata,
    audioPath: string,
    partialSequence: number,
  ): Promise<void> {
    const result = await transcribeWithTimeout(
      this.transcriptionProvider,
      {
        sessionId: session.id,
        streamId: session.streamId,
        chunk,
        audioPath,
        sourceLanguage: session.sourceLanguageControl.activeLanguage,
        sourceLanguageMode: session.sourceLanguageControl.mode,
      },
      this.transcriptionTimeoutMs,
    );
    // Language detection is deliberately NOT reconciled from interim audio: a
    // detection on half an utterance could bump the source-language revision
    // and make the utterance's own final transcription look stale.

    // A partial predicts the identity of the final it will be replaced by:
    // same sequence (the counter is only advanced by finals) and the same
    // `<chunkId>-s<index>` segment id, so a caption surface upserts in place.
    const baseSequence = this.peekTranscriptionSequence(session.id);
    const finalChunkId = this.webRtcChunkId(session, chunk.index);
    const transcribed = result.segments
      .filter((segment) => segment.text.trim() !== '')
      .map((segment, index): PartialTranscriptionEvent => {
        // Clamped so the window is always non-empty. A segment landing on (or
        // past) the chunk boundary would otherwise produce endMs === startMs,
        // which the timestamped-translation contract rejects outright — the
        // gateway logs "invalid timestamped translation event" and the caption
        // is silently lost, which looks exactly like the pipeline stalling.
        const startMs = Math.min(
          Math.max(chunk.startMs + segment.startMs, chunk.startMs),
          Math.max(chunk.startMs, chunk.endMs - 1),
        );
        const endMs = Math.min(
          Math.max(chunk.startMs + segment.endMs, startMs + 1),
          chunk.endMs,
        );
        return {
          sessionId: session.id,
          streamId: session.streamId,
          chunkId: `${finalChunkId}-s${index}`,
          sequence: baseSequence + index,
          sourceText: segment.text.trim(),
          detectedLanguage: result.detectedLanguage,
          startMs,
          endMs,
          confidence: result.confidence,
          sourceLanguageRevision: session.sourceLanguageControl.revision,
          providerLatencyMs: result.providerLatencyMs ?? null,
          status: 'transcribed',
          createdAt: new Date().toISOString(),
          isFinal: false,
          partialSequence,
        };
      });
    if (transcribed.length === 0) return;

    for (const event of transcribed) {
      this.onTranscriptionEvent(event);
    }

    const targetLanguages =
      session.targetLanguages.length > 0 ? session.targetLanguages : [session.targetLanguage];
    for (const segment of transcribed) {
      for (const targetLanguage of targetLanguages) {
        await this.emitPartialTranslation(session, segment, targetLanguage, partialSequence);
      }
    }
  }

  private async emitPartialTranslation(
    session: ProcessingSession,
    segment: PartialTranscriptionEvent,
    targetLanguage: string,
    partialSequence: number,
  ): Promise<void> {
    const startedAt = Date.now();
    const result = await translateWithTimeout(
      this.translationProvider,
      {
        sessionId: session.id,
        streamId: session.streamId,
        segmentId: segment.chunkId,
        sequence: segment.sequence,
        sourceLanguage: segment.detectedLanguage,
        targetLanguage,
        sourceText: segment.sourceText,
        startMs: segment.startMs,
        endMs: segment.endMs,
      },
      this.translationTimeoutMs,
    );
    const translated: PartialTimestampedTranslationEvent = {
      ...this.createTranslationEvent(
        session,
        segment,
        result.translatedText,
        'translated',
        {
          queuedMs: 0,
          providerMs: Date.now() - startedAt,
          totalMs: Math.max(0, Date.now() - startedAt),
        },
        undefined,
        targetLanguage,
      ),
      isFinal: false,
      partialSequence,
    };
    // Only the terminal state is emitted for a partial: intermediate
    // queued/translating events would flash empty captions on the way to text
    // that is itself provisional.
    this.onTranslationEvent(translated);
  }

  /** Stable id of the FINAL chunk for a sequence, shared by partials and finals. */
  private webRtcChunkId(session: ProcessingSession, sequence: number): string {
    return `${session.id}:webrtc:${session.webrtcTranscriptionBridge?.revision ?? 0}:${sequence}`;
  }

  /**
   * Pre-loads the models a native call is about to need.
   *
   * Measured on a real EN<->FR call: the first six delivered captions had a
   * median latency of 1651 ms (worst 4195 ms) while the remaining 52 sat at
   * 530 ms. The difference is model loading — faster-whisper is warmed at
   * service start, but each OPUS-MT pair and each Piper voice loads lazily on
   * first use, so the opening exchange of every call paid for it. That is the
   * worst possible moment: it is the part a demo audience actually watches.
   *
   * The probe deliberately goes through the ordinary `translate` / `generate`
   * calls rather than a bespoke warm-up hook, so it warms whatever provider is
   * wired in without widening the provider interface.
   *
   * Fire-and-forget and failure-proof by construction: warming is an
   * optimisation, so anything that goes wrong here must leave the call exactly
   * as it would have been with no warm-up at all.
   */
  private warmUpCallModels(session: ProcessingSession): void {
    if (!this.warmUpCallModelsEnabled || !isRealtimeCallSession(session)) return;
    // Auto-detect calls do not yet know what language is being spoken: the
    // control still holds the default until the first chunk reconciles it, so
    // warming here would load the wrong pair AND occupy the single translation
    // slot at the exact moment the first real utterance needs it.
    if (session.sourceLanguageControl.mode !== 'manual') return;
    // `.catch` rather than bare `void`: an unhandled rejection is fatal to the
    // process, and warming must never be able to take a call down with it.
    void this.runCallWarmUp(session).catch(() => undefined);
  }

  private async runCallWarmUp(session: ProcessingSession): Promise<void> {
    const sourceLanguage = session.sourceLanguageControl.activeLanguage;
    // Translation is warmed for every target: partials translate into all of
    // them. Speech is warmed only for the primary target, because that is the
    // only language the final path ever synthesizes.
    const targetLanguages =
      session.targetLanguages.length > 0 ? session.targetLanguages : [session.targetLanguage];
    for (const targetLanguage of targetLanguages) {
      await this.warmUpTranslationPair(session, sourceLanguage, targetLanguage);
    }
    await this.warmUpVoice(session, session.targetLanguage);
  }

  private async warmUpTranslationPair(
    session: ProcessingSession,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<void> {
    if (sourceLanguage === targetLanguage) return;
    const pair = `${sourceLanguage}->${targetLanguage}`;
    if (this.warmedTranslationPairs.has(pair)) return;
    this.warmedTranslationPairs.add(pair);
    try {
      // Through the same timeout wrapper the real path uses: a probe that hung
      // would hold the single translation slot against live speech.
      await translateWithTimeout(
        this.translationProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          segmentId: `${session.id}:warmup:${pair}`,
          sequence: 0,
          sourceLanguage,
          targetLanguage,
          sourceText: WARM_UP_PROBE_TEXT,
          startMs: 0,
          endMs: 1_000,
        },
        this.translationTimeoutMs,
      );
    } catch (error) {
      // Transient failure (model still downloading, worker restarting): forget
      // it so a later call retries. A rejection the configuration guarantees
      // will repeat is remembered instead, so it is attempted once per process
      // rather than on every single call forever.
      if (!isPermanentWarmUpFailure(error)) this.warmedTranslationPairs.delete(pair);
    }
  }

  private async warmUpVoice(session: ProcessingSession, targetLanguage: string): Promise<void> {
    // Mirror the real path's gate: a captions-only language falls through to
    // the default voice id, which would ask the engine for a voice in the wrong
    // language and fail every time.
    if (!this.textToSpeechSupportedLanguages.includes(targetLanguage)) return;
    const voiceId = this.voiceIdForLanguage(session, targetLanguage);
    const key = `${targetLanguage}:${voiceId}`;
    if (this.warmedVoices.has(key)) return;
    this.warmedVoices.add(key);
    let outputDir: string;
    let outputPath: string;
    try {
      // Path building validates the session id and language and can throw, so
      // it belongs inside the guarded region like everything else here.
      outputDir = resolve(safeSessionOutputDir(this.outputBaseDir, session.id), 'tts');
      outputPath = resolve(outputDir, `warmup-${safeLanguageDirectory(targetLanguage)}.wav`);
    } catch {
      return;
    }
    try {
      // Own the directory rather than assuming the provider creates it: a
      // provider that does not would fail the probe, roll the memo back, and
      // make every call warm again forever.
      await mkdir(outputDir, { recursive: true });
      await generateSpeechWithTimeout(
        this.textToSpeechProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          segmentId: `${session.id}:warmup:${targetLanguage}`,
          sequence: 0,
          targetLanguage,
          translatedText: WARM_UP_PROBE_TEXT,
          startMs: 0,
          endMs: 1_000,
          voiceId,
          outputPath,
          pacing: 'natural',
        },
        this.textToSpeechTimeoutMs,
      );
    } catch (error) {
      if (!isPermanentWarmUpFailure(error)) this.warmedVoices.delete(key);
    } finally {
      await this.discardWarmUpArtifacts(session, outputPath);
    }
  }

  /**
   * Removes everything the probe wrote. The engines stage a raw clip beside the
   * requested output (`.piper.wav` / `.mms.wav`) and only clean it up once they
   * reach normalisation, so a probe that failed earlier would leave it behind
   * with nothing else in the service to ever sweep it.
   *
   * A call can also be retired while its warm-up is still running — membership
   * churn deletes the ingest session and its output directory — in which case
   * `mkdir` above has just recreated that directory. If the session is gone,
   * take the directory with us rather than leaving an orphan per raced call.
   */
  private async discardWarmUpArtifacts(
    session: ProcessingSession,
    outputPath: string,
  ): Promise<void> {
    await Promise.all(
      [outputPath, `${outputPath}.piper.wav`, `${outputPath}.mms.wav`].map((path) =>
        rm(path, { force: true }).catch(() => undefined),
      ),
    );
    if (this.sessions.has(session.id)) return;
    await rm(safeSessionOutputDir(this.outputBaseDir, session.id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  /**
   * Records a failed INTERIM chunk. Deliberately touches neither `failedChunks`
   * nor `lastError`: those two mean "speech was lost on this call", and a
   * preview that never arrived costs only an earlier caption. The final chunk
   * for the same utterance is unaffected and still on its way.
   */
  private recordWebRtcPartialChunkFailure(
    session: ProcessingSession,
    error: unknown,
  ): ProcessingSession {
    const message = error instanceof Error ? error.message : 'WebRTC partial chunk failed.';
    if (session.webrtcTranscriptionBridge) {
      session.webrtcTranscriptionBridge = {
        ...session.webrtcTranscriptionBridge,
        failedPartialChunks: (session.webrtcTranscriptionBridge.failedPartialChunks ?? 0) + 1,
        lastPartialError: message,
      };
    }
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
    return { ...session };
  }

  /**
   * Records a per-chunk failure on a live call without ending the session.
   * The chunk is lost and reported; subsequent audio keeps being accepted.
   */
  private recordWebRtcChunkFailure(session: ProcessingSession, error: unknown): ProcessingSession {
    const message = error instanceof Error ? error.message : 'WebRTC transcription chunk failed.';
    if (session.webrtcTranscriptionBridge) {
      session.webrtcTranscriptionBridge = {
        ...session.webrtcTranscriptionBridge,
        failedChunks: session.webrtcTranscriptionBridge.failedChunks + 1,
        lastError: message,
      };
    }
    // Recorded in session metadata (bridge lastError/failedChunks + monitoring)
    // rather than logged: this module stays I/O-free, and the operator surface
    // already renders these fields.
    session.monitoring = { ...session.monitoring, lastError: message };
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
    return { ...session };
  }

  stopMicrophoneSession(sessionId: string): ProcessingSession {
    const session = this.requireMicrophoneSession(sessionId);
    if (session.state !== 'processing' && session.state !== 'paused') {
      throw new MediaIngestError(
        `Only active microphone sessions can be stopped.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    session.microphoneCapture = {
      ...session.microphoneCapture,
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      durationMs: lastMicrophoneEndMs(session),
    };
    session.error = null;
    if (session.state === 'paused') {
      this.transition(session.id, 'processing');
    }
    this.transition(session.id, 'completed');
    return { ...session };
  }

  /**
   * Destroy audio already generated in a personal voice (P6.3 withdrawal).
   *
   * Withdrawing consent has to reach audio that EXISTS, not just audio not yet
   * produced. Translated speech is generated ahead of playback and queued in
   * every listener's browser, so a revocation that only changed future routing
   * would let several more cloned utterances play out while the system
   * considered itself compliant.
   *
   * The files are removed rather than the events rewritten, because the
   * listeners holding those clips in a queue are other people's browsers and
   * the only thing this process controls is whether the bytes are still there
   * to fetch. A queued clip whose file is gone fails to load and is dropped by
   * the player, which is the outcome consent withdrawal is asking for.
   *
   * Returns how many were destroyed, so the caller can say what happened
   * instead of asserting it.
   */
  async purgePersonalVoiceAudio(personalVoiceId: string): Promise<number> {
    let removed = 0;
    for (const session of this.sessions.values()) {
      const affected = session.generatedAudio.events.filter(
        (event) => event.voiceId === personalVoiceId,
      );
      if (affected.length === 0) continue;

      for (const event of affected) {
        try {
          await rm(
            this.generatedAudioOutputPath(session.id, event.targetLanguage, event.sequence),
            { force: true },
          );
          removed += 1;
        } catch {
          // A file that refuses to go is reported by not being counted. The
          // route says how many were destroyed, never how many it meant to.
        }
      }

      // The record stops advertising a clip that can no longer be played. The
      // words are kept: the translation happened and denying it would be a
      // different kind of dishonesty from the one this is preventing.
      session.generatedAudio.events = session.generatedAudio.events.map((event) =>
        event.voiceId === personalVoiceId
          ? { ...event, status: 'failed' as const, error: 'Consent for this voice was withdrawn.' }
          : event,
      );
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);
    }
    return removed;
  }

  /**
   * P6.1B: remove a retired or ended native-call ingest session together with
   * its output directory, so call membership churn cannot accumulate stopped
   * sessions. Restricted to `call_` WebRTC sessions; programme sessions keep
   * their existing lifecycle.
   */
  async removeCallSession(sessionId: string): Promise<boolean> {
    if (!/^call_/i.test(sessionId)) {
      throw new MediaIngestError('Only native-call sessions can be removed.', 'invalid-media', 400);
    }
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.sourceKind !== 'webrtc') {
      throw new MediaIngestError('Only WebRTC call sessions can be removed.', 'invalid-media', 400);
    }
    if (session.state === 'processing' || session.state === 'paused' || session.state === 'failed') {
      this.stopWebRtcSession(sessionId);
    }
    await rm(safeSessionOutputDir(this.outputBaseDir, sessionId), { recursive: true, force: true });
    this.sessions.delete(sessionId);
    this.transcriptionSequences.delete(sessionId);
    this.generatedAudioReadyKeysBySession.delete(sessionId);
    this.viewerReadyRenders.delete(sessionId);
    this.targetLanguageTallies.delete(sessionId);
    // The call is over; there is no reason to keep knowing whose voice it was.
    this.voiceOwnersBySession.delete(sessionId);
    this.repetitionFilters.delete(sessionId);
    return true;
  }

  stopWebRtcSession(sessionId: string): ProcessingSession {
    const session = this.requireWebRtcSession(sessionId);
    if (session.state !== 'processing' && session.state !== 'paused' && session.state !== 'failed') {
      throw new MediaIngestError(
        `Only active WebRTC transcription sessions can be stopped.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    if (session.webrtcTranscriptionBridge) {
      session.webrtcTranscriptionBridge = {
        ...session.webrtcTranscriptionBridge,
        status: session.state === 'failed' ? 'failed' : 'stopped',
        stoppedAt: new Date().toISOString(),
      };
    }
    session.error = null;
    if (session.state === 'paused') {
      this.transition(session.id, 'processing');
    }
    if (session.state !== 'failed') {
      this.transition(session.id, 'completed');
    } else {
      this.emitSession(session);
    }
    return { ...session };
  }

  failMicrophoneDeviceDisconnected(sessionId: string): ProcessingSession {
    const session = this.requireMicrophoneSession(sessionId);
    return this.markMicrophoneSessionFailed(session, 'Microphone device disconnected.');
  }

  async retryAudioExtraction(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    if (session.state === 'processing') {
      throw new MediaIngestError(
        `Audio extraction is already running for ${sessionId}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (session.state === 'completed') {
      throw new MediaIngestError(
        `Audio extraction already completed for ${sessionId}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (!session.media) {
      throw new MediaIngestError(
        `Session ${sessionId} does not have validated media.`,
        'invalid-media',
        409,
        { ...session },
      );
    }

    await this.cleanupAudio(this.outputBaseDir, session.id);
    if (session.state === 'failed') {
      this.transition(session.id, 'ready');
    }
    return await this.startAudioExtraction(session.id);
  }

  async cleanupFailedAudio(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    if (session.state !== 'failed' && session.audioExtraction.status !== 'failed') {
      throw new MediaIngestError(
        `Audio cleanup is only available for failed processing sessions.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    await this.cleanupAudio(this.outputBaseDir, session.id);
    session.audioExtraction = emptyAudioExtraction('cleaned');
    session.error = null;
    this.transition(session.id, 'ready');
    return { ...session };
  }

  async startAudioExtraction(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    if (session.state === 'processing') {
      throw new MediaIngestError(
        `Audio extraction is already running for ${sessionId}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (session.state === 'completed') {
      throw new MediaIngestError(
        `Audio extraction already completed for ${sessionId}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (!session.media) {
      throw new MediaIngestError(
        `Session ${sessionId} does not have validated media.`,
        'invalid-media',
        409,
        { ...session },
      );
    }

    session.audioExtraction = {
      ...emptyAudioExtraction('extracting'),
      progressPct: 10,
      startedAt: new Date().toISOString(),
    };
    session.error = null;
    this.emitSession(session);
    this.transition(session.id, 'processing');

    try {
      session.audioExtraction = {
        ...session.audioExtraction,
        status: 'chunking',
        progressPct: 50,
      };
      this.emitSession(session);
      const extraction = await this.extractAudio({
        sessionId: session.id,
        sourcePath: session.sourcePath,
        outputBaseDir: this.outputBaseDir,
        expectedDurationMs: session.media.durationMs,
      });
      session.audioExtraction = extraction;
      this.emitSession(session);
      if (!(await this.waitUntilRunnable(session))) {
        return { ...session };
      }
      return await this.startTranscription(session.id);
    } catch (error) {
      return this.failSession(session, error, 'Audio extraction failed.');
    }
  }

  async startTranscription(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    this.assertNoActiveTranscription(session);
    if (session.audioExtraction.status !== 'completed') {
      throw new MediaIngestError(
        `Session ${sessionId} does not have completed audio extraction.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    const readyChunks = session.audioExtraction.chunks
      .filter((chunk) => chunk.status === 'ready')
      .sort((a, b) => a.index - b.index);
    if (readyChunks.length === 0) {
      throw new MediaIngestError(
        `Session ${sessionId} has no ready audio chunks to transcribe.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    this.transcriptionSequences.delete(session.id);
    session.transcription = {
      ...emptyTranscription('queued'),
      totalChunks: readyChunks.length,
      events: readyChunks.map((chunk) =>
        this.createTranscriptionEvent(
          session,
          chunk.chunkId,
          chunk.index,
          '',
          'und',
          null,
          'queued',
        ),
      ),
    };
    this.emitSession(session);
    for (const event of session.transcription.events) {
      this.onTranscriptionEvent(event);
    }

    return await this.processTranscriptionEvents(session, session.transcription.events);
  }

  async retryTranscriptionChunk(sessionId: string, chunkId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    try {
      this.assertRetryAllowed(session, 'retry-transcription', chunkId);
      this.assertNoActiveTranscription(session);
      const event = session.transcription.events.find((item) => item.chunkId === chunkId);
      if (!event) {
        throw new MediaIngestError(
          `Unknown transcription chunk: ${chunkId}.`,
          'invalid-transition',
          404,
          {
            ...session,
          },
        );
      }
      if (event.status !== 'failed') {
        throw new MediaIngestError(
          `Only failed transcription chunks can be retried.`,
          'duplicate-processing',
          409,
          { ...session },
        );
      }

      this.recordSessionEvent(
        session,
        'operator-action',
        'retry-transcription',
        'accepted',
        `Retry transcription requested for ${chunkId}.`,
        chunkId,
      );
      if (session.state === 'failed') {
        this.transition(session.id, 'processing');
      }

      const { error: _retryError, ...eventWithoutError } = event;
      const retrying = {
        ...eventWithoutError,
        status: 'retrying' as const,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, retrying);
      this.onTranscriptionEvent(retrying);
      this.updateTranscriptionProgress(session);
      this.emitSession(session);

      const next = await this.processTranscriptionEvents(session, [retrying]);
      const retried = next.transcription.events.find((item) => item.chunkId === chunkId);
      const retrySucceeded = retried ? retried.status === 'transcribed' : true;
      this.recordSessionEvent(
        session,
        'recovery-event',
        'retry-transcription',
        retrySucceeded ? 'succeeded' : 'failed',
        retrySucceeded
          ? `Transcription retry succeeded for ${chunkId}.`
          : (retried?.error ?? `Transcription retry failed for ${chunkId}.`),
        chunkId,
      );
      this.emitSession(session);
      return { ...session };
    } catch (error) {
      this.recordRejectedAction(session, 'retry-transcription', error, chunkId);
      throw error;
    }
  }

  exportTranscript(sessionId: string): string {
    const session = this.requireSession(sessionId);
    const events = session.transcription.events.slice().sort((a, b) => a.sequence - b.sequence);
    if (events.length === 0 || events.some((event) => event.status !== 'transcribed')) {
      throw new MediaIngestError(
        `Transcript export requires all ready chunks to be transcribed.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    return events
      .map(
        (event) =>
          `[${formatTranscriptTimestamp(event.startMs)} - ${formatTranscriptTimestamp(event.endMs)}] ${event.sourceText}`,
      )
      .join('\n');
  }

  async retryTranslationSegment(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    try {
      this.assertRetryAllowed(session, 'retry-translation', segmentId);
      this.assertNoActiveTranslation(session);
      const language = targetLanguage
        ? normalizeTargetLanguage(targetLanguage)
        : session.targetLanguage;
      const event = session.translation.events.find(
        (item) => item.segmentId === segmentId && item.targetLanguage === language,
      );
      if (!event) {
        throw new MediaIngestError(
          `Unknown translation segment: ${segmentId}.`,
          'invalid-transition',
          404,
          { ...session },
        );
      }
      if (event.status !== 'failed') {
        throw new MediaIngestError(
          `Only failed translation segments can be retried.`,
          'duplicate-processing',
          409,
          { ...session },
        );
      }

      this.recordSessionEvent(
        session,
        'operator-action',
        'retry-translation',
        'accepted',
        `Retry translation requested for ${segmentId}.`,
        segmentId,
      );
      if (session.state === 'failed') {
        this.transition(session.id, 'processing');
      }

      const { error: _retryError, ...eventWithoutError } = event;
      const retrying = {
        ...eventWithoutError,
        status: 'retrying' as const,
        translatedText: '',
        latency: zeroTranslationLatency(),
        createdAt: new Date().toISOString(),
      };
      this.replaceTranslationEvent(session, retrying);
      this.onTranslationEvent(retrying);
      this.updateTranslationProgress(session);
      this.emitSession(session);

      const next = await this.processTranslationEvents(session, [retrying]);
      const retried = next.translation.events.find(
        (item) => item.segmentId === segmentId && item.targetLanguage === language,
      );
      this.recordSessionEvent(
        session,
        'recovery-event',
        'retry-translation',
        retried?.status === 'translated' ? 'succeeded' : 'failed',
        retried?.status === 'translated'
          ? `Translation retry succeeded for ${segmentId}.`
          : (retried?.error ?? `Translation retry failed for ${segmentId}.`),
        segmentId,
      );
      this.emitSession(session);
      return { ...session };
    } catch (error) {
      this.recordRejectedAction(session, 'retry-translation', error, segmentId);
      throw error;
    }
  }

  pauseSession(sessionId: string): ProcessingSession {
    const session = this.requireSession(sessionId);
    if (session.state !== 'processing') {
      const error = new MediaIngestError(
        `Only processing sessions can be paused.`,
        'invalid-transition',
        409,
        { ...session },
      );
      this.recordRejectedAction(session, 'pause', error);
      throw error;
    }
    this.recordSessionEvent(
      session,
      'operator-action',
      'pause',
      'accepted',
      `Processing paused by operator.`,
    );
    if (session.sourceKind === 'microphone') {
      session.microphoneCapture = {
        ...session.microphoneCapture,
        status: 'paused',
      };
    }
    return this.transition(session.id, 'paused');
  }

  resumeSession(sessionId: string): ProcessingSession {
    const session = this.requireSession(sessionId);
    if (session.state !== 'paused') {
      const error = new MediaIngestError(
        `Only paused sessions can be resumed.`,
        'invalid-transition',
        409,
        { ...session },
      );
      this.recordRejectedAction(session, 'resume', error);
      throw error;
    }
    this.recordSessionEvent(
      session,
      'operator-action',
      'resume',
      'accepted',
      `Processing resumed by operator.`,
    );
    if (session.sourceKind === 'microphone') {
      session.microphoneCapture = {
        ...session.microphoneCapture,
        status: 'capturing',
      };
    }
    const resumed = this.transition(session.id, 'processing');
    this.releaseResumeWaiters(session.id);
    return resumed;
  }

  cancelSession(sessionId: string): ProcessingSession {
    const session = this.requireSession(sessionId);
    if (session.state === 'completed' || session.state === 'cancelled') {
      const error = new MediaIngestError(
        `Completed or cancelled sessions cannot be cancelled.`,
        'invalid-transition',
        409,
        { ...session },
      );
      this.recordRejectedAction(session, 'cancel', error);
      throw error;
    }
    this.recordSessionEvent(
      session,
      'operator-action',
      'cancel',
      'accepted',
      `Processing cancelled by operator.`,
    );
    if (session.sourceKind === 'microphone') {
      session.microphoneCapture = {
        ...session.microphoneCapture,
        status: 'cancelled',
        stoppedAt: new Date().toISOString(),
        durationMs: lastMicrophoneEndMs(session),
      };
    }
    const cancelled = this.transition(session.id, 'cancelled');
    this.releaseResumeWaiters(session.id);
    return cancelled;
  }

  exportPairedTranslation(sessionId: string): string {
    const session = this.requireSession(sessionId);
    const events = session.translation.events.slice().sort((a, b) => a.sequence - b.sequence);
    if (events.length === 0 || events.some((event) => event.status !== 'translated')) {
      throw new MediaIngestError(
        `Translation export requires all transcribed segments to be translated.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    return events
      .map(
        (event) =>
          `[${formatTranscriptTimestamp(event.startMs)} - ${formatTranscriptTimestamp(event.endMs)}]\n${event.sourceLanguage}: ${event.sourceText}\n${event.targetLanguage}: ${event.translatedText}`,
      )
      .join('\n\n');
  }

  async retryGeneratedAudioSegment(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    try {
      this.assertRetryAllowed(session, 'retry-tts', segmentId);
      this.assertNoActiveGeneratedAudio(session);
      const language = targetLanguage
        ? normalizeTargetLanguage(targetLanguage)
        : session.targetLanguage;
      const event = session.generatedAudio.events.find(
        (item) => item.segmentId === segmentId && item.targetLanguage === language,
      );
      if (!event) {
        throw new MediaIngestError(
          `Unknown generated-audio segment: ${segmentId}.`,
          'invalid-transition',
          404,
          { ...session },
        );
      }
      if (event.status !== 'failed') {
        throw new MediaIngestError(
          `Only failed generated-audio segments can be retried.`,
          'duplicate-processing',
          409,
          { ...session },
        );
      }

      this.recordSessionEvent(
        session,
        'operator-action',
        'retry-tts',
        'accepted',
        `Retry generated audio requested for ${segmentId}.`,
        segmentId,
      );
      if (session.state === 'failed') {
        this.transition(session.id, 'processing');
      }

      const { error: _retryError, ...eventWithoutError } = event;
      const retrying = {
        ...eventWithoutError,
        status: 'retrying' as const,
        providerLatencyMs: null,
        createdAt: new Date().toISOString(),
      };
      this.replaceGeneratedAudioEvent(session, retrying);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);

      const next = await this.processGeneratedAudioEvents(session, [retrying]);
      const retried = next.generatedAudio.events.find(
        (item) => item.segmentId === segmentId && item.targetLanguage === language,
      );
      this.recordSessionEvent(
        session,
        'recovery-event',
        'retry-tts',
        retried?.status === 'generated' ? 'succeeded' : 'failed',
        retried?.status === 'generated'
          ? `Generated-audio retry succeeded for ${segmentId}.`
          : (retried?.error ?? `Generated-audio retry failed for ${segmentId}.`),
        segmentId,
      );
      this.emitSession(session);
      return { ...session };
    } catch (error) {
      this.recordRejectedAction(session, 'retry-tts', error, segmentId);
      throw error;
    }
  }

  updateSourceLanguageControl(
    sessionId: string,
    input: SourceLanguageActionInput,
  ): ProcessingSession {
    const session = this.requireSession(sessionId);
    const previousRevision = session.sourceLanguageControl.revision;
    session.sourceLanguageControl = applySourceLanguageAction(session.sourceLanguageControl, input);
    if (session.sourceLanguageControl.revision !== previousRevision) {
      this.createLanguageRevisionBoundary(session);
    }
    session.error = null;
    this.emitSession(session);
    return { ...session };
  }

  transition(sessionId: string, nextState: StreamStatus): ProcessingSession {
    const session = this.requireSession(sessionId);

    if (!ALLOWED_TRANSITIONS[session.state].includes(nextState)) {
      throw new MediaIngestError(
        `Invalid stream state transition: ${session.state} -> ${nextState}.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    session.state = nextState;
    session.updatedAt = new Date().toISOString();
    this.emitSession(session);
    return { ...session };
  }

  get(sessionId: string): ProcessingSession | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  getTargetLanguageCatalogue(): TargetLanguageCapability[] {
    return this.targetLanguageCatalogue.map((capability) => ({ ...capability }));
  }

  /**
   * Incrementally maintained per-language output counters for a session, kept
   * in sync where translation/generated-audio events transition so broadcast
   * emitters do not rescan the full event history on every state change.
   */
  getTargetLanguageOutputTallies(sessionId: string): SessionTargetLanguageTallies | null {
    if (!this.sessions.has(sessionId)) return null;
    const tallies = this.targetLanguageTallies.get(sessionId);
    return {
      translation: cloneTallyMap(tallies?.translation),
      generatedAudio: cloneTallyMap(tallies?.generatedAudio),
    };
  }

  private sessionLanguageTallies(sessionId: string): MutableSessionLanguageTallies {
    let tallies = this.targetLanguageTallies.get(sessionId);
    if (!tallies) {
      tallies = { translation: new Map(), generatedAudio: new Map() };
      this.targetLanguageTallies.set(sessionId, tallies);
    }
    return tallies;
  }

  private recordTranslationTally(
    sessionId: string,
    previous: TimestampedTranslationEvent | null,
    next: TimestampedTranslationEvent,
  ): void {
    applyTallyTransition(
      this.sessionLanguageTallies(sessionId).translation,
      previous ? { targetLanguage: previous.targetLanguage, tallyClass: translationTallyClass(previous.status) } : null,
      { targetLanguage: next.targetLanguage, tallyClass: translationTallyClass(next.status) },
      next.status === 'failed' ? (next.error ?? null) : undefined,
    );
  }

  private recordGeneratedAudioTally(
    sessionId: string,
    previous: GeneratedAudioEvent | null,
    next: GeneratedAudioEvent,
  ): void {
    applyTallyTransition(
      this.sessionLanguageTallies(sessionId).generatedAudio,
      previous ? { targetLanguage: previous.targetLanguage, tallyClass: generatedAudioTallyClass(previous.status) } : null,
      { targetLanguage: next.targetLanguage, tallyClass: generatedAudioTallyClass(next.status) },
      next.status === 'failed' ? (next.error ?? null) : undefined,
    );
  }

  /** Rebuilds both tally maps from the session's current event arrays. */
  private rebuildLanguageTallies(session: ProcessingSession): void {
    const tallies = this.sessionLanguageTallies(session.id);
    tallies.translation = buildTallyMap(
      session.translation.events.map((event) => ({
        targetLanguage: event.targetLanguage,
        tallyClass: translationTallyClass(event.status),
        error: event.error ?? null,
      })),
    );
    tallies.generatedAudio = buildTallyMap(
      session.generatedAudio.events.map((event) => ({
        targetLanguage: event.targetLanguage,
        tallyClass: generatedAudioTallyClass(event.status),
        error: event.error ?? null,
      })),
    );
  }

  async getGeneratedAudioFile(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<GeneratedAudioFile> {
    assertSafeRouteId(sessionId, 'session ID');
    assertSafeRouteId(segmentId, 'segment ID');
    const session = this.requireSession(sessionId);
    const normalizedLanguage = targetLanguage
      ? normalizeTargetLanguage(targetLanguage)
      : session.targetLanguage;
    const event = session.generatedAudio.events.find(
      (item) =>
        item.segmentId === segmentId && item.targetLanguage === normalizedLanguage,
    );
    if (!event || event.status !== 'generated') {
      throw new MediaIngestError(
        `Generated audio is not available for segment ${segmentId}.`,
        'generated-audio-unavailable',
        404,
        { ...session },
      );
    }

    const audioPath = this.generatedAudioOutputPath(
      session.id,
      event.targetLanguage,
      event.sequence,
    );
    assertPathInsideSession(this.outputBaseDir, session.id, audioPath);

    let fileSize = 0;
    try {
      const file = await stat(audioPath);
      if (!file.isFile()) throw new Error('Generated audio path is not a file.');
      fileSize = file.size;
    } catch {
      throw new MediaIngestError(
        `Generated audio file is missing for segment ${segmentId}.`,
        'generated-audio-unavailable',
        404,
        { ...session },
      );
    }

    return {
      sessionId: session.id,
      segmentId: event.segmentId,
      sequence: event.sequence,
      targetLanguage: event.targetLanguage,
      voiceId: event.voiceId,
      durationMs: event.durationMs ?? (await readWavDurationMs(audioPath)),
      providerLatencyMs: event.providerLatencyMs,
      audioPath,
      sizeBytes: fileSize,
    };
  }

  private failSession(
    session: ProcessingSession,
    error: unknown,
    fallbackMessage: string,
  ): ProcessingSession {
    const message = error instanceof Error ? error.message : fallbackMessage;
    session.error = message;
    session.audioExtraction = {
      ...session.audioExtraction,
      status: 'failed',
      error: message,
    };
    session.transcription = {
      ...session.transcription,
      status: 'failed',
      error: message,
    };
    session.translation = {
      ...session.translation,
      status: 'failed',
      providerStatus: 'failed',
      error: message,
    };
    session.generatedAudio = {
      ...session.generatedAudio,
      status: 'failed',
      providerStatus: 'failed',
      error: message,
    };
    if (session.sourceKind === 'microphone') {
      session.microphoneCapture = {
        ...session.microphoneCapture,
        status: 'failed',
        error: message,
        stoppedAt: new Date().toISOString(),
      };
    }
    if (session.state !== 'failed') {
      this.transition(session.id, 'failed');
    } else {
      this.emitSession(session);
    }

    if (error instanceof MediaIngestError) {
      throw new MediaIngestError(error.message, error.code, error.statusCode, { ...session });
    }
    throw new MediaIngestError(message, 'invalid-media', 400, { ...session });
  }

  private failMicrophoneSession(
    session: ProcessingSession,
    error: unknown,
    fallbackMessage: string,
  ): ProcessingSession {
    const message = error instanceof Error ? error.message : fallbackMessage;
    this.markMicrophoneSessionFailed(session, message);

    if (error instanceof MediaIngestError) {
      throw new MediaIngestError(error.message, error.code, error.statusCode, { ...session });
    }
    throw new MediaIngestError(message, 'invalid-media', 400, { ...session });
  }

  private failWebRtcSession(
    session: ProcessingSession,
    error: unknown,
    fallbackMessage: string,
  ): ProcessingSession {
    const message = error instanceof Error ? error.message : fallbackMessage;
    session.error = message;
    session.audioExtraction = {
      ...session.audioExtraction,
      status: 'failed',
      error: message,
    };
    if (session.webrtcTranscriptionBridge) {
      session.webrtcTranscriptionBridge = {
        ...session.webrtcTranscriptionBridge,
        status: 'failed',
        lastError: message,
        stoppedAt: new Date().toISOString(),
      };
    }
    if (session.transcription.events.some((event) => event.status === 'failed')) {
      session.transcription = {
        ...session.transcription,
        status: 'failed',
        error: message,
      };
    }
    if (session.translation.events.some((event) => event.status === 'failed')) {
      session.translation = {
        ...session.translation,
        status: 'failed',
        providerStatus: 'failed',
        error: message,
      };
    }
    if (session.generatedAudio.events.some((event) => event.status === 'failed')) {
      session.generatedAudio = {
        ...session.generatedAudio,
        status: 'failed',
        providerStatus: 'failed',
        error: message,
      };
    }
    if (session.state !== 'failed') {
      this.transition(session.id, 'failed');
    } else {
      this.emitSession(session);
    }

    if (error instanceof MediaIngestError) {
      throw new MediaIngestError(error.message, error.code, error.statusCode, { ...session });
    }
    throw new MediaIngestError(message, 'invalid-media', 400, { ...session });
  }

  private markMicrophoneSessionFailed(
    session: ProcessingSession,
    message: string,
  ): ProcessingSession {
    session.error = message;
    session.microphoneCapture = {
      ...session.microphoneCapture,
      status: 'failed',
      durationMs: lastMicrophoneEndMs(session),
      stoppedAt: new Date().toISOString(),
      error: message,
    };
    session.audioExtraction = {
      ...session.audioExtraction,
      status: 'failed',
      error: message,
    };
    if (session.transcription.events.some((event) => event.status === 'failed')) {
      session.transcription = {
        ...session.transcription,
        status: 'failed',
        error: message,
      };
    }
    if (session.translation.events.some((event) => event.status === 'failed')) {
      session.translation = {
        ...session.translation,
        status: 'failed',
        providerStatus: 'failed',
        error: message,
      };
    }
    if (session.generatedAudio.events.some((event) => event.status === 'failed')) {
      session.generatedAudio = {
        ...session.generatedAudio,
        status: 'failed',
        providerStatus: 'failed',
        error: message,
      };
    }
    if (session.state !== 'failed') {
      this.transition(session.id, 'failed');
    } else {
      this.emitSession(session);
    }
    return { ...session };
  }

  async getSourceMediaFile(sessionId: string): Promise<SourceMediaFile> {
    assertSafeRouteId(sessionId, 'session ID');
    const session = this.requireSession(sessionId);
    if (session.sourceKind !== 'upload' || !session.media) {
      throw new MediaIngestError(
        `Source media is unavailable for session ${sessionId}.`,
        'source-media-unavailable',
        404,
        { ...session },
      );
    }
    const source = await stat(session.sourcePath).catch(() => null);
    if (!source?.isFile()) {
      throw new MediaIngestError(
        `Source media file is missing for session ${sessionId}.`,
        'source-media-unavailable',
        404,
        { ...session },
      );
    }
    return {
      mediaPath: session.sourcePath,
      mimeType: session.media.mimeType,
      sizeBytes: source.size,
    };
  }

  async getViewerReadyMediaFile(sessionId: string): Promise<ViewerReadyMediaFile> {
    assertSafeRouteId(sessionId, 'session ID');
    const session = this.requireSession(sessionId);
    if (session.sourceKind !== 'upload' || !session.media?.hasVideo) {
      throw new MediaIngestError(
        `Viewer-ready media is unavailable for session ${sessionId}.`,
        'viewer-ready-media-unavailable',
        404,
        { ...session },
      );
    }

    const outputPath = this.viewerReadyMediaOutputPath(session.id);
    assertPathInsideSession(this.outputBaseDir, session.id, outputPath);
    let rendered = await stat(outputPath).catch(() => null);
    if (!rendered?.isFile()) {
      await this.ensureViewerReadyMedia(session);
      rendered = await stat(outputPath).catch(() => null);
    }

    if (!rendered?.isFile()) {
      throw new MediaIngestError(
        `Viewer-ready media file is missing for session ${sessionId}.`,
        'viewer-ready-media-unavailable',
        404,
        { ...session },
      );
    }

    return {
      mediaPath: outputPath,
      mimeType: 'video/mp4',
      sizeBytes: rendered.size,
    };
  }

  private failRealtimeAudioSession(
    session: ProcessingSession,
    error: unknown,
    fallbackMessage: string,
  ): ProcessingSession {
    // Native calls degrade per utterance; only programme sessions end here.
    if (isRealtimeCallSession(session)) {
      return this.recordWebRtcChunkFailure(session, error);
    }
    return session.sourceKind === 'webrtc'
      ? this.failWebRtcSession(session, error, fallbackMessage)
      : this.failMicrophoneSession(session, error, fallbackMessage);
  }

  private validateProbeResult(kind: MediaKind, probeResult: ProbeResult): void {
    if (kind === 'audio') {
      if (!probeResult.hasAudio || probeResult.hasVideo) {
        throw new MediaIngestError(
          'Invalid audio media: expected an audio-only MP3 or WAV file.',
          'invalid-media',
          400,
        );
      }
      return;
    }

    if (!probeResult.hasVideo) {
      throw new MediaIngestError(
        'Invalid video media: no video stream was found.',
        'invalid-media',
        400,
      );
    }

    if (!probeResult.hasAudio) {
      throw new MediaIngestError(
        'Invalid video media: no audio stream was found.',
        'invalid-media',
        400,
      );
    }
  }

  private findDuplicate(upload: UploadedMediaFile): ProcessingSession | null {
    const fingerprint = fileFingerprint(upload);
    for (const session of this.sessions.values()) {
      if (
        DUPLICATE_PROTECTED_STATES.has(session.state) &&
        this.fingerprints.get(session.id) === fingerprint
      ) {
        return { ...session };
      }
    }
    return null;
  }

  private findCompletedDuplicate(upload: UploadedMediaFile): ProcessingSession | null {
    const fingerprint = fileFingerprint(upload);
    for (const session of this.sessions.values()) {
      if (session.state === 'completed' && this.fingerprints.get(session.id) === fingerprint) {
        return { ...session };
      }
    }
    return null;
  }

  private findActiveMicrophoneSession(): ProcessingSession | null {
    for (const session of this.sessions.values()) {
      if (
        session.sourceKind === 'microphone' &&
        (session.state === 'processing' || session.state === 'paused')
      ) {
        return { ...session };
      }
    }
    return null;
  }

  private requireSession(sessionId: string): ProcessingSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new MediaIngestError(
        `Unknown processing session: ${sessionId}.`,
        'invalid-transition',
        404,
      );
    }
    return session;
  }

  private requireMicrophoneSession(sessionId: string): ProcessingSession {
    const session = this.requireSession(sessionId);
    if (session.sourceKind !== 'microphone') {
      throw new MediaIngestError(
        `Session ${sessionId} is not a microphone capture session.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    return session;
  }

  private requireWebRtcSession(sessionId: string): ProcessingSession {
    const session = this.requireSession(sessionId);
    if (session.sourceKind !== 'webrtc') {
      throw new MediaIngestError(
        `Session ${sessionId} is not a WebRTC transcription session.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    return session;
  }

  private emitSession(session: ProcessingSession): void {
    session.updatedAt = new Date().toISOString();
    session.monitoring = buildSessionMonitoring(session, session.monitoring.events);
    this.onSessionChange({ ...session });
  }

  private assertMicrophoneChunkAccepted(
    session: ProcessingSession,
    input: MicrophoneChunkInput,
  ): void {
    if (session.state !== 'processing') {
      throw new MediaIngestError(
        `Microphone chunks can only be accepted while the session is processing.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    if (
      session.transcription.events.some(
        (event) => event.status === 'transcribing' || event.status === 'retrying',
      ) ||
      session.translation.events.some(
        (event) => event.status === 'translating' || event.status === 'retrying',
      )
    ) {
      throw new MediaIngestError(
        `A microphone chunk is already being processed for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (!Number.isInteger(input.sequence) || input.sequence < 0) {
      throw new MediaIngestError(
        'Microphone chunk sequence must be a non-negative integer.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    if (input.sequence !== session.audioExtraction.chunks.length) {
      throw new MediaIngestError(
        'Microphone chunk ordering failed: unexpected sequence number.',
        'audio-timeline-invalid',
        409,
        { ...session },
      );
    }
    if (
      !Number.isInteger(input.startMs) ||
      !Number.isInteger(input.endMs) ||
      input.startMs < 0 ||
      input.endMs <= input.startMs ||
      input.endMs - input.startMs > 30_000
    ) {
      throw new MediaIngestError(
        'Microphone chunk timestamps are invalid.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }

    const previousEndMs = lastMicrophoneEndMs(session);
    if (input.startMs !== previousEndMs) {
      throw new MediaIngestError(
        'Microphone chunk timeline failed: gap or overlap detected.',
        'audio-timeline-invalid',
        409,
        { ...session },
      );
    }
    if (input.sizeBytes <= 0 || !Number.isInteger(input.sizeBytes)) {
      throw new MediaIngestError(
        'Microphone chunk is empty or invalid.',
        'invalid-media',
        400,
        { ...session },
      );
    }
  }

  private async storeMicrophoneChunk(
    session: ProcessingSession,
    input: MicrophoneChunkInput,
  ): Promise<MicrophoneCaptureChunkMetadata> {
    const outputDir = safeSessionOutputDir(this.outputBaseDir, session.id);
    await mkdir(outputDir, { recursive: true });
    const extension = microphoneChunkExtension(input.mimeType);
    const filename = `mic-chunk-${String(input.sequence).padStart(6, '0')}.${extension}`;
    if (input.sourcePath) {
      await rename(input.sourcePath, resolve(outputDir, filename));
    }

    const chunk: MicrophoneCaptureChunkMetadata = {
      chunkId: `${session.id}:mic:${input.sequence}`,
      index: input.sequence,
      filename,
      startMs: input.startMs,
      endMs: input.endMs,
      durationMs: input.endMs - input.startMs,
      status: 'ready',
      receivedAt: new Date().toISOString(),
      mimeType: normalizeMimeType(input.mimeType) || 'application/octet-stream',
      sizeBytes: input.sizeBytes,
    };

    session.audioExtraction.chunks = [...session.audioExtraction.chunks, chunk];
    session.microphoneCapture.chunks = [...session.microphoneCapture.chunks, chunk];
    return chunk;
  }

  private assertWebRtcChunkAccepted(session: ProcessingSession, input: WebRtcChunkInput): void {
    if (session.state !== 'processing') {
      throw new MediaIngestError(
        `WebRTC transcription chunks can only be accepted while the session is processing.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    if (
      session.transcription.events.some(
        (event) => event.status === 'transcribing' || event.status === 'retrying',
      )
    ) {
      throw new MediaIngestError(
        `A WebRTC transcription chunk is already being processed for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
    if (!Number.isInteger(input.sequence) || input.sequence < 0) {
      throw new MediaIngestError(
        'WebRTC chunk sequence must be a non-negative integer.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    if (isRealtimeCallSession(session)) {
      // A native call tolerates gaps: a dropped utterance must not stall every
      // later one. Ordering is still enforced (strictly increasing), so stale
      // or duplicate chunks are rejected exactly as before.
      const lastAcceptedSequence = session.audioExtraction.chunks.at(-1)?.index ?? -1;
      if (input.sequence <= lastAcceptedSequence) {
        throw new MediaIngestError(
          'WebRTC chunk ordering failed: sequence is not newer than the last accepted chunk.',
          'audio-timeline-invalid',
          409,
          { ...session },
        );
      }
    } else if (input.sequence !== session.audioExtraction.chunks.length) {
      throw new MediaIngestError(
        'WebRTC chunk ordering failed: unexpected sequence number.',
        'audio-timeline-invalid',
        409,
        { ...session },
      );
    }
    if (
      !Number.isInteger(input.startMs) ||
      !Number.isInteger(input.endMs) ||
      input.startMs < 0 ||
      input.endMs <= input.startMs ||
      input.endMs - input.startMs > 30_000
    ) {
      throw new MediaIngestError(
        'WebRTC chunk timestamps are invalid.',
        'audio-timeline-invalid',
        400,
        { ...session },
      );
    }
    const previous = session.audioExtraction.chunks.at(-1);
    if (previous && input.startMs !== previous.endMs && !input.discontinuity) {
      // Native calls are VAD-segmented: chunks cover speech, and the silence
      // between utterances is a legitimate gap. Requiring contiguity here
      // rejected every utterance after the first for the rest of the call.
      // Overlap (starting before the previous chunk ended) still fails.
      const isCallGap = isRealtimeCallSession(session) && input.startMs > previous.endMs;
      if (!isCallGap) {
        throw new MediaIngestError(
          'WebRTC chunk timeline failed: gap or overlap detected.',
          'audio-timeline-invalid',
          409,
          { ...session },
        );
      }
    }
    if (
      input.sampleRate !== 16000 ||
      input.channelCount !== 1 ||
      input.pcmFormat !== 'pcm_s16le' ||
      input.mimeType !== 'audio/wav'
    ) {
      throw new MediaIngestError(
        'WebRTC chunk format must be WAV mono 16 kHz PCM 16-bit.',
        'invalid-media',
        400,
        { ...session },
      );
    }
    if (input.sizeBytes <= 44 || !Number.isInteger(input.sizeBytes)) {
      throw new MediaIngestError('WebRTC chunk is empty or invalid.', 'invalid-media', 400, {
        ...session,
      });
    }
    if (!isPathInside(this.webRtcStagingDir, input.sourcePath)) {
      throw new MediaIngestError('Unsafe WebRTC chunk path rejected.', 'unsafe-filename', 400, {
        ...session,
      });
    }
  }

  private async storeWebRtcChunk(
    session: ProcessingSession,
    input: WebRtcChunkInput,
  ): Promise<MicrophoneCaptureChunkMetadata> {
    const outputDir = safeSessionOutputDir(this.outputBaseDir, session.id);
    await mkdir(outputDir, { recursive: true });
    const filename = `webrtc-chunk-${String(input.sequence).padStart(6, '0')}.wav`;
    await rename(input.sourcePath, resolve(outputDir, filename));

    const chunk: MicrophoneCaptureChunkMetadata = {
      chunkId: this.webRtcChunkId(session, input.sequence),
      index: input.sequence,
      filename,
      startMs: input.startMs,
      endMs: input.endMs,
      durationMs: input.endMs - input.startMs,
      status: 'ready',
      receivedAt: new Date().toISOString(),
      mimeType: 'audio/wav',
      sizeBytes: input.sizeBytes,
    };

    session.audioExtraction.chunks = [...session.audioExtraction.chunks, chunk];
    return chunk;
  }

  private async processMicrophoneTranscriptionEvent(
    session: ProcessingSession,
    event: TranscriptionEvent,
  ): Promise<ProcessingSession> {
    const chunk = session.audioExtraction.chunks.find((item) => item.chunkId === event.chunkId);
    if (!chunk || chunk.status !== 'ready') {
      throw new MediaIngestError(
        `Unknown ready microphone chunk: ${event.chunkId}.`,
        'invalid-transition',
        404,
        { ...session },
      );
    }

    const { error: _eventError, ...eventWithoutError } = event;
    const transcribing = {
      ...eventWithoutError,
      status: 'transcribing' as const,
      createdAt: new Date().toISOString(),
    };
    this.replaceTranscriptionEvent(session, transcribing);
    this.updateTranscriptionProgress(session);
    this.onTranscriptionEvent(transcribing);
    this.emitSession(session);

    let transcribedSegments: TranscriptionEvent[];
    try {
      const result = await transcribeWithTimeout(
        this.transcriptionProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          chunk,
          audioPath: resolve(safeSessionOutputDir(this.outputBaseDir, session.id), chunk.filename),
          sourceLanguage: session.sourceLanguageControl.activeLanguage,
          sourceLanguageMode: session.sourceLanguageControl.mode,
        },
        this.transcriptionTimeoutMs,
      );
      this.reconcileDetectedLanguage(session, {
        language: result.detectedLanguage,
        confidence: result.confidence,
      });
      transcribedSegments = this.fanOutTranscribedSegments(session, transcribing, chunk, result);
      this.updateTranscriptionProgress(session);
      for (const transcribed of transcribedSegments) {
        this.onTranscriptionEvent(transcribed);
      }
      this.emitSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed.';
      const failed = {
        ...transcribing,
        status: 'failed' as const,
        error: message,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, failed);
      this.updateTranscriptionProgress(session);
      this.onTranscriptionEvent(failed);
      this.emitSession(session);
      return this.failMicrophoneSession(session, error, 'Microphone transcription failed.');
    }
    let updated: ProcessingSession = { ...session };
    for (const transcribed of transcribedSegments) {
      // The session can fail concurrently (e.g. device disconnect) while a
      // segment is in flight; stop fanning out further segments once it has.
      if (session.state === 'failed' || session.state === 'cancelled') {
        return { ...session };
      }
      updated = await this.processMicrophoneTranslationEvent(session, transcribed);
    }
    return updated;
  }

  private async processWebRtcTranscriptionEvent(
    session: ProcessingSession,
    event: TranscriptionEvent,
  ): Promise<ProcessingSession> {
    const chunk = session.audioExtraction.chunks.find((item) => item.chunkId === event.chunkId);
    if (!chunk || chunk.status !== 'ready') {
      throw new MediaIngestError(
        `Unknown ready WebRTC chunk: ${event.chunkId}.`,
        'invalid-transition',
        404,
        { ...session },
      );
    }

    const { error: _eventError, ...eventWithoutError } = event;
    const transcribing = {
      ...eventWithoutError,
      status: 'transcribing' as const,
      createdAt: new Date().toISOString(),
    };
    this.replaceTranscriptionEvent(session, transcribing);
    this.updateTranscriptionProgress(session);
    this.updateWebRtcBridgeMetadata(session);
    this.onTranscriptionEvent(transcribing);
    this.emitSession(session);

    try {
      const result = await transcribeWithTimeout(
        this.transcriptionProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          chunk,
          audioPath: resolve(safeSessionOutputDir(this.outputBaseDir, session.id), chunk.filename),
          sourceLanguage: session.sourceLanguageControl.activeLanguage,
          sourceLanguageMode: session.sourceLanguageControl.mode,
        },
        this.transcriptionTimeoutMs,
      );
      this.reconcileDetectedLanguage(session, {
        language: result.detectedLanguage,
        confidence: result.confidence,
      });
      const transcribedSegments = this.fanOutTranscribedSegments(
        session,
        transcribing,
        chunk,
        result,
      );
      this.updateTranscriptionProgress(session);
      this.updateWebRtcBridgeMetadata(session);
      for (const transcribed of transcribedSegments) {
        this.onTranscriptionEvent(transcribed);
      }
      this.emitSession(session);
      let updated: ProcessingSession = { ...session };
      for (const transcribed of transcribedSegments) {
        // The session can fail concurrently while a segment is in flight;
        // stop fanning out further segments once it has.
        if (session.state === 'failed' || session.state === 'cancelled') {
          return { ...session };
        }
        updated = await this.processMicrophoneTranslationEvent(session, transcribed);
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed.';
      const failed = {
        ...transcribing,
        status: 'failed' as const,
        error: message,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, failed);
      this.updateTranscriptionProgress(session);
      this.updateWebRtcBridgeMetadata(session);
      this.onTranscriptionEvent(failed);
      this.emitSession(session);
      if (isRealtimeCallSession(session)) {
        // One failed utterance must not end a live call.
        return this.recordWebRtcChunkFailure(session, error);
      }
      return this.failWebRtcSession(session, error, 'WebRTC transcription failed.');
    }
  }

  private async processMicrophoneTranslationEvent(
    session: ProcessingSession,
    segment: TranscriptionEvent,
  ): Promise<ProcessingSession> {
    if (this.isStaleSourceLanguageRevision(session, segment)) {
      const failed = this.createTranslationEvent(
        session,
        segment,
        '',
        'failed',
        zeroTranslationLatency(),
        'Stale transcription rejected after source-language revision changed.',
      );
      session.translation.events = [...session.translation.events, failed].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.recordTranslationTally(session.id, null, failed);
      this.updateTranslationProgress(session);
      this.onTranslationEvent(failed);
      this.emitSession(session);
      return this.failRealtimeAudioSession(
        session,
        new MediaIngestError(failed.error ?? 'Stale transcription rejected.', 'stale-source-language', 409),
        `${session.sourceKind === 'webrtc' ? 'WebRTC' : 'Microphone'} translation failed.`,
      );
    }
    const queued = this.createTranslationEvent(
      session,
      segment,
      '',
      'queued',
      zeroTranslationLatency(),
    );
    session.translation.events = [...session.translation.events, queued].sort(
      (a, b) => a.sequence - b.sequence,
    );
    this.recordTranslationTally(session.id, null, queued);
    this.updateTranslationProgress(session);
    this.onTranslationEvent(queued);
    this.emitSession(session);

    const queuedAt = Date.now();
    const translating = {
      ...queued,
      status: 'translating' as const,
      createdAt: new Date().toISOString(),
    };
    this.replaceTranslationEvent(session, translating);
    this.updateTranslationProgress(session);
    this.onTranslationEvent(translating);
    this.emitSession(session);

    try {
      const providerStartedAt = Date.now();
      const result = await translateWithTimeout(
        this.translationProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          segmentId: segment.chunkId,
          sequence: segment.sequence,
          sourceLanguage: segment.detectedLanguage,
          targetLanguage: session.targetLanguage,
          sourceText: segment.sourceText,
          startMs: segment.startMs,
          endMs: segment.endMs,
        },
        this.translationTimeoutMs,
      );
      const translated = {
        ...translating,
        translatedText: result.translatedText,
        status: 'translated' as const,
        latency: {
          queuedMs: Math.max(0, providerStartedAt - queuedAt),
          providerMs: Date.now() - providerStartedAt,
          totalMs: Math.max(0, Date.now() - queuedAt),
        },
        createdAt: new Date().toISOString(),
      };
      this.replaceTranslationEvent(session, translated);
      this.updateTranslationProgress(session);
      this.onTranslationEvent(translated);
      this.emitSession(session);
      return await this.processMicrophoneGeneratedAudioEvent(session, translated);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed.';
      const failed = {
        ...translating,
        status: 'failed' as const,
        error: message,
        latency: {
          queuedMs: 0,
          providerMs: 0,
          totalMs: Math.max(0, Date.now() - queuedAt),
        },
        createdAt: new Date().toISOString(),
      };
      this.replaceTranslationEvent(session, failed);
      this.updateTranslationProgress(session);
      this.onTranslationEvent(failed);
      this.emitSession(session);
      return this.failRealtimeAudioSession(
        session,
        error,
        `${session.sourceKind === 'webrtc' ? 'WebRTC' : 'Microphone'} translation failed.`,
      );
    }
  }

  private async processMicrophoneGeneratedAudioEvent(
    session: ProcessingSession,
    segment: TimestampedTranslationEvent,
  ): Promise<ProcessingSession> {
    if (!this.textToSpeechSupportedLanguages.includes(segment.targetLanguage)) {
      // Mirror the batch pipeline: a target language without an approved voice
      // stays captions-only instead of failing the whole live session.
      this.markRealtimeCaptionsOnlyLanguage(session, segment.targetLanguage);
      return { ...session };
    }
    try {
      const queued = this.createGeneratedAudioEvent(session, segment, 'queued');
      session.generatedAudio.events = [...session.generatedAudio.events, queued].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.recordGeneratedAudioTally(session.id, null, queued);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);

      const generating = {
        ...queued,
        status: 'generating' as const,
        createdAt: new Date().toISOString(),
      };
      this.replaceGeneratedAudioEvent(session, generating);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);

      await this.ensureGeneratedAudioOutputDir(session.id, segment.targetLanguage);
      const audioPath = this.generatedAudioOutputPath(
        session.id,
        segment.targetLanguage,
        segment.sequence,
      );
      const voice = this.synthesisVoiceFor(session, segment.targetLanguage);
      const result = await generateSpeechWithTimeout(
        this.textToSpeechProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          segmentId: segment.segmentId,
          sequence: segment.sequence,
          targetLanguage: segment.targetLanguage,
          translatedText: segment.translatedText,
          startMs: segment.startMs,
          endMs: segment.endMs,
          voiceId: voice.voiceId,
          standardVoiceId: voice.standardVoiceId,
          outputPath: audioPath,
          ...(session.generatedAudioPacing ? { pacing: session.generatedAudioPacing } : {}),
        },
        this.textToSpeechTimeoutMs,
      );
      const generated = {
        ...generating,
        status: 'generated' as const,
        durationMs: await readWavDurationMs(audioPath),
        providerLatencyMs: result.providerLatencyMs ?? null,
        // What was actually spoken, which after a personal-voice fallback is
        // not what was asked for.
        voiceId: result.effectiveVoiceId ?? voice.voiceId,
        createdAt: new Date().toISOString(),
      };
      this.replaceGeneratedAudioEvent(session, generated);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);
      this.emitGeneratedAudioReady(session, generated);
      return { ...session };
    } catch (error) {
      await rm(
        this.generatedAudioOutputPath(session.id, segment.targetLanguage, segment.sequence),
        { force: true },
      );
      const message = error instanceof Error ? error.message : 'Text-to-speech generation failed.';
      const failed = this.createGeneratedAudioEvent(session, segment, 'failed', message);
      this.replaceGeneratedAudioEvent(session, failed);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);
      return this.failRealtimeAudioSession(
        session,
        error,
        `${session.sourceKind === 'webrtc' ? 'WebRTC' : 'Microphone'} text-to-speech failed.`,
      );
    }
  }

  private async processTranscriptionEvents(
    session: ProcessingSession,
    requestedEvents: TranscriptionEvent[],
  ): Promise<ProcessingSession> {
    if (session.state !== 'processing') {
      this.transition(session.id, 'processing');
    }

    const orderedEvents = requestedEvents.slice().sort((a, b) => a.sequence - b.sequence);
    for (const event of orderedEvents) {
      if (!(await this.waitUntilRunnable(session))) {
        return { ...session };
      }
      const chunk = session.audioExtraction.chunks.find((item) => item.chunkId === event.chunkId);
      if (!chunk || chunk.status !== 'ready') {
        continue;
      }

      const { error: _eventError, ...eventWithoutError } = event;
      const transcribing = {
        ...eventWithoutError,
        status: 'transcribing' as const,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, transcribing);
      this.updateTranscriptionProgress(session);
      this.onTranscriptionEvent(transcribing);
      this.emitSession(session);

      try {
        const result = await transcribeWithTimeout(
          this.transcriptionProvider,
          {
            sessionId: session.id,
            streamId: session.streamId,
            chunk,
            audioPath: resolve(
              safeSessionOutputDir(this.outputBaseDir, session.id),
              chunk.filename,
            ),
            sourceLanguage: session.sourceLanguageControl.activeLanguage,
            sourceLanguageMode: session.sourceLanguageControl.mode,
          },
          this.transcriptionTimeoutMs,
        );
        this.reconcileDetectedLanguage(session, {
          language: result.detectedLanguage,
          confidence: result.confidence,
        });
        for (const transcribed of this.fanOutTranscribedSegments(
          session,
          transcribing,
          chunk,
          result,
        )) {
          this.onTranscriptionEvent(transcribed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transcription failed.';
        const failed = {
          ...transcribing,
          status: 'failed' as const,
          error: message,
          createdAt: new Date().toISOString(),
        };
        this.replaceTranscriptionEvent(session, failed);
        this.onTranscriptionEvent(failed);
      }
      this.updateTranscriptionProgress(session);
      this.emitSession(session);
      if (session.state === 'cancelled') {
        return { ...session };
      }
    }

    this.renumberTranscriptionSequences(session);

    if (!(await this.waitUntilRunnable(session))) {
      return { ...session };
    }

    const failedCount = session.transcription.events.filter(
      (event) => event.status === 'failed',
    ).length;
    if (failedCount > 0) {
      session.error = `${failedCount} transcription chunk${failedCount === 1 ? '' : 's'} failed.`;
      session.transcription = {
        ...session.transcription,
        status: 'failed',
        error: session.error,
      };
      this.transition(session.id, 'failed');
      return { ...session };
    }

    if (session.transcription.events.length === 0) {
      session.error = null;
      const { error: _transcriptionError, ...transcriptionWithoutError } = session.transcription;
      session.transcription = {
        ...transcriptionWithoutError,
        status: 'transcribed',
        progressPct: 100,
      };
      this.emitSession(session);
      return this.transition(session.id, 'completed');
    }

    if (session.transcription.events.every((event) => event.status === 'transcribed')) {
      session.error = null;
      const { error: _transcriptionError, ...transcriptionWithoutError } = session.transcription;
      session.transcription = {
        ...transcriptionWithoutError,
        status: 'transcribed',
        progressPct: 100,
      };
      this.emitSession(session);
      return await this.startTranslation(session.id);
    }

    this.emitSession(session);
    return { ...session };
  }

  private createTranscriptionEvent(
    session: ProcessingSession,
    chunkId: string,
    sequence: number,
    sourceText: string,
    detectedLanguage: string,
    confidence: number | null,
    status: TranscriptionStatus,
    error?: string,
  ): TranscriptionEvent {
    const chunk = session.audioExtraction.chunks.find((item) => item.chunkId === chunkId);
    if (!chunk) {
      throw new MediaIngestError(`Unknown audio chunk: ${chunkId}.`, 'invalid-transition', 404, {
        ...session,
      });
    }
    const event: TranscriptionEvent = {
      sessionId: session.id,
      streamId: session.streamId,
      chunkId,
      sequence,
      sourceText,
      detectedLanguage,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      confidence,
      sourceLanguageRevision: session.sourceLanguageControl.revision,
      status,
      createdAt: new Date().toISOString(),
    };
    if (error) event.error = error;
    return event;
  }

  private replaceTranscriptionEvent(session: ProcessingSession, next: TranscriptionEvent): void {
    session.transcription.events = session.transcription.events
      .map((event) => (event.chunkId === next.chunkId ? next : event))
      .sort((a, b) => a.sequence - b.sequence);
  }

  private nextTranscriptionSequence(sessionId: string): number {
    const sequence = this.transcriptionSequences.get(sessionId) ?? 0;
    this.transcriptionSequences.set(sessionId, sequence + 1);
    return sequence;
  }

  /**
   * The sequence the next transcribed segment will be given, without consuming
   * it. Interim (partial) events borrow it so they carry the same sequence as
   * the final segment that replaces them, while the counter stays owned by the
   * finals that form the durable record.
   */
  private peekTranscriptionSequence(sessionId: string): number {
    return this.transcriptionSequences.get(sessionId) ?? 0;
  }

  /**
   * Restores contiguous 0-based, timeline-ordered sequences after a batch
   * pass. A retried chunk fans out with counter values past the ones already
   * assigned to later chunks; renumbering before translation/TTS start keeps
   * exports ordered and preserves the gateway GeneratedAudioStore contract of
   * contiguous 0-based sequences per session and language.
   */
  private renumberTranscriptionSequences(session: ProcessingSession): void {
    const ordered = session.transcription.events
      .slice()
      // Chunks cover disjoint time ranges and fan-out segments are clamped
      // inside their chunk, so (startMs, endMs) yields timeline order; the
      // stable sort keeps same-timestamp events in their existing order.
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const renumbered: TranscriptionEvent[] = [];
    const changed: TranscriptionEvent[] = [];
    ordered.forEach((event, index) => {
      if (event.sequence === index) {
        renumbered.push(event);
        return;
      }
      const next = { ...event, sequence: index };
      renumbered.push(next);
      changed.push(next);
    });
    this.transcriptionSequences.set(session.id, renumbered.length);
    if (changed.length === 0) return;
    session.transcription.events = renumbered;
    for (const event of changed) {
      this.onTranscriptionEvent(event);
    }
  }

  private fanOutTranscribedSegments(
    session: ProcessingSession,
    transcribing: TranscriptionEvent,
    chunk: AudioChunkMetadata,
    result: TranscriptionProviderResult,
  ): TranscriptionEvent[] {
    const transcribed = result.segments
      .filter((segment) => segment.text.trim() !== '')
      .map((segment, index): TranscriptionEvent => {
        // Clamped so the window is always non-empty. A segment landing on (or
        // past) the chunk boundary would otherwise produce endMs === startMs,
        // which the timestamped-translation contract rejects outright — the
        // gateway logs "invalid timestamped translation event" and the caption
        // is silently lost, which looks exactly like the pipeline stalling.
        const startMs = Math.min(
          Math.max(chunk.startMs + segment.startMs, chunk.startMs),
          Math.max(chunk.startMs, chunk.endMs - 1),
        );
        const endMs = Math.min(
          Math.max(chunk.startMs + segment.endMs, startMs + 1),
          chunk.endMs,
        );
        return {
          ...transcribing,
          chunkId: `${transcribing.chunkId}-s${index}`,
          sequence: this.nextTranscriptionSequence(session.id),
          sourceText: segment.text.trim(),
          detectedLanguage: result.detectedLanguage,
          confidence: result.confidence,
          startMs,
          endMs,
          sourceLanguageRevision: session.sourceLanguageControl.revision,
          providerLatencyMs: result.providerLatencyMs ?? null,
          status: 'transcribed',
          createdAt: new Date().toISOString(),
        };
      });
    // A sentence the recogniser has locked onto is dropped here, before it
    // becomes a caption, a translation and a spoken clip. The speaker has
    // stopped talking; nothing downstream can tell that from speech.
    //
    // LIVE CALLS ONLY. In a recorded programme three identical lines can be a
    // chorus, a repeated announcement, or a stutter somebody wants captioned,
    // and there is no cloned voice reciting them at a listener. The harm this
    // prevents is specific to a conversation, so the rule is too.
    const loopFilter = isRealtimeCallSession(session)
      ? this.repetitionFilterFor(session.id)
      : null;
    const withoutLoops = !loopFilter ? transcribed : transcribed.filter((event) => {
      // Never logged with its text: writing a fabrication down is how it gets
      // quoted back as something somebody said.
      return !event.sourceText || !loopFilter.isLooping(event.sourceText);
    });
    session.transcription.events = session.transcription.events
      .filter((event) => event.chunkId !== transcribing.chunkId)
      .concat(withoutLoops)
      .sort((a, b) => a.sequence - b.sequence);
    return withoutLoops;
  }

  private updateTranscriptionProgress(session: ProcessingSession): void {
    const events = session.transcription.events;
    const transcribedChunks = events.filter((event) => event.status === 'transcribed').length;
    const failedChunks = events.filter((event) => event.status === 'failed').length;
    const active = events.some(
      (event) => event.status === 'transcribing' || event.status === 'retrying',
    );
    const detectedLanguage =
      events.find((event) => event.status === 'transcribed' && event.detectedLanguage !== 'und')
        ?.detectedLanguage ?? null;
    session.transcription = {
      ...session.transcription,
      status: active
        ? 'transcribing'
        : failedChunks > 0
          ? 'failed'
          : transcribedChunks === events.length && events.length > 0
            ? 'transcribed'
            : 'queued',
      totalChunks: events.length,
      transcribedChunks,
      failedChunks,
      detectedLanguage,
      progressPct: events.length === 0 ? 0 : Math.round((transcribedChunks / events.length) * 100),
    };
  }

  private updateWebRtcBridgeMetadata(session: ProcessingSession): void {
    if (!session.webrtcTranscriptionBridge) return;
    const events = session.transcription.events;
    const processingChunks = events.filter(
      (event) => event.status === 'queued' || event.status === 'transcribing' || event.status === 'retrying',
    ).length;
    const transcribedChunks = events.filter((event) => event.status === 'transcribed').length;
    const failedChunks = events.filter((event) => event.status === 'failed').length;
    const latestTranscript =
      events
        .filter((event) => event.status === 'transcribed')
        .sort((a, b) => b.sequence - a.sequence)[0]?.sourceText ?? null;
    const lastError =
      events
        .filter((event) => event.error)
        .sort((a, b) => b.sequence - a.sequence)[0]?.error ?? null;
    session.webrtcTranscriptionBridge = {
      ...session.webrtcTranscriptionBridge,
      status:
        failedChunks > 0
          ? 'failed'
          : processingChunks > 0
            ? 'processing'
            : events.length > 0
              ? 'chunking'
              : session.webrtcTranscriptionBridge.status,
      chunkCount: session.audioExtraction.chunks.length,
      processingChunks,
      transcribedChunks,
      failedChunks,
      latestTranscript,
      lastError,
    };
  }

  private async startTranslation(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    this.assertNoActiveTranslation(session);
    const transcribedSegments = session.transcription.events
      .filter((event) => event.status === 'transcribed')
      .sort((a, b) => a.sequence - b.sequence);
    if (transcribedSegments.length === 0) {
      throw new MediaIngestError(
        `Session ${sessionId} has no transcribed segments to translate.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    session.translation = {
      ...emptyTranslation('queued', session.targetLanguage, this.translationProvider.name),
      totalSegments: transcribedSegments.length * session.targetLanguages.length,
      sourceLanguage: transcribedSegments[0]?.detectedLanguage ?? null,
      targetLanguages: session.targetLanguages,
      events: transcribedSegments.flatMap((segment) =>
        session.targetLanguages.map((targetLanguage) =>
          this.createTranslationEvent(
            session,
            segment,
            '',
            'queued',
            zeroTranslationLatency(),
            undefined,
            targetLanguage,
          ),
        ),
      ),
    };
    this.rebuildLanguageTallies(session);
    this.emitSession(session);
    for (const event of session.translation.events) {
      this.onTranslationEvent(event);
    }

    return await this.processTranslationEvents(session, session.translation.events);
  }

  private async startGeneratedAudio(sessionId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    this.assertNoActiveGeneratedAudio(session);
    const translatedSegments = session.translation.events
      .filter((event) => event.status === 'translated')
      .sort((a, b) =>
        a.sequence === b.sequence
          ? session.targetLanguages.indexOf(a.targetLanguage) -
            session.targetLanguages.indexOf(b.targetLanguage)
          : a.sequence - b.sequence,
      );
    if (translatedSegments.length === 0) {
      throw new MediaIngestError(
        `Session ${sessionId} has no translated segments to generate.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    const voiceSegments = translatedSegments.filter((event) =>
      this.textToSpeechSupportedLanguages.includes(event.targetLanguage),
    );
    const textOnlyLanguages = session.targetLanguages.filter(
      (language) =>
        !this.textToSpeechSupportedLanguages.includes(language) &&
        translatedSegments.some((event) => event.targetLanguage === language),
    );

    if (voiceSegments.length === 0) {
      session.generatedAudio = {
        ...emptyGeneratedAudio(
          'generated',
          session.targetLanguage,
          this.textToSpeechVoiceId,
          this.textToSpeechProvider.name,
        ),
        providerStatus: 'text-only',
        progressPct: 100,
        totalSegments: 0,
        generatedSegments: 0,
        targetLanguages: session.targetLanguages,
        textOnlyLanguages,
        events: [],
      };
      this.rebuildLanguageTallies(session);
      this.emitSession(session);
      if (session.state === 'processing') {
        return this.transition(
          session.id,
          session.translation.failedSegments > 0 ? 'failed' : 'completed',
        );
      }
      return { ...session };
    }

    session.generatedAudio = {
      ...emptyGeneratedAudio(
        'queued',
        session.targetLanguage,
        this.textToSpeechVoiceId,
        this.textToSpeechProvider.name,
      ),
      targetLanguages: session.targetLanguages,
      textOnlyLanguages,
      totalSegments: voiceSegments.length,
      events: voiceSegments.map((segment) =>
        this.createGeneratedAudioEvent(session, segment, 'queued'),
      ),
    };
    this.rebuildLanguageTallies(session);
    this.emitSession(session);

    return await this.processGeneratedAudioEvents(session, session.generatedAudio.events);
  }

  private async processGeneratedAudioEvents(
    session: ProcessingSession,
    requestedEvents: GeneratedAudioEvent[],
  ): Promise<ProcessingSession> {
    if (session.state !== 'processing') {
      this.transition(session.id, 'processing');
    }

    // See processTranslationEvents: a revision boundary replaces this pass'
    // generated-audio state mid-flight; the new revision's pass owns the work.
    const revisionAtStart = session.sourceLanguageControl.revision;
    const revisionReplaced = () =>
      session.sourceLanguageControl.revision !== revisionAtStart;

    const orderedEvents = requestedEvents.slice().sort((a, b) =>
      a.sequence === b.sequence
        ? session.targetLanguages.indexOf(a.targetLanguage) -
          session.targetLanguages.indexOf(b.targetLanguage)
        : a.sequence - b.sequence,
    );
    for (const event of orderedEvents) {
      if (!(await this.waitUntilRunnable(session))) {
        return { ...session };
      }
      if (revisionReplaced()) {
        return { ...session };
      }
      const translatedSegment = session.translation.events.find(
        (item) =>
          item.segmentId === event.segmentId &&
          item.targetLanguage === event.targetLanguage &&
          item.status === 'translated',
      );
      if (!translatedSegment) continue;

      const generating = {
        ...event,
        status: event.status === 'retrying' ? 'retrying' as const : 'generating' as const,
        providerLatencyMs: null,
        createdAt: new Date().toISOString(),
      };
      this.replaceGeneratedAudioEvent(session, generating);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);

      try {
        await this.ensureGeneratedAudioOutputDir(session.id, event.targetLanguage);
        const audioPath = this.generatedAudioOutputPath(
          session.id,
          event.targetLanguage,
          translatedSegment.sequence,
        );
        const voice = this.synthesisVoiceFor(session, event.targetLanguage);
        const result = await generateSpeechWithTimeout(
          this.textToSpeechProvider,
          {
            sessionId: session.id,
            streamId: session.streamId,
            segmentId: translatedSegment.segmentId,
            sequence: translatedSegment.sequence,
            targetLanguage: event.targetLanguage,
            translatedText: translatedSegment.translatedText,
            startMs: translatedSegment.startMs,
            endMs: translatedSegment.endMs,
            voiceId: voice.voiceId,
            standardVoiceId: voice.standardVoiceId,
            outputPath: audioPath,
            ...(session.generatedAudioPacing ? { pacing: session.generatedAudioPacing } : {}),
          },
          this.textToSpeechTimeoutMs,
        );
        const generated = {
          ...generating,
          audioFilename: generatedAudioFilename(translatedSegment.sequence),
          durationMs: await readWavDurationMs(audioPath),
          providerLatencyMs: result.providerLatencyMs ?? null,
          voiceId: result.effectiveVoiceId ?? voice.voiceId,
          status: 'generated' as const,
          createdAt: new Date().toISOString(),
        };
        if (revisionReplaced()) {
          return { ...session };
        }
        this.replaceGeneratedAudioEvent(session, generated);
        this.emitGeneratedAudioReady(session, generated);
      } catch (error) {
        await rm(this.generatedAudioOutputPath(
          session.id,
          event.targetLanguage,
          translatedSegment.sequence,
        ), {
          force: true,
        });
        if (revisionReplaced()) {
          return { ...session };
        }
        const message = error instanceof Error ? error.message : 'Text-to-speech generation failed.';
        const failed = {
          ...generating,
          status: 'failed' as const,
          providerLatencyMs: 0,
          error: message,
          createdAt: new Date().toISOString(),
        };
        this.replaceGeneratedAudioEvent(session, failed);
      }
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);
      if (session.state === 'cancelled') {
        return { ...session };
      }
    }

    if (!(await this.waitUntilRunnable(session))) {
      return { ...session };
    }
    if (revisionReplaced()) {
      return { ...session };
    }

    const failedCount = session.generatedAudio.events.filter((event) => event.status === 'failed').length;
    const settled = session.generatedAudio.events.every(
      (event) => event.status === 'generated' || event.status === 'failed',
    );
    const generatedCount = session.generatedAudio.events.filter(
      (event) => event.status === 'generated',
    ).length;
    if (settled && generatedCount > 0) {
      session.error =
        failedCount > 0
          ? `${failedCount} generated-audio output${failedCount === 1 ? '' : 's'} failed; captions and other language channels remain available.`
          : session.error;
      const { error: _generatedAudioError, ...generatedAudioWithoutError } = session.generatedAudio;
      session.generatedAudio = {
        ...generatedAudioWithoutError,
        status: failedCount > 0 ? 'failed' : 'generated',
        progressPct: Math.round((generatedCount / session.generatedAudio.events.length) * 100),
        ...(session.error ? { error: session.error } : {}),
      };
      if (
        session.sourceKind === 'microphone' ||
        (session.sourceKind === 'webrtc' && session.webrtcTranscriptionBridge?.status !== 'stopped')
      ) {
        this.emitSession(session);
        return { ...session };
      }
      if (
        this.renderViewerReadyMediaOnCompletion &&
        session.sourceKind === 'upload' &&
        session.media?.hasVideo
      ) {
        try {
          await this.ensureViewerReadyMedia(session);
        } catch (error) {
          return this.failSession(session, error, 'Viewer-ready media render failed.');
        }
      }
      if (failedCount > 0 || session.translation.failedSegments > 0) {
        this.transition(session.id, 'failed');
        return { ...session };
      }
      this.transition(session.id, 'completed');
      return { ...session };
    }

    if (
      settled &&
      generatedCount === 0 &&
      (session.generatedAudio.textOnlyLanguages?.length ?? 0) > 0
    ) {
      session.error = `${failedCount} generated-audio output${failedCount === 1 ? '' : 's'} failed; caption-only language channels remain available.`;
      session.generatedAudio = {
        ...session.generatedAudio,
        status: 'failed',
        providerStatus: 'failed',
        error: session.error,
      };
      if (session.sourceKind === 'microphone' || session.sourceKind === 'webrtc') {
        this.emitSession(session);
        return { ...session };
      }
      this.transition(
        session.id,
        failedCount > 0 || session.translation.failedSegments > 0 ? 'failed' : 'completed',
      );
      return { ...session };
    }

    if (settled && generatedCount === 0) {
      session.error = `${failedCount} generated-audio output${failedCount === 1 ? '' : 's'} failed.`;
      session.generatedAudio = {
        ...session.generatedAudio,
        status: 'failed',
        error: session.error,
      };
      this.transition(session.id, 'failed');
      return { ...session };
    }

    this.emitSession(session);
    return { ...session };
  }

  private async processTranslationEvents(
    session: ProcessingSession,
    requestedEvents: TimestampedTranslationEvent[],
  ): Promise<ProcessingSession> {
    if (session.state !== 'processing') {
      this.transition(session.id, 'processing');
    }

    // A source-language revision boundary replaces session.translation with a
    // fresh pass mid-flight. This pass then owns nothing anymore: bail out
    // cleanly instead of misreading the new empty pass as a zero-output
    // failure. The new revision's pass owns the work from here.
    const revisionAtStart = session.sourceLanguageControl.revision;
    const revisionReplaced = () =>
      session.sourceLanguageControl.revision !== revisionAtStart;

    const orderedEvents = requestedEvents.slice().sort((a, b) =>
      a.sequence === b.sequence
        ? session.targetLanguages.indexOf(a.targetLanguage) -
          session.targetLanguages.indexOf(b.targetLanguage)
        : a.sequence - b.sequence,
    );
    for (const event of orderedEvents) {
      if (!(await this.waitUntilRunnable(session))) {
        return { ...session };
      }
      if (revisionReplaced()) {
        return { ...session };
      }
      const segment = session.transcription.events.find(
        (item) => item.chunkId === event.segmentId && item.status === 'transcribed',
      );
      if (!segment) {
        continue;
      }
      if (this.isStaleSourceLanguageRevision(session, segment)) {
        const failed = {
          ...event,
          status: 'failed' as const,
          error: 'Stale transcription rejected after source-language revision changed.',
          createdAt: new Date().toISOString(),
        };
        this.replaceTranslationEvent(session, failed);
        this.onTranslationEvent(failed);
        this.updateTranslationProgress(session);
        this.emitSession(session);
        continue;
      }

      const queuedAt = Date.now();
      const { error: _eventError, ...eventWithoutError } = event;
      const translating = {
        ...eventWithoutError,
        status: 'translating' as const,
        translatedText: '',
        latency: zeroTranslationLatency(),
        createdAt: new Date().toISOString(),
      };
      this.replaceTranslationEvent(session, translating);
      this.updateTranslationProgress(session);
      this.onTranslationEvent(translating);
      this.emitSession(session);

      try {
        const providerStartedAt = Date.now();
        const result = await translateWithTimeout(
          this.translationProvider,
          {
            sessionId: session.id,
            streamId: session.streamId,
            segmentId: segment.chunkId,
            sequence: segment.sequence,
            sourceLanguage: segment.detectedLanguage,
            targetLanguage: event.targetLanguage,
            sourceText: segment.sourceText,
            startMs: segment.startMs,
            endMs: segment.endMs,
          },
          this.translationTimeoutMs,
        );
        if (revisionReplaced()) {
          return { ...session };
        }
        const providerMs = Date.now() - providerStartedAt;
        const translated = {
          ...translating,
          translatedText: result.translatedText,
          status: 'translated' as const,
          latency: {
            queuedMs: Math.max(0, providerStartedAt - queuedAt),
            providerMs,
            totalMs: Math.max(0, Date.now() - queuedAt),
          },
          createdAt: new Date().toISOString(),
        };
        this.replaceTranslationEvent(session, translated);
        this.onTranslationEvent(translated);
      } catch (error) {
        if (revisionReplaced()) {
          return { ...session };
        }
        const message = error instanceof Error ? error.message : 'Translation failed.';
        const failed = {
          ...translating,
          status: 'failed' as const,
          error: message,
          latency: {
            queuedMs: 0,
            providerMs: 0,
            totalMs: Math.max(0, Date.now() - queuedAt),
          },
          createdAt: new Date().toISOString(),
        };
        this.replaceTranslationEvent(session, failed);
        this.onTranslationEvent(failed);
      }
      this.updateTranslationProgress(session);
      this.emitSession(session);
      if (session.state === 'cancelled') {
        return { ...session };
      }
    }

    if (!(await this.waitUntilRunnable(session))) {
      return { ...session };
    }
    if (revisionReplaced()) {
      return { ...session };
    }

    const failedCount = session.translation.events.filter(
      (event) => event.status === 'failed',
    ).length;
    const settled = session.translation.events.every(
      (event) => event.status === 'translated' || event.status === 'failed',
    );
    const translatedCount = session.translation.events.filter(
      (event) => event.status === 'translated',
    ).length;
    if (settled && translatedCount > 0) {
      session.error =
        failedCount > 0
          ? `${failedCount} translation segment output${failedCount === 1 ? '' : 's'} failed; other language channels remain available.`
          : null;
      const { error: _translationError, ...translationWithoutError } = session.translation;
      session.translation = {
        ...translationWithoutError,
        status: failedCount > 0 ? 'failed' : 'translated',
        progressPct: Math.round((translatedCount / session.translation.events.length) * 100),
        ...(session.error ? { error: session.error } : {}),
      };
      return await this.startGeneratedAudio(session.id);
    }

    if (settled && translatedCount === 0) {
      session.error = `${failedCount} translation segment output${failedCount === 1 ? '' : 's'} failed.`;
      session.translation = {
        ...session.translation,
        status: 'failed',
        error: session.error,
      };
      this.transition(session.id, 'failed');
      return { ...session };
    }

    this.emitSession(session);
    return { ...session };
  }

  private createTranslationEvent(
    session: ProcessingSession,
    segment: TranscriptionEvent,
    translatedText: string,
    status: TimestampedTranslationStatus,
    latency: TimestampedTranslationLatency,
    error?: string,
    targetLanguage = session.targetLanguage,
  ): TimestampedTranslationEvent {
    const event: TimestampedTranslationEvent = {
      sessionId: session.id,
      streamId: session.streamId,
      segmentId: segment.chunkId,
      sequence: segment.sequence,
      sourceLanguage: session.sourceLanguageControl.activeLanguage,
      sourceLanguageRevision: segment.sourceLanguageRevision ?? session.sourceLanguageControl.revision,
      targetLanguage,
      sourceText: segment.sourceText,
      translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
      status,
      latency,
      createdAt: new Date().toISOString(),
    };
    if (error) event.error = error;
    return event;
  }

  private isStaleSourceLanguageRevision(
    session: ProcessingSession,
    segment: TranscriptionEvent,
  ): boolean {
    return (
      segment.sourceLanguageRevision !== undefined &&
      segment.sourceLanguageRevision !== session.sourceLanguageControl.revision
    );
  }

  private replaceTranslationEvent(
    session: ProcessingSession,
    next: TimestampedTranslationEvent,
  ): void {
    let previous: TimestampedTranslationEvent | null = null;
    session.translation.events = session.translation.events
      .map((event) => {
        if (event.segmentId === next.segmentId && event.targetLanguage === next.targetLanguage) {
          previous = event;
          return next;
        }
        return event;
      })
      .sort((a, b) =>
        a.sequence === b.sequence
          ? session.targetLanguages.indexOf(a.targetLanguage) -
            session.targetLanguages.indexOf(b.targetLanguage)
          : a.sequence - b.sequence,
      );
    if (previous) {
      this.recordTranslationTally(session.id, previous, next);
    }
  }

  private createGeneratedAudioEvent(
    session: ProcessingSession,
    segment: TimestampedTranslationEvent,
    status: TextToSpeechStatus,
    error?: string,
  ): GeneratedAudioEvent {
    const event: GeneratedAudioEvent = {
      sessionId: session.id,
      streamId: session.streamId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      targetLanguage: segment.targetLanguage,
      translatedText: segment.translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
      voiceId: this.voiceIdForLanguage(session, segment.targetLanguage),
      audioFilename: generatedAudioFilename(segment.sequence),
      durationMs: null,
      providerLatencyMs: null,
      status,
      createdAt: new Date().toISOString(),
    };
    if (error) event.error = error;
    return event;
  }

  private replaceGeneratedAudioEvent(session: ProcessingSession, next: GeneratedAudioEvent): void {
    let previous: GeneratedAudioEvent | null = null;
    session.generatedAudio.events = session.generatedAudio.events
      .map((event) => {
        if (event.segmentId === next.segmentId && event.targetLanguage === next.targetLanguage) {
          previous = event;
          return next;
        }
        return event;
      })
      .sort((a, b) =>
        a.sequence === b.sequence
          ? session.targetLanguages.indexOf(a.targetLanguage) -
            session.targetLanguages.indexOf(b.targetLanguage)
          : a.sequence - b.sequence,
      );
    if (previous) {
      this.recordGeneratedAudioTally(session.id, previous, next);
    }
  }

  private updateGeneratedAudioProgress(session: ProcessingSession): void {
    const events = session.generatedAudio.events;
    const generatedSegments = events.filter((event) => event.status === 'generated').length;
    const failedSegments = events.filter((event) => event.status === 'failed').length;
    const active = events.some((event) => event.status === 'generating' || event.status === 'retrying');
    session.generatedAudio = {
      ...session.generatedAudio,
      status: active
        ? 'generating'
        : failedSegments > 0
          ? 'failed'
          : generatedSegments === events.length && events.length > 0
            ? 'generated'
            : 'queued',
      providerName: this.textToSpeechProvider.name,
      providerStatus: active
        ? 'generating'
        : failedSegments > 0
          ? 'failed'
          : session.generatedAudio.textOnlyLanguages?.includes(session.targetLanguage)
            ? 'text-only'
            : 'ready',
      totalSegments: events.length,
      generatedSegments,
      failedSegments,
      targetLanguage: session.targetLanguage,
      voiceId: this.voiceIdForLanguage(session, session.targetLanguage),
      progressPct: events.length === 0 ? 0 : Math.round((generatedSegments / events.length) * 100),
    };
  }

  private repetitionFilterFor(sessionId: string): RepetitionFilter {
    let filter = this.repetitionFilters.get(sessionId);
    if (!filter) {
      filter = createRepetitionFilter();
      this.repetitionFilters.set(sessionId, filter);
    }
    return filter;
  }

  private voiceIdForLanguage(session: ProcessingSession, targetLanguage: string): string {
    return (
      session.voiceIdsByLanguage?.[targetLanguage] ??
      this.textToSpeechVoiceIds.get(targetLanguage) ??
      this.textToSpeechVoiceId
    );
  }

  /**
   * Which voice speaks THIS utterance, resolved now rather than at session
   * creation.
   *
   * The standard voice is always computed, because it is both the answer for
   * everyone without a personal voice and the fallback for everyone with one.
   * The owner lookup runs fresh every time: that single decision is what makes
   * revoke, delete and re-record take effect on the next utterance instead of
   * the next call, and it is the reason nothing here is memoised.
   *
   * A lookup that throws is treated as "no personal voice". Somebody speaking
   * mid-call is not a good moment to discover that the voice store had an
   * opinion about error handling.
   */
  private synthesisVoiceFor(
    session: ProcessingSession,
    targetLanguage: string,
  ): { voiceId: string; standardVoiceId: string } {
    const standardVoiceId = this.voiceIdForLanguage(session, targetLanguage);
    const ownerId = this.voiceOwnersBySession.get(session.id);
    if (!ownerId) return { voiceId: standardVoiceId, standardVoiceId };
    let personalVoiceId: string | null = null;
    try {
      personalVoiceId = this.resolvePersonalVoiceId(ownerId);
    } catch {
      personalVoiceId = null;
    }
    return { voiceId: personalVoiceId ?? standardVoiceId, standardVoiceId };
  }

  private generatedAudioOutputPath(
    sessionId: string,
    targetLanguage: string,
    sequence: number,
  ): string {
    return resolve(
      safeSessionOutputDir(this.outputBaseDir, sessionId),
      'tts',
      safeLanguageDirectory(targetLanguage),
      generatedAudioFilename(sequence),
    );
  }

  private ensureViewerReadyMedia(session: ProcessingSession): Promise<void> {
    // Concurrent viewer-media requests share one render instead of spawning
    // one ffmpeg process each and racing writes to the same output file.
    const inFlight = this.viewerReadyRenders.get(session.id);
    if (inFlight) return inFlight;
    const render = this.renderViewerReadyMediaFile(session).finally(() => {
      this.viewerReadyRenders.delete(session.id);
    });
    this.viewerReadyRenders.set(session.id, render);
    return render;
  }

  private async renderViewerReadyMediaFile(session: ProcessingSession): Promise<void> {
    if (session.sourceKind !== 'upload' || !session.media?.hasVideo) {
      throw new MediaIngestError(
        `Viewer-ready media is unavailable for session ${session.id}.`,
        'viewer-ready-media-unavailable',
        404,
        { ...session },
      );
    }

    const source = await stat(session.sourcePath).catch(() => null);
    if (!source?.isFile()) {
      throw new MediaIngestError(
        `Source media file is missing for session ${session.id}.`,
        'source-media-unavailable',
        404,
        { ...session },
      );
    }

    const generatedSegments = session.generatedAudio.events
      .filter(
        (event) =>
          event.status === 'generated' && event.targetLanguage === session.targetLanguage,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const primaryLanguageTotal = session.generatedAudio.events.filter(
      (event) => event.targetLanguage === session.targetLanguage,
    ).length;
    if (
      generatedSegments.length === 0 ||
      generatedSegments.length !== primaryLanguageTotal
    ) {
      throw new MediaIngestError(
        `Viewer-ready media requires all generated audio segments for session ${session.id}.`,
        'viewer-ready-media-unavailable',
        409,
        { ...session },
      );
    }

    const outputPath = this.viewerReadyMediaOutputPath(session.id);
    // Render into a session-scoped temp file and promote it atomically so a
    // reader can never observe (or stream) a partially written programme file.
    const tempOutputPath = resolve(
      safeSessionOutputDir(this.outputBaseDir, session.id),
      'viewer-ready',
      `programme.tmp-${randomUUID()}.mp4`,
    );
    const subtitlesPath = this.viewerReadySubtitlesPath(session.id, session.targetLanguage);
    assertPathInsideSession(this.outputBaseDir, session.id, outputPath);
    assertPathInsideSession(this.outputBaseDir, session.id, tempOutputPath);
    assertPathInsideSession(this.outputBaseDir, session.id, subtitlesPath);
    const segments: ViewerReadyMediaRenderSegment[] = generatedSegments.map((event) => {
      const audioPath = this.generatedAudioOutputPath(
        session.id,
        event.targetLanguage,
        event.sequence,
      );
      assertPathInsideSession(this.outputBaseDir, session.id, audioPath);
      return {
        audioPath,
        translatedText: event.translatedText,
        startMs: event.startMs,
        endMs: event.endMs,
        sequence: event.sequence,
      };
    });

    try {
      await this.renderViewerReadyMedia({
        sourcePath: session.sourcePath,
        outputPath: tempOutputPath,
        subtitlesPath,
        segments,
        originalVolume: 0.2,
        translatedVolume: 1,
        subtitleLanguage: session.targetLanguage,
      });
      await rename(tempOutputPath, outputPath);
    } catch (error) {
      await rm(tempOutputPath, { force: true });
      throw error;
    }
  }

  private viewerReadyMediaOutputPath(sessionId: string): string {
    return resolve(safeSessionOutputDir(this.outputBaseDir, sessionId), 'viewer-ready', 'programme.mp4');
  }

  private viewerReadySubtitlesPath(sessionId: string, targetLanguage: string): string {
    return resolve(
      safeSessionOutputDir(this.outputBaseDir, sessionId),
      'viewer-ready',
      `captions.${safeLanguageDirectory(targetLanguage)}.srt`,
    );
  }

  private async ensureGeneratedAudioOutputDir(
    sessionId: string,
    targetLanguage: string,
  ): Promise<void> {
    await mkdir(resolve(
      safeSessionOutputDir(this.outputBaseDir, sessionId),
      'tts',
      safeLanguageDirectory(targetLanguage),
    ), {
      recursive: true,
    });
  }

  private emitGeneratedAudioReady(session: ProcessingSession, event: GeneratedAudioEvent): void {
    if (event.status !== 'generated' || event.durationMs === null) return;
    // Dedupe keys live in a per-session set so they are released together with
    // the session instead of accumulating for the lifetime of the store.
    let keys = this.generatedAudioReadyKeysBySession.get(session.id);
    if (!keys) {
      keys = new Set<string>();
      this.generatedAudioReadyKeysBySession.set(session.id, keys);
    }
    const key = `${event.segmentId}:${event.targetLanguage}`;
    if (keys.has(key)) return;
    keys.add(key);
    this.onGeneratedAudioReady({
      ...event,
    }, {
      ...session,
    });
  }

  private markRealtimeCaptionsOnlyLanguage(session: ProcessingSession, language: string): void {
    const textOnlyLanguages = session.generatedAudio.textOnlyLanguages ?? [];
    session.generatedAudio = {
      ...session.generatedAudio,
      // No voice output will be produced for this language; captions carry the
      // channel, matching the batch pipeline's text-only handling.
      status: 'generated',
      providerStatus: 'text-only',
      progressPct: 100,
      targetLanguages: session.targetLanguages,
      textOnlyLanguages: textOnlyLanguages.includes(language)
        ? textOnlyLanguages
        : [...textOnlyLanguages, language],
    };
    this.emitSession(session);
  }

  private updateTranslationProgress(session: ProcessingSession): void {
    const events = session.translation.events;
    const translatedSegments = events.filter((event) => event.status === 'translated').length;
    const failedSegments = events.filter((event) => event.status === 'failed').length;
    const active = events.some(
      (event) => event.status === 'translating' || event.status === 'retrying',
    );
    session.translation = {
      ...session.translation,
      status: active
        ? 'translating'
        : failedSegments > 0
          ? 'failed'
          : translatedSegments === events.length && events.length > 0
            ? 'translated'
            : 'queued',
      totalSegments: events.length,
      translatedSegments,
      failedSegments,
      sourceLanguage:
        session.sourceLanguageControl.activeLanguage ??
        events.find((event) => event.sourceLanguage !== 'und')?.sourceLanguage ??
        null,
      sourceLanguageRevision: session.sourceLanguageControl.revision,
      targetLanguage: session.targetLanguage,
      targetLanguages: session.targetLanguages,
      providerName: this.translationProvider.name,
      providerStatus: active ? 'translating' : failedSegments > 0 ? 'failed' : 'ready',
      progressPct: events.length === 0 ? 0 : Math.round((translatedSegments / events.length) * 100),
    };
  }

  private resolveSessionTargetLanguage(targetLanguage?: string): string {
    const normalized =
      targetLanguage === undefined || targetLanguage.trim() === ''
        ? this.defaultTranslationTargetLanguage
        : normalizeTargetLanguage(targetLanguage);
    if (!this.translationSupportedTargetLanguages.includes(normalized)) {
      throw new MediaIngestError(
        `Unsupported target language: ${targetLanguage ?? normalized}. Supported languages: ${this.translationSupportedTargetLanguages.join(', ')}.`,
        'unsupported-language',
        400,
      );
    }
    return normalized;
  }

  private resolveSessionTargetLanguages(
    targetLanguages: readonly string[] | undefined,
    fallback: string,
    sourceLanguage: string,
    /**
     * Whether `sourceLanguage` is a real answer or just the standing default.
     *
     * Under auto-detect nobody has said what is being spoken yet — the control
     * holds `defaultLanguage` until the first chunk reconciles it — so treating
     * it as the source and rejecting a matching target locks out the ordinary
     * case of a Spanish speaker requesting English listeners. The rule itself
     * is right and stays enforced wherever the source is actually known.
     */
    sourceLanguageKnown = true,
  ): string[] {
    const normalized = normalizeSupportedTargetLanguages(targetLanguages ?? [fallback]);
    const selected = normalized.length === 0 ? [fallback] : normalized;
    for (const targetLanguage of selected) {
      if (!this.translationSupportedTargetLanguages.includes(targetLanguage)) {
        throw new MediaIngestError(
          `Unsupported target language: ${targetLanguage}. Supported languages: ${this.translationSupportedTargetLanguages.join(', ')}.`,
          'unsupported-language',
          400,
        );
      }
      if (
        sourceLanguageKnown &&
        primaryLanguageSubtag(targetLanguage) === primaryLanguageSubtag(sourceLanguage)
      ) {
        throw new MediaIngestError(
          `Target language ${targetLanguage} matches the session source language; the original channel already delivers it.`,
          'unsupported-language',
          400,
        );
      }
    }
    return selected;
  }

  private reconcileDetectedLanguage(
    session: ProcessingSession,
    detection: { language: string; confidence: number | null },
  ): void {
    const previousRevision = session.sourceLanguageControl.revision;
    session.sourceLanguageControl = applySourceLanguageDetection(session.sourceLanguageControl, detection);
    session.transcription = {
      ...session.transcription,
      sourceLanguage: session.sourceLanguageControl.activeLanguage,
      sourceLanguageRevision: session.sourceLanguageControl.revision,
      languageDetectionConfidence: session.sourceLanguageControl.detectionConfidence,
    };
    if (session.sourceLanguageControl.revision !== previousRevision) {
      this.createLanguageRevisionBoundary(session);
    }
  }

  private createLanguageRevisionBoundary(session: ProcessingSession): void {
    session.translation = {
      ...emptyTranslation('queued', session.targetLanguage, this.translationProvider.name),
      sourceLanguage: session.sourceLanguageControl.activeLanguage,
      sourceLanguageRevision: session.sourceLanguageControl.revision,
      targetLanguages: session.targetLanguages,
    };
    session.generatedAudio = {
      ...emptyGeneratedAudio(
        'queued',
        session.targetLanguage,
        this.textToSpeechVoiceId,
        this.textToSpeechProvider.name,
      ),
      targetLanguages: session.targetLanguages,
      textOnlyLanguages: session.targetLanguages.filter(
        (language) => !this.textToSpeechSupportedLanguages.includes(language),
      ),
    };
    this.rebuildLanguageTallies(session);
    this.recordSessionEvent(
      session,
      'operator-action',
      'set-source-language',
      'accepted',
      `Source language revision ${session.sourceLanguageControl.revision} active: ${session.sourceLanguageControl.activeLanguage}.`,
    );
  }

  private resolveConfiguredTargetLanguage(targetLanguage: string): string {
    const normalized = normalizeTargetLanguage(targetLanguage);
    if (!this.translationSupportedTargetLanguages.includes(normalized)) {
      throw new MediaIngestError(
        `Unsupported target language: ${targetLanguage}. Supported languages: ${this.translationSupportedTargetLanguages.join(', ')}.`,
        'unsupported-language',
        400,
      );
    }
    return normalized;
  }

  private assertNoActiveTranslation(session: ProcessingSession): void {
    if (
      session.translation.events.some(
        (event) => event.status === 'translating' || event.status === 'retrying',
      )
    ) {
      throw new MediaIngestError(
        `Translation is already running for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
  }

  private assertNoActiveGeneratedAudio(session: ProcessingSession): void {
    if (
      session.generatedAudio.events.some(
        (event) => event.status === 'generating' || event.status === 'retrying',
      )
    ) {
      throw new MediaIngestError(
        `Generated audio is already running for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
  }

  private async waitUntilRunnable(session: ProcessingSession): Promise<boolean> {
    while (session.state === 'paused') {
      await new Promise<void>((resolve) => {
        const waiters = this.resumeWaiters.get(session.id) ?? new Set<() => void>();
        waiters.add(resolve);
        this.resumeWaiters.set(session.id, waiters);
      });
    }
    return session.state !== 'cancelled';
  }

  private releaseResumeWaiters(sessionId: string): void {
    const waiters = this.resumeWaiters.get(sessionId);
    if (!waiters) return;
    this.resumeWaiters.delete(sessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private assertRetryAllowed(
    session: ProcessingSession,
    action: SessionRecoveryAction,
    segmentId: string,
  ): void {
    if (
      session.state === 'cancelled' ||
      session.state === 'completed' ||
      session.state === 'paused'
    ) {
      throw new MediaIngestError(
        `Cannot ${action} while session is ${session.state}.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }
    if (
      session.transcription.events.some((event) => event.status === 'retrying') ||
      session.translation.events.some((event) => event.status === 'retrying') ||
      session.generatedAudio.events.some((event) => event.status === 'retrying')
    ) {
      throw new MediaIngestError(
        `A recovery retry is already running for ${segmentId}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
  }

  private recordRejectedAction(
    session: ProcessingSession,
    action: SessionRecoveryAction,
    error: unknown,
    segmentId?: string,
  ): void {
    const message = error instanceof Error ? error.message : `Operator action ${action} rejected.`;
    this.recordSessionEvent(session, 'operator-action', action, 'rejected', message, segmentId);
    this.emitSession(session);
  }

  private recordSessionEvent(
    session: ProcessingSession,
    kind: SessionRecoveryEventKind,
    action: SessionRecoveryAction,
    status: SessionRecoveryEventStatus,
    message: string,
    segmentId?: string,
  ): void {
    session.monitoring.events = [
      {
        id: `recovery_${randomUUID()}`,
        kind,
        action,
        status,
        message,
        ...(segmentId ? { segmentId } : {}),
        createdAt: new Date().toISOString(),
      },
      ...session.monitoring.events,
    ].slice(0, 50);
  }

  private assertNoActiveTranscription(session: ProcessingSession): void {
    if (
      session.transcription.events.some(
        (event) => event.status === 'transcribing' || event.status === 'retrying',
      )
    ) {
      throw new MediaIngestError(
        `Transcription is already running for ${session.id}.`,
        'duplicate-processing',
        409,
        { ...session },
      );
    }
  }
}

function assertSafeOriginalFilename(filename: string): void {
  const trimmed = filename.trim();
  if (
    !trimmed ||
    trimmed !== filename ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed.includes('..')
  ) {
    throw new MediaIngestError('Unsafe media filename rejected.', 'unsafe-filename', 400);
  }
}

function assertSafeWebRtcSessionInput(input: WebRtcSessionInput): void {
  for (const [field, value] of [
    ['sessionId', input.sessionId],
    ['broadcastId', input.broadcastId],
    ['broadcasterPeerId', input.broadcasterPeerId],
  ] as const) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
      throw new MediaIngestError(`Unsafe WebRTC ${field} rejected.`, 'unsafe-filename', 400);
    }
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new MediaIngestError('WebRTC revision must be a non-negative integer.', 'invalid-media', 400);
  }
  // Refused, not ignored: an owner id that fails to parse means something
  // upstream sent the wrong string, and quietly dropping it would present as a
  // personal voice that simply never happens.
  if (input.voiceOwnerId !== undefined && parseVoiceOwnerId(input.voiceOwnerId) === null) {
    throw new MediaIngestError('Unsafe WebRTC voice owner rejected.', 'invalid-media', 400);
  }
  for (const [language, voiceId] of Object.entries(input.voiceIdsByLanguage ?? {})) {
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language) || !/^[A-Za-z0-9_.-]{1,120}$/.test(voiceId)) {
      throw new MediaIngestError('Unsafe WebRTC voice selection rejected.', 'unsafe-filename', 400);
    }
  }
}

function assertSafeRequestedSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) {
    throw new MediaIngestError('Unsafe requested session ID rejected.', 'unsafe-filename', 400);
  }
  // `call_` ids are reserved for the P6.1B native-call runtime; a programme
  // upload claiming one would have its events swallowed by call interception.
  if (/^call_/i.test(sessionId)) {
    throw new MediaIngestError('Requested session ID prefix is reserved.', 'unsafe-filename', 400);
  }
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  const relation = relative(parent, child);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

function isSupportedExtension(extension: string): extension is SupportedMediaExtension {
  return extension === 'mp4' || extension === 'mov' || extension === 'mp3' || extension === 'wav';
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function normalizeTargetLanguage(targetLanguage: string): string {
  return targetLanguage.trim().toLowerCase();
}

function safeLanguageDirectory(targetLanguage: string): string {
  const normalized = normalizeTargetLanguage(targetLanguage);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(normalized)) {
    throw new MediaIngestError(
      `Unsafe target language rejected: ${targetLanguage}.`,
      'unsafe-filename',
      400,
    );
  }
  return normalized;
}

function normalizeSupportedTargetLanguages(targetLanguages: readonly string[]): string[] {
  return [...new Set(targetLanguages.map(normalizeTargetLanguage).filter(Boolean))];
}

function primaryLanguageSubtag(language: string): string {
  return normalizeTargetLanguage(language).split('-')[0] ?? '';
}

/**
 * Whether a failed warm-up probe (see `warmUpCallModels`) is one that repeating
 * cannot fix — an unsupported voice or language, an unsafe path, a rejected
 * request. Those are decided by configuration, so the attempt is remembered and
 * not retried on every subsequent call; anything else (a model still
 * downloading, a worker restarting, a timeout) is treated as transient.
 */
function isPermanentWarmUpFailure(error: unknown): boolean {
  return error instanceof MediaIngestError && error.statusCode >= 400 && error.statusCode < 500;
}

/**
 * Whether the source language is a real answer rather than the standing
 * default. Manual mode is an explicit statement, and a locked or confirmed
 * control has been settled by detection or a person; plain `auto-detect` before
 * the first chunk has decided nothing.
 */
function isSourceLanguageKnown(control: SourceLanguageControlMetadata): boolean {
  return control.mode === 'manual' || control.locked || control.confirmedLanguage !== null;
}

/** P6.1B native-call ingest sessions use the reserved `call_` id prefix. */
function isRealtimeCallSession(session: ProcessingSession): boolean {
  return session.sourceKind === 'webrtc' && /^call_/i.test(session.id);
}

function fileFingerprint(upload: UploadedMediaFile): string {
  return `${upload.originalName.toLowerCase()}|${upload.sizeBytes}|${normalizeMimeType(upload.mimeType)}`;
}

function emptyTranscription(status: TranscriptionStatus): TranscriptionSessionMetadata {
  return {
    status,
    progressPct: 0,
    totalChunks: 0,
    transcribedChunks: 0,
    failedChunks: 0,
    detectedLanguage: null,
    sourceLanguage: 'en',
    sourceLanguageRevision: 0,
    languageDetectionConfidence: null,
    events: [],
  };
}

function emptyTranslation(
  status: TimestampedTranslationStatus,
  targetLanguage: string,
  providerName = 'mock',
): TranslationSessionMetadata {
  return {
    status,
    providerName,
    providerStatus: translationProviderStatus(status),
    progressPct: 0,
    totalSegments: 0,
    translatedSegments: 0,
    failedSegments: 0,
    sourceLanguage: null,
    sourceLanguageRevision: 0,
    targetLanguage,
    targetLanguages: [targetLanguage],
    events: [],
  };
}

function emptyGeneratedAudio(
  status: TextToSpeechStatus,
  targetLanguage: string,
  voiceId: string,
  providerName = 'mock',
): TextToSpeechSessionMetadata {
  return {
    status,
    providerName,
    providerStatus: generatedAudioProviderStatus(status),
    progressPct: 0,
    totalSegments: 0,
    generatedSegments: 0,
    failedSegments: 0,
    targetLanguage,
    targetLanguages: [targetLanguage],
    voiceId,
    textOnlyLanguages: [],
    outputFormat: {
      container: 'wav',
      codec: 'pcm_s16le',
    },
    events: [],
  };
}

function translationProviderStatus(
  status: TimestampedTranslationStatus,
): NonNullable<TranslationSessionMetadata['providerStatus']> {
  if (status === 'translating' || status === 'retrying') return 'translating';
  if (status === 'failed') return 'failed';
  if (status === 'queued') return 'idle';
  return 'ready';
}

function generatedAudioProviderStatus(
  status: TextToSpeechStatus,
): NonNullable<TextToSpeechSessionMetadata['providerStatus']> {
  if (status === 'generating' || status === 'retrying') return 'generating';
  if (status === 'failed') return 'failed';
  if (status === 'queued') return 'idle';
  return 'ready';
}

function emptyMicrophoneCapture(
  status: MicrophoneCaptureMetadata['status'],
): MicrophoneCaptureMetadata {
  return {
    status,
    deviceId: null,
    deviceLabel: null,
    durationMs: 0,
    chunkCount: 0,
    chunks: [],
  };
}

function emptyMonitoring(): SessionMonitoringMetadata {
  return {
    currentStage: 'created',
    overallProgressPct: 0,
    failedSegmentCount: 0,
    averageLatencyMs: null,
    latestLatencyMs: null,
    lastError: null,
    events: [],
  };
}

function buildSessionMonitoring(
  session: ProcessingSession,
  events: SessionMonitoringMetadata['events'],
): SessionMonitoringMetadata {
  const translatedEvents = session.translation.events.filter(
    (event) => event.status === 'translated',
  );
  const generatedEvents = session.generatedAudio.events.filter(
    (event) => event.status === 'generated' && event.providerLatencyMs !== null,
  );
  const latencies = [
    ...translatedEvents.map((event) => event.latency.totalMs),
    ...generatedEvents.map((event) => event.providerLatencyMs ?? 0),
  ];
  const latestLatencyMs =
    generatedEvents.at(-1)?.providerLatencyMs ?? translatedEvents.at(-1)?.latency.totalMs ?? null;
  const averageLatencyMs =
    latencies.length === 0
      ? null
      : Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length);

  return {
    currentStage: currentProcessingStage(session),
    overallProgressPct: overallProgress(session),
    failedSegmentCount:
      session.transcription.failedChunks +
      session.translation.failedSegments +
      session.generatedAudio.failedSegments,
    averageLatencyMs,
    latestLatencyMs,
    lastError: lastSessionError(session),
    events,
  };
}

function currentProcessingStage(
  session: ProcessingSession,
): SessionMonitoringMetadata['currentStage'] {
  if (session.state === 'paused') return 'paused';
  if (session.state === 'completed') return 'completed';
  if (session.state === 'failed') return 'failed';
  if (session.state === 'cancelled') return 'cancelled';
  if (session.state === 'validating') return 'validating';
  if (
    session.sourceKind === 'microphone' &&
    (session.microphoneCapture.status === 'capturing' ||
      session.microphoneCapture.status === 'paused')
  ) {
    return 'microphone-capture';
  }
  if (
    session.audioExtraction.status === 'extracting' ||
    session.audioExtraction.status === 'chunking' ||
    session.audioExtraction.status === 'validating'
  ) {
    return 'audio-extraction';
  }
  if (session.transcription.totalChunks > 0 && session.transcription.status !== 'transcribed') {
    return 'transcription';
  }
  if (session.translation.totalSegments > 0 && session.translation.status !== 'translated') {
    return 'translation';
  }
  if (session.generatedAudio.totalSegments > 0 && session.generatedAudio.status !== 'generated') {
    return 'text-to-speech';
  }
  return session.state === 'ready' || session.audioExtraction.status === 'completed'
    ? 'transcription'
    : 'created';
}

function overallProgress(session: ProcessingSession): number {
  if (session.state === 'completed') return 100;
  if (session.sourceKind === 'microphone') {
    if (session.audioExtraction.chunkCount === 0) return session.state === 'processing' ? 5 : 0;
    const transcriptionPct =
      session.transcription.totalChunks > 0 ? clampPct(session.transcription.progressPct) : 0;
    const translationPct =
      session.translation.totalSegments > 0 ? clampPct(session.translation.progressPct) : 0;
    const generatedAudioPct =
      session.generatedAudio.totalSegments > 0 ? clampPct(session.generatedAudio.progressPct) : 0;
    return Math.round(transcriptionPct * 0.35 + translationPct * 0.35 + generatedAudioPct * 0.3);
  }
  const extractionPct = clampPct(session.audioExtraction.progressPct);
  const transcriptionPct =
    session.transcription.totalChunks > 0 ? clampPct(session.transcription.progressPct) : 0;
  const translationPct =
    session.translation.totalSegments > 0 ? clampPct(session.translation.progressPct) : 0;
  const generatedAudioPct =
    session.generatedAudio.totalSegments > 0 ? clampPct(session.generatedAudio.progressPct) : 0;
  return Math.round(
    extractionPct * 0.25 + transcriptionPct * 0.3 + translationPct * 0.25 + generatedAudioPct * 0.2,
  );
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function lastSessionError(session: ProcessingSession): string | null {
  return (
    session.error ??
    session.translation.error ??
    session.generatedAudio.error ??
    session.transcription.error ??
    session.microphoneCapture.error ??
    session.audioExtraction.error ??
    session.translation.events.find((event) => event.error)?.error ??
    session.generatedAudio.events.find((event) => event.error)?.error ??
    session.transcription.events.find((event) => event.error)?.error ??
    null
  );
}

function lastMicrophoneEndMs(session: ProcessingSession): number {
  return session.microphoneCapture.chunks.at(-1)?.endMs ?? 0;
}

function normalizeOptionalDeviceField(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function microphoneChunkExtension(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'audio/mp4' || normalized === 'audio/aac') return 'm4a';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  return 'bin';
}

function zeroTranslationLatency(): TimestampedTranslationLatency {
  return {
    queuedMs: 0,
    providerMs: 0,
    totalMs: 0,
  };
}

function generatedAudioFilename(sequence: number): string {
  return `tts-${String(sequence).padStart(6, '0')}.wav`;
}

function normalizeVoiceId(voiceId: string): string {
  const normalized = voiceId.trim();
  if (!normalized) {
    throw new MediaIngestError('Unsupported TTS voice: empty voice ID.', 'unsupported-tts-voice', 400);
  }
  return normalized;
}

function assertSafeRouteId(value: string, label: string): void {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed.includes('..')
  ) {
    throw new MediaIngestError(`Unsafe generated-audio ${label} rejected.`, 'unsafe-path', 400);
  }
}

function assertPathInsideSession(outputBaseDir: string, sessionId: string, filePath: string): void {
  const sessionDir = safeSessionOutputDir(outputBaseDir, sessionId);
  const resolvedFilePath = resolve(filePath);
  const pathFromSession = relative(sessionDir, resolvedFilePath);
  if (
    pathFromSession === '' ||
    pathFromSession.startsWith('..') ||
    pathFromSession.includes(':') ||
    resolve(sessionDir, pathFromSession) !== resolvedFilePath
  ) {
    throw new MediaIngestError('Generated audio path escaped the session directory.', 'unsafe-path', 400);
  }
}

async function readWavDurationMs(audioPath: string): Promise<number> {
  const buffer = await readFile(audioPath);
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Generated audio is not a valid WAV file.');
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) break;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('Generated WAV fmt chunk is invalid.');
      const audioFormat = buffer.readUInt16LE(dataOffset);
      const channels = buffer.readUInt16LE(dataOffset + 2);
      const sampleRate = buffer.readUInt32LE(dataOffset + 4);
      byteRate = buffer.readUInt32LE(dataOffset + 8);
      const bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
      if (
        audioFormat !== 1 ||
        channels !== 1 ||
        ![16_000, 22_050, 24_000, 44_100, 48_000].includes(sampleRate) ||
        bitsPerSample !== 16
      ) {
        throw new Error('Generated WAV must be mono PCM 16-bit at a supported sample rate.');
      }
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || dataSize === null) {
    throw new Error('Generated WAV is missing required audio metadata.');
  }
  return Math.round((dataSize / byteRate) * 1000);
}

interface MutableSessionLanguageTallies {
  translation: Map<string, TargetLanguageOutputTally>;
  generatedAudio: Map<string, TargetLanguageOutputTally>;
}

type TallyClass = 'completed' | 'failed' | 'active' | 'other';

function translationTallyClass(status: TimestampedTranslationStatus): TallyClass {
  if (status === 'translated') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'translating' || status === 'retrying') return 'active';
  return 'other';
}

function generatedAudioTallyClass(status: TextToSpeechStatus): TallyClass {
  if (status === 'generated') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'generating' || status === 'retrying') return 'active';
  return 'other';
}

function applyTallyTransition(
  tallies: Map<string, TargetLanguageOutputTally>,
  previous: { targetLanguage: string; tallyClass: TallyClass } | null,
  next: { targetLanguage: string; tallyClass: TallyClass },
  failureError?: string | null,
): void {
  let tally = tallies.get(next.targetLanguage);
  if (!tally) {
    tally = emptyTargetLanguageOutputTally();
    tallies.set(next.targetLanguage, tally);
  }
  if (previous) {
    adjustTally(tally, previous.tallyClass, -1);
  } else {
    tally.totalSegments += 1;
  }
  adjustTally(tally, next.tallyClass, 1);
  if (failureError !== undefined) {
    tally.lastError = failureError;
  }
}

function adjustTally(tally: TargetLanguageOutputTally, tallyClass: TallyClass, delta: number): void {
  if (tallyClass === 'completed') tally.completedSegments += delta;
  else if (tallyClass === 'failed') tally.failedSegments += delta;
  else if (tallyClass === 'active') tally.activeSegments += delta;
}

function buildTallyMap(
  events: ReadonlyArray<{ targetLanguage: string; tallyClass: TallyClass; error: string | null }>,
): Map<string, TargetLanguageOutputTally> {
  const tallies = new Map<string, TargetLanguageOutputTally>();
  for (const event of events) {
    let tally = tallies.get(event.targetLanguage);
    if (!tally) {
      tally = emptyTargetLanguageOutputTally();
      tallies.set(event.targetLanguage, tally);
    }
    tally.totalSegments += 1;
    adjustTally(tally, event.tallyClass, 1);
    if (event.tallyClass === 'failed' && event.error !== null) {
      tally.lastError = event.error;
    }
  }
  return tallies;
}

function cloneTallyMap(
  tallies: Map<string, TargetLanguageOutputTally> | undefined,
): Map<string, TargetLanguageOutputTally> {
  return new Map([...(tallies ?? new Map<string, TargetLanguageOutputTally>())].map(
    ([language, tally]) => [language, { ...tally }],
  ));
}

function formatTranscriptTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
