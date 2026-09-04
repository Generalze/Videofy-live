/** @author masterzee001 */
/**
 * Five separate facts about a provider that have been travelling as one.
 *
 * "Configured" has been doing the work of all of them. A credential in an
 * environment variable proves somebody pasted a string; it does not prove the
 * instance answers, that it will answer without waking up first, that anyone
 * has checked its output is the right language, or that this direction is
 * approved to carry a live audience.
 *
 * They are kept apart here because collapsing them is how a route reaches an
 * audience on the strength of a paste. Each is separately unknown -- `null`
 * where it has never been established -- because "not checked" and "checked
 * and false" are different, and only one of them is a defect.
 */

import type { ReviewedQuality } from './reviewed.js';

export interface ProviderReadiness {
  readonly provider: string;
  /** A credential exists. The weakest fact, and the one usually mistaken for the rest. */
  readonly configured: boolean;
  /**
   * The instance answered a probe. Null means nobody has asked it.
   *
   * A provider that has never been probed is not healthy; it is unknown, and
   * an unknown provider must not be presented as a working one.
   */
  readonly healthy: boolean | null;
  /**
   * It answers WITHOUT waking up first.
   *
   * A scale-to-zero deployment is healthy when probed -- the probe is what
   * woke it -- and returns 503 to the first real request that arrives after it
   * has gone back to sleep. That is precisely the request that opens a
   * broadcast, so warmth is tracked as its own fact rather than folded into
   * health, which would report the very deployment that fails a demo as ready.
   */
  readonly warm: boolean | null;
  /** Somebody who reads the language has judged its output. */
  readonly qualified: ReviewedQuality;
  /** The route authority admits this direction for this scope. */
  readonly approved: boolean;
}

export type LiveEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly blockers: readonly string[] };

/**
 * May this provider carry a live audience on this route?
 *
 * Every one of the five must hold. The list of blockers is returned rather
 * than a single reason because a route is usually short of more than one
 * thing, and telling an operator to fix them one at a time wastes a day per
 * item.
 *
 * The rule that matters most: NO APPROVED LIVE ROUTE MAY DEPEND ON A
 * SCALE-TO-ZERO PROVIDER. If warmth cannot be guaranteed, the route is not
 * eligible -- a 503 on the first sentence of a broadcast is not a degraded
 * experience, it is a broadcast that did not happen.
 */
export function liveRouteEligibility(readiness: ProviderReadiness): LiveEligibility {
  const blockers: string[] = [];
  if (!readiness.configured) blockers.push('no credential is configured');
  if (readiness.healthy === null) blockers.push('the provider has never been probed');
  else if (!readiness.healthy) blockers.push('the provider did not answer its last probe');
  if (readiness.warm === null) blockers.push('warmth is unknown; a cold start would meet the audience');
  else if (!readiness.warm) blockers.push('the provider scales to zero and cannot serve a live route');
  if (!readiness.qualified.assessed) {
    blockers.push(
      readiness.qualified.reason === 'stale'
        ? 'the linguistic assessment is about an earlier model or corpus'
        : 'no linguistic assessment exists for this route',
    );
  }
  if (!readiness.approved) blockers.push('the route authority does not approve this direction');
  return blockers.length === 0 ? { eligible: true } : { eligible: false, blockers };
}

/**
 * The single word a console may show, and never a more flattering one.
 *
 * Deliberately not a colour. The caller decides how to paint it; what it may
 * not do is invent a level the evidence does not support.
 */
export function readinessLevel(readiness: ProviderReadiness): string {
  /*
   * A LADDER, not a set of badges.
   *
   * Each rung requires every rung below it, so a provider can never display a
   * level it has skipped: one that is linguistically qualified but asleep
   * reads as `healthy`, because that is the highest thing continuously true
   * about it. Reporting `qualified` there would be accurate about the
   * translation and quietly wrong about the broadcast.
   */
  if (!readiness.configured) return 'unconfigured';
  if (readiness.healthy !== true) return 'configured';
  if (readiness.warm !== true) return 'healthy';
  if (!readiness.qualified.assessed) return 'warm';
  if (!readiness.approved) return 'qualified';
  return 'approved';
}
