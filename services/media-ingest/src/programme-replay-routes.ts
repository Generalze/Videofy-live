/** @author masterzee001 */
/**
 * The door onto a finished broadcast, and every lock on it.
 *
 * This is the live egress doctrine applied to recordings, and it differs from
 * the live door in one way that matters: a replay has no cursor. There is no
 * "not yet public" here, because the whole programme is finished. What replaces
 * it is a lifecycle -- only `available` is playable -- and a visibility that
 * belongs to the RECORDING rather than to the channel.
 *
 * FOUR CHECKS, IN THIS ORDER, EACH LOAD-BEARING:
 *
 *   1. IS THE RUN ID EVEN A RUN ID. Shape first, before it reaches a map key,
 *      because everything after this treats it as trusted.
 *   2. MAY THIS VIEWER SEE THIS RECORDING. Asked per request, given the whole
 *      record so it can see the channel, the programme and the visibility.
 *      There is no default: a composition that supplies no access policy gets
 *      no routes.
 *   3. IS IT PLAYABLE AT ALL. Asked of the archive at this instant, never
 *      answered by the playlist a client happens to be holding.
 *   4. DOES THE OBJECT LIE INSIDE THE ARCHIVE. Delegated to delivery, which
 *      resolves it rather than trusting the string we wrote down.
 *
 * THE MANIFEST IS NOT A GRANT. Every init and every segment request repeats all
 * four checks. A viewer who fetched a playlist a minute ago and then had their
 * access revoked, or whose recording was deleted in between, holds a list of
 * names and nothing else.
 *
 * NO LISTING, DELIBERATELY. There is no way in here to ask what recordings
 * exist, for a channel or otherwise. An unlisted replay is unlisted precisely
 * because knowing its id is the only way to reach it, and a history endpoint
 * would undo that in one route.
 *
 * INERT BY DESIGN IN THIS WAVE: nothing registers these routes in production.
 * The capability is built and proven; switching it on is a separate decision.
 */

import type express from 'express';
import {
  planReplayPlayback,
  renderReplayVodManifest,
  type ProgrammeReplayArchive,
  type ReplayRecord,
} from '@videofy-live/programme-replay';
import { parseRangeHeader } from './generated-audio-delivery-route.js';
import type {
  ReplayDeliveryRefusal,
  ReplayMediaDelivery,
  ReplayMediaLocator,
  ReplayObject,
} from './programme-replay-delivery.js';
import { logger } from './logger.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** Opaque by contract: ids this service minted, and nothing resembling a path. */
const SEGMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/u;
/**
 * A canonical non-negative decimal integer, and nothing else.
 *
 * NO PRODUCT CEILING. An earlier version of this route accepted at most four
 * digits, which invented a limit the Replay contract does not have: a durable
 * recording whose encoder had restarted ten thousand times would have become
 * unservable because of a regular expression. The bound below is the numeric
 * domain -- what a double can represent exactly -- rather than a guess about
 * how many times an encoder ought to restart.
 *
 * Canonical, so one object has one address: no leading zeros, no sign, no
 * fraction, no exponent. `007` and `7` naming the same material would be two
 * URLs for one thing, and a cache would treat them as two.
 */
const GENERATION_DIGITS = /^(?:0|[1-9][0-9]*)$/u;

/** The generation this path names, or null if the path does not name one. */
export function parseGeneration(raw: string): number | null {
  // Bounded before it is parsed: `Number` on an unbounded string is work a
  // caller should not be able to ask for. Sixteen digits covers every integer
  // a double holds exactly.
  if (raw.length === 0 || raw.length > 16) return null;
  if (!GENERATION_DIGITS.test(raw)) return null;
  const generation = Number(raw);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

/** What an access policy may answer. Anything but `allow` serves no bytes. */
export type ReplayAudienceVerdict = 'allow' | 'sign-in' | 'forbidden' | 'unknown-replay';

/**
 * Who may watch a recording.
 *
 * REQUIRED, with no default offered here on purpose.
 *
 * It is given the whole `ReplayRecord` rather than a run id, because the
 * decision needs the channel, the programme and above all the REPLAY's own
 * visibility -- which is public/unlisted/private and is not the channel's
 * public/private/locked. Handing this a run id would force it to look the
 * record up again and invite it to answer on the channel's terms.
 *
 * The three tiers mean:
 *
 *   public   - an ordinary viewer may be allowed.
 *   unlisted - holding the link may be enough; nothing here lists it.
 *   private  - an explicit decision is required. Knowing the run id is not one.
 *
 * What "explicit" means in production is an authority this wave does not have,
 * which is why it is injected rather than invented.
 */
export interface ReplayAudienceAccess {
  mayView(
    record: ReplayRecord,
    request: express.Request,
  ): Promise<ReplayAudienceVerdict> | ReplayAudienceVerdict;
}

/** Something an operator should see, carrying no path and no viewer identity. */
export interface ReplayDeliveryProblem {
  readonly runId: string;
  readonly refusal: ReplayDeliveryRefusal;
  readonly object: 'initialisation' | 'segment';
}

export interface ProgrammeReplayRoutesDeps {
  readonly archive: ProgrammeReplayArchive;
  readonly access: ReplayAudienceAccess;
  readonly delivery: ReplayMediaDelivery;
  /** Counted for an operator: archived material that would not serve. */
  readonly onDeliveryProblem?: (problem: ReplayDeliveryProblem) => void;
}

/**
 * A private recording and a recording that does not exist answer identically.
 *
 * Distinguishing them tells an anonymous caller which run ids are real, which
 * is how an unlisted broadcast stops being unlisted.
 */
function denial(res: express.Response, verdict: Exclude<ReplayAudienceVerdict, 'allow'>): void {
  if (verdict === 'sign-in') {
    res.status(401).json({ error: 'Sign in to watch this replay.' });
    return;
  }
  res.status(404).json({ error: 'No such replay.' });
}

/** HTTP for a recording that exists and is not playable. */
function statusForLifecycle(record: ReplayRecord): { readonly status: number; readonly error: string } {
  switch (record.status) {
    case 'recording':
    case 'processing':
      /*
       * 409, not 404 and never a partial playlist. It exists, the viewer may
       * see it, and it is not finished -- a state a player should be told
       * about plainly so it can come back rather than treat the recording as
       * missing.
       */
      return { status: 409, error: 'This replay is not finished yet.' };
    case 'failed':
      // Gone in the sense that matters: it will never be playable, so a player
      // should stop rather than retry.
      return { status: 410, error: 'This replay was not completed.' };
    case 'expired':
    case 'deleted':
      return { status: 410, error: 'This replay is no longer available.' };
    case 'available':
      return { status: 200, error: '' };
  }
}

export function registerProgrammeReplayRoutes(
  app: express.Express,
  deps: ProgrammeReplayRoutesDeps,
): void {
  /**
   * Everything that must be true before a byte or a line is produced.
   *
   * Repeated on EVERY request, including the ones whose names came from a
   * manifest this service wrote a minute ago.
   */
  const admit = async (
    req: express.Request,
    res: express.Response,
  ): Promise<ReplayRecord | null> => {
    const runId = String(req.params['runId'] ?? '');
    if (!RUN_ID.test(runId)) {
      res.status(404).json({ error: 'No such replay.' });
      return null;
    }

    let record: ReplayRecord | null;
    try {
      record = await deps.archive.describe(runId);
    } catch {
      // The port promises not to throw; an implementation that does must not
      // take the service with it.
      res.status(503).json({ error: 'Replay is unavailable.' });
      return null;
    }
    if (record === null) {
      res.status(404).json({ error: 'No such replay.' });
      return null;
    }

    /*
     * THE URL NAMES THE RECORDING; THE RECORD ONLY CLAIMS TO.
     *
     * `runId` here has been shape-checked and is what the viewer asked for.
     * `record.identity.runId` was read out of durable metadata, and everything
     * downstream -- which access decision is taken, which directory delivery
     * will trust -- keys on the run identity. Letting the record supply it
     * would hand the untrusted side the choice of the very boundary meant to
     * constrain it: a state file edited to claim another run would move the
     * whole request onto that run's material.
     *
     * They must be the same, and disagreeing is an archive-integrity fault
     * rather than a viewer's problem. The other identity is never named back.
     */
    if (record.identity.runId !== runId) {
      logger.error('Replay state claims a different run from the one requested', { runId });
      res.status(503).json({ error: 'Replay is unavailable.' });
      return null;
    }

    const verdict = await deps.access.mayView(record, req);
    if (verdict !== 'allow') {
      denial(res, verdict);
      return null;
    }
    return record;
  };

  /** Admission, plus the requirement that there is something to play. */
  const admitPlayable = async (
    req: express.Request,
    res: express.Response,
  ): Promise<ReplayRecord | null> => {
    const record = await admit(req, res);
    if (record === null) return null;
    if (record.status !== 'available') {
      const outcome = statusForLifecycle(record);
      res.status(outcome.status).json({ error: outcome.error });
      return null;
    }
    return record;
  };

  /**
   * The whole programme, as a VOD playlist.
   *
   * NEVER CACHED. A recording can be deleted or expire between one request and
   * the next, and a shared cache holding this would keep handing out a map to
   * material an operator has withdrawn.
   */
  app.get('/replays/:runId/playlist.m3u8', (req, res) => {
    void (async () => {
      const record = await admitPlayable(req, res);
      if (record === null) return;

      const playback = planReplayPlayback(record);
      if (!playback.playable) {
        /*
         * Available, and not renderable. Refused rather than patched, and the
         * REPLAY IS NOT MUTATED: delivery finding a problem is not authority to
         * rewrite a lifecycle the archive already committed.
         */
        logger.error('Replay is available but cannot be rendered', {
          runId: record.identity.runId,
          refusal: playback.refusal,
        });
        res.status(503).json({ error: 'This replay cannot be played.' });
        return;
      }

      const runId = encodeURIComponent(record.identity.runId);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(
        renderReplayVodManifest(playback.plan, {
          init: (generation) => `/replays/${runId}/init/${String(generation)}`,
          segment: (segmentId) => `/replays/${runId}/segments/${encodeURIComponent(segmentId)}`,
        }),
      );
    })();
  });

  /** The initialisation material for one encoder generation. */
  app.get('/replays/:runId/init/:generation', (req, res) => {
    void (async () => {
      const record = await admitPlayable(req, res);
      if (record === null) return;

      const generation = parseGeneration(String(req.params['generation'] ?? ''));
      if (generation === null) {
        res.status(404).json({ error: 'No such initialisation object.' });
        return;
      }
      const held = record.initialisations.find((entry) => entry.generation === generation);
      if (held === undefined) {
        res.status(404).json({ error: 'No such initialisation object.' });
        return;
      }

      await serve(req, res, record, 'initialisation', 'video/mp4', {
        kind: 'initialisation',
        runId: record.identity.runId,
        generation,
        reference: held.storageReference,
        expectedBytes: held.bytes,
      });
    })();
  });

  /** One archived fragment. */
  app.get('/replays/:runId/segments/:segmentId', (req, res) => {
    void (async () => {
      const record = await admitPlayable(req, res);
      if (record === null) return;

      const segmentId = String(req.params['segmentId'] ?? '');
      if (!SEGMENT_ID.test(segmentId)) {
        res.status(404).json({ error: 'No such segment.' });
        return;
      }
      const held = record.segments.find((entry) => entry.segmentId === segmentId);
      if (held === undefined) {
        res.status(404).json({ error: 'No such segment.' });
        return;
      }

      await serve(req, res, record, 'segment', 'video/iso.segment', {
        kind: 'segment',
        runId: record.identity.runId,
        segmentId: held.segmentId,
        reference: held.storageReference,
        expectedBytes: held.bytes,
      });
    })();
  });

  /**
   * Open, check, and stream one archived object.
   *
   * The refusals collapse to ONE response body. An operator learns which of
   * them happened through the callback and the log; a caller learns only that
   * the material is not available, because "the bytes are the wrong length" and
   * "that reference points outside the archive" are both facts about this
   * host.
   */
  async function serve(
    req: express.Request,
    res: express.Response,
    record: ReplayRecord,
    kind: 'initialisation' | 'segment',
    contentType: string,
    locator: ReplayMediaLocator,
  ): Promise<void> {
    const opening = await deps.delivery.open(locator);
    if (!opening.ok) {
      const problem: ReplayDeliveryProblem = {
        runId: record.identity.runId,
        refusal: opening.refusal,
        object: kind,
      };
      deps.onDeliveryProblem?.(problem);
      if (opening.refusal === 'outside-archive') {
        // Never expected, and far larger than one failed request if it fires.
        logger.error('Replay object resolved outside the archive', { ...problem });
      } else {
        logger.warn('Replay object could not be served', { ...problem });
      }
      res.status(503).json({ error: 'Replay media is unavailable.' });
      return;
    }

    const object: ReplayObject = opening.object;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    /*
     * `private`, never `public`. An archived object never changes, so it is
     * immutable to the viewer who fetched it -- but a shared cache holding it
     * would answer for the NEXT viewer without the access check above ever
     * running, which is how a private recording leaks.
     */
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    const range = parseRangeHeader(req.headers.range, object.sizeBytes);
    if (range === 'invalid') {
      await object.close();
      res
        .status(416)
        .setHeader('Content-Range', `bytes */${object.sizeBytes}`)
        .json({ error: 'Invalid range requested.' });
      return;
    }

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${object.sizeBytes}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      object.stream(range).pipe(res);
      return;
    }
    res.setHeader('Content-Length', String(object.sizeBytes));
    object.stream(null).pipe(res);
  }
}
