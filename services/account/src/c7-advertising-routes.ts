/** @author masterzee001 */
/**
 * The internal surface C7's decision engine reads and writes.
 *
 * INTERNAL ONLY, AND THAT IS THE COMMERCIAL BOUNDARY, not a convenience. These
 * responses carry advertiser names, priorities, caps and spacing -- the facts
 * that make the platform sellable and that a broadcaster reading them would
 * make it unsellable. There is no public variant of this route and there must
 * not be one: what leaves C7 for a client is an id and a duration.
 *
 * THE OPERATOR CANNOT REACH ANY OF IT. No route here accepts an operator
 * session, and none takes a campaign or creative from a caller. A broadcaster
 * offers a break opportunity -- knowledge C7 does not have, about whether a
 * moment would cut somebody off mid-sentence -- and that is the whole of their
 * contribution.
 *
 * IMPRESSIONS ARE IDEMPOTENT AND SAY SO. Recording one that was already
 * recorded answers 200 with `recorded: false` rather than an error: a
 * reconnect replaying a decision is ordinary, and an error would invite a
 * retry loop that is only ever going to get the same answer.
 */

import type express from 'express';
import { internalIngressRequestAllowed } from '@videofy-live/service-env';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import type { C7AdvertisingStore, RecordedImpression } from './db/c7-advertising-postgres.js';

const ID = /^[A-Za-z0-9_.:-]{1,64}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export interface C7AdvertisingRoutesDeps {
  readonly store: C7AdvertisingStore;
  readonly internalAuth: InternalIngressAuthResolution;
  readonly now?: () => number;
}

function presentedToken(req: express.Request): string | undefined {
  return req.header('X-Videofy-Internal-Token') ?? undefined;
}

export function registerC7AdvertisingRoutes(
  app: express.Express,
  deps: C7AdvertisingRoutesDeps,
): void {
  const now = deps.now ?? ((): number => Date.now());

  const internal = (req: express.Request, res: express.Response): boolean => {
    if (internalIngressRequestAllowed(deps.internalAuth, presentedToken(req))) return true;
    /*
     * 404, not 403. An unauthenticated caller learns that this path does not
     * exist for them, rather than that it exists and is guarded -- which is
     * the answer that tells somebody where to keep looking.
     */
    res.status(404).json({ error: 'Not found.' });
    return false;
  };

  const guarded =
    (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response): void => {
      void handler(req, res).catch(() => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'That could not be completed. Try again.' });
        }
      });
    };

  /** Every campaign that could be eligible now. The engine decides which is. */
  app.get(
    '/internal/advertising/campaigns',
    guarded(async (req, res) => {
      if (!internal(req, res)) return;
      const campaigns = await deps.store.eligibleCampaigns(now());
      res.status(200).json({ campaigns });
    }),
  );

  /** What has already run in one broadcast, so caps survive a restart. */
  app.get(
    '/internal/advertising/runs/:runId/impressions',
    guarded(async (req, res) => {
      if (!internal(req, res)) return;
      const runId = String(req.params['runId'] ?? '');
      if (!RUN_ID.test(runId)) {
        res.status(400).json({ error: 'Not a run id.' });
        return;
      }
      res.status(200).json({ impressions: await deps.store.impressionsForRun(runId) });
    }),
  );

  /** Record what ran. Replaying a decision is a no-op, not a second impression. */
  app.post(
    '/internal/advertising/impressions',
    guarded(async (req, res) => {
      if (!internal(req, res)) return;
      const body = (req.body ?? {}) as Partial<RecordedImpression>;
      if (
        typeof body.decisionId !== 'string' ||
        typeof body.runId !== 'string' ||
        typeof body.campaignId !== 'string' ||
        typeof body.creativeId !== 'string' ||
        typeof body.programmeTimeMs !== 'number' ||
        typeof body.durationMs !== 'number' ||
        typeof body.policyVersion !== 'string' ||
        typeof body.origin !== 'string' ||
        typeof body.decidedAtMs !== 'number' ||
        !ID.test(body.decisionId) ||
        !RUN_ID.test(body.runId)
      ) {
        res.status(400).json({ error: 'Not an impression.' });
        return;
      }
      const recorded = await deps.store.recordImpression({
        decisionId: body.decisionId,
        runId: body.runId,
        campaignId: body.campaignId,
        creativeId: body.creativeId,
        programmeTimeMs: body.programmeTimeMs,
        durationMs: body.durationMs,
        policyVersion: body.policyVersion,
        origin: body.origin,
        decidedAtMs: body.decidedAtMs,
      });
      // Not an error when it was already there: a reconnect replaying a
      // decision is ordinary, and an error would invite a pointless retry.
      res.status(200).json({ recorded });
    }),
  );

  /**
   * What a client should play for a creative it has been told to play.
   *
   * The ONLY advertising route with a public shape, and it carries a media URL
   * and a duration -- nothing about who bought it, what it cost, or why it
   * won. A viewer cannot use this to choose an advert: they can only ask about
   * one the timeline has already told them is theirs.
   */
  app.get(
    '/advertising/creatives/:creativeId',
    guarded(async (req, res) => {
      const creativeId = String(req.params['creativeId'] ?? '');
      if (!ID.test(creativeId)) {
        res.status(404).json({ error: 'No such creative.' });
        return;
      }
      const media = await deps.store.creativeMedia(creativeId);
      if (media === null) {
        res.status(404).json({ error: 'No such creative.' });
        return;
      }
      res.status(200).json({ creativeId, ...media });
    }),
  );
}
