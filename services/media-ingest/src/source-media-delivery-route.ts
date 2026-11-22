import express from 'express';
import { createReadStream } from 'node:fs';
import type { SourceMediaFile } from './media-session.js';
import { MediaIngestError } from './ingest-error.js';
import { logger } from './logger.js';
import { parseRangeHeader } from './generated-audio-delivery-route.js';

export interface SourceMediaDeliveryService {
  getSourceMediaFile(sessionId: string): Promise<SourceMediaFile>;
}

export function registerSourceMediaDeliveryRoute(
  app: express.Express,
  ingest: SourceMediaDeliveryService,
  /**
   * The audience door. REQUIRED, so this route cannot be registered without
   * one -- it was registered without one until 29 Sep 2026, and the session
   * id it keys on is broadcast to every listener on the channel.
   */
  audience: express.RequestHandler,
): void {
  app.get('/sessions/:sessionId/source-media', audience, async (req, res) => {
    try {
      const file = await ingest.getSourceMediaFile(String(req.params['sessionId']));
      sendSourceMediaFile(req.headers.range, file, res);
    } catch (error) {
      sendIngestError(res, error);
    }
  });
}

function sendSourceMediaFile(
  rangeHeader: string | undefined,
  file: SourceMediaFile,
  res: express.Response,
): void {
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = parseRangeHeader(rangeHeader, file.sizeBytes);
  if (range === 'invalid') {
    res
      .status(416)
      .setHeader('Content-Range', `bytes */${file.sizeBytes}`)
      .json({ error: 'Invalid media range requested.' });
    return;
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    createReadStream(file.mediaPath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(file.sizeBytes));
  createReadStream(file.mediaPath).pipe(res);
}

function sendIngestError(res: express.Response, error: unknown): void {
  if (error instanceof MediaIngestError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      session: error.session,
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Media ingest source delivery failed.';
  logger.error('Unexpected source-media delivery failure', { message });
  res.status(500).json({ error: 'Media ingest source delivery failed.' });
}
