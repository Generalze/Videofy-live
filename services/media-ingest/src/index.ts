// FIRST import: loads .env before any module below reads process.env.
import '@videofy-live/service-env/auto';
import express from 'express';
import http from 'http';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { internalIngressRequestAllowed } from '@videofy-live/service-env';
import { loadConfig } from './config.js';
import { registerGeneratedAudioDeliveryRoute } from './generated-audio-delivery-route.js';
import { createUnavailablePersonalVoiceProvider } from './personal-voice-provider.js';
import {
  createOpenVoicePersonalVoiceProvider,
  personalVoiceId,
} from './openvoice-personal-voice.js';
import { createPersonalVoiceWiring } from './personal-voice-wiring.js';
import { registerVoiceWithdrawalRoutes } from './voice-withdrawal-route.js';
import { registerVoiceEnrollmentRoute } from './voice-enrollment-route.js';
import { registerVoiceProfileInitRoute } from './voice-profile-init-route.js';
import { createFileVoiceEnrollmentStorage } from './voice-enrollment-storage.js';
import { createFileVoiceProfileRecords } from './voice-profile-records.js';
import {
  createRefusingAuthentication,
  createTokenAuthentication,
} from './account-authentication.js';
import { reconcileVoiceMaterial } from './voice-material-reconciliation.js';
import { VoiceProfileStore } from './voice-profile-store.js';
import { registerSourceMediaDeliveryRoute } from './source-media-delivery-route.js';
import { registerViewerReadyMediaDeliveryRoute } from './viewer-ready-media-delivery-route.js';
import { IngestService, buildTextToSpeechVoiceIdsByLanguage } from './ingest-service.js';
import { createTranscriptionProvider } from './transcription-provider.js';
import { registerVoiceNoteTranslationRoute } from './voice-note-translation-route.js';
import { logger, setLogLevel } from './logger.js';
import { MediaIngestError } from './ingest-error.js';
import {
  OPERATOR_CONSOLE_ACCOUNT_IDS_VARIABLE,
  createProgrammeControlGuard,
  operatorEntitlementFromAllowlist,
} from './programme-control-auth.js';
import { setOpusMtDiagnosticLogger } from './translation-provider.js';
import { attachRealtimeAudioIngress, REALTIME_INGRESS_PATH } from './realtime-ingress-server.js';
import { createLiveStreamOpener } from './live-session-host.js';
import {
  SileroSpeechDetector,
  type SpeechProbabilityDetector,
} from '@videofy-live/speech-activity';
import {
  buildStreamingSynthesisProvider,
  buildStreamingTranscriptionProvider,
  describeLiveEngine,
} from './live-provider-wiring.js';

const config = loadConfig();
setLogLevel(config.logLevel);
// The OPUS-MT error classifier collapses every worker failure onto a handful
// of stable messages. Keep the raw text reachable, or a real fault is only
// ever visible as somebody's guess about what it meant.
setOpusMtDiagnosticLogger((line, detail) => logger.debug(line, detail));

const app = express();
const server = http.createServer(app);
// Configurable, like every other storage path this service uses.
//
// The old value was resolved from the process working directory, which put
// uploads INSIDE the deployed code tree. A hardened unit refuses to make the
// code directory writable -- correctly, since a process that can rewrite its
// own source is one bug away from persisting an attacker -- so the service
// could not start at all until the path could be moved out.
const uploadDir = process.env['MEDIA_INGEST_UPLOAD_DIR']
  ? resolve(process.env['MEDIA_INGEST_UPLOAD_DIR'])
  : resolve(process.cwd(), '../../uploads/media-ingest');
mkdirSync(uploadDir, { recursive: true });
mkdirSync(config.webrtcAudioChunkStagingDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.uploadMaxBytes },
});
// Personal voice (P6.3). Enrollment material lives beside the uploads, in a
// git-ignored directory, and never in the repository or the logs.
const personalVoiceServiceUrl = process.env['OPENVOICE_SERVICE_URL'] ?? 'http://127.0.0.1:3005';
const voiceEnrollmentStorage = createFileVoiceEnrollmentStorage({
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
        if (response.status === 404) return 'not-found';
        // A 5xx means the engine still holds it.
        if (!response.ok) return 'failed';
        const body = (await response.json()) as { removed?: boolean };
        return body.removed === true ? 'removed' : 'not-found';
      } catch {
        // Unreachable engine: the asset survives, so this must read as failure
        // and stay in pendingCleanups(). Reporting absence here would discard
        // the only pointer able to finish the job.
        return 'failed';
      }
    },
});
// Records live beside the material they describe, in the same ignored
// directory. Without this the store was a Map, and every deletion guarantee
// held only until the process restarted — at which point the records vanished
// and the recordings they described did not.
const voiceProfileStore = new VoiceProfileStore(
  voiceEnrollmentStorage,
  undefined,
  createFileVoiceProfileRecords(resolve(process.cwd(), '../../voice-enrollment/profiles.json')),
);
/**
 * The real engine when one is configured, and the honest refusal otherwise.
 *
 * OPENVOICE_SERVICE_URL being unset is a deliberate, supported state: every
 * creation fails, no profile reaches `ready`, and calls use the standard voice.
 */
const openVoicePersonal =
  process.env['OPENVOICE_SERVICE_URL'] === undefined
    ? null
    : createOpenVoicePersonalVoiceProvider({
        serviceUrl: personalVoiceServiceUrl,
        // Bytes, never a path: the provider must not learn storage layout.
        readEnrollment: (recordingRef) =>
          voiceEnrollmentStorage.readEnrollmentRecording(recordingRef),
      });

const personalVoiceProvider = openVoicePersonal ?? createUnavailablePersonalVoiceProvider();

/**
 * Personal voice reaches synthesis through `createPersonalVoiceWiring`, which
 * the acceptance tests import too — so the composition running here is the one
 * under test rather than a lookalike written twice.
 *
 * With no engine configured the service receives no personal-voice
 * dependencies at all and behaves exactly as it did before P6.3.
 */
const ingest = new IngestService(
  config,
  openVoicePersonal === null
    ? {}
    : createPersonalVoiceWiring({
        voiceProfileStore,
        engine: openVoicePersonal,
        defaultVoiceId: config.textToSpeechDefaultVoiceId,
        writeAudio: async (outputPath, audio) => {
          await writeFile(outputPath, audio);
        },
        onFallback: (reason) => {
          // The reason, never the asset or owner: this line reaches logs.
          logger.warn('Personal voice unavailable; using standard voice', { reason });
        },
      }),
);


/*
 * Translated voice notes (P7 messaging). Mounted BEFORE the global parser
 * because a two-minute voice note is larger than 1mb; the route carries its
 * own scoped limit. The recogniser is a second batch instance of the SAME
 * configured provider -- the upload path's lives inside IngestService and
 * exposing it is a larger change than this one; faster-whisper loads its
 * worker lazily, so nothing is paid until the first note arrives. The
 * translator IS the live instance, and the synthesiser is resolved per
 * request because the live one is built further down this file.
 */
const voiceNoteVoiceIds = buildTextToSpeechVoiceIdsByLanguage(config);
registerVoiceNoteTranslationRoute(app, {
  auth: config.internalIngressAuth,
  transcription: createTranscriptionProvider({
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
  translation: ingest.liveTranslation,
  synthesis: () => streamingSynthesis,
  voiceIdFor: (targetLanguage) =>
    voiceNoteVoiceIds.get(targetLanguage) ?? config.textToSpeechDefaultVoiceId,
  stagingDir: resolve(config.webrtcAudioChunkStagingDir, 'voice-notes'),
  transcriptionTimeoutMs: config.transcriptionTimeoutMs,
  translationTimeoutMs: config.translationTimeoutMs,
  synthesisTimeoutMs: config.textToSpeechTimeoutMs,
});

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // The voice-owner header is a custom one, so it must be listed explicitly or
  // the browser preflight rejects the request before it is ever sent.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Range,Authorization,X-Videofy-Enrolled-Language',
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
  // Withdrawn voices whose stored material refused to go. A count, never an
  // id: this endpoint is public. Zero is the healthy state, and anything else
  // is somebody's biometric data still on disk after they asked for it to go —
  // which is worth seeing without having to know to look.
  const strandedVoiceCleanups = voiceProfileStore.pendingCleanups().length;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'degraded',
    service: 'media-ingest',
    gatewayConnected: connected,
    /**
     * Whether this deployment can translate speech at all.
     *
     * Reported unconditionally, including when it is fine. An operator asking
     * "why is there no translated audio" should get the answer here rather
     * than by reading five environment variables on a box they may not have.
     */
    translationEngine: {
      real: liveEngine.real,
      transcription: liveEngine.transcription,
      synthesis: liveEngine.synthesis,
      translation: liveEngine.translation,
      ...(liveEngine.stubbed.length > 0 ? { stubbed: liveEngine.stubbed } : {}),
    },
    ...(unavailablePairs.length > 0 ? { unavailableTranslationPairs: unavailablePairs } : {}),
    ...(strandedVoiceCleanups > 0 ? { strandedVoiceCleanups } : {}),
    timestamp: new Date().toISOString(),
  });
});

/*
 * The deployment's target-language catalogue, readable before a programme
 * exists. Public and side-effect free: it lists which languages THIS
 * deployment's chain can translate into and with what capability state, and
 * nothing an operator could not learn from the next media state anyway.
 */
app.get('/languages/catalogue', (_req, res) => {
  res.json({
    service: 'media-ingest',
    catalogue: ingest.targetLanguageCatalogue,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Who is calling, from a verified session token.
 *
 * With no secret configured this refuses everybody rather than falling back to
 * trusting a header. Failing closed costs the voice feature; failing open costs
 * somebody their voice, because an unverified owner id is just a string the
 * client chose.
 */
const authenticate = (() => {
  const configured = process.env['VIDEOFY_AUTH_SECRET'];
  if (!configured) {
    logger.warn(
      'VIDEOFY_AUTH_SECRET is not set; personal voice and programme control endpoints will refuse every request',
    );
    return createRefusingAuthentication();
  }
  return createTokenAuthentication(
    requireSessionSecret(configured, 'VIDEOFY_AUTH_SECRET'),
  );
})();

/**
 * PROGRAMME CONTROL IS OPERATED, NOT OPEN.
 *
 * Every route below that creates, feeds, steers or reads a programme runs
 * behind this guard: the SAME verified session the gateway's operator socket
 * requires, and the SAME OPERATOR_CONSOLE_ACCOUNT_IDS allowlist it applies.
 * Unset means nobody -- the deployment that forgets the variable notices in
 * minutes; one that silently opens to everybody notices in a headline. The
 * gateway's internal token is honoured too, so a server-side probe can drive
 * a programme; it already holds a credential that creates sessions.
 *
 * GET /languages/catalogue stays public: it is the deployment's capability
 * list, and nothing an anonymous caller could act on. The three delivery
 * routes (/source-media, /viewer-media, generated audio) are the AUDIENCE's
 * and are not operator routes; they keep their own rules.
 */
const operatorEntitlement = operatorEntitlementFromAllowlist(
  process.env[OPERATOR_CONSOLE_ACCOUNT_IDS_VARIABLE],
);
const operatorOnly = createProgrammeControlGuard({
  authenticate,
  entitlement: operatorEntitlement,
  internalTokenAllowed: (presented) =>
    internalIngressRequestAllowed(config.internalIngressAuth, presented),
});

app.post('/microphone/sessions', operatorOnly, async (req, res) => {
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

app.post('/microphone/sessions/:sessionId/chunks', operatorOnly, upload.single('audio'), async (req, res) => {
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

app.post('/microphone/sessions/:sessionId/stop', operatorOnly, (req, res) => {
  try {
    const session = ingest.stopMicrophoneSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

/**
 * Plain text, translated -- the messaging path's seam into the translation
 * engine (founder's ruling 2026-08-27: translated conversations).
 *
 * The SAME provider instance the live path speaks through, reached over the
 * SAME internal token the other /internal routes require. The session-shaped
 * tracking fields the provider interface carries are meaningless for a chat
 * message and are filled with a fixed marker rather than invented per call:
 * they exist for stream diagnostics this path does not produce.
 */
app.post('/internal/text-translation', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  const body = (req.body ?? {}) as {
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    sourceText?: unknown;
  };
  const sourceLanguage = typeof body.sourceLanguage === 'string' ? body.sourceLanguage : '';
  const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage : '';
  const sourceText = typeof body.sourceText === 'string' ? body.sourceText : '';
  if (!sourceLanguage || !targetLanguage || !sourceText || sourceText.length > 8000) {
    res.status(400).json({ error: 'sourceLanguage, targetLanguage and sourceText are required.' });
    return;
  }
  try {
    /*
     * ONE SENTENCE PER PROVIDER CALL. The live path always feeds opus-mt a
     * single utterance, and fed a two-sentence message it kept only the
     * first (observed on staging: the second sentence of a chat message
     * silently vanished). Messages are split on sentence boundaries,
     * translated in order, and rejoined -- a partial provider failure keeps
     * whatever DID translate plus the original for the rest, because a
     * message must never lose words to a vendor.
     */
    const sentences = sourceText.match(/[^.!?…]+[.!?…]*\s*/gu) ?? [sourceText];
    const bounded = sentences.length > 24 ? [sourceText] : sentences;
    /*
     * CONCURRENT, order preserved by index. Translated sequentially, a
     * two-sentence chat message stacked two full provider latencies and
     * flapped across the account client's timeout -- the matrix caught
     * single sentences passing while pairs failed. The provider owns its own
     * queue; concurrency here is just not adding our own artificial one.
     */
    let providerName: string | null = null;
    const pieces = await Promise.all(
      bounded.map(async (raw, index) => {
        const piece = raw.trim();
        if (piece.length === 0) return '';
        try {
          const result = await ingest.liveTranslation.translate({
            sessionId: 'internal-text',
            streamId: 'internal-text',
            segmentId: `internal-text-${index}`,
            sequence: index,
            startMs: 0,
            endMs: 0,
            sourceLanguage,
            targetLanguage,
            sourceText: piece,
          });
          providerName = result.providerName ?? providerName;
          return result.translatedText.trim() || piece;
        } catch {
          return piece;
        }
      }),
    );
    res.json({
      translatedText: pieces.filter((piece) => piece.length > 0).join(' '),
      providerName,
    });
  } catch (error) {
    logger.warn('Internal text translation failed', {
      sourceLanguage,
      targetLanguage,
      message: error instanceof Error ? error.message : 'unknown',
    });
    res.status(502).json({ error: 'Translation is unavailable right now.' });
  }
});

app.post('/internal/media/sessions', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      broadcastId?: unknown;
      broadcasterPeerId?: unknown;
      revision?: unknown;
      targetLanguage?: unknown;
      targetLanguages?: unknown;
      textOnlyLanguages?: unknown;
      sourceLanguage?: unknown;
      sourceLanguageMode?: unknown;
      voiceIdsByLanguage?: unknown;
      voiceOwnerId?: unknown;
      generatedAudioPacing?: unknown;
    };
    const session = await ingest.createMediaSession({
      sessionId: requireStringField(body.sessionId, 'sessionId'),
      broadcastId: requireStringField(body.broadcastId, 'broadcastId'),
      broadcasterPeerId: requireStringField(body.broadcasterPeerId, 'broadcasterPeerId'),
      revision: parseIntegerField(body.revision, 'revision'),
      ...(typeof body.targetLanguage === 'string' ? { targetLanguage: body.targetLanguage } : {}),
      ...(Array.isArray(body.targetLanguages)
        ? { targetLanguages: body.targetLanguages.filter((value): value is string => typeof value === 'string') }
        : {}),
      // P6.4: targets translated for captions but never synthesized. The
      // session store enforces the subset-of-targetLanguages rule.
      ...(Array.isArray(body.textOnlyLanguages)
        ? { textOnlyLanguages: body.textOnlyLanguages.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(typeof body.sourceLanguage === 'string' ? { sourceLanguage: body.sourceLanguage } : {}),
      ...(body.sourceLanguageMode === 'manual' || body.sourceLanguageMode === 'auto-detect'
        ? { sourceLanguageMode: body.sourceLanguageMode }
        : {}),
      ...(voiceIdRecordOrNull(body.voiceIdsByLanguage)
        ? { voiceIdsByLanguage: voiceIdRecordOrNull(body.voiceIdsByLanguage)! }
        : {}),
      // Passed through unparsed; the session store validates it and rejects the
      // request rather than accepting a string that only looks like an owner.
      ...(typeof body.voiceOwnerId === 'string' ? { voiceOwnerId: body.voiceOwnerId } : {}),
      ...(body.generatedAudioPacing === 'natural' || body.generatedAudioPacing === 'fit-window'
        ? { generatedAudioPacing: body.generatedAudioPacing }
        : {}),
    });
    res.status(201).json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.delete('/internal/media/sessions/:sessionId', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const sessionId = requireRouteParam(req.params.sessionId, 'sessionId');
    const removed = await ingest.removeCallSession(sessionId);
    res.status(removed ? 200 : 404).json({ removed });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/internal/media/sessions/:sessionId/chunks', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = requireRouteParam(req.params.sessionId, 'sessionId');
    const partial = parseOptionalBooleanField(body.partial, 'partial');
    const session = await ingest.ingestMediaChunk(sessionId, {
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

app.post('/internal/media/sessions/:sessionId/stop', (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  try {
    const session = ingest.stopMediaSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/microphone/sessions/:sessionId/device-disconnected', operatorOnly, (req, res) => {
  try {
    const session = ingest.failMicrophoneDeviceDisconnected(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions', operatorOnly, upload.single('media'), async (req, res) => {
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

app.post('/sessions/:sessionId/audio/retry', operatorOnly, async (req, res) => {
  try {
    const session = await ingest.retryAudioExtraction(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.delete('/sessions/:sessionId/audio', operatorOnly, async (req, res) => {
  try {
    const session = await ingest.cleanupFailedAudio(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/pause', operatorOnly, (req, res) => {
  try {
    const session = ingest.pauseSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/resume', operatorOnly, (req, res) => {
  try {
    const session = ingest.resumeSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/cancel', operatorOnly, (req, res) => {
  try {
    const session = ingest.cancelSession(req.params.sessionId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.post('/sessions/:sessionId/transcription/chunks/:chunkId/retry', operatorOnly, async (req, res) => {
  try {
    const session = await ingest.retryTranscriptionChunk(req.params.sessionId, req.params.chunkId);
    res.json({ session });
  } catch (error) {
    sendIngestError(res, error);
  }
});

app.get('/sessions/:sessionId/transcript', operatorOnly, (req, res) => {
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

app.post('/sessions/:sessionId/translation/segments/:segmentId/retry', operatorOnly, async (req, res) => {
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

app.get('/sessions/:sessionId/translation/export', operatorOnly, (req, res) => {
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

app.post('/sessions/:sessionId/generated-audio/segments/:segmentId/retry', operatorOnly, async (req, res) => {
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

app.post('/sessions/:sessionId/source-language', operatorOnly, (req, res) => {
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

let voiceProfileSerial = 0;
registerVoiceProfileInitRoute(app, {
  store: voiceProfileStore,
  authenticate,
  newVoiceProfileId: () => `vp_${Date.now().toString(36)}_${++voiceProfileSerial}`,
});
registerVoiceEnrollmentRoute(app, {
  store: voiceProfileStore,
  authenticate,
  provider: personalVoiceProvider,
  newVoiceProfileId: () => `vp_${Date.now().toString(36)}_${++voiceProfileSerial}`,
});
registerVoiceWithdrawalRoutes(app, {
  store: voiceProfileStore,
  authenticate,
  personalVoiceIdFor: personalVoiceId,
  purgeGeneratedAudio: (voiceId) => ingest.purgePersonalVoiceAudio(voiceId),
});

/**
 * Finish a withdrawal whose cleanup failed.
 *
 * Internal, because it is an operational verb rather than a participant's. It
 * exists at all because the alternative — a store that quietly keeps a list of
 * material it failed to delete, with no way to act on it — is how "we deleted
 * your recording" becomes untrue over time rather than all at once.
 */
app.post('/internal/voice-cleanups/retry', async (req, res) => {
  if (!assertInternalWebRtcRequest(req, res)) return;
  const outstanding = voiceProfileStore.pendingCleanups();
  let finished = 0;
  for (const cleanup of outstanding) {
    const evidence = await voiceProfileStore.retryCleanup(cleanup.voiceProfileId);
    if (evidence && !evidence.cleanupRetryRequired) finished += 1;
  }
  res.json({
    attempted: outstanding.length,
    finished,
    stillStranded: voiceProfileStore.pendingCleanups().length,
  });
});

registerGeneratedAudioDeliveryRoute(app, ingest);
registerSourceMediaDeliveryRoute(app, ingest);
registerViewerReadyMediaDeliveryRoute(app, ingest);

// Records first, then the sweep, and only then the port. Serving before
// hydration would let a call resolve a personal voice from an empty store and
// conclude the speaker had none — and reconciling after would race a fresh
// enrollment whose record had not been written yet.
const restoredVoiceProfiles = await voiceProfileStore.hydrate();
const voiceMaterial = await reconcileVoiceMaterial({
  storage: voiceEnrollmentStorage,
  referenced: voiceProfileStore.referencedEnrollmentRecordings(),
});
// Counts only. Naming an orphan in a log would preserve the very thing that is
// being removed for having no record.
logger.info('Voice profile records restored', {
  restoredVoiceProfiles,
  strandedCleanups: voiceProfileStore.pendingCleanups().length,
  ...voiceMaterial,
});
if (voiceMaterial.orphansRemaining > 0) {
  logger.warn('Enrollment material outlived its record and could not be removed', {
    orphansRemaining: voiceMaterial.orphansRemaining,
  });
}

/**
 * Refuse to start rather than start unprotected.
 *
 * A 403 on each request is the minimum, and it is not enough on its own: a
 * service that boots without its credential is discovered by an attacker before
 * it is discovered by an operator. The internal media API can create sessions
 * and inject audio, so an unconfigured one is not a degraded service — it is an
 * open one. This follows VIDEOFY_AUTH_SECRET, which services already refuse to
 * start without.
 */
if (config.internalIngressAuth.mustRefuseToStart) {
  logger.error('Refusing to start: internal media API would be unauthenticated', {
    detail: config.internalIngressAuth.summary,
  });
  process.exit(1);
}
if (config.internalIngressAuth.mode === 'insecure-explicit') {
  logger.warn(config.internalIngressAuth.summary);
}

/**
 * Programme control is authenticated, and the service says so at boot.
 *
 * Until 30 Aug 2026 `/microphone/sessions` and `/sessions/:id/*` accepted
 * anonymous callers, and a guard here refused to start in production because
 * anonymous reach to them is remote control of a live broadcast. The fix that
 * guard was waiting for is `operatorOnly` above: a verified C7 session plus
 * the operator allowlist, mirrored from the gateway. This block is what
 * replaced the refusal -- the mode is logged so a deployment can read from its
 * own journal which population may operate, and an empty allowlist is called
 * out because it means the console works for nobody.
 */
const PROGRAMME_ROUTES_ARE_UNAUTHENTICATED = false as const;
const deploymentEnvironment = (process.env['C7_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? '')
  .trim()
  .toLowerCase();
if (PROGRAMME_ROUTES_ARE_UNAUTHENTICATED) {
  logger.error('Refusing to start: programme control routes must never be unauthenticated');
  process.exit(1);
}
logger.info('programme control authenticated: session + operator allowlist', {
  environment: deploymentEnvironment || 'unset',
  operatorAccountsAllowed: operatorEntitlement.allowedCount,
});
if (operatorEntitlement.allowedCount === 0) {
  logger.warn(
    `${OPERATOR_CONSOLE_ACCOUNT_IDS_VARIABLE} is not set: programme control refuses every account.`,
  );
}

// THE LIVE PATH. Attached only when a streaming recogniser is configured:
// without one there is nothing to transcribe a stream WITH, and opening the
// socket anyway would accept a call's audio and produce no captions while
// every component reported success.
const streamingTranscription = buildStreamingTranscriptionProvider(config);
const streamingSynthesis = buildStreamingSynthesisProvider(config);

/**
 * Say plainly whether this deployment can translate speech at all.
 *
 * Mock providers open sessions, answer healthily and produce nothing. Staging
 * ran that way while the call surface told people they were "hearing
 * translated voice", because no component ever stated the obvious. It does now,
 * at the loudest moment available -- startup -- and on /health for anything
 * that checks later.
 */
const liveEngine = describeLiveEngine(config);
if (!liveEngine.real) {
  logger.warn('Translation engine is NOT real; calls cannot produce translated audio', {
    transcription: liveEngine.transcription,
    synthesis: liveEngine.synthesis,
    translation: liveEngine.translation,
    stubbed: liveEngine.stubbed,
  });
} else {
  logger.info('Translation engine ready', {
    transcription: liveEngine.transcription,
    synthesis: liveEngine.synthesis,
    translation: liveEngine.translation,
  });
}
/**
 * The learned voice detector, when the model is on this machine.
 *
 * Loaded ONCE and shared: the model is stateless and expensive to load, while
 * each stream gets its own detector because the recurrent state describes one
 * conversation.
 *
 * A missing or unloadable model is NOT fatal. Calls fall back to the energy
 * and periodicity gate, which is weaker -- it admits tones and music -- but
 * present. Refusing to start over a VAD would trade "some noise gets through"
 * for "nobody can call", which is the wrong way round. It is logged at warn
 * either way, because a deployment running the weaker gate should know it.
 */
const sileroModelPath = process.env['SILERO_VAD_MODEL_PATH']?.trim();
let createSpeechDetector: (() => SpeechProbabilityDetector) | null = null;
if (sileroModelPath) {
  try {
    createSpeechDetector = await SileroSpeechDetector.factory(sileroModelPath);
    logger.info('Silero VAD loaded', { model: sileroModelPath });
  } catch (error) {
    logger.warn('Silero VAD unavailable; falling back to the energy/periodicity gate', {
      model: sileroModelPath,
      message: error instanceof Error ? error.message : 'unknown failure',
    });
  }
} else {
  logger.warn(
    'SILERO_VAD_MODEL_PATH is not set; using the energy/periodicity gate, which admits tones and music',
  );
}

if (streamingTranscription !== null) {
  attachRealtimeAudioIngress(server, {
    auth: config.internalIngressAuth,
    openStream: createLiveStreamOpener({
      transcription: streamingTranscription,
      translation: ingest.liveTranslation,
      // Captions still work without synthesis. A session with no synthesiser
      // must not fall back to a default voice speaking the wrong language.
      synthesis: streamingSynthesis,
      mintSegmentId: () => `seg_${crypto.randomUUID()}`,
      speechPlansFor: (open) => ingest.liveSpeechPlansFor(open.sessionId),
      ...(createSpeechDetector === null
        ? {}
        : { speech: { createDetector: createSpeechDetector } }),
      onCaption: (event) => ingest.acceptLiveTranscript(event),
      log: (line, detail) => logger.debug(line, detail ?? {}),
    }),
    log: (line, detail) => logger.warn(line, detail ?? {}),
  });
  logger.info('Realtime audio ingress attached', {
    path: REALTIME_INGRESS_PATH,
    transcription: streamingTranscription.name,
    synthesis: streamingSynthesis?.name ?? 'none (captions only)',
  });
}

server.listen(config.port, config.host, () => {
  logger.info('Media ingest endpoint started', {
    port: config.port,
    host: config.host,
    uploadDir,
    // Safe to log, and the question actually being asked when internal calls
    // start returning 403: do these two services hold the SAME token?
    internalIngressAuth: config.internalIngressAuth.mode,
    ...(config.internalIngressAuth.fingerprint === null
      ? {}
      : { internalTokenFingerprint: config.internalIngressAuth.fingerprint }),
  });
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

/**
 * FAILS CLOSED. This previously read:
 *
 *     if (!config.internalWebRtcToken) return true;
 *
 * so an unconfigured deployment authenticated nobody and accepted audio from
 * anyone who could reach the port. Absence of configuration is now a refusal,
 * and disabling authentication requires an explicit, deliberate opt-out.
 *
 * This is Layer 1 — it authenticates a CALLER. It says nothing about which
 * session that caller may write into; that is the session capability in P6.9,
 * and this function must not be mistaken for it.
 */
function assertInternalWebRtcRequest(req: express.Request, res: express.Response): boolean {
  if (internalIngressRequestAllowed(config.internalIngressAuth, req.header('X-Videofy-Internal-Token'))) {
    return true;
  }
  res.status(403).json({ error: 'Forbidden internal media request.' });
  return false;
}
