// FIRST import: loads .env before any module below reads process.env.
import '@videofy-live/service-env/auto';
import { createServer } from 'node:http';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import { AdapterControlPlane } from './adapter-control-plane.js';
import { createAdapterControlRouter } from './adapter-control-routes.js';
import { AdapterIngressBinding } from './adapter-ingress-binding.js';
import { attachAdapterMediaChannel } from './adapter-media-channel.js';
import {
  StaticAdapterRoutePolicyResolver,
  loadRoutePolicyFile,
  provisionRouteCredentials,
} from './adapter-route-policy.js';
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

/**
 * The adapter surface exists only when this deployment runs adapters.
 *
 * Its switch is the route policy path, because that is the thing a deployment
 * without adapters genuinely has no value for. What must never happen is a
 * HALF-configured one: routes declared but no service credential to
 * authenticate the adapters that would use them. That combination would start,
 * mount the endpoints, and refuse every adapter with a 401 that looks exactly
 * like a wrong secret. So it refuses to start instead, which is the same
 * discipline the internal media API already follows.
 */
const adapterSurface =
  config.adapterRoutePolicyPath === null
    ? null
    : (() => {
        if (config.adapterServiceAuth.mustRefuseToStart) {
          logger.error(
            'Refusing to start: adapter routes are configured but adapters cannot be authenticated',
            { detail: config.adapterServiceAuth.summary },
          );
          process.exit(1);
        }
        if (config.adapterServiceAuth.mode === 'insecure-explicit') {
          logger.warn(config.adapterServiceAuth.summary);
        }
        // Throws on unreadable, invalid, or half-provisioned configuration.
        // Startup is where that is one line to fix.
        const file = loadRoutePolicyFile(config.adapterRoutePolicyPath);
        const authority = new AdapterAuthority();
        const { provisioned } = provisionRouteCredentials(authority, file);
        return { file, authority, provisioned };
      })();

const app = createApp({
  diagnostics: () => gateway.getWebRtcDiagnostics(),
  ...(adapterSurface === null
    ? {}
    : {
        adapterControlRouter: () =>
          createAdapterControlRouter({
            controlPlane: adapterControlPlane!,
            serviceAuth: config.adapterServiceAuth,
            log: (line, detail) => logger.info(line, detail ?? {}),
          }),
      }),
  internalToken: config.internalIngressAuth.token,
  // Lazy on purpose (same pattern as diagnostics): `gateway` is created below.
  connectV1Router: () => gateway.getConnectV1Router(),
});
const server = createServer(app);
/*
 * Read before the Gateway is built so the warning lands at startup, next to the
 * other boot diagnostics, rather than the first time an operator connects.
 */
const channelIdSalt = process.env['CHANNEL_ID_SALT'];
if (channelIdSalt === undefined || channelIdSalt.length === 0) {
  logger.warn(
    'CHANNEL_ID_SALT is not set; channel ids are derived with the built-in salt. ' +
      'Links stay stable, but an account id can be mapped to its channel id. ' +
      'Set it once per deployment and never change it.',
  );
}

const gateway = new Gateway(server, config.corsOrigins, {
  mediaIngestUrl: config.mediaIngestUrl,
  realtimeIngressUrl: config.realtimeIngressUrl,
  livePathProfile: config.livePathProfile,
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
  operator: {
    // The SAME secret the account service signs sessions with. A separate
    // secret here would mean a token minted at sign-in did not verify at the
    // gateway, and the symptom is an operator who cannot connect for reasons
    // nothing explains.
    authSecret: process.env['VIDEOFY_AUTH_SECRET'],
    /*
     * OPEN, BUT NOT ANONYMOUS.
     *
     * Any verified C7 account may operate a programme today. That is a
     * deliberate product decision taken while there is nothing to subscribe
     * to, not an oversight -- and it is NOT a bypass of authentication: a
     * caller with no valid session token is refused either way.
     *
     * When pricing exists this becomes true and takes an entitlement check,
     * which is a one-line change here rather than a rewrite, because the
     * accountId is already resolved.
     */
    requireEntitlement: false,
    /*
     * PER-DEPLOYMENT, AND STABLE FOREVER AFTER.
     *
     * Channel ids are a digest of the account id under this salt, and they
     * appear in the links operators hand out. Changing it silently invalidates
     * every link anybody has ever shared, so it is set once per deployment and
     * then left alone -- it is not a secret to be rotated.
     *
     * Absent, the gateway falls back to a value that is in the source code.
     * That still works and still keeps links stable; what it does not do is
     * stop somebody who knows an account id from computing its channel id,
     * which is the correlation DP-171 asks to prevent. So it warns rather than
     * failing to boot: refusing to start would take a running deployment down
     * over a property it has never had.
     */
    channelSalt: channelIdSalt,
  },
});

/**
 * Composed AFTER the Gateway, because the binding drives the SAME media bridge
 * every other producer uses. A second bridge for adapters would be a second
 * pipeline, which is the thing P6.9 exists to avoid.
 */
const adapterControlPlane =
  adapterSurface === null
    ? null
    : (() => {
        const binding = new AdapterIngressBinding({
          authority: adapterSurface.authority,
          bridge: gateway.getMediaTranscriptionBridge(),
          policy: new StaticAdapterRoutePolicyResolver({
            file: adapterSurface.file,
            log: (line, detail) => logger.warn(line, detail ?? {}),
          }),
          log: (line, detail) => logger.info(line, detail ?? {}),
        });
        attachAdapterMediaChannel({
          server,
          binding,
          serviceAuth: config.adapterServiceAuth,
          log: (line, detail) => logger.info(line, detail ?? {}),
        });
        return new AdapterControlPlane({ authority: adapterSurface.authority, binding });
      })();

if (adapterSurface !== null) {
  logger.info('Adapter ingress enabled', {
    adapters: adapterSurface.provisioned,
    routes: Object.keys(adapterSurface.file.routes),
    credential: config.adapterServiceAuth.fingerprint,
  });
}

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
