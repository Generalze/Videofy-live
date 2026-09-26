/** @author masterzee001 */
/**
 * The QA set is content-addressed, and the score is derived from the questions
 * the specialist was actually asked.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  QA_SET_REFERENCE_LANGUAGE,
  ROUTE_QA_MIN_JUDGED_PER_GROUP,
  ROUTE_QA_PASS_BARS,
  ROUTE_QA_PASS_BAR_PERCENT,
  canonicalQaSetBody,
  displayPercent,
  itemPasses,
  meetsPassBar,
  qaReviewAccess,
  readQaSetDefinition,
  routeQaMethod,
  routeQaScale,
  scoreRouteQa,
  type QaSetDefinition,
  type ReviewVerdict,
} from '../index.js';

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

const OPUS = { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-en-fr', modelVersion: 'dd7f654' };
const M2M = { provider: 'm2m100', model: 'facebook/m2m100_418M', modelVersion: 'r1' };

function items(count: number, engine = OPUS, direction = 'en->fr') {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    direction,
    category: 'money',
    sourceText: `source ${index + 1}`,
    candidateText: `candidate ${index + 1}`,
    provider: engine.provider,
    model: engine.model,
  }));
}

const DEFINITION = {
  language: 'fr',
  version: 'review-packets/2026-09-25',
  engines: [OPUS],
  items: items(12),
  sourceReference: 'docs/certification/review-packets/review-fr.csv',
};

const CLEAN: ReviewVerdict = {
  candidateId: 'c',
  meaningPreserved: 'yes',
  meaningReversed: 'no',
  informationOmitted: 'no',
  informationInvented: 'no',
  namesNumbersCorrupted: 'no',
  naturalness: 4,
  grammar: 5,
  trustInRealChat: 'yes',
};

describe('reading a QA set definition', () => {
  it('accepts a sound definition and hashes its content', () => {
    const reading = readQaSetDefinition(DEFINITION, digest);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(reading.definition.items).toHaveLength(12);
  });

  it('PIN: the hash follows the content -- one changed sentence is a different set', () => {
    // corpusHash exists so a score can be tied to exactly the sentences that
    // produced it. If an edit kept the hash, old evidence would describe text
    // that no longer exists.
    const a = readQaSetDefinition(DEFINITION, digest);
    const edited = {
      ...DEFINITION,
      items: DEFINITION.items.map((item, index) =>
        index === 3 ? { ...item, candidateText: 'candidate 4 reworded' } : item,
      ),
    };
    const b = readQaSetDefinition(edited, digest);
    expect(a.ok && b.ok && a.sha256 !== b.sha256).toBe(true);
  });

  it('PIN: the hash follows the engine too, not just the words', () => {
    // The same sentences attributed to a different model are different
    // evidence: a score would be filed against the wrong route.
    const a = readQaSetDefinition(DEFINITION, digest);
    const b = readQaSetDefinition({ ...DEFINITION, engines: [{ ...OPUS, modelVersion: 'other' }] }, digest);
    expect(a.ok && b.ok && a.sha256 !== b.sha256).toBe(true);
  });

  it('the source reference is not hashed: fixing a file path is not a new set', () => {
    const a = readQaSetDefinition(DEFINITION, digest);
    const b = readQaSetDefinition({ ...DEFINITION, sourceReference: 'elsewhere' }, digest);
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
  });

  it('PIN: the version label is not hashed either -- a renamed corpus is not a new one', () => {
    // The registry's own words on corpusHash. The same sentences under a
    // second label are the same evidence, and the store refuses them as a
    // duplicate by hash rather than accepting a second set nobody can tell
    // from the first.
    const a = readQaSetDefinition(DEFINITION, digest);
    const b = readQaSetDefinition({ ...DEFINITION, version: 'relabelled' }, digest);
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
  });

  it('the canonical body is stable under key order', () => {
    const shuffled: QaSetDefinition = {
      sourceReference: DEFINITION.sourceReference,
      items: DEFINITION.items,
      engines: DEFINITION.engines,
      version: DEFINITION.version,
      language: DEFINITION.language,
    };
    expect(canonicalQaSetBody(shuffled)).toBe(canonicalQaSetBody(DEFINITION));
  });

  it('PIN: an item from an engine the set does not declare is refused', () => {
    // The evidence cites a model VERSION from the engine table. An item whose
    // engine is not in the table would be scored under a version nobody stated.
    const reading = readQaSetDefinition(
      { ...DEFINITION, items: [...items(11), { ...items(1)[0], ordinal: 12, provider: 'm2m100', model: M2M.model }] },
      digest,
    );
    expect(reading.ok).toBe(false);
    expect(!reading.ok && reading.problems.map((p) => p.kind)).toContain('engine-not-declared');
  });

  it('PIN: a direction that does not touch the set’s language is refused', () => {
    // A French set carrying an en->es row would file Spanish evidence under a
    // French specialist's name.
    const reading = readQaSetDefinition(
      { ...DEFINITION, items: [...items(11), { ...items(1)[0], ordinal: 12, direction: 'en->es' }] },
      digest,
    );
    expect(reading.ok).toBe(false);
    expect(!reading.ok && reading.problems.map((p) => p.kind)).toContain('direction-not-this-language');
  });

  it('PIN: the other side of every direction is English -- the one language every track assesses', () => {
    // A `yo` set used to accept any direction with `yo` on EITHER side, so a
    // `yo->de` item asked a Yoruba specialist to judge German output. Nothing
    // in the Yoruba track measured whether they read German. The programme
    // assesses a person in their language and English only, so English is
    // the only other side a set may carry. Refused at publication.
    expect(QA_SET_REFERENCE_LANGUAGE).toBe('en');
    const yoruba = { ...DEFINITION, language: 'yo', items: items(12, OPUS, 'en->yo') };
    expect(readQaSetDefinition(yoruba, digest).ok).toBe(true);
    expect(readQaSetDefinition({ ...yoruba, items: items(12, OPUS, 'yo->en') }, digest).ok).toBe(true);

    for (const direction of ['yo->de', 'de->yo', 'yo->fr', 'ha->yo', 'yo->yo']) {
      const reading = readQaSetDefinition(
        { ...yoruba, items: [...items(11, OPUS, 'en->yo'), { ...items(1, OPUS, direction)[0], ordinal: 12 }] },
        digest,
      );
      expect(reading.ok, direction).toBe(false);
      if (reading.ok) continue;
      const problem = reading.problems.find((p) => p.kind === 'direction-other-side-not-assessed');
      expect(problem, direction).toBeDefined();
      expect(problem?.kind === 'direction-other-side-not-assessed' && problem.other).toBe(
        direction.split('->').find((side) => side !== 'yo') ?? 'yo',
      );
    }
  });

  it('refuses a duplicate ordinal, a missing version, too few items and an unknown language', () => {
    const dup = readQaSetDefinition(
      { ...DEFINITION, items: [...items(11), { ...items(1)[0], ordinal: 11 }] },
      digest,
    );
    expect(!dup.ok && dup.problems.map((p) => p.kind)).toContain('ordinal-duplicated');
    const noVersion = readQaSetDefinition({ ...DEFINITION, version: '' }, digest);
    expect(!noVersion.ok && noVersion.problems.map((p) => p.kind)).toContain('no-version');
    const few = readQaSetDefinition({ ...DEFINITION, items: items(3) }, digest);
    expect(!few.ok && few.problems.map((p) => p.kind)).toContain('too-few-items');
    const lang = readQaSetDefinition({ ...DEFINITION, language: 'xx' }, digest);
    expect(!lang.ok && lang.problems.map((p) => p.kind)).toContain('not-a-track');
  });

  it('PIN: an empty source or candidate is a real row, not a malformed one', () => {
    // The packets carry blank-input probe rows on purpose, and an engine that
    // returns nothing has produced something a reviewer should judge. A
    // MISSING field is still refused.
    const probe = { ...items(1)[0]!, ordinal: 12, sourceText: '', candidateText: '   ' };
    const reading = readQaSetDefinition({ ...DEFINITION, items: [...items(11), probe] }, digest);
    expect(reading.ok).toBe(true);
    expect(reading.ok && reading.definition.items[11]?.candidateText).toBe('');

    const missing = { ordinal: 12, direction: 'en->fr', category: '', provider: OPUS.provider, model: OPUS.model };
    const refused = readQaSetDefinition({ ...DEFINITION, items: [...items(11), missing] }, digest);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems.map((p) => p.kind)).toContain('item-malformed');
  });

  it('re-emits items field by field, so an answer-key column cannot ride into storage', () => {
    const reading = readQaSetDefinition(
      { ...DEFINITION, items: DEFINITION.items.map((item) => ({ ...item, expectedWinner: true })) },
      digest,
    );
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(Object.keys(reading.definition.items[0] ?? {})).not.toContain('expectedWinner');
  });
});

describe('the pass bar', () => {
  it('PIN: is 82, the founder’s number, in one place', () => {
    expect(ROUTE_QA_PASS_BAR_PERCENT).toBe(82);
    expect(ROUTE_QA_PASS_BARS.messaging).toBe(82);
    expect(ROUTE_QA_PASS_BARS.live).toBe(82);
  });

  it('PIN: exactly 82 meets it; 81.9 does not', () => {
    expect(meetsPassBar({ passed: 41, judged: 50 }, 'messaging')).toBe(true);
    expect(meetsPassBar({ passed: 41, judged: 50 }, 'live')).toBe(true);
    expect(meetsPassBar({ passed: 819, judged: 1000 }, 'messaging')).toBe(false);
    expect(meetsPassBar({ passed: 819, judged: 1000 }, 'live')).toBe(false);
    expect(meetsPassBar({ passed: 0, judged: 0 }, 'messaging')).toBe(false);
  });

  it('PIN: the ratio is compared, not a rounded percent -- 50 of 61 is 81.97 and does not pass', () => {
    // The first version rounded to one decimal and compared the rounded
    // value: 81.967 became 82.0 and cleared the bar. Reproduced over live
    // HTTP with a 61-item set by a reviewer. The bar is the founder's number
    // and it has to mean what it says.
    expect(meetsPassBar({ passed: 50, judged: 61 }, 'messaging')).toBe(false);
    expect(displayPercent((50 * 100) / 61)).toBe(82);
    // And the score field keeps the exact value, so the registry validator's
    // own `score >= passThreshold` reaches the same answer.
    const rows = [
      ...Array.from({ length: 50 }, () => ({ direction: 'en->fr', provider: 'p', model: 'm', reviewerAccountId: 'a', verdict: CLEAN })),
      ...Array.from({ length: 11 }, () => ({ direction: 'en->fr', provider: 'p', model: 'm', reviewerAccountId: 'a', verdict: { ...CLEAN, meaningReversed: 'yes' as const } })),
    ];
    const [score] = scoreRouteQa(rows).scores;
    expect(score?.percent).toBe((50 * 100) / 61);
    expect(score?.percent).toBeLessThan(82);
    expect(score?.percent).not.toBe(82);
  });

  it('PIN: 41 of 50 is exactly 82, whichever way the floats fall', () => {
    const rows = [
      ...Array.from({ length: 41 }, () => ({ direction: 'en->fr', provider: 'p', model: 'm', reviewerAccountId: 'a', verdict: CLEAN })),
      ...Array.from({ length: 9 }, () => ({ direction: 'en->fr', provider: 'p', model: 'm', reviewerAccountId: 'a', verdict: { ...CLEAN, meaningReversed: 'yes' as const } })),
    ];
    const [score] = scoreRouteQa(rows).scores;
    expect(score?.percent).toBe(82);
    expect(meetsPassBar({ passed: 41, judged: 50 }, 'live')).toBe(true);
  });
});

describe('the scale and method name the sample', () => {
  it('PIN: sample size and direction are legible in the evidence text itself', () => {
    // RouteReviewEvidence has no field for either, and its shape is fixed. A
    // reader of "82" must be able to see 41 of 50 and en->fr without the
    // database, so the two free-text fields carry them.
    const sample = { direction: 'en->fr', judged: 50, passed: 41 };
    expect(routeQaScale(sample)).toBe('percent of judged items passing: 41 of 50 items passed, en->fr');
    expect(routeQaMethod(sample)).toContain('en->fr, 41 of 50 judged items passed');
    expect(routeQaMethod(sample)).toContain(`no fewer than ${ROUTE_QA_MIN_JUDGED_PER_GROUP} judged items`);
  });
});

describe('whether one item passes', () => {
  it('passes a clean verdict', () => {
    expect(itemPasses(CLEAN, 'fr')).toBe(true);
  });

  it('PIN: every adverse yes/no answer fails the item, on its own', () => {
    // Read from REVIEW_CRITERIA, not restated: the table says which answer is
    // the bad one for each row, and that is exactly what decides here.
    const failing: Partial<ReviewVerdict>[] = [
      { meaningPreserved: 'no' },
      { meaningReversed: 'yes' },
      { informationOmitted: 'yes' },
      { informationInvented: 'yes' },
      { namesNumbersCorrupted: 'yes' },
      { trustInRealChat: 'no' },
    ];
    for (const override of failing) {
      expect(itemPasses({ ...CLEAN, ...override }, 'fr'), JSON.stringify(override)).toBe(false);
    }
  });

  it('the 1-5 scores do not decide a pass', () => {
    expect(itemPasses({ ...CLEAN, naturalness: 1, grammar: 1 }, 'fr')).toBe(true);
  });

  it('PIN: where the target asks what language the output is in, only the target passes', () => {
    expect(itemPasses({ ...CLEAN, observedLanguage: 'Portuguese' }, 'pt')).toBe(true);
    expect(itemPasses({ ...CLEAN, observedLanguage: 'Italian' }, 'pt')).toBe(false);
    expect(itemPasses({ ...CLEAN, observedLanguage: 'Unsure' }, 'pt')).toBe(false);
    /* Not asked for French: absent is fine. */
    expect(itemPasses(CLEAN, 'fr')).toBe(true);
  });
});

describe('scoring per (direction, provider, model)', () => {
  const judged = (
    provider: string,
    model: string,
    direction: string,
    verdict: ReviewVerdict,
    reviewer = 'acct_a',
  ) => ({ direction, provider, model, reviewerAccountId: reviewer, verdict });

  const FLOOR = ROUTE_QA_MIN_JUDGED_PER_GROUP;
  const many = (
    count: number,
    provider: string,
    model: string,
    direction: string,
    verdict: ReviewVerdict,
    reviewer = 'acct_a',
  ) => Array.from({ length: count }, () => judged(provider, model, direction, verdict, reviewer));

  it('PIN: the floor is 20 judged items per group, named beside the bar', () => {
    expect(FLOOR).toBe(20);
  });

  it('PIN: a mixed-engine set never produces a mixed score', () => {
    // 20 of 20 OPUS-MT pass; 0 of 20 M2M100 pass. One score across both would
    // be 50% -- half about a model nobody is approving.
    const rows = [
      ...many(FLOOR, 'opus-mt', 'o', 'en->yo', CLEAN),
      ...many(FLOOR, 'm2m100', 'm', 'en->yo', { ...CLEAN, meaningReversed: 'yes' }),
    ];
    const { scores, unscored } = scoreRouteQa(rows);
    expect(scores).toHaveLength(2);
    expect(unscored).toEqual([]);
    expect(scores.find((s) => s.provider === 'opus-mt')?.percent).toBe(100);
    expect(scores.find((s) => s.provider === 'm2m100')?.percent).toBe(0);
    expect(scores.every((s) => s.percent !== 50)).toBe(true);
  });

  it('PIN: a group below the floor produces NO score -- not a low one and not a high one', () => {
    // A ten-item set that was nine of one engine and one of another yielded a
    // group of one; that one item passed, and 100% cleared the bar. A
    // percentage over a handful of sentences is arithmetic wearing the
    // costume of evidence. Below the floor the group is reported with its
    // count and never with a percent, exactly as a group with zero
    // judgements already was.
    const rows = [
      ...many(9, 'opus-mt', 'o', 'en->yo', { ...CLEAN, meaningReversed: 'yes' }),
      ...many(1, 'm2m100', 'm', 'en->yo', CLEAN),
    ];
    const { scores, unscored } = scoreRouteQa(rows);
    expect(scores).toEqual([]);
    expect(unscored.map((g) => [g.provider, g.judged, g.needed])).toEqual([
      ['opus-mt', 9, FLOOR],
      ['m2m100', 1, FLOOR],
    ]);
    expect(JSON.stringify(unscored)).not.toContain('percent');
  });

  it('PIN: one below the floor and one above: the one above scores, the one below does not', () => {
    const rows = [
      ...many(FLOOR, 'opus-mt', 'o', 'en->yo', CLEAN),
      ...many(FLOOR - 1, 'm2m100', 'm', 'en->yo', CLEAN),
    ];
    const { scores, unscored } = scoreRouteQa(rows);
    expect(scores.map((s) => s.provider)).toEqual(['opus-mt']);
    expect(unscored.map((g) => [g.provider, g.judged])).toEqual([['m2m100', FLOOR - 1]]);
  });

  it('PIN: the floor counts judgements, so two specialists on a ten-item group reach it', () => {
    const rows = [
      ...many(10, 'opus-mt', 'o', 'en->yo', CLEAN, 'acct_a'),
      ...many(10, 'opus-mt', 'o', 'en->yo', CLEAN, 'acct_b'),
    ];
    const { scores, unscored } = scoreRouteQa(rows);
    expect(unscored).toEqual([]);
    expect(scores[0]?.judged).toBe(20);
    expect(scores[0]?.reviewerAccountIds).toEqual(['acct_a', 'acct_b']);
  });

  it('PIN: the two directions of one model are two scores', () => {
    const rows = [
      ...many(FLOOR, 'opus-mt', 'o', 'en->yo', CLEAN),
      ...many(FLOOR, 'opus-mt', 'o', 'yo->en', { ...CLEAN, informationOmitted: 'yes' }),
    ];
    const { scores } = scoreRouteQa(rows);
    expect(scores.map((s) => [s.direction, s.percent])).toEqual([
      ['en->yo', 100],
      ['yo->en', 0],
    ]);
  });

  it('PIN: the same model under two versions is not merged -- version rides on the model id', () => {
    // Grouping is on (direction, provider, model); a set declares one version
    // per model, so two versions of one model must be two set entries with
    // distinct model ids. Same model id, same group.
    const rows = [
      ...many(FLOOR, 'opus-mt', 'o', 'en->fr', CLEAN),
      ...many(FLOOR, 'opus-mt', 'o', 'en->fr', CLEAN, 'acct_b'),
    ];
    expect(scoreRouteQa(rows).scores).toHaveLength(1);
  });

  it('counts every specialist’s verdict, names each reviewer once, and keeps the percent exact', () => {
    const rows = [
      ...many(10, 'opus-mt', 'o', 'en->fr', CLEAN, 'acct_a'),
      ...many(10, 'opus-mt', 'o', 'en->fr', CLEAN, 'acct_b'),
      ...many(10, 'opus-mt', 'o', 'en->fr', { ...CLEAN, meaningReversed: 'yes' }, 'acct_a'),
    ];
    const [score] = scoreRouteQa(rows).scores;
    expect(score?.judged).toBe(30);
    expect(score?.passed).toBe(20);
    expect(score?.percent).toBe((20 * 100) / 30);
    expect(displayPercent(score?.percent ?? 0)).toBe(66.7);
    expect(score?.reversed).toBe(10);
    expect(score?.reviewerAccountIds).toEqual(['acct_a', 'acct_b']);
  });

  it('reports the 1-5 means beside the score', () => {
    const rows = [
      ...many(10, 'opus-mt', 'o', 'en->fr', { ...CLEAN, naturalness: 5, grammar: 3 }),
      ...many(10, 'opus-mt', 'o', 'en->fr', { ...CLEAN, naturalness: 4, grammar: 4 }),
    ];
    const [score] = scoreRouteQa(rows).scores;
    expect(score?.meanNaturalness).toBe(4.5);
    expect(score?.meanGrammar).toBe(3.5);
  });

  it('nothing judged is no score, not a zero', () => {
    expect(scoreRouteQa([])).toEqual({ scores: [], unscored: [] });
  });
});

describe('who may pick up a QA set', () => {
  it('PIN: QUALIFIED and TRANSLATION_REVIEWER, both, for THIS language', () => {
    expect(
      qaReviewAccess({ language: 'yo', qualificationState: 'QUALIFIED', capabilities: ['TRANSLATION_REVIEWER'] }),
    ).toEqual({ unlocked: true });
  });

  it('PIN: qualified without the capability is locked', () => {
    // Six capabilities that authorise nothing are a permission model that
    // only looks like one.
    expect(qaReviewAccess({ language: 'yo', qualificationState: 'QUALIFIED', capabilities: [] })).toEqual({
      unlocked: false,
      reason: 'capability-not-granted',
    });
    expect(
      qaReviewAccess({ language: 'yo', qualificationState: 'QUALIFIED', capabilities: ['CULTURAL_REVIEWER'] }),
    ).toEqual({ unlocked: false, reason: 'capability-not-granted' });
  });

  it('PIN: the capability without a QUALIFIED track is locked', () => {
    for (const state of ['APPLIED', 'SUBMITTED', 'UNDER_REVIEW', 'NOT_QUALIFIED', 'REASSESSMENT_ALLOWED'] as const) {
      expect(
        qaReviewAccess({ language: 'yo', qualificationState: state, capabilities: ['TRANSLATION_REVIEWER'] }),
        state,
      ).toEqual({ unlocked: false, reason: 'not-qualified' });
    }
    expect(
      qaReviewAccess({ language: 'yo', qualificationState: 'SUSPENDED', capabilities: ['TRANSLATION_REVIEWER'] }),
    ).toEqual({ unlocked: false, reason: 'suspended' });
    expect(qaReviewAccess({ language: 'yo', qualificationState: null, capabilities: ['TRANSLATION_REVIEWER'] })).toEqual({
      unlocked: false,
      reason: 'not-applied',
    });
  });
});
