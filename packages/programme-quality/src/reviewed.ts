/** @author masterzee001 */
/**
 * Whether a route's output is any GOOD, which is not a thing a clock can tell.
 *
 * The third of three claims that used to share one word. Readiness says a
 * route can operate. Performance says how fast it is operating. Neither has
 * anything to say about whether the Yoruba coming out is Yoruba a Yoruba
 * speaker would accept, and the danger this module exists to remove is the
 * quiet implication that fast means accurate.
 *
 * That implication has already cost this product once: an engine translated
 * Hausa business sentences into Qur'anic register, promptly and reliably,
 * with every latency healthy. No amount of runtime telemetry would ever have
 * found it. A person who reads Hausa found it in a minute.
 *
 * So the default is NOT ASSESSED, and it stays that way until somebody
 * qualified has looked. "Not assessed" is an honest, publishable state. A
 * green tick inferred from p95 is not.
 */

import type { ServiceScope } from '@videofy-live/translation-routes';

/** How the judgement was reached, so a reader can weigh it. */
export type ReviewMethod =
  /** A speaker of the target language read the output and scored it. */
  | 'human-review'
  /** Scored against reference translations by an automatic metric. */
  | 'reference-corpus'
  /** A human reviewed the automatic scoring rather than the output itself. */
  | 'reviewed-automatic';

export interface ReviewEvidence {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly scope: ServiceScope;
  /** Exactly what was judged. A new model version is a new judgement. */
  readonly engine: string;
  readonly model: string;
  readonly modelVersion: string;
  /**
   * Which corpus, by content hash.
   *
   * By hash rather than by name because "the Nigerian corpus" changes, and an
   * assessment against last month's corpus is evidence about last month's
   * corpus. The hash makes a stale qualification visible instead of assumed.
   */
  readonly corpusHash: string;
  readonly corpusVersion: string;
  /** Who is accountable for the judgement. A person or a named process. */
  readonly evaluator: string;
  readonly assessedAt: string;
  readonly method: ReviewMethod;
  /** The score, on the scale its method defines. */
  readonly score: number;
  readonly scale: string;
  /** Where the working is kept: a document, a run id, a ticket. */
  readonly evidenceReference: string;
}

export type ReviewedQuality =
  /** Nobody has judged this route. The honest default. */
  | { readonly assessed: false; readonly reason: 'not-assessed' }
  /**
   * It was judged, and the judgement is about a model or corpus that has since
   * moved on. Not the same as unassessed, and not usable as approval.
   */
  | { readonly assessed: false; readonly reason: 'stale'; readonly evidence: ReviewEvidence }
  | { readonly assessed: true; readonly evidence: ReviewEvidence };

export const NOT_ASSESSED: ReviewedQuality = { assessed: false, reason: 'not-assessed' };

/**
 * Is this assessment still about the thing now running?
 *
 * A qualification is evidence about one model version against one corpus.
 * Change either and the evidence describes something that is no longer there,
 * which must be visible rather than inherited.
 */
export function reviewedQualityFor(
  evidence: ReviewEvidence | null,
  running: { readonly modelVersion: string; readonly corpusHash: string },
): ReviewedQuality {
  if (evidence === null) return NOT_ASSESSED;
  const current =
    evidence.modelVersion === running.modelVersion && evidence.corpusHash === running.corpusHash;
  return current ? { assessed: true, evidence } : { assessed: false, reason: 'stale', evidence };
}

/**
 * The sentence a console should show. Never invented, never optimistic.
 *
 * Returned as words rather than a state so that no caller can accidentally
 * render "assessed: false" as an empty cell that reads like a pass.
 */
export function reviewedQualityWords(quality: ReviewedQuality): string {
  if (quality.assessed) {
    return `Reviewed ${quality.evidence.assessedAt.slice(0, 10)} by ${quality.evidence.evaluator}: ${quality.evidence.score} ${quality.evidence.scale}`;
  }
  return quality.reason === 'stale'
    ? 'Reviewed against an earlier model or corpus. Not assessed for what is running now.'
    : 'Not assessed.';
}
