/** @author masterzee001 */
/**
 * TWO SURFACES, AND THEY ARE NOT THE SAME SURFACE.
 *
 * The OPERATOR routes configure a programme's creative and require the same
 * authority as Page 05: signed in, and allowed to administer THIS programme,
 * with the programme taken from the authorised path and never from the body.
 *
 * The DELIVERY route is read by anybody watching a programme. It is separate on
 * purpose rather than the operator route with a looser guard, because those
 * drift: a field added for the console -- a draft, a note, a schedule an
 * advertiser has not agreed yet -- would be served to every viewer the moment
 * somebody widened one handler. Two handlers cannot leak into each other by
 * accident.
 *
 * DELIVERY DECIDES EFFECTIVENESS, NOT THE CLIENT. The window is evaluated here
 * against the SERVICE clock. A phone with a wrong date would otherwise show an
 * advert outside the period that was actually sold, and nothing would disagree
 * with it.
 */

import express from 'express';
import {
  HOUSE_CREATIVE,
  SPONSORED_PLACEMENT,
  evaluateEffectiveCreative,
  validateProgrammeCreative,
} from '@videofy-live/shared-types';
import type { DurableSponsoredCreativePort } from './db/programme-sponsored-creative-postgres.js';

export interface SponsoredCreativeCaller {
  readonly accountId: string;
}

export interface SponsoredCreativeRouteDependencies {
  readonly creatives: DurableSponsoredCreativePort;
  readonly callerAccountId: (req: express.Request) => SponsoredCreativeCaller | null;
  readonly mayAdminister: (accountId: string, programmeId: string) => Promise<boolean>;
  /**
   * Does this programme exist at all, for the PUBLIC surface?
   *
   * Required, and deliberately not defaulted to "yes". A house creative exists
   * for every programme, so without this an unknown or mistyped programme id
   * would answer 200 with a perfectly valid-looking advert -- letting anything
   * masquerade as a programme merely because the fallback is universal.
   */
  readonly programmeExists: (programmeId: string) => Promise<boolean>;
  /** Injected so tests can place the clock. Production passes nothing. */
  readonly now?: () => Date;
  readonly onEvent?: (name: string, detail: Record<string, unknown>) => void;
}

function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

/**
 * The revision this operator was looking at, or why it is unusable.
 *
 * Identical strictness to Page 05: `"3"` is fine because HTTP carries strings;
 * `3.5`, `-1`, `""`, `null` and absent are all refused. A missing precondition
 * silently treated as zero would overwrite somebody on the very first save.
 */
function readExpectedRevision(body: unknown): { value: number } | { error: string } {
  const raw = (body as { expectedRevision?: unknown } | undefined)?.expectedRevision;
  if (raw === undefined || raw === null || raw === '') {
    return {
      error:
        'expectedRevision is required. Send the revision you were editing so a ' +
        'change made by somebody else since then is not overwritten.',
    };
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { error: 'expectedRevision must be a whole number, zero or greater.' };
  }
  return { value };
}

export function registerSponsoredCreativeRoutes(
  app: express.Express,
  deps: SponsoredCreativeRouteDependencies,
): void {
  const clock = deps.now ?? (() => new Date());

  async function authorised(
    req: express.Request,
    res: express.Response,
  ): Promise<{ programmeId: string; accountId: string } | null> {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    // FROM THE PATH. A programmeId in the body would let a signed-in operator
    // of one programme write another's advert.
    const programmeId = String(req.params['programmeId'] ?? '').trim();
    if (programmeId === '') {
      res.status(400).json({ error: 'A programme is required.' });
      return null;
    }
    if (!(await deps.mayAdminister(caller.accountId, programmeId))) {
      // 404, not 403: the same tenant-hiding Page 05 uses. Whether a programme
      // exists is information a caller with no authority may not have.
      res.status(404).json({ error: 'No such programme.' });
      return null;
    }
    return { programmeId, accountId: caller.accountId };
  }

  /* ---------------- operator ---------------- */

  app.get(
    '/operator/programmes/:programmeId/sponsored-creative',
    guarded(async (req, res) => {
      const scope = await authorised(req, res);
      if (scope === null) return;
      const stored = await deps.creatives.read(scope.programmeId);
      // The effective state comes from the service, so the console renders a
      // decision rather than making one.
      const effective = evaluateEffectiveCreative(
        scope.programmeId, stored.creative, clock(),
      );
      res.status(200).json({
        programmeId: scope.programmeId,
        revision: stored.revision,
        creative: stored.creative,
        effective,
      });
    }),
  );

  app.put(
    '/operator/programmes/:programmeId/sponsored-creative',
    guarded(async (req, res) => {
      const scope = await authorised(req, res);
      if (scope === null) return;

      const expected = readExpectedRevision(req.body);
      if ('error' in expected) {
        res.status(400).json({ error: expected.error });
        return;
      }

      // VALIDATED BEFORE STORED. An unsafe href never reaches the database, so
      // it can never reach a viewer even if a later reader forgets to check.
      const validated = validateProgrammeCreative(req.body);
      if (!validated.ok) {
        res.status(400).json({
          error: 'That creative cannot be saved.',
          problems: validated.problems,
        });
        return;
      }

      const outcome = await deps.creatives.save(
        scope.programmeId, validated.value, expected.value,
      );

      if (!outcome.ok) {
        deps.onEvent?.('sponsored-creative.conflict', {
          programmeId: scope.programmeId,
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
        });
        res.status(409).json({
          error: 'revision-conflict',
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
        });
        return;
      }

      const effective = evaluateEffectiveCreative(
        scope.programmeId, outcome.creative, clock(),
      );
      res.status(200).json({
        programmeId: scope.programmeId,
        revision: outcome.revision,
        creative: outcome.creative,
        effective,
      });
    }),
  );

  /* ---------------- delivery ---------------- */

  /**
   * What THIS programme's viewers should see right now.
   *
   * Read-only, unauthenticated, and it returns nothing an operator would mind a
   * viewer seeing: the effective creative, its source, and the placement. Not
   * the stored configuration, not the schedule, not the revision -- a viewer
   * has no use for when an advert is due to change, and an advertiser might
   * mind them knowing.
   */
  app.get(
    '/programmes/:programmeId/sponsored-creative',
    guarded(async (req, res) => {
      const programmeId = String(req.params['programmeId'] ?? '').trim();
      if (programmeId === '') {
        res.status(400).json({ error: 'A programme is required.' });
        return;
      }

      /*
       * AN UNKNOWN PROGRAMME IS A 404, not a house creative. Every programme
       * has a house fallback, so answering 200 here would make any string look
       * like a real programme -- a typo in a link would render a plausible page
       * instead of failing.
       */
      if (!(await deps.programmeExists(programmeId))) {
        res.status(404).json({ error: 'No such programme.' });
        return;
      }

      const stored = await deps.creatives.read(programmeId);
      const effective = evaluateEffectiveCreative(programmeId, stored.creative, clock());

      res.status(200).json({
        programmeId: effective.programmeId,
        placement: effective.placement,
        source: effective.source,
        creative: effective.creative,
      });
    }),
  );
}

/** Re-exported so a caller with no store still has the canonical fallback. */
export { HOUSE_CREATIVE, SPONSORED_PLACEMENT };
