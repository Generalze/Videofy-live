/** @author masterzee001 */
/**
 * THE JOIN. Specialist verdicts, scored, become the route registry's
 * `RouteReviewEvidence` -- typed against that package's own interface, so a
 * field the validator adds is a compile error here rather than a document the
 * registry refuses at the next boot.
 *
 * This is the one module in the repository that imports from BOTH
 * `@videofy-live/language-specialist` and `@videofy-live/translation-routes`.
 * Until it existed the two shared zero imports: verdicts sat in Postgres and
 * approval read a JSON file, and the only bridge was a person retyping numbers
 * into a command line. That is the seam this repository keeps shipping open.
 *
 * THE SPECIALIST SIGNS. Founder's ruling: "specialists sign their review since
 * they already have a profile". So `evaluator` names the specialist -- display
 * name and username from their C7 account, which IS their profile; the
 * specialist application deliberately holds no name of its own -- and never a
 * generic process string on its own. Where several specialists judged the same
 * set the field names them all: "3 qualified Yoruba specialists" is a named
 * process, and the names beside it make it a person-form too. A review nobody's
 * name is attached to is the thing this gate exists to prevent.
 *
 * EMITTING EVIDENCE IS NOT APPROVING A ROUTE. Nothing here writes the route
 * document. The output is a block an operator hands to the promotion command,
 * where the allowlist and live identity verification still apply.
 */
import type { RouteReviewEvidence, ServiceScope } from '@videofy-live/translation-routes';
import {
  ROUTE_QA_METHOD,
  ROUTE_QA_PASS_BARS,
  ROUTE_QA_SCALE,
  ROUTE_QA_SCALE_MAXIMUM,
  meetsPassBar,
  trackNames,
  type RouteQaScopeFamily,
  type RouteQaScore,
} from '@videofy-live/language-specialist';

/** What is known about a reviewer, from their C7 account. */
export interface ReviewerIdentity {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly username: string | null;
}

/**
 * The registry's three scopes, onto the two bar families the founder ruled on.
 *
 * `programme-live` and `call-live` both put words in front of a listener who
 * cannot reread them, which is the distinction that was raised when a stricter
 * bar was discussed. The mapping lives here, at the join, and nowhere else.
 */
export function scopeFamilyOf(scope: ServiceScope): RouteQaScopeFamily {
  return scope === 'messaging' ? 'messaging' : 'live';
}

/**
 * The bar the evidence states. `RouteReviewEvidence` carries ONE
 * `passThreshold`, so it carries the STRICTER of the two families: a block that
 * clears it clears both, and a block that does not is honest about the higher
 * bar. Today the two are the same number, so this is a choice with no
 * consequence; if the founder ever splits them, per-scope evidence blocks are
 * the next step and this is where they would be built.
 */
export const EVIDENCE_PASS_THRESHOLD = Math.max(ROUTE_QA_PASS_BARS.messaging, ROUTE_QA_PASS_BARS.live);

/** One reviewer, as the evidence names them. */
function personLabel(reviewer: ReviewerIdentity): string {
  const name = reviewer.displayName?.trim() ?? '';
  const handle = reviewer.username?.trim() ?? '';
  if (name.length > 0 && handle.length > 0) return `${name} (@${handle})`;
  if (name.length > 0) return name;
  if (handle.length > 0) return `@${handle}`;
  /* The account id is a name of last resort; it is still a name. */
  return reviewer.accountId;
}

/**
 * The `evaluator` field.
 *
 * One reviewer: their name, their handle and their standing. Several: how many
 * qualified specialists agreed, then every name. Both forms name a person; the
 * second also names the process, which is what survives a specialist leaving.
 */
export function evaluatorLabel(reviewers: readonly ReviewerIdentity[], language: string): string {
  const english = trackNames(language)?.english ?? language;
  const names = reviewers.map(personLabel);
  if (names.length === 1) {
    return `${names[0]}, C7 Language Specialist (${english}, qualified, TRANSLATION_REVIEWER)`;
  }
  return (
    `${names.length} qualified ${english} C7 Language Specialists (TRANSLATION_REVIEWER), ` +
    `blind review: ${names.join('; ')}`
  );
}

export interface EvidenceBuildInput {
  readonly score: RouteQaScore;
  readonly modelVersion: string;
  readonly corpusHash: string;
  readonly corpusVersion: string;
  readonly language: string;
  readonly reviewers: readonly ReviewerIdentity[];
  readonly assessedAtMs: number;
  readonly evidenceReference: string;
}

/**
 * Build the block, in the registry's shape, and say whether it clears the bar.
 *
 * Assembled field by field against `RouteReviewEvidence`, so the thirteen
 * fields the validator demands are the thirteen fields this emits. The
 * `approvable` flag is the pass-bar comparison written down; the validator
 * makes the same comparison again and refuses a `passed` status below it.
 */
export function buildRouteReviewEvidence(input: EvidenceBuildInput): {
  readonly evidence: RouteReviewEvidence;
  readonly approvable: boolean;
} {
  const evidence: RouteReviewEvidence = {
    engine: input.score.provider,
    model: input.score.model,
    modelVersion: input.modelVersion,
    corpusHash: input.corpusHash,
    corpusVersion: input.corpusVersion,
    evaluator: evaluatorLabel(input.reviewers, input.language),
    assessedAt: new Date(input.assessedAtMs).toISOString(),
    method: ROUTE_QA_METHOD,
    score: input.score.percent,
    scale: ROUTE_QA_SCALE,
    scaleMaximum: ROUTE_QA_SCALE_MAXIMUM,
    passThreshold: EVIDENCE_PASS_THRESHOLD,
    evidenceReference: input.evidenceReference,
  };
  const approvable =
    meetsPassBar(input.score.percent, 'messaging') && meetsPassBar(input.score.percent, 'live');
  return { evidence, approvable };
}

/**
 * The promotion command an operator would run with this block. A courtesy: the
 * arguments are the block's fields, in the flags the CLI already takes, so the
 * operator does not retype thirteen values -- which is how a corpus hash gets
 * a digit wrong.
 */
export function promotionCommandFor(
  evidence: RouteReviewEvidence,
  direction: { readonly source: string; readonly target: string },
): string {
  const q = (value: string | number): string => JSON.stringify(String(value));
  return [
    'npm run routes:approve -- approve',
    `--source ${q(direction.source)} --target ${q(direction.target)}`,
    '--scope <messaging|programme-live|call-live> --approver <you> --document <path> --dry-run',
    `--review-engine ${q(evidence.engine)} --review-model ${q(evidence.model)}`,
    `--review-model-version ${q(evidence.modelVersion)}`,
    `--review-corpus-hash ${q(evidence.corpusHash)} --review-corpus-version ${q(evidence.corpusVersion)}`,
    `--review-evaluator ${q(evidence.evaluator)} --review-assessed-at ${q(evidence.assessedAt)}`,
    `--review-method ${q(evidence.method)}`,
    `--review-score ${evidence.score} --review-scale ${q(evidence.scale)}`,
    `--review-scale-maximum ${evidence.scaleMaximum} --review-pass-threshold ${evidence.passThreshold}`,
    `--review-reference ${q(evidence.evidenceReference)}`,
  ].join(' \\\n  ');
}
