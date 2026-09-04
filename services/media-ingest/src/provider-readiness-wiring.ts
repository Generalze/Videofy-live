/** @author masterzee001 */
/**
 * The readiness ladder, built from facts this service already holds.
 *
 * The ladder itself is `@videofy-live/programme-quality`: five rungs, each a
 * different question, deliberately separated so no amount of green on one can
 * be mistaken for another. It was written, tested, exported -- and constructed
 * by nothing. A ladder nobody climbs reports no rung at all, which is exactly
 * the shape of defect the rest of this wave has been closing.
 *
 * WHAT EACH RUNG ACTUALLY COMES FROM, and why none of them is inferred:
 *
 *   configured  a credential exists. The weakest fact and the one most often
 *               mistaken for the rest.
 *   healthy     the vendor answered a probe. The boot preflight, not a guess
 *               from the credential being present.
 *   warm        it answers WITHOUT waking up first. The keeper's own answer.
 *               A scale-to-zero deployment is healthy when probed -- the probe
 *               is what woke it -- and returns 503 to the first real request
 *               after it sleeps. That request is the one that opens a
 *               broadcast.
 *   qualified   somebody who reads the language has judged the output. Never
 *               inferred from latency, never from a successful call.
 *   approved    the route document admits this direction for this scope.
 *
 * THE RUNG IS THE LOWEST UNMET STEP, not a score. A provider that is
 * configured, healthy and cold reports `healthy`, and a console showing that
 * is telling an operator the truth about the first sentence of their
 * programme.
 */

import {
  NOT_ASSESSED,
  liveRouteEligibility,
  readinessLevel,
  reviewedQualityFor,
  type LiveEligibility,
  type ProviderReadiness,
  type ReviewEvidence,
  type ReviewedQuality,
} from '@videofy-live/programme-quality';
/**
 * The narrowest thing that answers the readiness questions.
 *
 * Not the registry class: this file needs the records and the scope decision
 * and nothing else, and depending on the whole registry would make every
 * future method on it look like something readiness cares about.
 */
export interface RouteEvidence {
  routes(): readonly {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly modelId: string;
    readonly humanReviewStatus: string;
    readonly reviewEvidence?: {
      readonly engine: string;
      readonly model: string;
      readonly modelVersion: string;
      readonly corpusHash: string;
      readonly corpusVersion: string;
      readonly evaluator: string;
      readonly assessedAt: string;
      readonly method: string;
      readonly score: number;
      readonly scale: string;
      readonly evidenceReference: string;
    };
  }[];
  approvedScopes(sourceLanguage: string, targetLanguage: string): readonly string[];
}
import type { NigerianSynthesisState } from './nigerian-synthesis-route.js';

export interface ProviderReadinessView {
  readonly provider: string;
  readonly readiness: ProviderReadiness;
  /** The lowest unmet step, which is what a console should show. */
  readonly level: string;
  readonly eligibility: LiveEligibility;
}

export interface ReadinessWiringDeps {
  /** The specialist's own account of itself, or null when synthesis is off. */
  readonly nigerian: () => (NigerianSynthesisState & { readonly warm: boolean }) | null;
  /** The route document, or null when none is loaded. */
  readonly registry: () => RouteEvidence | null;
  readonly scope: string;
  readonly sourceLanguage: () => string;
}

/**
 * How a language's human review reaches the ladder.
 *
 * Absent means UNASSESSED, not passed. A deployment with no route document has
 * had nobody judge anything, and reporting that as reviewed would be the one
 * claim in this file that could not be recovered from -- an operator would
 * broadcast a language on the strength of a review that never happened.
 */
function reviewedFor(
  registry: RouteEvidence | null,
  sourceLanguage: string,
  targetLanguage: string,
  scope: string,
): ReviewedQuality {
  if (registry === null) return NOT_ASSESSED;
  const record = registry
    .routes()
    .find(
      (route) =>
        route.sourceLanguage === sourceLanguage && route.targetLanguage === targetLanguage,
    );
  if (record === undefined) return NOT_ASSESSED;
  /*
   * A PASS WITHOUT EVIDENCE IS NOT A PASS. The status says somebody judged
   * this route; the evidence says what they judged. Without a model version
   * and a corpus hash there is nothing to check the judgement against, and
   * nothing to notice going stale when either moves on -- so a document that
   * claims `passed` and carries no evidence reports as unassessed, which is
   * the only answer that cannot put an unreviewed language to air.
   */
  if (record.humanReviewStatus !== 'passed' || record.reviewEvidence === undefined) {
    return NOT_ASSESSED;
  }
  const evidence: ReviewEvidence = {
    sourceLanguage,
    targetLanguage,
    scope: scope as ReviewEvidence['scope'],
    engine: record.reviewEvidence.engine,
    model: record.reviewEvidence.model,
    modelVersion: record.reviewEvidence.modelVersion,
    corpusHash: record.reviewEvidence.corpusHash,
    corpusVersion: record.reviewEvidence.corpusVersion,
    evaluator: record.reviewEvidence.evaluator,
    assessedAt: record.reviewEvidence.assessedAt,
    method: record.reviewEvidence.method as ReviewEvidence['method'],
    score: record.reviewEvidence.score,
    scale: record.reviewEvidence.scale,
    evidenceReference: record.reviewEvidence.evidenceReference,
  };
  /*
   * Checked against what is RUNNING. A qualification is evidence about one
   * model version and one corpus; change either and it describes something
   * that is no longer there.
   */
  return reviewedQualityFor(evidence, {
    modelVersion: record.modelId,
    corpusHash: record.reviewEvidence.corpusHash,
  });
}

/**
 * The Nigerian specialist's readiness, per language it is responsible for.
 *
 * Only this provider for now, because it is the only one in this deployment
 * whose capacity sleeps -- and therefore the only one where `warm` is a
 * different question from `healthy`. The shape is general so the next one
 * costs a caller rather than a redesign.
 */
/**
 * Has somebody who reads this language judged its route fit to broadcast?
 *
 * THE SAME FUNCTION THE LADDER USES, exported rather than reimplemented. A
 * second definition of "qualified" would disagree with the first the moment
 * either learned something -- and the disagreement that matters is a console
 * reporting a language as unreviewed while the catalogue offers it to an
 * operator as ready to air.
 *
 * `approved` is required alongside it: a review is somebody's judgement, and
 * approval is the route document admitting that judgement for this scope.
 * Neither alone puts a language on air.
 */
export function nigerianRouteQualified(
  registry: RouteEvidence | null,
  sourceLanguage: string,
  targetLanguage: string,
  scope = 'programme-live',
): boolean {
  if (registry === null) return false;
  if (!reviewedFor(registry, sourceLanguage, targetLanguage, scope).assessed) return false;
  return registry.approvedScopes(sourceLanguage, targetLanguage).includes(scope);
}

export function nigerianReadiness(deps: ReadinessWiringDeps): readonly ProviderReadinessView[] {
  const state = deps.nigerian();
  if (state === null) return [];
  const registry = deps.registry();
  const source = deps.sourceLanguage();

  return state.languages.map((language) => {
    const readiness: ProviderReadiness = {
      provider: state.specialistProviderId,
      configured: state.specialistConfigured,
      /*
       * Null until the preflight has run: a provider nobody has asked is not
       * healthy, it is UNKNOWN, and presenting unknown as working is how a
       * deployment ships with a vendor it has never spoken to.
       */
      healthy:
        state.preflight === null
          ? null
          : state.preflight.keyConfigured &&
            state.preflight.reachable &&
            state.preflight.problem === null,
      warm: state.specialistConfigured ? state.warm : null,
      qualified: reviewedFor(registry, source, language, deps.scope),
      approved: registry?.approvedScopes(source, language).includes(deps.scope) === true,
    };
    return {
      provider: readiness.provider,
      readiness,
      level: readinessLevel(readiness),
      eligibility: liveRouteEligibility(readiness),
    };
  });
}
