/** @author masterzee001 */
/**
 * ONE READING OF THE ROUTE EVIDENCE, for the chips that must agree with Page 06.
 *
 * THREE FACTS THAT ARE NOT ONE FACT, and the whole reason this file is careful:
 *
 *   Route quality analysis   IMPLEMENTED -- measured, per route, per stage
 *   Recommended delay        IMPLEMENTED, ADVISORY -- what a buffer SHOULD be
 *   Broadcast safety buffer  NOT IMPLEMENTED -- nothing holds the output back
 *
 * A recommendation is not a buffer. An operator who reads one as the other
 * believes they have seconds in hand to cut away from something, and they have
 * none. So this module produces a formatted ADVISORY string and never anything
 * an interface could honestly label "current" or "on-air" delay.
 *
 * NOTHING IS RECOMPUTED HERE. The states and the seconds come from
 * `@videofy-live/programme-quality`, which the service already ran; this only
 * folds many routes into the one line a chip has room for.
 */
import type { QualityState, RouteQualityRow } from '@videofy-live/programme-quality';

/** Weakest first, so the fold cannot average a failure away. */
const SEVERITY: Record<QualityState, number> = {
  ready: 0,
  degraded: 1,
  'review-pending': 2,
  unavailable: 3,
};

const WORD: Record<QualityState, string> = {
  ready: 'Ready',
  degraded: 'Degraded',
  'review-pending': 'Review pending',
  unavailable: 'Unavailable',
};

export interface RouteQualitySummary {
  /** The weakest route's word, or null when nothing has been read. */
  readonly quality: string | null;
  /**
   * The advisory recommendation, formatted (e.g. "45 s"), or null when no
   * route evidence supports one. NEVER a measurement of an output delay.
   */
  readonly recommendedDelay: string | null;
}

export const NO_ROUTE_QUALITY: RouteQualitySummary = {
  quality: null,
  recommendedDelay: null,
};

export function summariseRouteQuality(
  rows: readonly RouteQualityRow[] | null,
): RouteQualitySummary {
  // Null means unread, and an empty list means a programme with no routes
  // configured. Neither is an answer about quality, and neither may render as
  // one.
  if (rows === null || rows.length === 0) return NO_ROUTE_QUALITY;

  /*
   * THE WEAKEST ROUTE DECIDES THE WORD, exactly as the weakest STAGE decides a
   * route inside programme-quality. An operator glancing at one chip must not
   * read "Ready" while one of their languages cannot go to air at all.
   */
  const weakest = rows.reduce<QualityState>(
    (worst, row) => (SEVERITY[row.overall] > SEVERITY[worst] ? row.overall : worst),
    'ready',
  );

  /*
   * THE LARGEST RECOMMENDATION WINS, for the same reason: a delay sized for the
   * fastest route protects nothing on the slowest. Routes that recommend
   * nothing -- because they cannot run, or because nothing was measured --
   * contribute nothing rather than dragging the figure down.
   */
  const seconds = rows
    .map((row) => row.recommendedDelay.seconds)
    .filter((value): value is number => value !== null);

  return {
    quality: WORD[weakest],
    recommendedDelay: seconds.length === 0 ? null : `${Math.max(...seconds)} s`,
  };
}
