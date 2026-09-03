/** @author masterzee001 */
/**
 * What a live broadcast is actually doing, for the console that must say so.
 *
 * Page 06 has been describing configuration and calling it quality, and Page
 * 10 has had no way to show an output cursor because none existed. Both now
 * have somewhere to ask, and every answer here distinguishes the three things
 * that have been collapsed:
 *
 *   what a route CAN do       readiness, computed from approval and capability
 *   what it IS doing          measured, from samples taken as work completed
 *   whether it is any GOOD    judged by people, and absent until they have
 *
 * NO SAMPLES IS AN ANSWER. A route that has done nothing reports no samples,
 * never zeroes, so a console cannot render a pipeline that has never run as
 * one performing perfectly. A run this process does not hold answers 404
 * rather than a status full of defaults, because "not running here" and
 * "running with nothing to report" are different facts.
 */

import type express from 'express';
import type { ProgrammePerformanceRegistry } from './programme-performance-registry.js';
import type { ProgrammeTimelineRegistry } from './programme-timeline-registry.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export interface ProgrammeRuntimeRoutesDeps {
  readonly performance: ProgrammePerformanceRegistry;
  readonly timelines: ProgrammeTimelineRegistry;
}

export function registerProgrammeRuntimeRoutes(
  app: express.Express,
  deps: ProgrammeRuntimeRoutesDeps,
): void {
  /**
   * The measured behaviour and safety state of one broadcast.
   *
   * Not authenticated here: this is the same trust boundary the rest of this
   * service's operator surface sits behind, and it carries no content -- only
   * timings, counts and a cursor. It carries no vocabulary, no transcript and
   * no campaign, which is deliberate rather than incidental.
   */
  app.get('/programmes/:runId/runtime', (req, res) => {
    void (async () => {
      const runId = String(req.params['runId'] ?? '');
      if (!RUN_ID.test(runId)) {
        res.status(400).json({ error: 'Not a run id.' });
        return;
      }

      const buffer = deps.timelines.status(runId);
      const tracked = deps.timelines.tracks(runId) || deps.performance.tracks(runId);
      if (!tracked) {
        // A different process may be running it. This one must not answer for
        // a broadcast it knows nothing about.
        res.status(404).json({ error: 'This service is not running that broadcast.' });
        return;
      }

      const durability = await deps.timelines.durable();
      const routes = deps.performance.snapshot(runId).map((route) => ({
        sourceLanguage: route.sourceLanguage,
        targetLanguage: route.targetLanguage,
        stt: route.stt,
        translation: route.translation,
        tts: route.tts,
        endToEnd: route.endToEnd,
      }));

      res.status(200).json({
        runId,
        /*
         * Null when this process holds no timeline for the run: the console
         * must not print a delay for a broadcast whose cursor it cannot see.
         */
        safetyBuffer: buffer,
        /**
         * Whether the safety promise would survive a restart. Reported beside
         * the buffer because a delay that cannot be recovered is a different
         * promise from one that can, and an operator deserves to know which
         * they have before rather than during.
         */
        durability,
        /** Empty means nothing measured, which is not the same as nothing wrong. */
        routes,
        measuredAtMs: Date.now(),
      });
    })().catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'That could not be read.' });
    });
  });
}
