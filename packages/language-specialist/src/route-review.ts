/** @author masterzee001 */
/**
 * Turning blind verdicts into a route score, and the bar that score is held to.
 *
 * THE BAR IS THE FOUNDER'S NUMBER, WRITTEN ONCE. She ruled 82%. It is a named
 * constant here, with her ruling in the comment, and nothing else in the
 * repository may re-derive it. When it was raised that a live call might
 * deserve a stricter bar than a message -- a caller cannot reread a sentence --
 * she gave one number, so one number it is. The table below is shaped to carry
 * two so that a second ruling is a one-line change rather than a redesign, and
 * both rows currently point at the same constant on purpose.
 *
 * THE CRITERIA ARE THE ONES THE SPECIALIST WAS ASKED. There is no ninth question
 * and no private weighting. `REVIEW_CRITERIA` in `blind-review.ts` already says,
 * per yes/no question, which answer is the adverse one, and it says so
 * precisely so that summarising code does not carry its own table. An item
 * PASSES when no yes/no criterion took its adverse answer and -- where the
 * target language asks -- the output was observed to be in the target language.
 * The two 1-5 scores do not decide a pass; they are averaged and reported,
 * because "natural" is a matter of degree and "reversed" is not.
 *
 * `meaningReversed` is the decisive criterion and it stays decisive: a reversed
 * item fails whatever else was answered, and the count of reversed items is
 * reported beside the score so a route that scores 85% with three reversals in
 * forty is visible for what it is.
 *
 * ONE SCORE PER (DIRECTION, PROVIDER, MODEL). A QA set may hold sentences from
 * more than one engine -- the Yoruba packet is a blind head-to-head, 68 OPUS-MT
 * and 68 M2M100 -- and a score across both would be half about a model nobody
 * is approving. Grouping is on the identity the candidate carries, which the
 * reviewer never saw: this is the one place the blind is lifted, on the server,
 * after the verdict is recorded.
 */
import { REVIEW_CRITERIA, observedLanguageQuestion, type ReviewVerdict, type YesNo } from './blind-review.js';
import { splitDirection } from './qa-set.js';

/**
 * THE PASS BAR. Founder's ruling, 2026-09-26: "82%". Below it a route is not
 * approvable on that evidence. Percent of judged items passing, per
 * (direction, provider, model).
 */
export const ROUTE_QA_PASS_BAR_PERCENT = 82;

/**
 * The bar per scope family. Two rows, one number: see the module note. The
 * account service maps the registry's three service scopes onto these two
 * (`messaging` -> messaging; `programme-live` and `call-live` -> live).
 */
export const ROUTE_QA_PASS_BARS = {
  messaging: ROUTE_QA_PASS_BAR_PERCENT,
  live: ROUTE_QA_PASS_BAR_PERCENT,
} as const;

export type RouteQaScopeFamily = keyof typeof ROUTE_QA_PASS_BARS;

export function routeQaPassBar(scope: RouteQaScopeFamily): number {
  return ROUTE_QA_PASS_BARS[scope];
}

/** The scale the evidence states, as the validator wants it: floor 0, higher is better. */
export const ROUTE_QA_SCALE = 'percent of judged items passing';
export const ROUTE_QA_SCALE_MAXIMUM = 100;

/**
 * The method, in one sentence, for `RouteReviewEvidence.method`. Stated here
 * so the evidence and the code that produced it cannot describe two different
 * procedures.
 */
export const ROUTE_QA_METHOD =
  'C7 blind specialist review: each item judged on the eight packet criteria with engine ' +
  'identity withheld; an item passes when no yes/no criterion takes its adverse answer ' +
  '(meaning preserved, not reversed, nothing omitted or invented, names and numbers intact, ' +
  'trusted in a real chat) and, where asked, the output is observed to be in the target ' +
  'language; score is the percent of judged items passing, per direction and model.';

/**
 * Whether ONE verdict passes its item.
 *
 * Reads `REVIEW_CRITERIA` for which answer is adverse rather than restating it.
 * A criterion with no `adverse` is a 1-5 score and does not decide.
 */
export function itemPasses(verdict: ReviewVerdict, targetLanguage: string): boolean {
  for (const criterion of REVIEW_CRITERIA) {
    if (criterion.kind !== 'yes-no' || criterion.adverse === undefined) continue;
    const answer = (verdict as unknown as Record<string, unknown>)[criterion.key] as YesNo;
    if (answer === criterion.adverse) return false;
  }
  /*
   * Where the target language asks "what language is this actually in", the
   * first option is the target language itself (see `blind-review.ts`) and
   * anything else -- a neighbour, Other, Unsure -- is not a pass. "Unsure" is
   * honest and is not counted against the reviewer; it is counted against the
   * item, because a sentence a fluent speaker cannot place is not one to put in
   * somebody's ear.
   */
  const asks = observedLanguageQuestion(targetLanguage);
  if (asks !== null) {
    return verdict.observedLanguage === asks.options[0];
  }
  return true;
}

/** One verdict, joined back to the engine it was about. The un-blinded row. */
export interface JudgedCandidate {
  readonly direction: string;
  readonly provider: string;
  readonly model: string;
  readonly reviewerAccountId: string;
  readonly verdict: ReviewVerdict;
}

/** The score for one (direction, provider, model). */
export interface RouteQaScore {
  readonly direction: string;
  readonly provider: string;
  readonly model: string;
  /** Verdicts counted. Several specialists on one item are several judgements. */
  readonly judged: number;
  readonly passed: number;
  /** `passed / judged * 100`, to one decimal place. */
  readonly percent: number;
  /** Items marked meaning REVERSED. Reported beside the score, never folded into it. */
  readonly reversed: number;
  readonly meanNaturalness: number;
  readonly meanGrammar: number;
  /** Who judged, distinct, in first-seen order. Named in the evidence. */
  readonly reviewerAccountIds: readonly string[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Score every (direction, provider, model) present in the judgements.
 *
 * Groups on the identity the candidate carries; never on position, category
 * or text. Returns groups in first-seen order so a caller can present them
 * stably, and returns nothing for an engine with no judged items -- a group
 * with zero judgements has no percent, and inventing one would be a score for
 * a review nobody performed.
 */
export function scoreRouteQa(judged: readonly JudgedCandidate[]): readonly RouteQaScore[] {
  const groups = new Map<
    string,
    {
      direction: string;
      provider: string;
      model: string;
      judged: number;
      passed: number;
      reversed: number;
      naturalness: number;
      grammar: number;
      reviewers: string[];
    }
  >();
  for (const row of judged) {
    const key = `${row.direction}::${row.provider}::${row.model}`;
    const group = groups.get(key) ?? {
      direction: row.direction,
      provider: row.provider,
      model: row.model,
      judged: 0,
      passed: 0,
      reversed: 0,
      naturalness: 0,
      grammar: 0,
      reviewers: [],
    };
    const target = splitDirection(row.direction)?.target ?? row.direction;
    group.judged += 1;
    if (itemPasses(row.verdict, target)) group.passed += 1;
    if (row.verdict.meaningReversed === 'yes') group.reversed += 1;
    group.naturalness += row.verdict.naturalness;
    group.grammar += row.verdict.grammar;
    if (!group.reviewers.includes(row.reviewerAccountId)) group.reviewers.push(row.reviewerAccountId);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    direction: group.direction,
    provider: group.provider,
    model: group.model,
    judged: group.judged,
    passed: group.passed,
    percent: round1((group.passed / group.judged) * 100),
    reversed: group.reversed,
    meanNaturalness: round1(group.naturalness / group.judged),
    meanGrammar: round1(group.grammar / group.judged),
    reviewerAccountIds: group.reviewers,
  }));
}

/**
 * Whether a score clears the bar for a scope family. `>=`, because the ruling
 * is "82%" and a route that scores exactly 82.0 met it.
 */
export function meetsPassBar(percent: number, scope: RouteQaScopeFamily): boolean {
  return percent >= routeQaPassBar(scope);
}
