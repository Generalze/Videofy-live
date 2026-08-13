import express from 'express';
import { createReadStream } from 'node:fs';
import type { ViewerReadyMediaFile } from './media-session.js';
import { MediaIngestError } from './ingest-error.js';
import { logger } from './logger.js';
import { parseRangeHeader } from './generated-audio-delivery-route.js';

export interface ViewerReadyMediaDeliveryService {
  getViewerReadyMediaFile(sessionId: string): Promise<ViewerReadyMediaFile>;
}

export function registerViewerReadyMediaDeliveryRoute(
  app: express.Express,
  ingest: ViewerReadyMediaDeliveryService,
): void {
  app.get('/sessions/:sessionId/viewer-media', async (req, res) => {
    try {
      const file = await ingest.getViewerReadyMediaFile(req.params.sessionId);
      sendViewerReadyMediaFile(req.headers.range, file, res);
    } catch (error) {
      sendIngestError(res, error);
    }
  });
}

function sendViewerReadyMediaFile(
  rangeHeader: string | undefined,
  file: ViewerReadyMediaFile,
  res: express.Response,
): void {
  res.setHeader('Content-Type', 'video/mp4');
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

  const message = error instanceof Error ? error.message : 'Viewer-ready media delivery failed.';
  logger.error('Unexpected viewer-ready media delivery failure', { message });
  res.status(500).json({ error: 'Viewer-ready media delivery failed.' });
}
