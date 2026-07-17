import express from 'express';
import http from 'http';
import { loadConfig } from './config.js';
import { IngestService } from './ingest-service.js';
import { logger, setLogLevel } from './logger.js';

const config = loadConfig();
setLogLevel(config.logLevel);

const app = express();
const server = http.createServer(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'media-ingest', timestamp: new Date().toISOString() });
});

server.listen(config.port, () => {
  logger.info('Media ingest health endpoint started', { port: config.port });
});

const ingest = new IngestService(config);

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
