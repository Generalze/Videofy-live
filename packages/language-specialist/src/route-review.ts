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
 * THE FLOOR UNDER A SCORE. A (direction, provider, model) group with fewer
 * judged items than this produces NO score -- not a low one and not a high
 * one, the same rule already applied to a group with zero judgements.
 *
 * It exists because a percentage over a handful of sentences is arithmetic
 * wearing the costume of evidence. `MIN_QA_SET_ITEMS` floors the whole SET;
 * it says nothing about the groups the set is cut into, so a ten-item set
 * that was nine of one engine and one of another yielded a group of one, that
 * one item passed, and 100% cleared the bar above. A judged item is one
 * verdict, so a ten-item group reaches the floor when two specialists have
 * both finished it; a group that cannot reach the floor is reported as such,
 * with its count, and never as a number.
 */
export const ROUTE_QA_MIN_JUDGED_PER_GROUP = 20;

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
export const ROUTE_QA_SCALE_MAXIMUM = 100;

/**
 * The procedure, in one sentence, for `RouteReviewEvidence.method`. Stated
 * here so the evidence and the code that produced it cannot describe two
 * different procedures. `routeQaMethod` appends what THIS block measured.
 */
export const ROUTE_QA_METHOD =
  'C7 blind specialist review: each item judged on the eight packet criteria with engine ' +
  'identity withheld; an item passes when no yes/no criterion takes its adverse answer ' +
  '(meaning preserved, not reversed, nothing omitted or invented, names and numbers intact, ' +
  'trusted in a real chat) and, where asked, the output is observed to be in the target ' +
  'language; score is the exact percent of judged items passing, per direction and model, ' +
  `over no fewer than ${ROUTE_QA_MIN_JUDGED_PER_GROUP} judged items.`;

/** What one block's scale and method have to say about the block itself. */
export interface RouteQaSample {
  readonly direction: string;
  readonly judged: number;
  readonly passed: number;
}

/**
 * The `scale` field, WITH the sample size and the direction in it.
 *
 * `RouteReviewEvidence` carries a corpusHash naming a whole set and a score
 * computed over one slice of it, and has no field for the slice. So the two
 * free-text fields carry it: a reader of "82" must be able to see whether it
 * was 41 of 50 or 9 of 11, and which direction it describes, without the
 * database. The registry's shape is fixed and other systems read it; nothing
 * is added to it.
 */
export function routeQaScale(sample: RouteQaSample): string {
  return `percent of judged items passing: ${sample.passed} of ${sample.judged} items passed, ${sample.direction}`;
}

/** The `method` field: the procedure, then what this block measured. */
export function routeQaMethod(sample: RouteQaSample): string {
  return (
    `${ROUTE_QA_METHOD} This block: ${sample.direction}, ${sample.passed} of ${sample.judged} ` +
    'judged items passed.'
  );
}

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
  /**
   * `passed * 100 / judged`, EXACT. Not rounded: 50 of 61 is 81.967..., and
   * a value rounded to 82.0 before the comparison cleared a bar it had not
   * met. Round with `displayPercent` for a screen, never before comparing.
   */
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

/** A percent as a screen shows it: one decimal place. For display only. */
export function displayPercent(percent: number): number {
  return round1(percent);
}

/**
 * A (direction, provider, model) group that has judgements but not enough
 * of them to be scored. Reported with its count so the operator screen can
 * say so plainly, and with no percent so nothing can be acted on.
 */
export interface RouteQaUnscoredGroup {
  readonly direction: string;
  readonly provider: string;
  readonly model: string;
  readonly judged: number;
  /** How many judged items a score needs: `ROUTE_QA_MIN_JUDGED_PER_GROUP`. */
  readonly needed: number;
  readonly reviewerAccountIds: readonly string[];
}

export interface RouteQaScoring {
  /** Every group at or above the floor, in first-seen order. */
  readonly scores: readonly RouteQaScore[];
  /** Every group below it, in first-seen order. Never a percent. */
  readonly unscored: readonly RouteQaUnscoredGroup[];
}

/**
 * Score every (direction, provider, model) present in the judgements.
 *
 * Groups on the identity the candidate carries; never on position, category
 * or text. Returns groups in first-seen order so a caller can present them
 * stably. A group with zero judgements does not appear at all, and a group
 * with fewer than `ROUTE_QA_MIN_JUDGED_PER_GROUP` appears under `unscored`
 * with its count and no percent: inventing one would be a score for a review
 * that was not big enough to be one.
 */
export function scoreRouteQa(judged: readonly JudgedCandidate[]): RouteQaScoring {
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
  const scores: RouteQaScore[] = [];
  const unscored: RouteQaUnscoredGroup[] = [];
  for (const group of groups.values()) {
    if (group.judged < ROUTE_QA_MIN_JUDGED_PER_GROUP) {
      unscored.push({
        direction: group.direction,
        provider: group.provider,
        model: group.model,
        judged: group.judged,
        needed: ROUTE_QA_MIN_JUDGED_PER_GROUP,
        reviewerAccountIds: group.reviewers,
      });
      continue;
    }
    scores.push({
      direction: group.direction,
      provider: group.provider,
      model: group.model,
      judged: group.judged,
      passed: group.passed,
      /* Multiply first: 41 * 100 / 50 is exactly 82; 41 / 50 * 100 need not be. */
      percent: (group.passed * 100) / group.judged,
      reversed: group.reversed,
      meanNaturalness: round1(group.naturalness / group.judged),
      meanGrammar: round1(group.grammar / group.judged),
      reviewerAccountIds: group.reviewers,
    });
  }
  return { scores, unscored };
}

/**
 * Whether a score clears the bar for a scope family.
 *
 * COMPARED AS A RATIO, NEVER AS A ROUNDED NUMBER. `passed * 100 >= bar *
 * judged` is integer arithmetic on both sides, so 41 of 50 meets 82 exactly
 * and 50 of 61 (81.967...) does not, whatever a screen later rounds it to.
 * The previous version took a percent already rounded to one decimal, so
 * 81.95 became 82.0 and passed; the bar is the founder's number and it has
 * to mean what it says. `>=`, because the ruling is "82%" and a route that
 * scores exactly 82 met it.
 */
export function meetsPassBar(
  sample: { readonly passed: number; readonly judged: number },
  scope: RouteQaScopeFamily,
): boolean {
  if (sample.judged <= 0) return false;
  return sample.passed * 100 >= routeQaPassBar(scope) * sample.judged;
}
