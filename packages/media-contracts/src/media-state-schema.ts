import { z } from 'zod';

export const StreamStatusSchema = z.enum([
  'created',
  'validating',
  'ready',
  'processing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const VideoSourceSchema = z.enum([
  'mock',
  'local-file',
  'microphone',
  'webcam',
  'zoom',
  'teams',
  'meet',
  'obs',
  'rtmp',
  'webrtc',
  'hls',
]);

export const SessionMonitoringSchema = z.object({
  currentStage: z.enum([
    'created',
    'validating',
    'microphone-capture',
    'audio-extraction',
    'transcription',
    'translation',
    'text-to-speech',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ]),
  overallProgressPct: z.number().min(0).max(100),
  failedSegmentCount: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  latestLatencyMs: z.number().nonnegative().nullable(),
  lastError: z.string().min(1).nullable(),
  events: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['operator-action', 'recovery-event']),
      action: z.enum([
        'pause',
        'resume',
        'cancel',
        'retry-transcription',
        'retry-translation',
        'retry-tts',
        'set-source-language',
      ]),
      status: z.enum(['accepted', 'rejected', 'succeeded', 'failed']),
      message: z.string().min(1),
      segmentId: z.string().min(1).optional(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export const MediaStateEventSchema = z.object({
  eventId: z.string().min(1),
  streamId: z.string().min(1).optional(),
  processingSessionId: z.string().min(1).optional(),
  shareableWebRtcSessionId: z.string().min(3).optional(),
  streamStatus: StreamStatusSchema,
  videoSource: VideoSourceSchema,
  media: z
    .object({
      filename: z.string().min(1),
      fileSizeBytes: z.number().int().positive(),
      mimeType: z.string().min(1),
      durationMs: z.number().positive(),
      hasAudio: z.boolean(),
      hasVideo: z.boolean(),
      codecs: z.array(
        z.object({
          type: z.enum(['audio', 'video']),
          codecName: z.string().min(1),
          codecLongName: z.string().min(1).optional(),
          profile: z.string().min(1).optional(),
        }),
      ),
    })
    .optional(),
  audioExtraction: z
    .object({
      status: z.enum([
        'pending',
        'extracting',
        'chunking',
        'validating',
        'completed',
        'failed',
        'cleaned',
      ]),
      progressPct: z.number().min(0).max(100),
      chunkCount: z.number().int().nonnegative(),
      chunkDurationMs: z.number().int().positive(),
      outputFormat: z.object({
        container: z.literal('wav'),
        codec: z.literal('pcm_s16le'),
        sampleRateHz: z.literal(16000),
        channels: z.literal(1),
      }),
      chunks: z.array(
        z.object({
          chunkId: z.string().min(1),
          index: z.number().int().nonnegative(),
          filename: z.string().min(1),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          durationMs: z.number().int().positive(),
          status: z.enum(['ready', 'failed']),
        }),
      ),
      startedAt: z.string().datetime().optional(),
      completedAt: z.string().datetime().optional(),
      error: z.string().min(1).optional(),
    })
    .optional(),
  microphoneCapture: z
    .object({
      status: z.enum(['idle', 'capturing', 'paused', 'stopped', 'failed', 'cancelled']),
      deviceId: z.string().min(1).nullable(),
      deviceLabel: z.string().min(1).nullable(),
      durationMs: z.number().int().nonnegative(),
      chunkCount: z.number().int().nonnegative(),
      chunks: z.array(
        z.object({
          chunkId: z.string().min(1),
          index: z.number().int().nonnegative(),
          filename: z.string().min(1),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          durationMs: z.number().int().positive(),
          status: z.enum(['ready', 'failed']),
          receivedAt: z.string().datetime(),
          mimeType: z.string().min(1),
          sizeBytes: z.number().int().positive(),
        }),
      ),
      startedAt: z.string().datetime().optional(),
      stoppedAt: z.string().datetime().optional(),
      error: z.string().min(1).optional(),
    })
    .optional(),
  webrtcTranscriptionBridge: z
    .object({
      status: z.enum(['idle', 'ready', 'chunking', 'processing', 'stopped', 'failed']),
      broadcastId: z.string().min(1),
      webRtcSessionId: z.string().min(1),
      broadcasterPeerId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      chunkCount: z.number().int().nonnegative(),
      processingChunks: z.number().int().nonnegative(),
      transcribedChunks: z.number().int().nonnegative(),
      failedChunks: z.number().int().nonnegative(),
      latestTranscript: z.string().nullable(),
      lastError: z.string().nullable(),
      startedAt: z.string().datetime().optional(),
      stoppedAt: z.string().datetime().optional(),
    })
    .optional(),
  transcription: z
    .object({
      status: z.enum(['queued', 'transcribing', 'transcribed', 'failed', 'retrying']),
      progressPct: z.number().min(0).max(100),
      totalChunks: z.number().int().nonnegative(),
      transcribedChunks: z.number().int().nonnegative(),
      failedChunks: z.number().int().nonnegative(),
      detectedLanguage: z.string().min(2).max(16).nullable(),
      sourceLanguage: z.string().min(2).max(16).nullable().optional(),
      sourceLanguageRevision: z.number().int().nonnegative().optional(),
      languageDetectionConfidence: z.number().min(0).max(1).nullable().optional(),
      events: z.array(
        z.object({
          sessionId: z.string().min(1),
          streamId: z.string().min(1),
          chunkId: z.string().min(1),
          sequence: z.number().int().nonnegative(),
          sourceText: z.string(),
          detectedLanguage: z.string().min(2).max(16),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          confidence: z.number().min(0).max(1).nullable(),
          sourceLanguageRevision: z.number().int().nonnegative().optional(),
          providerLatencyMs: z.number().int().nonnegative().nullable().optional(),
          status: z.enum(['queued', 'transcribing', 'transcribed', 'failed', 'retrying']),
          error: z.string().min(1).optional(),
          createdAt: z.string().datetime(),
        }),
      ),
      error: z.string().min(1).optional(),
    })
    .optional(),
  translation: z
    .object({
      status: z.enum(['queued', 'translating', 'translated', 'failed', 'retrying']),
      providerName: z.string().min(1).optional(),
      providerStatus: z.enum(['idle', 'ready', 'translating', 'failed']).optional(),
      progressPct: z.number().min(0).max(100),
      totalSegments: z.number().int().nonnegative(),
      translatedSegments: z.number().int().nonnegative(),
      failedSegments: z.number().int().nonnegative(),
      sourceLanguage: z.string().min(2).max(16).nullable(),
      sourceLanguageRevision: z.number().int().nonnegative().optional(),
      targetLanguage: z.string().min(2).max(16),
      targetLanguages: z.array(z.string().min(2).max(16)).optional(),
      events: z.array(
        z.object({
          sessionId: z.string().min(1),
          streamId: z.string().min(1),
          segmentId: z.string().min(1),
          sequence: z.number().int().nonnegative(),
          sourceLanguage: z.string().min(2).max(16),
          sourceLanguageRevision: z.number().int().nonnegative().optional(),
          targetLanguage: z.string().min(2).max(16),
          sourceText: z.string(),
          translatedText: z.string(),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          status: z.enum(['queued', 'translating', 'translated', 'failed', 'retrying']),
          latency: z.object({
            queuedMs: z.number().nonnegative(),
            providerMs: z.number().nonnegative(),
            totalMs: z.number().nonnegative(),
          }),
          error: z.string().min(1).optional(),
          createdAt: z.string().datetime(),
        }),
      ),
      error: z.string().min(1).optional(),
    })
    .optional(),
  generatedAudio: z
    .object({
      status: z.enum(['queued', 'generating', 'generated', 'failed', 'retrying']),
      providerName: z.string().min(1).optional(),
      providerStatus: z.enum(['idle', 'ready', 'generating', 'failed', 'text-only']).optional(),
      progressPct: z.number().min(0).max(100),
      totalSegments: z.number().int().nonnegative(),
      generatedSegments: z.number().int().nonnegative(),
      failedSegments: z.number().int().nonnegative(),
      targetLanguage: z.string().min(2).max(16),
      targetLanguages: z.array(z.string().min(2).max(16)).optional(),
      voiceId: z.string().min(1),
      textOnlyLanguages: z.array(z.string().min(2).max(16)).optional(),
      outputFormat: z.object({
        container: z.literal('wav'),
        codec: z.literal('pcm_s16le'),
      }),
      events: z.array(
        z.object({
          sessionId: z.string().min(1),
          streamId: z.string().min(1),
          segmentId: z.string().min(1),
          sequence: z.number().int().nonnegative(),
          targetLanguage: z.string().min(2).max(16),
          translatedText: z.string(),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          voiceId: z.string().min(1),
          audioFilename: z.string().min(1),
          durationMs: z.number().int().nonnegative().nullable(),
          providerLatencyMs: z.number().int().nonnegative().nullable(),
          status: z.enum(['queued', 'generating', 'generated', 'failed', 'retrying']),
          error: z.string().min(1).optional(),
          createdAt: z.string().datetime(),
        }),
      ),
      error: z.string().min(1).optional(),
    })
    .optional(),
  monitoring: SessionMonitoringSchema.optional(),
  sourceLanguageControl: z
    .object({
      defaultLanguage: z.string().min(2).max(16),
      activeLanguage: z.string().min(2).max(16),
      mode: z.enum(['manual', 'auto-detect']),
      status: z.enum([
        'manual',
        'detecting',
        'detected',
        'needs-confirmation',
        'confirmed',
        'rejected',
        'locked',
      ]),
      detectedLanguage: z.string().min(2).max(16).nullable(),
      detectionConfidence: z.number().min(0).max(1).nullable(),
      confirmedLanguage: z.string().min(2).max(16).nullable(),
      rejectedLanguage: z.string().min(2).max(16).nullable(),
      locked: z.boolean(),
      revision: z.number().int().nonnegative(),
      confidenceThreshold: z.number().min(0).max(1),
      updatedAt: z.string().datetime(),
    })
    .optional(),
  targetLanguageCatalogue: z
    .array(
      z.object({
        language: z.string().min(2).max(16),
        label: z.string().min(1),
        translationAvailable: z.boolean(),
        voiceAvailable: z.boolean(),
        textOnly: z.boolean(),
        experimental: z.boolean(),
        availability: z.enum([
          'translation-available',
          'voice-available',
          'text-only',
          'unavailable',
          'experimental',
        ]),
        translationModel: z.string().min(1).nullable(),
        voiceId: z.string().min(1).nullable(),
        license: z.string().min(1),
        commercialUse: z.enum(['allowed', 'unknown', 'restricted']),
      }),
    )
    .optional(),
  aiProviderStatus: z
    .object({
      worker: z.enum(['offline', 'ready', 'processing', 'delayed', 'failed']),
      vad: z.enum(['inactive', 'active', 'fallback', 'failed']),
      transcription: z.enum(['idle', 'loading', 'ready', 'processing', 'failed']),
      translation: z.enum(['idle', 'loading', 'ready', 'processing', 'failed']),
      textToSpeech: z.enum(['idle', 'loading', 'ready', 'text-only', 'processing', 'failed']),
      lastError: z.string().min(1).nullable(),
    })
    .optional(),
  videoTimestampMs: z.number().nonnegative(),
  sourceAudioActive: z.boolean(),
  translatedLanguages: z.array(z.string().min(2).max(10)),
  connectedListeners: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type ValidatedMediaStateEvent = z.infer<typeof MediaStateEventSchema>;

export function parseMediaStateEvent(raw: unknown): ValidatedMediaStateEvent {
  return MediaStateEventSchema.parse(raw);
}

export function safeParseMediaStateEvent(raw: unknown) {
  return MediaStateEventSchema.safeParse(raw);
}
