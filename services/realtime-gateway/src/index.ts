import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { logger, setLogLevel } from './logger.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const app = createApp();
const server = createServer(app);
const gateway = new Gateway(server, config.corsOrigins, {
  mediaIngestUrl: config.mediaIngestUrl,
  internalWebRtcToken: config.internalWebRtcToken,
  webRtcTranscriptionChunkMs: config.webRtcTranscriptionChunkMs,
  webRtcTranscriptionStagingDir: config.webRtcTranscriptionStagingDir,
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
