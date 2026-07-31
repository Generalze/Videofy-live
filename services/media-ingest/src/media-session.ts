import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AiProviderStatusMetadata,
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
import { MediaIngestError } from './ingest-error.js';
import {
  MockTranscriptionProvider,
  transcribeWithTimeout,
  type TranscriptionProvider,
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
  applySourceLanguageAction,
  applySourceLanguageDetection,
  buildTargetLanguageCatalogue,
  createInitialSourceLanguageControl,
  defaultAiProviderStatus,
  type SourceLanguageActionInput,
} from './language-controls.js';

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
}

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
  textToSpeechProvider?: TextToSpeechProvider;
  textToSpeechTimeoutMs?: number;
  textToSpeechVoiceId?: string;
  textToSpeechSupportedLanguages?: readonly string[];
  sourceLanguageConfidenceThreshold?: number;
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

const DUPLICATE_PROTECTED_STATES = new Set<StreamStatus>([
  'created',
  'validating',
  'ready',
  'processing',
  'paused',
  'completed',
  'failed',
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
  private readonly textToSpeechSupportedLanguages: readonly string[];
  private readonly sourceLanguageConfidenceThreshold: number;
  private readonly targetLanguageCatalogue: TargetLanguageCapability[];
  private readonly onGeneratedAudioReady: (event: GeneratedAudioEvent, session: ProcessingSession) => void;
  private readonly generatedAudioReadyKeys = new Set<string>();

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
    this.sourceLanguageConfidenceThreshold = options.sourceLanguageConfidenceThreshold ?? 0.82;
    this.targetLanguageCatalogue = buildTargetLanguageCatalogue({
      supportedTranslationLanguages: this.translationSupportedTargetLanguages,
      supportedVoiceLanguages: this.textToSpeechSupportedLanguages,
      voiceIds: new Map(
        this.textToSpeechSupportedLanguages.map((language) => [
          language,
          this.textToSpeechVoiceId,
        ]),
      ),
    });
  }

  async createFromUpload(
    upload: UploadedMediaFile,
    probe: MediaProbe = ffprobeMedia,
  ): Promise<ProcessingSession> {
    const supported = resolveSupportedMedia(upload.originalName, upload.mimeType);
    const targetLanguage = this.resolveSessionTargetLanguage(upload.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(upload.targetLanguages, targetLanguage);
    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(upload.sourceLanguage ? { sourceLanguage: upload.sourceLanguage } : {}),
      ...(upload.sourceLanguageMode ? { sourceLanguageMode: upload.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
    const duplicate = this.findDuplicate(upload);
    if (duplicate) {
      throw new MediaIngestError(
        `Duplicate submission rejected for ${upload.originalName}.`,
        'duplicate-submission',
        409,
        duplicate,
      );
    }

    const now = new Date().toISOString();
    const session: ProcessingSession = {
      id: `ps_${randomUUID()}`,
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

    const targetLanguage = this.resolveSessionTargetLanguage(input.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(input.targetLanguages, targetLanguage);
    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.sourceLanguageMode ? { sourceLanguageMode: input.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
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
    }

    const targetLanguage = this.resolveSessionTargetLanguage(input.targetLanguage);
    const targetLanguages = this.resolveSessionTargetLanguages(input.targetLanguages, targetLanguage);
    const sourceLanguageControl = createInitialSourceLanguageControl({
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.sourceLanguageMode ? { sourceLanguageMode: input.sourceLanguageMode } : {}),
      confidenceThreshold: this.sourceLanguageConfidenceThreshold,
    });
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
      return this.failWebRtcSession(session, error, 'WebRTC transcription chunk ingest failed.');
    } finally {
      this.activeWebRtcChunkSessions.delete(session.id);
    }
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
      this.recordSessionEvent(
        session,
        'recovery-event',
        'retry-transcription',
        retried?.status === 'transcribed' ? 'succeeded' : 'failed',
        retried?.status === 'transcribed'
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

  async retryTranslationSegment(sessionId: string, segmentId: string): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    try {
      this.assertRetryAllowed(session, 'retry-translation', segmentId);
      this.assertNoActiveTranslation(session);
      const event = session.translation.events.find((item) => item.segmentId === segmentId);
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
      const retried = next.translation.events.find((item) => item.segmentId === segmentId);
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
  ): Promise<ProcessingSession> {
    const session = this.requireSession(sessionId);
    try {
      this.assertRetryAllowed(session, 'retry-tts', segmentId);
      this.assertNoActiveGeneratedAudio(session);
      const event = session.generatedAudio.events.find((item) => item.segmentId === segmentId);
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
      const retried = next.generatedAudio.events.find((item) => item.segmentId === segmentId);
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

  async getGeneratedAudioFile(sessionId: string, segmentId: string): Promise<GeneratedAudioFile> {
    assertSafeRouteId(sessionId, 'session ID');
    assertSafeRouteId(segmentId, 'segment ID');
    const session = this.requireSession(sessionId);
    const event = session.generatedAudio.events.find((item) => item.segmentId === segmentId);
    if (!event || event.status !== 'generated') {
      throw new MediaIngestError(
        `Generated audio is not available for segment ${segmentId}.`,
        'generated-audio-unavailable',
        404,
        { ...session },
      );
    }

    const audioPath = this.generatedAudioOutputPath(session.id, event.sequence);
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

  private failRealtimeAudioSession(
    session: ProcessingSession,
    error: unknown,
    fallbackMessage: string,
  ): ProcessingSession {
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
    if (input.sequence !== session.audioExtraction.chunks.length) {
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
      throw new MediaIngestError(
        'WebRTC chunk timeline failed: gap or overlap detected.',
        'audio-timeline-invalid',
        409,
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

  private async storeWebRtcChunk(
    session: ProcessingSession,
    input: WebRtcChunkInput,
  ): Promise<MicrophoneCaptureChunkMetadata> {
    const outputDir = safeSessionOutputDir(this.outputBaseDir, session.id);
    await mkdir(outputDir, { recursive: true });
    const filename = `webrtc-chunk-${String(input.sequence).padStart(6, '0')}.wav`;
    await rename(input.sourcePath, resolve(outputDir, filename));

    const chunk: MicrophoneCaptureChunkMetadata = {
      chunkId: `${session.id}:webrtc:${session.webrtcTranscriptionBridge?.revision ?? 0}:${input.sequence}`,
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

    let transcribed: TranscriptionEvent;
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
      transcribed = {
        ...transcribing,
        sourceText: result.sourceText,
        detectedLanguage: result.detectedLanguage,
        confidence: result.confidence,
        sourceLanguageRevision: session.sourceLanguageControl.revision,
        providerLatencyMs: result.providerLatencyMs ?? null,
        status: 'transcribed' as const,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, transcribed);
      this.updateTranscriptionProgress(session);
      this.onTranscriptionEvent(transcribed);
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
    return await this.processMicrophoneTranslationEvent(session, transcribed);
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
      const transcribed = {
        ...transcribing,
        sourceText: result.sourceText,
        detectedLanguage: result.detectedLanguage,
        confidence: result.confidence,
        sourceLanguageRevision: session.sourceLanguageControl.revision,
        providerLatencyMs: result.providerLatencyMs ?? null,
        status: 'transcribed' as const,
        createdAt: new Date().toISOString(),
      };
      this.replaceTranscriptionEvent(session, transcribed);
      this.updateTranscriptionProgress(session);
      this.updateWebRtcBridgeMetadata(session);
      this.onTranscriptionEvent(transcribed);
      this.emitSession(session);
      return await this.processMicrophoneTranslationEvent(session, transcribed);
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
    try {
      this.assertTextToSpeechLanguageSupported(session.targetLanguage);
      const queued = this.createGeneratedAudioEvent(session, segment, 'queued');
      session.generatedAudio.events = [...session.generatedAudio.events, queued].sort(
        (a, b) => a.sequence - b.sequence,
      );
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

      await this.ensureGeneratedAudioOutputDir(session.id);
      const result = await generateSpeechWithTimeout(
        this.textToSpeechProvider,
        {
          sessionId: session.id,
          streamId: session.streamId,
          segmentId: segment.segmentId,
          sequence: segment.sequence,
          targetLanguage: session.targetLanguage,
          translatedText: segment.translatedText,
          startMs: segment.startMs,
          endMs: segment.endMs,
          voiceId: this.textToSpeechVoiceId,
          outputPath: this.generatedAudioOutputPath(session.id, segment.sequence),
        },
        this.textToSpeechTimeoutMs,
      );
      const generated = {
        ...generating,
        status: 'generated' as const,
        durationMs: await readWavDurationMs(this.generatedAudioOutputPath(session.id, segment.sequence)),
        providerLatencyMs: result.providerLatencyMs ?? null,
        createdAt: new Date().toISOString(),
      };
      this.replaceGeneratedAudioEvent(session, generated);
      this.updateGeneratedAudioProgress(session);
      this.emitSession(session);
      this.emitGeneratedAudioReady(session, generated);
      return { ...session };
    } catch (error) {
      await rm(this.generatedAudioOutputPath(session.id, segment.sequence), { force: true });
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
        const transcribed = {
          ...transcribing,
          sourceText: result.sourceText,
          detectedLanguage: result.detectedLanguage,
          confidence: result.confidence,
          sourceLanguageRevision: session.sourceLanguageControl.revision,
          providerLatencyMs: result.providerLatencyMs ?? null,
          status: 'transcribed' as const,
          createdAt: new Date().toISOString(),
        };
        this.replaceTranscriptionEvent(session, transcribed);
        this.onTranscriptionEvent(transcribed);
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
      totalSegments: transcribedSegments.length,
      sourceLanguage: transcribedSegments[0]?.detectedLanguage ?? null,
      events: transcribedSegments.map((segment) =>
        this.createTranslationEvent(session, segment, '', 'queued', zeroTranslationLatency()),
      ),
    };
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
      .sort((a, b) => a.sequence - b.sequence);
    if (translatedSegments.length === 0) {
      throw new MediaIngestError(
        `Session ${sessionId} has no translated segments to generate.`,
        'invalid-transition',
        409,
        { ...session },
      );
    }

    if (!this.textToSpeechSupportedLanguages.includes(session.targetLanguage)) {
      session.generatedAudio = {
        ...emptyGeneratedAudio(
          'generated',
          session.targetLanguage,
          this.textToSpeechVoiceId,
          this.textToSpeechProvider.name,
        ),
        providerStatus: 'text-only',
        progressPct: 100,
        totalSegments: translatedSegments.length,
        generatedSegments: 0,
        targetLanguages: session.targetLanguages,
        textOnlyLanguages: [session.targetLanguage],
        events: [],
      };
      this.emitSession(session);
      if (session.state === 'processing') {
        return this.transition(session.id, 'completed');
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
      totalSegments: translatedSegments.length,
      events: translatedSegments.map((segment) => this.createGeneratedAudioEvent(session, segment, 'queued')),
    };
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

    const orderedEvents = requestedEvents.slice().sort((a, b) => a.sequence - b.sequence);
    for (const event of orderedEvents) {
      if (!(await this.waitUntilRunnable(session))) {
        return { ...session };
      }
      const translatedSegment = session.translation.events.find(
        (item) => item.segmentId === event.segmentId && item.status === 'translated',
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
        await this.ensureGeneratedAudioOutputDir(session.id);
        const result = await generateSpeechWithTimeout(
          this.textToSpeechProvider,
          {
            sessionId: session.id,
            streamId: session.streamId,
            segmentId: translatedSegment.segmentId,
            sequence: translatedSegment.sequence,
            targetLanguage: session.targetLanguage,
            translatedText: translatedSegment.translatedText,
            startMs: translatedSegment.startMs,
            endMs: translatedSegment.endMs,
            voiceId: this.textToSpeechVoiceId,
            outputPath: this.generatedAudioOutputPath(session.id, translatedSegment.sequence),
          },
          this.textToSpeechTimeoutMs,
        );
        const generated = {
          ...generating,
          audioFilename: generatedAudioFilename(translatedSegment.sequence),
          durationMs: await readWavDurationMs(
            this.generatedAudioOutputPath(session.id, translatedSegment.sequence),
          ),
          providerLatencyMs: result.providerLatencyMs ?? null,
          status: 'generated' as const,
          createdAt: new Date().toISOString(),
        };
        this.replaceGeneratedAudioEvent(session, generated);
        this.emitGeneratedAudioReady(session, generated);
      } catch (error) {
        await rm(this.generatedAudioOutputPath(session.id, translatedSegment.sequence), {
          force: true,
        });
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

    const failedCount = session.generatedAudio.events.filter((event) => event.status === 'failed').length;
    if (failedCount > 0) {
      session.error = `${failedCount} generated-audio segment${failedCount === 1 ? '' : 's'} failed.`;
      session.generatedAudio = {
        ...session.generatedAudio,
        status: 'failed',
        error: session.error,
      };
      this.transition(session.id, 'failed');
      return { ...session };
    }

    if (session.generatedAudio.events.every((event) => event.status === 'generated')) {
      session.error = null;
      const { error: _generatedAudioError, ...generatedAudioWithoutError } = session.generatedAudio;
      session.generatedAudio = {
        ...generatedAudioWithoutError,
        status: 'generated',
        progressPct: 100,
      };
      if (session.sourceKind === 'microphone') {
        this.emitSession(session);
        return { ...session };
      }
      this.transition(session.id, 'completed');
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

    const orderedEvents = requestedEvents.slice().sort((a, b) => a.sequence - b.sequence);
    for (const event of orderedEvents) {
      if (!(await this.waitUntilRunnable(session))) {
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
            targetLanguage: session.targetLanguage,
            sourceText: segment.sourceText,
            startMs: segment.startMs,
            endMs: segment.endMs,
          },
          this.translationTimeoutMs,
        );
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

    const failedCount = session.translation.events.filter(
      (event) => event.status === 'failed',
    ).length;
    if (failedCount > 0) {
      session.error = `${failedCount} translation segment${failedCount === 1 ? '' : 's'} failed.`;
      session.translation = {
        ...session.translation,
        status: 'failed',
        error: session.error,
      };
      this.transition(session.id, 'failed');
      return { ...session };
    }

    if (session.translation.events.every((event) => event.status === 'translated')) {
      session.error = null;
      const { error: _translationError, ...translationWithoutError } = session.translation;
      session.translation = {
        ...translationWithoutError,
        status: 'translated',
        progressPct: 100,
      };
      return await this.startGeneratedAudio(session.id);
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
  ): TimestampedTranslationEvent {
    const event: TimestampedTranslationEvent = {
      sessionId: session.id,
      streamId: session.streamId,
      segmentId: segment.chunkId,
      sequence: segment.sequence,
      sourceLanguage: session.sourceLanguageControl.activeLanguage,
      sourceLanguageRevision: segment.sourceLanguageRevision ?? session.sourceLanguageControl.revision,
      targetLanguage: session.targetLanguage,
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
    session.translation.events = session.translation.events
      .map((event) => (event.segmentId === next.segmentId ? next : event))
      .sort((a, b) => a.sequence - b.sequence);
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
      targetLanguage: session.targetLanguage,
      translatedText: segment.translatedText,
      startMs: segment.startMs,
      endMs: segment.endMs,
      voiceId: this.textToSpeechVoiceId,
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
    session.generatedAudio.events = session.generatedAudio.events
      .map((event) => (event.segmentId === next.segmentId ? next : event))
      .sort((a, b) => a.sequence - b.sequence);
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
      providerStatus: active ? 'generating' : failedSegments > 0 ? 'failed' : 'ready',
      totalSegments: events.length,
      generatedSegments,
      failedSegments,
      targetLanguage: session.targetLanguage,
      voiceId: this.textToSpeechVoiceId,
      progressPct: events.length === 0 ? 0 : Math.round((generatedSegments / events.length) * 100),
    };
  }

  private generatedAudioOutputPath(sessionId: string, sequence: number): string {
    return resolve(safeSessionOutputDir(this.outputBaseDir, sessionId), 'tts', generatedAudioFilename(sequence));
  }

  private async ensureGeneratedAudioOutputDir(sessionId: string): Promise<void> {
    await mkdir(resolve(safeSessionOutputDir(this.outputBaseDir, sessionId), 'tts'), {
      recursive: true,
    });
  }

  private emitGeneratedAudioReady(session: ProcessingSession, event: GeneratedAudioEvent): void {
    if (event.status !== 'generated' || event.durationMs === null) return;
    const key = generatedAudioReadyKey(session.id, event.segmentId);
    if (this.generatedAudioReadyKeys.has(key)) return;
    this.generatedAudioReadyKeys.add(key);
    this.onGeneratedAudioReady({
      ...event,
    }, {
      ...session,
    });
  }

  private assertTextToSpeechLanguageSupported(targetLanguage: string): void {
    if (!this.textToSpeechSupportedLanguages.includes(targetLanguage)) {
      throw new MediaIngestError(
        `Unsupported TTS language: ${targetLanguage}. Supported languages: ${this.textToSpeechSupportedLanguages.join(', ')}.`,
        'unsupported-tts-language',
        400,
      );
    }
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

function normalizeSupportedTargetLanguages(targetLanguages: readonly string[]): string[] {
  return [...new Set(targetLanguages.map(normalizeTargetLanguage).filter(Boolean))];
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
      if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16) {
        throw new Error('Generated WAV must be mono 16 kHz PCM 16-bit.');
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

function generatedAudioReadyKey(sessionId: string, segmentId: string): string {
  return `${sessionId}:${segmentId}`;
}

function formatTranscriptTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
