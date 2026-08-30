/** @author masterzee001 */
/**
 * One place that turns a MediaIngestError into an HTTP response.
 *
 * WHY IT IS ITS OWN MODULE. This mapping existed twice -- once in index.ts and
 * once in generated-audio-delivery-route.ts -- with the same shape and no
 * shared definition. Two copies of a rule are two rules, and the second one
 * drifts quietly: a status code carried in one and dropped in the other is
 * invisible until somebody's client reads a 500 for a capability that is
 * merely switched off.
 *
 * It also made the HTTP behaviour untestable. A test could only re-declare the
 * handler shape and assert against its own copy, which proves the copy. The
 * CTO asked (30 Aug 2026) for proof that "the API actually returns the correct
 * 503 to a caller" rather than that the provider throws 503-shaped metadata,
 * and that proof needs the real mapper.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent a status. An error that is not a
 * MediaIngestError is a bug in this service, not a message for the caller, so
 * it becomes a 500 with a fixed sentence and the detail goes to the log --
 * never to the response, where it would leak a path or a provider's internals.
 */
import type express from 'express';
import { MediaIngestError } from './ingest-error.js';
import { logger } from './logger.js';

export function sendIngestError(res: express.Response, error: unknown, context?: string): void {
  if (error instanceof MediaIngestError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      session: error.session,
    });
    return;
  }

  const message = error instanceof Error ? error.message : 'Media ingest failed.';
  logger.error(context ?? 'Unexpected media ingest failure', { message });
  res.status(500).json({ error: 'Media ingest failed.' });
}
