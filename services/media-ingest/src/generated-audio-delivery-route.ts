import express from 'express';
import { createReadStream } from 'node:fs';
import type { GeneratedAudioFile } from './media-session.js';
import { MediaIngestError } from './ingest-error.js';
import { sendIngestError } from './ingest-error-response.js';
import { logger } from './logger.js';

export interface GeneratedAudioDeliveryService {
  getGeneratedAudioFile(
    sessionId: string,
    segmentId: string,
    targetLanguage?: string,
  ): Promise<GeneratedAudioFile>;
}

/**
 * Has the cursor released this piece of translated audio yet?
 *
 * `not-governed` is the ordinary answer for a session with no protected run,
 * and it is not a weakness: a programme that holds nothing back has nothing to
 * withhold. `not-yet-public` is the one that matters -- segment ids are
 * sequential and a caller can count, so the manifest of released segments is
 * necessary and nowhere near sufficient.
 */
export type GeneratedAudioRelease = 'public' | 'not-yet-public' | 'not-governed';

export interface GeneratedAudioReleaseGuard {
  assess(sessionId: string, segmentId: string): GeneratedAudioRelease;
}

/**
 * The audience's translated audio, gated on the same cursor as everything else.
 *
 * WITHOUT THE GUARD THIS ROUTE WAS A BYPASS. Translated audio is produced from
 * the original as it arrives, so a protected programme's next forty-five
 * seconds of speech exist on disk long before the audience may hear them.
 * Anyone who could guess a segment id could fetch them, which would have made
 * the delay decorative on the very plane it was already governing.
 *
 * The guard is optional at the type level and supplied in production. Absent,
 * every request is treated as ungoverned, which is the correct behaviour for a
 * deployment with no protected runs and is stated here rather than left to be
 * inferred from a missing argument.
 */
export function registerGeneratedAudioDeliveryRoute(
  app: express.Express,
  ingest: GeneratedAudioDeliveryService,
  guard?: GeneratedAudioReleaseGuard,
): void {
  app.get('/sessions/:sessionId/generated-audio/segments/:segmentId/audio', async (req, res) => {
    try {
      const release = guard?.assess(req.params.sessionId, req.params.segmentId) ?? 'not-governed';
      if (release === 'not-yet-public') {
        /*
         * Refused, and told apart from "no such segment" in the status rather
         * than the body: an operator needs to see somebody counting, and a
         * caller learns nothing they did not already suppose.
         */
        res.status(403).json({ error: 'That segment has not been released yet.' });
        return;
      }
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

