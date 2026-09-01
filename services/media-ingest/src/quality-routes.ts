/** @author masterzee001 */
/**
 * WHAT THE OPERATOR CONSOLE IS TOLD ABOUT ROUTE QUALITY.
 *
 * The console must not work this out. Readiness derived in React is a second
 * answer to a question this service already answers when it builds a request,
 * and the moment the two disagree an operator is told a route is ready while
 * the gate refuses it. So the composition happens HERE, from the same registry
 * the gate uses and the same capability catalogue the session builds from, and
 * the console renders the result.
 *
 * NO EVIDENCE MEANS NO ANSWER. When the route document failed to load, the gate
 * refuses every direction; this endpoint reports that it cannot answer rather
 * than returning an empty list, because an empty list renders as "no problems".
 * That asymmetry -- failing closed at the gate but failing silent at the
 * console -- is exactly how a deployment looks healthy while translating
 * nothing.
 */

import type { Express, Request, Response } from 'express';
import {
  deriveRouteQuality,
  type RouteQualityRow,
} from '@videofy-live/programme-quality';
import type { ServiceScope } from '@videofy-live/translation-routes';
import type { TargetLanguageCapability } from '@videofy-live/shared-types';
import type { RouteEvidenceSource } from './translation-gate-wiring.js';

export interface QualityRoutesDeps {
  /** The registry the gate loaded, or null when none did. */
  readonly registry: RouteEvidenceSource | null;
  /** The deployment's capability catalogue, read fresh per request. */
  readonly catalogue: () => readonly TargetLanguageCapability[];
  /** The scope this service runs under. Never widened by a query parameter. */
  readonly scope: ServiceScope;
}

/** Comma-separated tags, emptied of blanks. Never defaulted to "everything". */
function parseLanguages(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag !== '');
}

export function registerQualityRoutes(app: Express, deps: QualityRoutesDeps): void {
  app.get('/quality/routes', (req: Request, res: Response) => {
    const sourceLanguage = String(req.query['source'] ?? '').trim().toLowerCase();
    const targets = parseLanguages(req.query['targets']);

    if (sourceLanguage === '') {
      res.status(400).json({
        error: 'source-required',
        message: 'A source language is required: quality is directional.',
      });
      return;
    }

    /*
     * THE SERVICE CANNOT ANSWER. Reported as its own state, with the reason,
     * so the console shows "unknown" rather than a clean empty table.
     */
    if (deps.registry === null) {
      res.json({
        service: 'media-ingest',
        scope: deps.scope,
        evidenceAvailable: false,
        reason:
          'No translation route document is loaded, so no route can be described. ' +
          'Every direction is refused at the gate; nothing here is merely unlisted.',
        rows: [],
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const catalogue = deps.catalogue();
    const find = (language: string): TargetLanguageCapability | null =>
      catalogue.find((entry) => entry.language.toLowerCase() === language) ?? null;

    const registry = deps.registry;
    const rows: RouteQualityRow[] = targets.map((targetLanguage) =>
      deriveRouteQuality({
        sourceLanguage,
        targetLanguage,
        scope: deps.scope,
        // The SAME decision the gate would make for this direction.
        decision: registry.mayTranslate(sourceLanguage, targetLanguage, deps.scope),
        sourceCapability: find(sourceLanguage),
        targetCapability: find(targetLanguage),
      }),
    );

    res.json({
      service: 'media-ingest',
      scope: deps.scope,
      evidenceAvailable: true,
      rows,
      timestamp: new Date().toISOString(),
    });
  });
}
