// FIRST import: loads .env before any module below reads process.env.
import '@videofy-live/service-env/auto';
import express from 'express';
import http from 'http';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { sendIngestError } from './ingest-error-response.js';
import {
  OPERATOR_CONSOLE_ACCOUNT_IDS_VARIABLE,
  createProgrammeControlGuard,
  operatorEntitlementFromAllowlist,
} from './programme-control-auth.js';
import { setOpusMtDiagnosticLogger } from './translation-provider.js';
import { attachRealtimeAudioIngress, REALTIME_INGRESS_PATH } from './realtime-ingress-server.js';
import { createLiveStreamOpener } from './live-session-host.js';
import { createVocabularySnapshotClient } from './vocabulary-snapshot-client.js';
import { ProgrammePerformanceRegistry } from './programme-performance-registry.js';
import { ProgrammeTimelineRegistry } from './programme-timeline-registry.js';
import { METADATA_PLANE_ONLY } from '@videofy-live/programme-timeline';
import { JournalTimelineStore } from './journal-timeline-store.js';
import {
  SileroSpeechDetector,
  type SpeechProbabilityDetector,
} from '@videofy-live/speech-activity';
import { buildTranslationGate } from './translation-gate-wiring.js';
import { registerQualityRoutes } from './quality-routes.js';
import { registerProgrammeRuntimeRoutes } from './programme-runtime-routes.js';
import { registerProgrammeEgressRoutes } from './programme-egress-routes.js';
import { ProgrammeEgressAuthority } from './programme-egress.js';
import { ProgrammeMediaStore } from './programme-media-store.js';
import { ProgrammeMediaOrigin } from './programme-media-origin.js';
import {
  VISIBILITY_UNRESOLVABLE,
  createChannelVisibilityClient,
  createProgrammeAudienceAccess,
} from './programme-audience-access.js';
import { supportsKeyterms } from './providers/deepgram/nova-streaming-stt.js';
import {
  buildLiveSynthesis,
  buildStreamingTranscriptionProvider,
  describeLiveEngine,
  describeNaijaLingoPreflight,
  preflightNigerianSpecialist,
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
/*
 * ONE SYNTHESIS STACK, built before anything that speaks.
 *
 * It used to be built beside the live path, several hundred lines below the
 * batch service -- which is precisely how the batch service came to have a
 * speech engine of its own that had never heard of the Nigerian specialist or
 * the founder's chosen voices. It is hoisted here because the uploaded-media
 * path needs it too, and because the specialist warms itself at construction:
 * the vendor behind it scales to zero, so earlier is strictly better.
 */
const liveSynthesis = buildLiveSynthesis(config);
const streamingSynthesis = liveSynthesis.provider;

const ingest = new IngestService(config, {
  /*
   * THE JOIN. Without this line the batch factory has no stack to speak with,
   * TEXT_TO_SPEECH_PROVIDER=streaming refuses at boot, and the deployment falls
   * back to the selector that writes empty files. Both halves of this were
   * built and tested before; the join is the part that was missing.
   */
  ...(streamingSynthesis === null ? {} : { streamingSynthesisProvider: streamingSynthesis }),
  onSynthesisDegraded: (input, degradation) => {
    // Language and vendor, never the text that was spoken.
    logger.warn('Uploaded segment served by a fallback voice', {
      targetLanguage: input.targetLanguage,
      expected: degradation.expectedProvider,
      served: degradation.servedBy,
      reason: degradation.reason,
    });
  },
  ...(openVoicePersonal === null
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
      })),
});


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
    /**
     * What ha/ig/yo/pcm will ACTUALLY sound like on this box.
     *
     * Reported unconditionally, including when it is fine, and including when
     * nobody has asked for those languages yet. This is the one degradation in
     * the pipeline that produces no other signal: the fallback returns 200 and
     * plausible audio, and only a speaker of the language can hear that the
     * wrong vendor answered. A surface that stayed silent about it would be
     * reporting a working product while shipping a broken one.
     */
    ...(nigerianSynthesis === null ? {} : { nigerianLanguageSynthesis: nigerianSynthesis() }),
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
/*
 * WHAT THIS DEPLOYMENT'S SELECTED ROUTES CAN ACTUALLY DO WITH VOCABULARY.
 *
 * The operator console must not decide this. A second model-name check written
 * in React would be a second answer to a question this service already answers
 * when it builds the request -- and the moment the two disagree, the console
 * tells an operator a term is consumed while the wire sends nothing.
 *
 * So the SAME `supportsKeyterms` predicate that decides whether `keyterm` goes
 * into the Deepgram URL decides what is reported here. One rule, one answer.
 */
app.get('/vocabulary/capabilities', (_req, res) => {
  // Read from the SAME env the wiring reads, with the SAME default, so the
  // reported model is the one actually requested rather than a second guess.
  const sttSelected = config.streamingTranscriptionProvider;
  const sttModel =
    (process.env['DEEPGRAM_MODEL'] ?? '').trim() ||
    (sttSelected === 'deepgram-flux' ? 'flux-general-en' : 'nova-3');
  res.json({
    service: 'media-ingest',
    sttRouteName:
      sttSelected === 'off' ? 'no recognition route' : `${sttSelected} ${sttModel}`.trim(),
    // The identical predicate the request builder uses.
    sttKeyterms: sttSelected.startsWith('deepgram') && supportsKeyterms(sttModel),
    synthesisRouteName: streamingSynthesis?.name ?? 'no synthesis route',
    /*
     * NO SYNTHESIS ROUTE ON THIS DEPLOYMENT ACCEPTS A PRONUNCIATION HINT.
     * Reported as false rather than omitted, so the console shows stored hints
     * as `unsupported` instead of leaving an operator to assume they work. When
     * a voice gains the mechanism this becomes a capability check like the one
     * above, never a hard-coded true.
     */
    pronunciationHints: false,
    timestamp: new Date().toISOString(),
  });
});

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
    /*
     * A SENTENCE THAT DID NOT TRANSLATE IS COUNTED, NOT HIDDEN.
     *
     * Keeping the original for a failed sentence is right -- a message must
     * never lose words to a vendor -- but returning it inside `translatedText`
     * with no other signal made the response a LIE the caller could not detect:
     * a two-sentence message where one sentence failed came back as a 200 with
     * half the text in the sender's language, labelled as a translation. The
     * whole-message case was caught downstream by an echo guard; the mixed case
     * was invisible to everyone.
     *
     * So the counts travel with the text and the caller decides. That is the
     * same rule the messaging path already applies to a total failure: deliver
     * real words, and say honestly that they are not a translation.
     */
    const pieces = await Promise.all(
      bounded.map(async (raw, index) => {
        const piece = raw.trim();
        if (piece.length === 0) return { text: '', translated: true };
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
          const translatedPiece = result.translatedText.trim();
          if (translatedPiece.length === 0) return { text: piece, translated: false };
          return { text: translatedPiece, translated: true };
        } catch {
          return { text: piece, translated: false };
        }
      }),
    );
    const spoken = pieces.filter((piece) => piece.text.length > 0);
    res.json({
      translatedText: spoken.map((piece) => piece.text).join(' '),
      providerName,
      sentenceCount: spoken.length,
      translatedSentenceCount: spoken.filter((piece) => piece.translated).length,
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
/**
 * Every live programme's measured behaviour, for the life of this process.
 *
 * One registry, partitioned by run, so two airings of the same programme never
 * describe each other. Held here rather than per-session because a console
 * asks about a run that a session may already have closed.
 */
const programmePerformance = new ProgrammePerformanceRegistry();

/**
 * Each live broadcast's own account of itself, and the cursor the audience
 * receives it through. One per run, resumed across a reconnect.
 */
/*
 * WHETHER THE MEDIA PLANE IS GOVERNED, AND THEREFORE WHETHER A DELAY IS
 * POSSIBLE AT ALL.
 *
 * The buffer refuses a protective delay unless every time-sensitive plane is
 * held to the cursor. PRODUCING SEGMENTS IS NOT THE SAME AS HOLDING THE
 * ORIGINAL: the gateway relays the broadcaster's tracks straight to each
 * listener, on a path this service's cursor has no part in. A deployment that
 * ran an encoder and concluded the media plane was governed would hold its
 * captions while its audience heard the speaker live -- the exact failure the
 * plane check exists to prevent, dressed as protection.
 *
 * So governance follows the DELIVERY mode, and that mode cannot be `delayed`
 * until the gateway can be told to stop relaying. Both conditions are
 * required; either alone is a promise nothing keeps.
 */
const programmeMediaProduced =
  config.programmeMediaOriginInput !== null && config.programmeMediaDelivery === 'delayed';
const programmeTimelines = new ProgrammeTimelineRegistry(
  undefined,
  config.programmeSafetyDelayMs,
  undefined,
  /*
   * The spool that lets a broadcast outlive this process.
   *
   * Beside the audio spool, because a timeline is the same kind of thing: a
   * bounded, append-only, per-broadcast artefact this service owns. Without it
   * a restart mid-programme loses the cursor, and `durable()` reports that
   * BEFORE a programme promises a safety delay rather than during it.
   */
  new JournalTimelineStore({ directory: join(config.audioChunkDir, 'timelines') }),
  programmeMediaProduced ? { metadata: true, media: true } : METADATA_PLANE_ONLY,
);
/*
 * THE MODE, SAID AT BOOT. An operator asking "is this programme protected"
 * must not have to infer it from two unrelated variables.
 */
if (config.programmeSafetyDelayMs === 0) {
  logger.info('Programme broadcast mode: TRUE LIVE', {
    reason: 'PROGRAMME_SAFETY_DELAY_MS is zero; nothing is held back',
  });
} else if (programmeMediaProduced) {
  logger.info('Programme broadcast mode: PROTECTED LIVE', {
    delayMs: config.programmeSafetyDelayMs,
  });
} else {
  logger.error('Programme safety delay is configured and CANNOT be held', {
    delayMs: config.programmeSafetyDelayMs,
    mediaProduction: config.programmeMediaOriginInput === null ? 'off' : 'on',
    mediaDelivery: config.programmeMediaDelivery,
    reason:
      'the original programme media is delivered live and is not held to the cursor, so the ' +
      'buffer will refuse the delay rather than hold captions against live speech',
  });
}

const streamingTranscription = buildStreamingTranscriptionProvider(config);

/**
 * Ask 9jaLingo two questions before anybody needs an answer, and say the result
 * in ONE line.
 *
 * WHY AT BOOT AND NOT ON FIRST USE. The way "paste the key" goes wrong is
 * quiet: a key that is valid but has no plan, a key whose speaker catalogue
 * does not cover Yoruba, a header the vendor changed. All three produce a
 * fallback that sounds like a working product to anyone who does not speak the
 * language -- so the moment to find out is before the demo, not during it.
 *
 * IT CANNOT FAIL THE BOOT. A vendor outage must not become an outage here;
 * that coupling is exactly what the fallback exists to avoid. It reports, and
 * the report goes on /health so somebody who missed the log can still find it.
 *
 * NAMES ONLY. Nothing in this line is or contains a credential.
 */
if (liveSynthesis.nigerian !== null) {
  void preflightNigerianSpecialist()
    .then((preflight) => {
      liveSynthesis.nigerian?.recordPreflight(preflight);
      const line = describeNaijaLingoPreflight(preflight);
      if (preflight.keyConfigured && preflight.reachable && preflight.problem === null) {
        logger.info(line);
      } else {
        logger.warn(line);
      }
    })
    .catch((error: unknown) => {
      logger.warn('9jaLingo preflight could not run', {
        message: error instanceof Error ? error.message : 'unknown failure',
      });
    });
}

/**
 * Say plainly whether this deployment can translate speech at all.
 *
 * Mock providers open sessions, answer healthily and produce nothing. Staging
 * ran that way while the call surface told people they were "hearing
 * translated voice", because no component ever stated the obvious. It does now,
 * at the loudest moment available -- startup -- and on /health for anything
 * that checks later.
 */
/** Read at request time, like `liveEngine`; null only when synthesis is off. */
const nigerianSynthesis = liveSynthesis.nigerian === null
  ? null
  : (): unknown => liveSynthesis.nigerian?.state();

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
/*
 * WHAT SPEAKS FOR AN UPLOADED PROGRAMME -- said out loud at boot.
 *
 * Every other engine on this service announces itself here, and the batch
 * speech engine did not. That is the blind spot a deployment fell into: it ran
 * `mock` against real programmes for as long as nobody uploaded one and
 * listened, because no line ever named it and its output arrived as a file
 * like any other. `mock` reads as a warning now, and `streaming` names the
 * stack it borrows, so which one is mounted takes one glance.
 */
/*
 * THE TRANSLATION GATE, built at boot and said out loud.
 *
 * The registry package was declared in this service's package.json and imported
 * by nothing, so every direction translated regardless of approval. This is the
 * join, and the line below is how anybody can tell it held: a deployment that
 * failed closed says so, and one with no approved directions says that too
 * rather than looking identical to a working one.
 */
const translationGate = buildTranslationGate({
  scope: 'programme-live',
  ...(process.env['TRANSLATION_ROUTES_DOCUMENT']
    ? { documentPath: process.env['TRANSLATION_ROUTES_DOCUMENT'] }
    : {}),
});
logger.info('Translation route gate ready', {
  scope: 'programme-live',
  failedClosed: translationGate.failedClosed,
  approvedDirections: translationGate.approvedDirections.length,
  directions: translationGate.approvedDirections,
  detail: translationGate.description,
  ...(translationGate.failedClosed
    ? { warning: 'every direction refuses; the ORIGINAL is still delivered untranslated' }
    : {}),
});

/*
 * THE QUALITY SURFACE. Registered from the SAME gate instance above, so the
 * console is told exactly what the gate would decide -- not a second reading of
 * the document that can disagree with it after an edit.
 */
/*
 * What each live broadcast is measurably doing, and whether its safety
 * promise would survive this process. The console reads truth from here
 * rather than inferring it from configuration.
 */
registerProgrammeRuntimeRoutes(app, {
  performance: programmePerformance,
  timelines: programmeTimelines,
});

/*
 * THE AUDIENCE'S DOOR, and the only one.
 *
 * The egress authority has existed, tested, and constructed by nothing, since
 * it was written -- the same unwired seam this repository keeps producing. It
 * is composed here, once, so there is exactly one place where "what the cursor
 * has published" becomes "what an HTTP client may fetch".
 *
 * The spool sits beside the audio chunks, under a directory of its own. The
 * routes are given that directory as their containment boundary, so a segment
 * reference that ever resolved outside it would be refused rather than served.
 *
 * NO PRODUCER IS ATTACHED YET. The media origin worker that writes segments
 * into this store is not wired, so today this store is empty and the manifest
 * is empty with it. That is said plainly in the boot line below rather than
 * left for somebody to discover: an empty playlist and a broken encoder look
 * identical from outside, and only one of them is what this deployment is.
 */
const programmeMediaSpool = join(config.audioChunkDir, 'programme-media');
const programmeMedia = new ProgrammeMediaStore();
const programmeEgress = new ProgrammeEgressAuthority(programmeTimelines, programmeMedia);

/**
 * Whether an audience can be admitted at all depends on being able to tell a
 * public channel from a locked one, and that answer lives with the account
 * service. Without it, this refuses everybody -- deliberately, and out loud.
 */
const channelVisibility =
  config.accountServiceUrl !== null && config.internalIngressAuth.token !== null
    ? createChannelVisibilityClient({
        accountServiceUrl: config.accountServiceUrl,
        internalToken: config.internalIngressAuth.token,
      })
    : VISIBILITY_UNRESOLVABLE;

registerProgrammeEgressRoutes(app, {
  egress: programmeEgress,
  access: createProgrammeAudienceAccess({
    channelOf: (runId) => programmeTimelines.channelOf(runId),
    visibility: channelVisibility,
    authenticate,
    entitlement: operatorEntitlement,
    internalTokenAllowed: (presented) =>
      internalIngressRequestAllowed(config.internalIngressAuth, presented),
  }),
  spoolRoot: programmeMediaSpool,
  onFuturePeek: () => {
    /*
     * Somebody asked for a segment the cursor has not published. Counted at
     * warn because guessing sequential names is deliberate; the run is named
     * so an operator can look, and nothing about the requester is kept.
     */
    logger.warn('A request asked for programme media ahead of the public cursor');
  },
});
/*
 * THE PRODUCER, and the reason an operator cannot choose what it reads.
 *
 * The input is built from a template this deployment owns, with the run id
 * substituted. An operator asking us to encode an address of their choosing
 * would be asking us to read whatever sits at that address -- a local file, an
 * internal host -- and broadcast it to an audience. They say which run to
 * produce; the deployment says where its media comes from.
 */
const programmeOrigin = new ProgrammeMediaOrigin({
  media: programmeMedia,
  timelines: programmeTimelines,
  egress: programmeEgress,
  spoolRoot: programmeMediaSpool,
});

app.post('/programmes/:runId/media-origin', operatorOnly, (req, res) => {
  void (async () => {
    const runId = String(req.params['runId'] ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) {
      res.status(400).json({ error: 'Not a run id.' });
      return;
    }
    if (config.programmeMediaOriginInput === null) {
      res.status(503).json({
        error: 'This deployment produces no programme media: PROGRAMME_MEDIA_ORIGIN_INPUT is unset.',
      });
      return;
    }
    if (!programmeTimelines.tracks(runId)) {
      // Producing media for a broadcast this process is not running would
      // spool bytes nothing could ever publish.
      res.status(404).json({ error: 'This service is not running that broadcast.' });
      return;
    }

    const started = await programmeOrigin.start(
      runId,
      config.programmeMediaOriginInput.replace('{runId}', runId),
    );
    res.status(started ? 202 : 200).json({ runId, producing: true, started });
  })();
});

app.delete('/programmes/:runId/media-origin', operatorOnly, (req, res) => {
  void (async () => {
    const runId = String(req.params['runId'] ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) {
      res.status(400).json({ error: 'Not a run id.' });
      return;
    }
    await programmeOrigin.stop(runId);
    res.status(200).json({ runId, producing: false });
  })();
});

logger.info('Programme egress ready', {
  spool: programmeMediaSpool,
  visibilitySource: channelVisibility === VISIBILITY_UNRESOLVABLE ? 'none' : 'account-service',
  ...(channelVisibility === VISIBILITY_UNRESOLVABLE
    ? {
        warning:
          'no audience can watch through this service: ACCOUNT_SERVICE_URL or the internal ' +
          'token is unset, so a public channel cannot be told from a locked one',
      }
    : {}),
  /*
   * Said out loud because the two states are indistinguishable from outside:
   * a deployment with no media source and one whose encoder is broken both
   * serve an empty playlist.
   */
  mediaProduction: config.programmeMediaOriginInput === null ? 'off' : 'on',
  ...(config.programmeMediaOriginInput === null
    ? { note: 'PROGRAMME_MEDIA_ORIGIN_INPUT is unset; the published manifest will be empty' }
    : {}),
});

registerQualityRoutes(app, {
  registry: translationGate.registry,
  catalogue: () => ingest.targetLanguageCatalogue,
  scope: 'programme-live',
});
logger.info('Route quality surface ready', {
  scope: 'programme-live',
  evidenceAvailable: translationGate.registry !== null,
  ...(translationGate.registry === null
    ? { warning: 'no route document loaded; the console will report quality as unknown' }
    : {}),
});

logger.info('Programme speech engine ready', {
  provider: config.textToSpeechProvider,
  ...(config.textToSpeechProvider === 'streaming'
    ? { speaks: streamingSynthesis?.name ?? 'nothing: no live synthesis stack' }
    : {}),
  ...(config.textToSpeechProvider === 'mock'
    ? { warning: 'mock writes EMPTY audio files; uploaded programmes will be silent' }
    : {}),
});
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
      /*
       * THE OPERATOR'S VOCABULARY, ON ITS WAY TO THE RECOGNISER.
       *
       * Built here rather than inside the host so the host stays testable
       * without a network, and so a deployment with no seam configured gets a
       * client that says so out loud instead of an absent dependency that
       * quietly resolves to no terms.
       */
      // Measurements live for the life of the process, partitioned by run.
      performance: programmePerformance,
      timelines: programmeTimelines,
      /*
       * The cursor has to be advanced by something. In production that is a
       * real interval; a test drives it by hand instead of by waiting.
       */
      setOutputTimer: (tick, everyMs) => {
        const timer = setInterval(tick, everyMs);
        timer.unref?.();
        return () => clearInterval(timer);
      },
      vocabulary: createVocabularySnapshotClient({
        accountUrl: config.accountServiceUrl,
        internalToken: config.internalIngressAuth.token,
        sttKeyterms: true,
        log: (line, detail) => logger.info(line, detail),
      }),
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
