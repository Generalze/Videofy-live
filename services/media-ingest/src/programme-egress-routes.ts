/** @author masterzee001 */
/**
 * The only door the audience has, and every lock on it.
 *
 * `ProgrammeEgressAuthority` decides what is public. Until now nothing asked
 * it: it was built, tested, and constructed by no running process, which is
 * this repository's recurring defect and the one worth naming plainly. This
 * file is the join -- the HTTP surface a player actually talks to, and the
 * place the encoder's spool stops being reachable by anything else.
 *
 * FOUR CHECKS, IN THIS ORDER, AND EACH IS LOAD-BEARING:
 *
 *   1. IS THE RUN ID EVEN A RUN ID. Rejected on shape before it reaches a map
 *      key or a path, because everything after this treats it as trusted.
 *   2. MAY THIS VIEWER SEE THIS BROADCAST AT ALL. Channel visibility, asked
 *      per request and never cached across viewers. There is no default: a
 *      composition that does not supply an access policy does not get routes.
 *   3. HAS THE CURSOR PUBLISHED THIS SEGMENT. Asked at fetch, against the
 *      cursor at this instant -- not answered by the manifest the client
 *      happens to hold, which is a snapshot of a moment that has passed.
 *   4. DOES THE FILE LIE INSIDE THE SPOOL. The reference comes from our own
 *      store, so this should never fire; it is here because "should never"
 *      and "cannot" are different, and the thing on the other side of a
 *      traversal is the operating system.
 *
 * WHAT IS NOT SERVED, AT ALL: the encoder's own playlist, its directory, and
 * any segment named by a filesystem path. A viewer names segments by opaque
 * id. That is what lets the spool become object storage later without a
 * player noticing, and what stops a directory listing from handing somebody
 * the next forty-five seconds of a protected broadcast.
 *
 * ASKING FOR THE FUTURE IS REPORTED. A request for a segment that exists and
 * is not yet public is refused like the others, and is the only refusal worth
 * an operator's attention: guessing sequential names is what somebody does on
 * purpose. It is counted, never logged with the requester's identity.
 */

import type express from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  renderHlsManifest,
  type EgressRefusal,
  type ProgrammeEgressAuthority,
} from './programme-egress.js';
import { parseRangeHeader } from './generated-audio-delivery-route.js';
import { logger } from './logger.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** Opaque by contract: ids this service minted, and nothing resembling a path. */
const SEGMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/u;

/** What an access policy may answer. Anything but `allow` serves no bytes. */
export type AudienceVerdict = 'allow' | 'sign-in' | 'forbidden' | 'unknown-run';

/**
 * Who may watch a broadcast.
 *
 * REQUIRED, with no default implementation offered here on purpose. A public
 * channel, an unlisted one and a private one differ only in this answer, and a
 * permissive fallback would make a private programme public the first time
 * somebody composed these routes without thinking about it.
 */
export interface ProgrammeAudienceAccess {
  mayView(runId: string, request: express.Request): Promise<AudienceVerdict> | AudienceVerdict;
}

export interface ProgrammeEgressRoutesDeps {
  readonly egress: ProgrammeEgressAuthority;
  readonly access: ProgrammeAudienceAccess;
  /**
   * The one directory segment bytes may come from.
   *
   * Every resolved reference must sit inside it. Passing the spool root is
   * what turns the containment check from a comment into a check.
   */
  readonly spoolRoot: string;
  /** Counted for an operator: somebody asking for material not yet published. */
  readonly onFuturePeek?: (runId: string) => void;
}

/** HTTP for each refusal. Distinct, because each has a different fix. */
function statusFor(refusal: EgressRefusal): number {
  switch (refusal) {
    case 'unknown-run':
    case 'unknown-segment':
      return 404;
    case 'not-yet-public':
      // Not 404: it exists. Not 200 in any circumstance: it is not yet theirs.
      return 403;
    case 'output-stopped':
      // The broadcast has been withdrawn; a player should stop, not retry hard.
      return 410;
  }
}

function denial(res: express.Response, verdict: Exclude<AudienceVerdict, 'allow'>): void {
  if (verdict === 'sign-in') {
    res.status(401).json({ error: 'Sign in to watch this programme.' });
    return;
  }
  /*
   * A private programme and a programme that does not exist answer the SAME
   * way. Distinguishing them tells an anonymous caller which run ids are real,
   * which is how an unlisted broadcast stops being unlisted.
   */
  res.status(404).json({ error: 'No such programme.' });
}

export function registerProgrammeEgressRoutes(
  app: express.Express,
  deps: ProgrammeEgressRoutesDeps,
): void {
  const spoolRoot = resolve(deps.spoolRoot);

  const admit = async (req: express.Request, res: express.Response): Promise<string | null> => {
    const runId = String(req.params['runId'] ?? '');
    if (!RUN_ID.test(runId)) {
      res.status(404).json({ error: 'No such programme.' });
      return null;
    }
    const verdict = await deps.access.mayView(runId, req);
    if (verdict !== 'allow') {
      denial(res, verdict);
      return null;
    }
    return runId;
  };

  /**
   * The playlist, built from the cursor rather than from the encoder.
   *
   * NEVER CACHED. It describes where the audience is right now, and a cached
   * copy served a minute later either stalls a player or -- worse, once the
   * run has been withdrawn -- keeps an audience watching a broadcast that was
   * pulled.
   */
  app.get('/programmes/:runId/playlist.m3u8', (req, res) => {
    void (async () => {
      const runId = await admit(req, res);
      if (runId === null) return;

      const manifest = deps.egress.manifest(runId);
      if (!manifest.available) {
        res.status(statusFor(manifest.refusal)).json({ error: manifest.detail });
        return;
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res
        .status(200)
        .send(
          renderHlsManifest(
            manifest,
            (segmentId) =>
              `/programmes/${encodeURIComponent(runId)}/segments/${encodeURIComponent(segmentId)}`,
          ),
        );
    })();
  });

  /**
   * One segment's bytes, if the cursor has published it.
   *
   * The authority is asked again here. A client holding a manifest from thirty
   * seconds ago is holding a claim about the past, and the question that
   * matters is what is public now.
   */
  app.get('/programmes/:runId/segments/:segmentId', (req, res) => {
    void (async () => {
      const runId = await admit(req, res);
      if (runId === null) return;

      const segmentId = String(req.params['segmentId'] ?? '');
      if (!SEGMENT_ID.test(segmentId)) {
        res.status(404).json({ error: 'No such segment.' });
        return;
      }

      const authorization = deps.egress.authorizeSegment(runId, segmentId);
      if (!authorization.allowed) {
        if (authorization.refusal === 'not-yet-public') {
          // Counted, not attributed: the fact is operationally interesting and
          // the requester's identity is not ours to keep for it.
          deps.onFuturePeek?.(runId);
        }
        res.status(statusFor(authorization.refusal)).json({ error: 'No such segment.' });
        return;
      }

      const path = resolve(authorization.storageReference);
      if (path !== spoolRoot && !path.startsWith(`${spoolRoot}${sep}`)) {
        /*
         * Unreachable if the store is behaving. Logged as an error rather than
         * swallowed, because if it ever fires the store is handing out
         * references it did not mint, and that is a far larger problem than
         * one failed request.
         */
        logger.error('Programme segment resolved outside the spool', { runId });
        res.status(500).json({ error: 'Segment unavailable.' });
        return;
      }

      let sizeBytes: number;
      try {
        sizeBytes = (await stat(path)).size;
      } catch {
        // Published, and its bytes are gone: retention, or a lost volume.
        res.status(410).json({ error: 'Segment no longer held.' });
        return;
      }

      res.setHeader('Content-Type', 'video/iso.segment');
      res.setHeader('Accept-Ranges', 'bytes');
      /*
       * `private`, never `public`. A published segment never changes, so it is
       * immutable to the viewer who fetched it -- but a shared cache holding it
       * would answer for the NEXT viewer without the access check above ever
       * running, which is how a private broadcast leaks.
       */
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

      const range = parseRangeHeader(req.headers.range, sizeBytes);
      if (range === 'invalid') {
        res.status(416).setHeader('Content-Range', `bytes */${sizeBytes}`).json({
          error: 'Invalid segment range requested.',
        });
        return;
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
        createReadStream(path, { start: range.start, end: range.end }).pipe(res);
        return;
      }
      res.setHeader('Content-Length', String(sizeBytes));
      createReadStream(path).pipe(res);
    })();
  });
}
