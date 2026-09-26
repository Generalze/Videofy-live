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
 * set the field names them all: "3 C7 Language Specialists (Yoruba)" is a
 * named process, and the names beside it make it a person-form too. A review
 * nobody's name is attached to is the thing this gate exists to prevent. Each
 * name carries the standing the store READ at emission (`ReviewerStanding`),
 * never a standing assumed from the language.
 *
 * EMITTING EVIDENCE IS NOT APPROVING A ROUTE. Nothing here writes the route
 * document. The output is a block an operator hands to the promotion command,
 * where the allowlist and live identity verification still apply.
 */
import type { RouteReviewEvidence, ServiceScope } from '@videofy-live/translation-routes';
import {
  ROUTE_QA_PASS_BARS,
  ROUTE_QA_SCALE_MAXIMUM,
  meetsPassBar,
  routeQaMethod,
  routeQaScale,
  splitDirection,
  trackNames,
  type QualificationState,
  type RouteQaScopeFamily,
  type RouteQaScore,
} from '@videofy-live/language-specialist';

/**
 * A reviewer's standing in THIS language, read at the moment the evidence is
 * emitted. Not inferred from the fact that they once picked the set up.
 *
 * The first version of the evaluator field wrote "qualified,
 * TRANSLATION_REVIEWER" from the language alone, having read neither the
 * track nor the grant at that moment; a specialist whose track was later
 * suspended still carried evidence calling her qualified. That is a sentence
 * asserting something nothing measured, which is the defect this whole
 * feature exists to stop. Now the store reads both at emission and the label
 * states what was true then, or says nothing.
 */
export interface ReviewerStanding {
  /** Null when no track exists for this account in this language. */
  readonly qualificationState: QualificationState | null;
  /** TRANSLATION_REVIEWER granted for this language, at emission. */
  readonly translationReviewer: boolean;
}

/** What is known about a reviewer, from their C7 account and their track. */
export interface ReviewerIdentity {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly standing: ReviewerStanding;
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
 * A reviewer's standing, in words that were true when they were written.
 *
 * "qualified" appears ONLY when the track read QUALIFIED at emission, and the
 * capability is named only when the grant was found. Anything else is stated
 * as what it is: the state the track was in, and "not held".
 */
function standingLabel(standing: ReviewerStanding): string {
  const track =
    standing.qualificationState === null
      ? 'no track'
      : standing.qualificationState === 'QUALIFIED'
        ? 'qualified'
        : `track ${standing.qualificationState}`;
  const grant = standing.translationReviewer ? 'TRANSLATION_REVIEWER held' : 'TRANSLATION_REVIEWER not held';
  return `${track}, ${grant}`;
}

/**
 * The `evaluator` field.
 *
 * One reviewer: their name, their handle and their standing AT EMISSION.
 * Several: how many specialists judged, then every name with its own standing.
 * Both forms name a person; the second also names the process, which is what
 * survives a specialist leaving. Neither form claims a standing the store did
 * not read at the moment the block was built.
 */
export function evaluatorLabel(reviewers: readonly ReviewerIdentity[], language: string): string {
  const english = trackNames(language)?.english ?? language;
  const named = reviewers.map((reviewer) => `${personLabel(reviewer)} [${standingLabel(reviewer.standing)}]`);
  if (named.length === 1) {
    return `${named[0]}, C7 Language Specialist (${english}; standing as read at emission)`;
  }
  return (
    `${named.length} C7 Language Specialists (${english}; standing per name as read at emission), ` +
    `blind review: ${named.join('; ')}`
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
 * `approvable` flag is the pass-bar comparison written down -- as a ratio,
 * `passed` against `judged`, never a rounded percent -- and `score` carries
 * the exact value, so the validator's own `score >= passThreshold` agrees
 * with it. The sample size and the direction ride in `scale` and `method`,
 * because the registry's shape has no field for them and is not extended.
 */
export function buildRouteReviewEvidence(input: EvidenceBuildInput): {
  readonly evidence: RouteReviewEvidence;
  readonly approvable: boolean;
} {
  const sample = { direction: input.score.direction, judged: input.score.judged, passed: input.score.passed };
  const evidence: RouteReviewEvidence = {
    engine: input.score.provider,
    model: input.score.model,
    modelVersion: input.modelVersion,
    corpusHash: input.corpusHash,
    corpusVersion: input.corpusVersion,
    evaluator: evaluatorLabel(input.reviewers, input.language),
    assessedAt: new Date(input.assessedAtMs).toISOString(),
    method: routeQaMethod(sample),
    score: input.score.percent,
    scale: routeQaScale(sample),
    scaleMaximum: ROUTE_QA_SCALE_MAXIMUM,
    passThreshold: EVIDENCE_PASS_THRESHOLD,
    evidenceReference: input.evidenceReference,
  };
  const approvable = meetsPassBar(sample, 'messaging') && meetsPassBar(sample, 'live');
  return { evidence, approvable };
}

/** The placeholder the operator replaces with the path they saved the block to. */
export const REVIEW_BLOCK_FILE_PLACEHOLDER = '<path to the reviewEvidence block, saved as JSON>';

/**
 * The promotion command an operator would run with this block.
 *
 * NOTHING FROM THE BLOCK IS ON THE COMMAND LINE. The first version quoted
 * the thirteen fields with `JSON.stringify`, which escapes quotes and
 * backslashes and not `$` or backticks -- and the evaluator field is built
 * from a display name the account rules allow both in. A command that exists
 * to be copied and run by an operator was a shell injection. Now the block
 * travels as data: the operator saves the `reviewEvidence` object beside this
 * command to a file and names it with `--review-from`, and the command itself
 * is a fixed template plus two language subtags that have already passed the
 * direction regex (`splitDirection`). A side that does not pass it is
 * written as a placeholder rather than quoted.
 */
export function promotionCommandFor(direction: { readonly source: string; readonly target: string }): string {
  const sides = splitDirection(`${direction.source}->${direction.target}`);
  const source = sides?.source ?? '<source>';
  const target = sides?.target ?? '<target>';
  return [
    'npm run routes:approve -- approve',
    `--source ${source} --target ${target}`,
    '--scope <messaging|programme-live|call-live> --approver <you> --document <path>',
    `--review-from ${REVIEW_BLOCK_FILE_PLACEHOLDER} --dry-run`,
  ].join(' \\\n  ');
}
