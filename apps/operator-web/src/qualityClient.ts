/** @author masterzee001 */
/**
 * The real route-quality client. No cache, no local derivation, no defaults.
 *
 * EVERY STATE ON PAGE 06 IS COMPUTED BY THE SERVICE. This file transports the
 * answer and nothing else: there is no readiness rule here, no provider table,
 * and no fallback that turns a failed request into a healthy-looking route. The
 * console asking a second time and computing its own answer is precisely how an
 * operator gets told a direction is ready while the gate refuses it.
 *
 * A FAILURE IS REPORTED AS A FAILURE. `evidenceAvailable: false` and a thrown
 * error are different facts -- the service saying "I cannot answer" versus not
 * answering at all -- and both are carried through rather than flattened into
 * an empty list, which would render as "no problems".
 */

import type { RouteQualityRow } from '@videofy-live/programme-quality';

export interface RouteQualityResponse {
  readonly scope: string;
  /** False when no route document is loaded. NOT the same as zero rows. */
  readonly evidenceAvailable: boolean;
  readonly reason?: string;
  readonly rows: readonly RouteQualityRow[];
}

export class QualityUnavailableError extends Error {
  constructor(detail: string) {
    super(`Route quality is unavailable: ${detail}`);
    this.name = 'QualityUnavailableError';
  }
}

function base(url: string): string {
  return url.replace(/\/$/u, '');
}

/**
 * Ask the service what this programme's routes can do.
 *
 * The direction list is sent explicitly. There is no "all languages" mode,
 * because quality is a property of a DIRECTION and a request that does not name
 * one has not asked a real question.
 */
export async function fetchRouteQuality(
  ingestUrl: string,
  sourceLanguage: string,
  targetLanguages: readonly string[],
): Promise<RouteQualityResponse> {
  const query = new URLSearchParams({
    source: sourceLanguage,
    targets: targetLanguages.join(','),
  });

  let response: Response;
  try {
    response = await fetch(`${base(ingestUrl)}/quality/routes?${query.toString()}`);
  } catch (error) {
    throw new QualityUnavailableError(
      error instanceof Error ? error.message : 'the media service did not respond',
    );
  }

  if (!response.ok) {
    // A 404 means this deployment has no quality surface at all; a 500 means it
    // broke. Both are "we do not know", and neither is "everything is fine".
    throw new QualityUnavailableError(`the media service answered ${response.status}`);
  }

  const body = (await response.json()) as Partial<RouteQualityResponse>;
  return {
    scope: typeof body.scope === 'string' ? body.scope : 'unknown',
    evidenceAvailable: body.evidenceAvailable === true,
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    rows: Array.isArray(body.rows) ? body.rows : [],
  };
}
