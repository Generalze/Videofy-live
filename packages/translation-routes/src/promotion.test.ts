/** @author masterzee001 */
/**
 * THE ACT OF APPROVING A ROUTE, AND THE ACT OF TAKING IT BACK.
 *
 * Two properties this file exists to hold down, because losing either turns the
 * promotion tool into the thing it was built to replace:
 *
 *   A PROMOTION THAT CANNOT SHOW ITS EVIDENCE IS REFUSED, and the refusal names
 *   every missing field at once. A tool that reveals the bar one failure at a
 *   time teaches nobody what the bar is.
 *
 *   MECHANISM, NOT POLICY. The last block below takes the SHIPPED SEED and
 *   asserts that this tool refuses every route in it exactly as it stands. If
 *   somebody ever uses this module to pre-approve something into the seed, that
 *   test goes red.
 */
import { describe, expect, it } from 'vitest';

import { MEASURED, PERMISSIVE_LICENCE, documentOf, route, scopes } from './document.fixtures.js';
import { promoteRoute, revokeRoute, type PromotionRequest } from './promotion.js';
import { TranslationRouteRegistry } from './registry.js';
import { SERVICE_SCOPES, type RouteReviewEvidence } from './route-record.js';
import seedDocument from '../routes/translation-routes.seed.json' with { type: 'json' };

const REVIEW: RouteReviewEvidence = {
  engine: 'opus-mt',
  model: 'Helsinki-NLP/opus-mt-en-fr',
  modelVersion: 'a1b2c3d',
  corpusHash: 'sha256:9f2c',
  corpusVersion: '2026-09-01',
  evaluator: 'A. Reader',
  assessedAt: '2026-09-19T09:00:00.000Z',
  method: 'read all eight chat lines end to end against the source',
  score: 8,
  scale: 'sentences materially correct out of 8',
  scaleMaximum: 8,
  passThreshold: 7,
  evidenceReference: 'docs/reviews/en-fr-2026-09-19.md',
};

function promotable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return route({
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-fr',
    technicalEvidence: { ...MEASURED },
    licenceStatus: { ...PERMISSIVE_LICENCE },
    ...overrides,
  });
}

function request(overrides: Partial<PromotionRequest> = {}): PromotionRequest {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    scopes: ['messaging'],
    approver: 'Zoe',
    decidedAt: '2026-09-20T12:00:00.000Z',
    reviewEvidence: REVIEW,
    ...overrides,
  };
}

function paths(decision: ReturnType<typeof promoteRoute>): string[] {
  return decision.ok ? [] : decision.problems.map((problem) => problem.path);
}

function routeIn(document: unknown, index = 0): Record<string, unknown> {
  return (document as { routes: Record<string, unknown>[] }).routes[index] as Record<
    string,
    unknown
  >;
}

describe('a promotion that cannot show its evidence is refused', () => {
  it('names every missing thing at once, not the first one', () => {
    const decision = promoteRoute(
      documentOf(
        route({
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          technicalEvidence: null,
          licenceStatus: { licence: 'CC-BY-NC-4.0', commercialUse: 'restricted', evidence: 'read' },
        }),
      ),
      request({ reviewEvidence: undefined }),
    );

    expect(decision.ok).toBe(false);
    // Three separate people fix these three, so all three are reported.
    expect(paths(decision)).toEqual(
      expect.arrayContaining([
        'routes[0].technicalEvidence',
        'routes[0].licenceStatus.commercialUse',
        'routes[0].humanReviewStatus',
      ]),
    );
  });

  it('refuses a route nobody measured', () => {
    const decision = promoteRoute(
      documentOf(promotable({ technicalEvidence: null })),
      request(),
    );
    expect(paths(decision)).toContain('routes[0].technicalEvidence');
  });

  it('refuses a measurement that recorded nothing', () => {
    const decision = promoteRoute(
      documentOf(promotable({ technicalEvidence: { ...MEASURED, successRate: 0 } })),
      request(),
    );
    expect(paths(decision)).toContain('routes[0].technicalEvidence.successRate');
  });

  it('refuses a licence whose commercial use is not established', () => {
    const decision = promoteRoute(
      documentOf(
        promotable({
          licenceStatus: { licence: 'Apache-2.0', commercialUse: 'unknown', evidence: 'the card' },
        }),
      ),
      request(),
    );
    expect(paths(decision)).toContain('routes[0].licenceStatus.commercialUse');
  });

  it('refuses a licence finding that does not say where it was read', () => {
    const decision = promoteRoute(
      documentOf(promotable({ licenceStatus: { licence: 'Apache-2.0', commercialUse: 'unknown', evidence: 'x' } })),
      request({ licence: { commercialUse: 'permitted', evidence: '  ' } }),
    );
    expect(paths(decision)).toContain('routes[0].licenceStatus.evidence');
  });

  it('refuses a half-filled review block, naming each field it lacks', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, corpusHash: '', evaluator: '' } }),
    );
    expect(paths(decision)).toEqual(
      expect.arrayContaining([
        'routes[0].reviewEvidence.corpusHash',
        'routes[0].reviewEvidence.evaluator',
      ]),
    );
  });

  it('refuses a review whose timestamp is not a date', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, assessedAt: 'last tuesday' } }),
    );
    expect(paths(decision)).toContain('routes[0].reviewEvidence.assessedAt');
  });

  it('refuses a direction that is a declared gap', () => {
    const decision = promoteRoute(
      documentOf(
        promotable({
          sourceLanguage: 'en',
          targetLanguage: 'pcm',
          provider: 'unassigned',
          modelId: 'unassigned',
        }),
      ),
      request({ targetLanguage: 'pcm' }),
    );
    expect(paths(decision)).toContain('routes[0].provider');
    /*
     * The MESSAGE, not just the path. Mutation testing caught this one passing
     * for the wrong reason: with the tool's own check removed, the promotion
     * ran on and was stopped by the post-edit validation instead, which reports
     * the same path. The two refusals say different things -- this one tells
     * the reader the direction is a declared gap and to name a real model --
     * and it is the earlier, clearer one that is under test.
     */
    expect(
      decision.ok === false &&
        decision.problems.some((problem) => problem.message.includes('declared gap')),
    ).toBe(true);
  });

  it('refuses a cloud route for messaging, which can never select one', () => {
    const decision = promoteRoute(
      documentOf(promotable({ executionClass: 'cloud' })),
      request(),
    );
    expect(paths(decision)).toContain('routes[0].executionClass');
  });

  it('allows that same cloud route for programme-live, which has no such rule', () => {
    const decision = promoteRoute(
      documentOf(promotable({ executionClass: 'cloud' })),
      request({ scopes: ['programme-live'] }),
    );
    expect(decision.ok).toBe(true);
  });

  it('refuses a direction nobody has written down, and widens to nothing', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ targetLanguage: 'es' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.problems[0]?.message).toContain('en->es');
  });

  it('refuses an unsigned decision', () => {
    expect(paths(promoteRoute(documentOf(promotable()), request({ approver: '   ' })))).toContain(
      'approver',
    );
  });

  it('refuses a promotion that names no scope; there is no "everything"', () => {
    expect(paths(promoteRoute(documentOf(promotable()), request({ scopes: [] })))).toContain(
      'scopes',
    );
  });

  it('refuses a promotion that would produce a document the validator rejects', () => {
    /*
     * The last line of defence, and it is reachable: the evidence bar checks
     * that a licence finding PERMITS commercial use and cites a source, but the
     * validator additionally requires the licence to be NAMED. A blank
     * identifier gets past the bar and is caught by re-validating the whole
     * document before anything is written -- which is the difference between a
     * refusal here and every service failing to load the registry at its next
     * boot.
     */
    const original = documentOf(promotable());
    const snapshot = JSON.stringify(original);
    const decision = promoteRoute(
      original,
      request({ licence: { licence: '', commercialUse: 'permitted', evidence: 'read in full' } }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.problems[0]?.message).toContain('Nothing was written');
    expect(paths(decision)).toContain('routes[0].licenceStatus.licence');
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('will not edit a document that is already invalid', () => {
    const broken = documentOf(promotable(), promotable()); // the same direction twice
    const decision = promoteRoute(broken, request());
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.problems[0]?.message).toContain('already invalid');
  });
});

describe('the bar is the stricter of the two gates', () => {
  it('refuses an outstanding review even on a language off the review-required list', () => {
    // Gate A would let this through; the messaging gate in services/account
    // would not, and a promotion that passes one and fails the other is a
    // record that reads as live and translates nothing.
    const decision = promoteRoute(
      documentOf(promotable({ humanReviewStatus: 'required-not-done' })),
      request({ reviewEvidence: undefined }),
    );
    expect(paths(decision)).toContain('routes[0].humanReviewStatus');
  });

  it('refuses a review declared unnecessary, rather than passed', () => {
    const decision = promoteRoute(
      documentOf(promotable({ humanReviewStatus: 'not-required' })),
      request({ reviewEvidence: undefined }),
    );
    expect(paths(decision)).toContain('routes[0].humanReviewStatus');
  });

  it('accepts a review the document already records, with its evidence', () => {
    const decision = promoteRoute(
      documentOf(promotable({ humanReviewStatus: 'passed', reviewEvidence: { ...REVIEW } })),
      request({ reviewEvidence: undefined }),
    );
    expect(decision.ok).toBe(true);
  });

  it('refuses a bare "passed" with no evidence behind it', () => {
    const decision = promoteRoute(
      documentOf(promotable({ humanReviewStatus: 'passed' })),
      request({ reviewEvidence: undefined }),
    );
    expect(paths(decision)).toContain('routes[0].humanReviewStatus');
  });

  it('demands a named reader, review-required language or not', () => {
    const decision = promoteRoute(
      documentOf(promotable({ sourceLanguage: 'en', targetLanguage: 'yo' })),
      request({ targetLanguage: 'yo', reviewEvidence: { ...REVIEW, evaluator: '' } }),
    );
    expect(paths(decision)).toContain('routes[0].reviewEvidence.evaluator');
  });
});

describe('a refusal recorded in the document is a decision, not a gap', () => {
  it('will not quietly overturn a scope marked refused', () => {
    const decision = promoteRoute(
      documentOf(promotable({ serviceScopes: scopes({ messaging: 'refused' }) })),
      request(),
    );
    expect(paths(decision)).toContain('routes[0].serviceScopes.messaging');
  });

  it('overturns one when the reason is given, and writes the reason down', () => {
    const decision = promoteRoute(
      documentOf(promotable({ serviceScopes: scopes({ messaging: 'refused' }) })),
      request({ overturnRefusalReason: 'a speaker re-read all eight and passed them' }),
    );
    expect(decision.ok).toBe(true);
    expect(decision.ok === true && String((decision.document as { note: string }).note)).toContain(
      'a speaker re-read all eight and passed them',
    );
  });
});

describe('a promotion approves one direction, one scope, and nothing else', () => {
  it('leaves the other scopes of the same route alone', () => {
    const decision = promoteRoute(documentOf(promotable()), request({ scopes: ['messaging'] }));
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['serviceScopes']).toEqual({
      messaging: 'approved',
      'programme-live': 'unapproved',
      'call-live': 'unapproved',
    });
  });

  it('leaves the reverse direction refused', () => {
    const decision = promoteRoute(
      documentOf(promotable(), promotable({ sourceLanguage: 'fr', targetLanguage: 'en' })),
      request(),
    );
    expect(decision.ok).toBe(true);
    const created = TranslationRouteRegistry.fromDocument(
      decision.ok === true ? decision.document : null,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.registry.mayTranslate('en', 'fr', 'messaging').allowed).toBe(true);
    expect(created.registry.mayTranslate('fr', 'en', 'messaging').allowed).toBe(false);
    expect(created.registry.mayTranslate('en', 'fr', 'call-live').allowed).toBe(false);
  });

  it('records who reviewed it, when, and against what', () => {
    const decision = promoteRoute(documentOf(promotable()), request());
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['humanReviewStatus']).toBe('passed');
    expect(after['reviewEvidence']).toEqual({ ...REVIEW });
    const note = String((decision.ok === true ? (decision.document as { note?: string }) : {}).note);
    expect(note).toContain('APPROVED 2026-09-20T12:00:00.000Z by Zoe');
    expect(note).toContain('en->fr');
    expect(note).toContain('A. Reader');
  });

  it('records a licence finding made as part of the same act', () => {
    const decision = promoteRoute(
      documentOf(
        promotable({
          licenceStatus: { licence: 'Apache-2.0', commercialUse: 'unknown', evidence: 'card only' },
        }),
      ),
      request({
        licence: { commercialUse: 'permitted', evidence: 'LICENSE read in full 2026-09-19' },
      }),
    );
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['licenceStatus']).toEqual({
      licence: 'Apache-2.0',
      commercialUse: 'permitted',
      evidence: 'LICENSE read in full 2026-09-19',
    });
  });

  it('never mutates the document it was handed', () => {
    const original = documentOf(promotable());
    const snapshot = JSON.stringify(original);
    promoteRoute(original, request());
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('produces a document that still validates', () => {
    const decision = promoteRoute(documentOf(promotable()), request());
    expect(decision.ok).toBe(true);
    const created = TranslationRouteRegistry.fromDocument(
      decision.ok === true ? decision.document : null,
    );
    expect(created.ok).toBe(true);
  });
});

describe('running it twice changes nothing and says so', () => {
  it('reports no change and appends no second audit line', () => {
    const first = promoteRoute(documentOf(promotable()), request());
    expect(first.ok === true && first.changed).toBe(true);
    if (!first.ok) return;

    const second = promoteRoute(first.document, request());
    expect(second.ok === true && second.changed).toBe(false);
    expect(second.ok === true && second.summary).toContain('Nothing was changed');
    expect(JSON.stringify(second.ok === true ? second.document : null)).toBe(
      JSON.stringify(first.document),
    );
  });
});

describe('withdrawing an approval is always allowed', () => {
  function approvedDocument(): unknown {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ scopes: ['messaging', 'programme-live'] }),
    );
    if (!decision.ok) throw new Error('fixture promotion was refused');
    return decision.document;
  }

  const withdrawal = {
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    approver: 'whoever is awake',
    decidedAt: '2026-09-21T02:14:00.000Z',
  } as const;

  it('needs no evidence, no review and no reason', () => {
    const decision = revokeRoute(approvedDocument(), { ...withdrawal, scopes: [] });
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['serviceScopes']).toEqual({
      messaging: 'unapproved',
      'programme-live': 'unapproved',
      'call-live': 'unapproved',
    });
    expect(after['productionApproved']).toBe(false);
  });

  it('withdraws one scope and leaves the others', () => {
    const decision = revokeRoute(approvedDocument(), { ...withdrawal, scopes: ['messaging'] });
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['serviceScopes']).toEqual({
      messaging: 'unapproved',
      'programme-live': 'approved',
      'call-live': 'unapproved',
    });
    // Still approved for something, so the headline stays true.
    expect(after['productionApproved']).toBe(true);
  });

  it('can say "decided against" rather than "not yet"', () => {
    const decision = revokeRoute(approvedDocument(), {
      ...withdrawal,
      scopes: ['messaging'],
      markRefused: true,
      reason: 'corrupted a phone number in a live chat',
    });
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect((after['serviceScopes'] as Record<string, string>)['messaging']).toBe('refused');
    const note = String((decision.ok === true ? (decision.document as { note?: string }) : {}).note);
    expect(note).toContain('WITHDRAWN 2026-09-21T02:14:00.000Z by whoever is awake');
    expect(note).toContain('corrupted a phone number in a live chat');
  });

  it('works on a document that is already invalid, because the alternative is leaving it live', () => {
    const broken = documentOf(
      promotable({
        productionApproved: true,
        humanReviewStatus: 'passed',
        serviceScopes: scopes({ messaging: 'approved' }),
        // Invalid: approved with a licence that does not permit commercial use.
        licenceStatus: { licence: 'CC-BY-NC-4.0', commercialUse: 'restricted', evidence: 'read' },
      }),
    );
    expect(TranslationRouteRegistry.fromDocument(broken).ok).toBe(false);

    const decision = revokeRoute(broken, { ...withdrawal, scopes: [] });
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect((after['serviceScopes'] as Record<string, string>)['messaging']).toBe('unapproved');
  });

  it('says plainly when there was nothing to withdraw', () => {
    const decision = revokeRoute(documentOf(promotable()), { ...withdrawal, scopes: [] });
    expect(decision.ok === true && decision.changed).toBe(false);
  });

  it('refuses a direction it does not hold, rather than inventing one', () => {
    const decision = revokeRoute(documentOf(promotable()), {
      ...withdrawal,
      targetLanguage: 'ig',
      scopes: [],
    });
    expect(decision.ok).toBe(false);
  });
});

describe('MECHANISM, NOT POLICY: the shipped seed is still refused by this tool', () => {
  it('refuses every direction in the seed, for every scope, as it stands', () => {
    const routes = (seedDocument as { routes: { sourceLanguage: string; targetLanguage: string }[] })
      .routes;
    expect(routes.length).toBe(14);

    for (const record of routes) {
      for (const scope of SERVICE_SCOPES) {
        const decision = promoteRoute(structuredClone(seedDocument) as unknown, {
          sourceLanguage: record.sourceLanguage,
          targetLanguage: record.targetLanguage,
          scopes: [scope],
          approver: 'nobody',
          decidedAt: '2026-09-20T12:00:00.000Z',
        });
        expect(
          decision.ok,
          `${record.sourceLanguage}->${record.targetLanguage} ${scope} was promotable`,
        ).toBe(false);
      }
    }
  });
});

/**
 * THE ONE CONTROL BETWEEN OPUS-MT'S CONFIDENT WRONG HAUSA AND SOMEBODY'S EAR.
 *
 * A recorded `failed` is a named speaker of the language having read the output
 * and said it is wrong. It was the strongest thing this document could carry
 * and the cheapest thing in it to erase: a scope marked `refused` demanded an
 * explicit flag and a written reason, and overturning a failed review demanded
 * nothing, while the promotion replaced the failing evidence block wholesale.
 */
describe('overturning a failed human review costs at least what a refused scope costs', () => {
  const FAILED_REVIEW: RouteReviewEvidence = {
    ...REVIEW,
    evaluator: 'a Hausa speaker, 9jaLingo',
    method: 'read eight business sentences aloud',
    score: 2,
    evidenceReference: 'docs/reviews/en-ha-FAILED.md',
  };

  function failedRoute(): Record<string, unknown> {
    return promotable({
      humanReviewStatus: 'failed',
      reviewEvidence: { ...FAILED_REVIEW },
    });
  }

  it('refuses an ordinary approve that carries a fresh review and no acknowledgement', () => {
    const decision = promoteRoute(documentOf(failedRoute()), request());
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].humanReviewStatus');
    expect(
      decision.ok === false &&
        decision.problems.some((problem) => problem.message.includes('said it is wrong')),
    ).toBe(true);
  });

  it('allows it when the reason is given, and KEEPS the review it supersedes', () => {
    const decision = promoteRoute(
      documentOf(failedRoute()),
      request({
        overturnFailedReviewReason: 'a second named speaker re-read all eight and passed them',
      }),
    );
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);

    expect(after['humanReviewStatus']).toBe('passed');
    expect(after['reviewEvidence']).toEqual({ ...REVIEW });

    const history = after['reviewHistory'] as Record<string, unknown>[];
    expect(history).toHaveLength(1);
    expect(history[0]?.['status']).toBe('failed');
    expect(history[0]?.['supersededBy']).toBe('Zoe');
    expect(history[0]?.['reason']).toContain('re-read all eight');
    // The finding itself, not a note that there was one: the speaker, the
    // score they gave, and where their working is kept.
    expect(history[0]?.['evidence']).toEqual({ ...FAILED_REVIEW });
  });

  it('says in the note that a failed review was overturned, and by whom', () => {
    const decision = promoteRoute(
      documentOf(failedRoute()),
      request({ overturnFailedReviewReason: 'a second named speaker re-read all eight' }),
    );
    expect(decision.ok).toBe(true);
    const note = String((decision.ok === true ? (decision.document as { note?: string }) : {}).note);
    expect(note).toContain('OVERTURNS A FAILED HUMAN REVIEW');
    expect(note).toContain('a second named speaker re-read all eight');
    expect(note).toContain('by Zoe');
  });

  it('produces a document that still validates, with the history in it', () => {
    const decision = promoteRoute(
      documentOf(failedRoute()),
      request({ overturnFailedReviewReason: 'read again by somebody accountable' }),
    );
    expect(decision.ok).toBe(true);
    expect(
      TranslationRouteRegistry.fromDocument(decision.ok === true ? decision.document : null).ok,
    ).toBe(true);
  });

  it('keeps an earlier passed review too, rather than dropping it on the way past', () => {
    const first = promoteRoute(documentOf(promotable()), request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = promoteRoute(
      first.document,
      request({
        reviewEvidence: { ...REVIEW, evaluator: 'B. Reader', assessedAt: '2026-09-25T09:00:00.000Z' },
      }),
    );
    expect(second.ok).toBe(true);
    const after = routeIn(second.ok === true ? second.document : null);
    const history = after['reviewHistory'] as Record<string, unknown>[];
    expect(history).toHaveLength(1);
    expect((history[0]?.['evidence'] as Record<string, unknown>)['evaluator']).toBe('A. Reader');
  });
});

/**
 * WHO APPROVED IT, AS A FIELD.
 *
 * The approver's name used to live only in the free-text `note`, which is
 * optional: a reviewer deleted it and the approval stayed live, signed by
 * nobody, with every gate and report silent. `reviewEvidence` names the
 * REVIEWER, who is a different person.
 */
describe('an approval cannot survive its own provenance', () => {
  it('records who approved it, when, and which scopes', () => {
    const decision = promoteRoute(documentOf(promotable()), request({ scopes: ['messaging'] }));
    expect(decision.ok).toBe(true);
    const after = routeIn(decision.ok === true ? decision.document : null);
    expect(after['approval']).toEqual({
      approvedBy: 'Zoe',
      approvedAt: '2026-09-20T12:00:00.000Z',
      scopes: ['messaging'],
    });
  });

  it('covers a scope added by a later act as well as the one that came first', () => {
    const first = promoteRoute(documentOf(promotable()), request({ scopes: ['messaging'] }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = promoteRoute(
      first.document,
      request({ scopes: ['programme-live'], approver: 'Someone Else' }),
    );
    expect(second.ok).toBe(true);
    const after = routeIn(second.ok === true ? second.document : null);
    expect(after['approval']).toEqual({
      approvedBy: 'Someone Else',
      approvedAt: '2026-09-20T12:00:00.000Z',
      scopes: ['messaging', 'programme-live'],
    });
  });

  it('will not load a document whose approved route has had its provenance deleted', () => {
    const decision = promoteRoute(documentOf(promotable()), request());
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const stripped = structuredClone(decision.document) as { routes: Record<string, unknown>[] };
    delete (stripped.routes[0] as Record<string, unknown>)['approval'];
    delete (stripped as Record<string, unknown>)['note'];

    const created = TranslationRouteRegistry.fromDocument(stripped);
    expect(created.ok).toBe(false);
    expect(
      created.ok === false && created.problems.some((problem) => problem.path.endsWith('.approval')),
    ).toBe(true);
  });
});

/**
 * EVIDENCE THAT IS COLLECTED HAS TO BE CHECKED.
 *
 * `model` was demanded, stored and compared to nothing, so a block naming
 * opus-mt-en-fr could approve en->yo. `score` was unconstrained, so a review
 * that scored 0 out of 8 approved a route. Both refusals live in validate.ts,
 * which is what production reads, so they hold for a hand-edited document as
 * well as for one this tool wrote -- these tests drive them through the tool.
 */
describe('a review must be a review of THIS model, and must have passed its own bar', () => {
  it('refuses a review that names a different model from the record', () => {
    const decision = promoteRoute(
      documentOf(promotable({ sourceLanguage: 'en', targetLanguage: 'yo', modelId: 'Helsinki-NLP/opus-mt-en-alv' })),
      request({ targetLanguage: 'yo' }),
    );
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].reviewEvidence.model');
  });

  it('refuses a score of zero against a scale that tops out at eight', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, score: 0 } }),
    );
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].reviewEvidence.score');
  });

  it('refuses a score that did not reach the threshold its own method sets', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, score: 6, passThreshold: 7 } }),
    );
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].reviewEvidence.score');
  });

  it('refuses a score above the scale it claims to be on', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, score: 9 } }),
    );
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].reviewEvidence.score');
  });

  it('refuses a threshold that passes everything', () => {
    const decision = promoteRoute(
      documentOf(promotable()),
      request({ reviewEvidence: { ...REVIEW, passThreshold: 0 } }),
    );
    expect(decision.ok).toBe(false);
    expect(paths(decision)).toContain('routes[0].reviewEvidence.passThreshold');
  });
});
