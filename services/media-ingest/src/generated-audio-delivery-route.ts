import express from 'express';
import { createReadStream } from 'node:fs';
import type { GeneratedAudioFile } from './media-session.js';
import { MediaIngestError } from './ingest-error.js';
import { logger } from './logger.js';

export interface GeneratedAudioDeliveryService {
  getGeneratedAudioFile(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<GeneratedAudioFile>;
}

export function registerGeneratedAudioDeliveryRoute(
  app: express.Express,
  ingest: GeneratedAudioDeliveryService,
): void {
  app.get('/sessions/:sessionId/generated-audio/segments/:segmentId/audio', async (req, res) => {
    try {
      const targetLanguage =
        typeof req.query['language'] === 'string' ? req.query['language'] : undefined;
      const file = await ingest.getGeneratedAudioFile(
        req.params.sessionId,
        req.params.segmentId,
        targetLanguage,
      );
      sendGeneratedAudioFile(req.headers.range, file, res);
    } catch (error) {
      sendIngestError(res, error);
    }
  });
}

export function sendGeneratedAudioFile(
  rangeHeader: string | undefined,
  file: GeneratedAudioFile,
  res: express.Response,
): void {
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = parseRangeHeader(rangeHeader, file.sizeBytes);
  if (range === 'invalid') {
    res
      .status(416)
      .setHeader('Content-Range', `bytes */${file.sizeBytes}`)
      .json({ error: 'Invalid audio range requested.' });
    return;
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    createReadStream(file.audioPath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(file.sizeBytes));
  createReadStream(file.audioPath).pipe(res);
}

export function parseRangeHeader(
  header: string | undefined,
  fileSizeBytes: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return 'invalid';

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return {
      start: Math.max(0, fileSizeBytes - suffixLength),
      end: fileSizeBytes - 1,
    };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : fileSizeBytes - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= fileSizeBytes
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(end, fileSizeBytes - 1) };
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

  const message = error instanceof Error ? error.message : 'Media ingest failed.';
  logger.error('Unexpected generated-audio delivery failure', { message });
  res.status(500).json({ error: 'Media ingest failed.' });
}
