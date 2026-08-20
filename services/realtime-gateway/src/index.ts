// FIRST import: loads .env before any module below reads process.env.
import '@videofy-live/service-env/auto';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { logger, setLogLevel } from './logger.js';

const config = loadConfig();
setLogLevel(config.logLevel);

/**
 * Refuse to start rather than start unable to authenticate.
 *
 * The gateway is the CLIENT of the internal media API, so an unconfigured
 * gateway does not expose anything itself — every call it makes simply gets a
 * 403. That is a working deployment where transcription silently never happens,
 * which is a worse failure to diagnose than a service that will not boot. The
 * two services resolve this from the same module for exactly this reason: a
 * deployment is either configured or it stops, never half of each.
 */
if (config.internalIngressAuth.mustRefuseToStart) {
  logger.error('Refusing to start: no credential for the internal media API', {
    detail: config.internalIngressAuth.summary,
  });
  process.exit(1);
}
if (config.internalIngressAuth.mode === 'insecure-explicit') {
  logger.warn(config.internalIngressAuth.summary);
}

const app = createApp({
  diagnostics: () => gateway.getWebRtcDiagnostics(),
  internalToken: config.internalIngressAuth.token,
  // Lazy on purpose (same pattern as diagnostics): `gateway` is created below.
  connectV1Router: () => gateway.getConnectV1Router(),
});
const server = createServer(app);
const gateway = new Gateway(server, config.corsOrigins, {
  mediaIngestUrl: config.mediaIngestUrl,
  mediaIngestPublicUrl: config.mediaIngestPublicUrl,
  internalWebRtcToken: config.internalIngressAuth.token,
  webRtcTranscriptionChunkMs: config.webRtcTranscriptionChunkMs,
  webRtcTranscriptionRequestTimeoutMs: config.webRtcTranscriptionRequestTimeoutMs,
  vad: config.webRtcVadEnabled
    ? {
        enabled: true,
        mode: config.webRtcVadMode,
        speechThreshold: config.webRtcVadSpeechThreshold,
        endSilenceMs: config.webRtcVadEndSilenceMs,
        minSpeechMs: config.webRtcVadMinSpeechMs,
        maxSegmentMs: config.webRtcVadMaxSegmentMs,
      }
    : undefined,
  webRtcTranscriptionStagingDir: config.webRtcTranscriptionStagingDir,
  webRtcPartialCaptionIntervalMs: config.webRtcPartialCaptionIntervalMs,
  callTranscriptLogDir: config.callTranscriptLogDir,
  connect: {
    authSecret: config.connectAuthSecret,
    projectsPath: config.connectProjectsPath,
  },
});

server.listen(config.port, config.host, () => {
  logger.info('Realtime gateway started', {
    host: config.host,
    port: config.port,
  });
});

function shutdown(signal: string): void {
  logger.info('Shutting down gateway', { signal });
  server.close(() => {
    logger.info('Gateway shut down cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { gateway };
