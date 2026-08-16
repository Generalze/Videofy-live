import express from 'express';
import http from 'http';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { registerGeneratedAudioDeliveryRoute } from './generated-audio-delivery-route.js';
import { createUnavailablePersonalVoiceProvider } from './personal-voice-provider.js';
import { registerVoiceEnrollmentRoute } from './voice-enrollment-route.js';
import { registerVoiceProfileInitRoute } from './voice-profile-init-route.js';
import { createFileVoiceEnrollmentStorage } from './voice-enrollment-storage.js';
import { VoiceProfileStore } from './voice-profile-store.js';
import { registerSourceMediaDeliveryRoute } from './source-media-delivery-route.js';
import { registerViewerReadyMediaDeliveryRoute } from './viewer-ready-media-delivery-route.js';
import { IngestService } from './ingest-service.js';
import { logger, setLogLevel } from './logger.js';
import { MediaIngestError } from './ingest-error.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const app = express();
const server = http.createServer(app);
const uploadDir = resolve(process.cwd(), '../../uploads/media-ingest');
mkdirSync(uploadDir, { recursive: true });
mkdirSync(config.webrtcAudioChunkStagingDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.uploadMaxBytes },
});
const ingest = new IngestService(config);

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  // The voice-owner header is a custom one, so it must be listed explicitly or
  // the browser preflight rejects the request before it is ever sent.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Range,X-Videofy-Voice-Owner,X-Videofy-Enrolled-Language',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/health', (_req, res) => {
  // "degraded", not "ok", when the gateway socket is down: the process is alive
  // and will happily accept and transcribe chunks, but nothing it produces can
  // reach a participant. Reporting ok in that state hides the failure behind
  // the one signal an operator checks first, and the symptom — captions simply
  // stop — gives no hint of the cause.
  const connected = ingest.connectedToGateway;
  // Unavailable pairs do not make the service unhealthy — every other pair
  // still works — but they are listed, because the alternative is a listener
  // discovering it by hearing nothing.
  const unavailablePairs = ingest.translationPairAvailability
    .filter((pair) => !pair.available)
    .map((pair) => ({ pair: pair.pair, reason: pair.reason }));
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'degraded',
    service: 'media-ingest',
    gatewayConnected: connected,
    ...(unavailablePairs.length > 0 ? { unavailableTranslationPairs: unavailablePairs } : {}),
    timestamp: new Date().toISOString(),
  });
});

app.post('/microphone/sessions', async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      deviceId?: unknown;
      deviceLabel?: unknown;
      targetLanguage?: unknown;
      targetLanguages?: unknown;
      sourceLanguage?: unknown;
      sourceLanguageMode?: unknown;
    };
    const input: Parameters<typeof ingest.createMicrophoneSession>[0] = {};
    if (typeof body.deviceId === 'string') input.deviceId = body.deviceId;
    if (typeof body.deviceLabel === 'string') input.deviceLabel = body.deviceLabel;
    if (typeof body.targetLanguage === 'string') input.targetLanguage = body.targetLanguage;
    if (Array.isArray(body.targetLanguages)) {
      input.targetLanguages = body.targetLanguages.filter((value): value is string => typeof value === 'string');
    }
    if (typeof body.sourceLanguage === 'string') input.sourceLanguage = body.sourceLanguage;
    if (body.sourceLanguageMode === 'manual' || body.sourceLanguageMode === 'auto-detect') {
      input.sourceLanguageMode = body.sourceLanguageMode;
    }
    const session = await ingest.createMicrophoneSession(input);
    res.status(201).json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/microphone/sessions/:sessionId/chunks', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Upload a microphone chunk using the "audio" form field.' });
    return;
  }

  try {
    const sequence = parseIntegerField(req.body?.sequence, 'sequence');
    const startMs = parseIntegerField(req.body?.startMs, 'startMs');
    const endMs = parseIntegerField(req.body?.endMs, 'endMs');
    const sessionId = requireRouteParam(req.params.sessionId, 'sessionId');
    const session = await ingest.ingestMicrophoneChunk(sessionId, {
      sequence,
      startMs,
      endMs,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      sourcePath: req.file.path,
    });
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/microphone/sessions/:sessionId/stop', (req, res) => {
  try {
    const session = ingest.stopMicrophoneSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/internal/webrtc/sessions', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      broadcastId?: unknown;
      broadcasterPeerId?: unknown;
      revision?: unknown;
      targetLanguage?: unknown;
      targetLanguages?: unknown;
      sourceLanguage?: unknown;
      sourceLanguageMode?: unknown;
      voiceIdsByLanguage?: unknown;
      generatedAudioPacing?: unknown;
    };
    const session = await ingest.createWebRtcSession({
      sessionId: requireStringField(body.sessionId, 'sessionId'),
      broadcastId: requireStringField(body.broadcastId, 'broadcastId'),
      broadcasterPeerId: requireStringField(body.broadcasterPeerId, 'broadcasterPeerId'),
      revision: parseIntegerField(body.revision, 'revision'),
      ...(typeof body.targetLanguage === 'string' ? { targetLanguage: body.targetLanguage } : {}),
      ...(Array.isArray(body.targetLanguages)
        ? { targetLanguages: body.targetLanguages.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(typeof body.sourceLanguage === 'string' ? { sourceLanguage: body.sourceLanguage } : {}),
      ...(body.sourceLanguageMode === 'manual' || body.sourceLanguageMode === 'auto-detect'
        ? { sourceLanguageMode: body.sourceLanguageMode }
        : {}),
      ...(voiceIdRecordOrNull(body.voiceIdsByLanguage)
        ? { voiceIdsByLanguage: voiceIdRecordOrNull(body.voiceIdsByLanguage)! }
        : {}),
      ...(body.generatedAudioPacing === 'natural' || body.generatedAudioPacing === 'fit-window'
        ? { generatedAudioPacing: body.generatedAudioPacing }
        : {}),
    });
    res.status(201).json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.delete('/internal/webrtc/sessions/:sessionId', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const sessionId = requireRouteParam(req.params.sessionId, 'sessionId');
    const removed = await ingest.removeCallSession(sessionId);
    res.status(removed ? 200 : 404).json({ removed });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/internal/webrtc/sessions/:sessionId/chunks', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = requireRouteParam(req.params.sessionId, 'sessionId');
    const partial = parseOptionalBooleanField(body.partial, 'partial');
    const session = await ingest.ingestWebRtcChunk(sessionId, {
      sequence: parseIntegerField(body.sequence, 'sequence'),
      startMs: parseIntegerField(body.startMs, 'startMs'),
      endMs: parseIntegerField(body.endMs, 'endMs'),
      sampleRate: parseLiteralInteger(body.sampleRate, 16000, 'sampleRate'),
      channelCount: parseLiteralInteger(body.channelCount, 1, 'channelCount'),
      pcmFormat: parseLiteralString(body.pcmFormat, 'pcm_s16le', 'pcmFormat'),
      discontinuity: body.discontinuity === true,
      endOfStream: body.endOfStream === true,
      mimeType: parseLiteralString(body.mimeType, 'audio/wav', 'mimeType'),
      sizeBytes: parseIntegerField(body.sizeBytes, 'sizeBytes'),
      sourcePath: requireStringField(body.sourcePath, 'sourcePath'),
      // P6 streaming captions: an interim slice of an utterance still being
      // spoken. Optional, so an older gateway keeps sending finals only.
      ...(partial === undefined ? {} : { partial }),
      ...(body.partialSequence === undefined || body.partialSequence === null
        ? {}
        : {
            partialSequence: parseNonNegativeIntegerField(body.partialSequence, 'partialSequence'),
          }),
    });
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/internal/webrtc/sessions/:sessionId/stop', (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const session = ingest.stopWebRtcSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/microphone/sessions/:sessionId/device-disconnected', (req, res) => {
  try {
    const session = ingest.failMicrophoneDeviceDisconnected(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions', upload.single('media'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Upload a media file using the "media" form field.' });
    return;
  }

  try {
    const targetLanguage =
      typeof req.body?.targetLanguage === 'string' ? req.body.targetLanguage : undefined;
    const targetLanguages = Array.isArray(req.body?.targetLanguages)
      ? req.body.targetLanguages.filter((value: unknown): value is string => typeof value === 'string')
      : typeof req.body?.targetLanguages === 'string'
        ? [req.body.targetLanguages]
        : undefined;
    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string' ? req.body.sourceLanguage : undefined;
    const sourceLanguageMode =
      req.body?.sourceLanguageMode === 'manual' || req.body?.sourceLanguageMode === 'auto-detect'
        ? req.body.sourceLanguageMode
        : undefined;
    const requestedSessionId =
      typeof req.body?.requestedSessionId === 'string' ? req.body.requestedSessionId : undefined;
    const upload = {
      path: req.file.path,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
      ...(requestedSessionId ? { requestedSessionId } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      ...(targetLanguages ? { targetLanguages } : {}),
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(sourceLanguageMode ? { sourceLanguageMode } : {}),
    };
    const session = await ingest.createProcessingSession(upload);
    res.status(201).json({ session });
  } catch (error) {
    if (error instanceof MediaIngestError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        session: error.session,
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Media ingest failed.';
    logger.error('Unexpected media upload failure', { message });
    res.status(500).json({ error: 'Media ingest failed.' });
  }
});

app.post('/sessions/:sessionId/audio/retry', async (req, res) => {
  try {
    const session = await ingest.retryAudioExtraction(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.delete('/sessions/:sessionId/audio', async (req, res) => {
  try {
    const session = await ingest.cleanupFailedAudio(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/pause', (req, res) => {
  try {
    const session = ingest.pauseSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/resume', (req, res) => {
  try {
    const session = ingest.resumeSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/cancel', (req, res) => {
  try {
    const session = ingest.cancelSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/transcription/chunks/:chunkId/retry', async (req, res) => {
  try {
    const session = await ingest.retryTranscriptionChunk(req.params.sessionId, req.params.chunkId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.get('/sessions/:sessionId/transcript', (req, res) => {
  try {
    const transcript = ingest.exportTranscript(req.params.sessionId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.params.sessionId}-transcript.txt"`,
    );
    res.send(transcript);
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/translation/segments/:segmentId/retry', async (req, res) => {
  try {
    const session = await ingest.retryTranslationSegment(
      req.params.sessionId,
      req.params.segmentId,
      typeof req.query['language'] === 'string' ? req.query['language'] : undefined,
    );
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.get('/sessions/:sessionId/translation/export', (req, res) => {
  try {
    const paired = ingest.exportPairedTranslation(req.params.sessionId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.params.sessionId}-translation.txt"`,
    );
    res.send(paired);
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/generated-audio/segments/:segmentId/retry', async (req, res) => {
  try {
    const session = await ingest.retryGeneratedAudioSegment(
      req.params.sessionId,
      req.params.segmentId,
      typeof req.query['language'] === 'string' ? req.query['language'] : undefined,
    );
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/source-language', (req, res) => {
  try {
    const body = (req.body ?? {}) as { action?: unknown; language?: unknown };
    const action = requireStringField(body.action, 'action') as Parameters<
      typeof ingest.updateSourceLanguageControl
    >[1]['action'];
    const session = ingest.updateSourceLanguageControl(req.params.sessionId, {
      action,
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
    });
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

// Personal voice (P6.3). Enrollment material lives beside the uploads, in a
// git-ignored directory, and never in the repository or the logs.
const personalVoiceServiceUrl = process.env['OPENVOICE_SERVICE_URL'] ?? 'http://127.0.0.1:3005';
const voiceProfileStore = new VoiceProfileStore(
  createFileVoiceEnrollmentStorage({
    directory: resolve(process.cwd(), '../../voice-enrollment'),
    // The derived representation lives in the voice engine's own store, so
    // deletion is delegated there. Pointing this at the enrollment directory
    // made asset removal silently impossible.
    deleteVoiceAsset: async (voiceAssetRef) => {
      try {
        const response = await fetch(
          `${personalVoiceServiceUrl}/voice-assets/${encodeURIComponent(voiceAssetRef)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) return false;
        const body = (await response.json()) as { removed?: boolean };
        return body.removed === true;
      } catch {
        // Unreachable engine means the asset survives; reporting false keeps it
        // in pendingCleanups() for retry rather than orphaning it.
        return false;
      }
    },
  }),
);
let voiceProfileSerial = 0;
registerVoiceProfileInitRoute(app, {
  store: voiceProfileStore,
  newVoiceProfileId: () => `vp_${Date.now().toString(36)}_${++voiceProfileSerial}`,
});
registerVoiceEnrollmentRoute(app, {
  store: voiceProfileStore,
  // Until a cloning engine is validated this refuses every creation, so a
  // profile never reaches `ready` and calls keep using the standard voice.
  provider: createUnavailablePersonalVoiceProvider(),
  newVoiceProfileId: () => `vp_${Date.now().toString(36)}_${++voiceProfileSerial}`,
});

registerGeneratedAudioDeliveryRoute(app, ingest);
registerSourceMediaDeliveryRoute(app, ingest);
registerViewerReadyMediaDeliveryRoute(app, ingest);

server.listen(config.port, () => {
  logger.info('Media ingest endpoint started', { port: config.port, uploadDir });
});

ingest.start().catch((err: Error) => {
  logger.error('Failed to start ingest service', { message: err.message });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down media ingest', { signal });
  await ingest.stop();
  server.close();
  logger.info('Media ingest shut down cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

function sendIngestError(res: express.Response, error: unknown): void {
  if (error instanceof MediaIngestError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      session: error.session,
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Media ingest failed.';
  logger.error('Unexpected media ingest failure', { message });
  res.status(500).json({ error: 'Media ingest failed.' });
}

function parseIntegerField(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) {
    throw new MediaIngestError(`${fieldName} must be an integer.`, 'invalid-media', 400);
  }
  return parsed;
}

function parseNonNegativeIntegerField(value: unknown, fieldName: string): number {
  const parsed = parseIntegerField(value, fieldName);
  if (parsed < 0) {
    throw new MediaIngestError(
      `${fieldName} must be a non-negative integer.`,
      'invalid-media',
      400,
    );
  }
  return parsed;
}

/** Undefined when the field is absent; a hard 400 when it is present but not a boolean. */
function parseOptionalBooleanField(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new MediaIngestError(`${fieldName} must be a boolean.`, 'invalid-media', 400);
}

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MediaIngestError(`${fieldName} is required.`, 'invalid-media', 400);
  }
  return value;
}

/** Shapes an optional language->voiceId record; deep safety checks stay in the session store. */
function voiceIdRecordOrNull(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function parseLiteralInteger<T extends number>(value: unknown, expected: T, fieldName: string): T {
  const parsed = parseIntegerField(value, fieldName);
  if (parsed !== expected) {
    throw new MediaIngestError(`${fieldName} must be ${expected}.`, 'invalid-media', 400);
  }
  return expected;
}

function parseLiteralString<T extends string>(value: unknown, expected: T, fieldName: string): T {
  if (value !== expected) {
    throw new MediaIngestError(`${fieldName} must be ${expected}.`, 'invalid-media', 400);
  }
  return expected;
}

function requireRouteParam(value: string | undefined, fieldName: string): string {
  if (!value) {
    throw new MediaIngestError(`${fieldName} is required.`, 'invalid-transition', 400);
  }
  return value;
}

function assertInternalWebRtcRequest(req: express.Request, res: express.Response): boolean {
  if (!config.internalWebRtcToken) return true;
  if (req.header('X-Videofy-Internal-Token') === config.internalWebRtcToken) return true;
  res.status(403).json({ error: 'Forbidden internal WebRTC request.' });
  return false;
}
