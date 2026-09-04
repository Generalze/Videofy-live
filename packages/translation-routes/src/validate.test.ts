/** @author masterzee001 */
/**
 * What the document may not say. Every refusal here is cheaper than the
 * incident that would follow the document being believed.
 */
import { describe, expect, it } from 'vitest';

import { MEASURED, PERMISSIVE_LICENCE, documentOf, route, scopes } from './document.fixtures.js';
import { parseRouteDocument } from './validate.js';

function problemsFor(document: unknown, options = {}): readonly { path: string; message: string }[] {
  const parsed = parseRouteDocument(document, options);
  if (parsed.ok) return [];
  return parsed.problems;
}

function paths(document: unknown, options = {}): readonly string[] {
  return problemsFor(document, options).map((problem) => problem.path);
}

describe('approval must be backed by something', () => {
  it('refuses productionApproved with null technicalEvidence', () => {
    const problems = problemsFor(documentOf(route({ productionApproved: true })));

    expect(problems.map((problem) => problem.path)).toContain('routes[0].productionApproved');
    expect(problems.some((problem) => problem.message.includes('nothing has been measured'))).toBe(
      true,
    );
  });

  it('accepts productionApproved once evidence is present and the licence is settled', () => {
    const parsed = parseRouteDocument(
      documentOf(
        route({
          productionApproved: true,
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'passed',
          licenceStatus: { ...PERMISSIVE_LICENCE },
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
  });

  it('refuses productionApproved when commercial use is not established', () => {
    for (const commercialUse of ['restricted', 'unknown']) {
      const problems = paths(
        documentOf(
          route({
            productionApproved: true,
            technicalEvidence: { ...MEASURED },
            humanReviewStatus: 'passed',
            licenceStatus: { licence: 'CC-BY-NC-4.0', commercialUse, evidence: 'fixture' },
          }),
        ),
      );
      expect(problems, commercialUse).toContain('routes[0].licenceStatus.commercialUse');
    }
  });

  it('refuses an unsourced licence claim', () => {
    expect(
      paths(documentOf(route({ licenceStatus: { licence: 'MIT', commercialUse: 'permitted', evidence: '' } }))),
    ).toContain('routes[0].licenceStatus.evidence');
  });
});

describe('a human must clear the review-required languages', () => {
  it('refuses a scope approved while review is outstanding for yo, ha, ig or pcm', () => {
    for (const language of ['yo', 'ha', 'ig', 'pcm']) {
      const problems = problemsFor(
        documentOf(
          route({
            sourceLanguage: 'en',
            targetLanguage: language,
            productionApproved: true,
            technicalEvidence: { ...MEASURED },
            humanReviewStatus: 'required-not-done',
            serviceScopes: scopes({ messaging: 'approved' }),
          }),
        ),
      );
      expect(problems.map((problem) => problem.path), language).toContain(
        'routes[0].serviceScopes.messaging',
      );
    }
  });

  it('refuses it in the reverse direction too', () => {
    expect(
      paths(
        documentOf(
          route({
            sourceLanguage: 'yo',
            targetLanguage: 'en',
            productionApproved: true,
            technicalEvidence: { ...MEASURED },
            humanReviewStatus: 'required-not-done',
            serviceScopes: scopes({ 'call-live': 'approved' }),
          }),
        ),
      ),
    ).toContain('routes[0].serviceScopes.call-live');
  });

  it('refuses any approved scope on a route whose review FAILED', () => {
    expect(
      paths(
        documentOf(
          route({
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            productionApproved: true,
            technicalEvidence: { ...MEASURED },
            humanReviewStatus: 'failed',
            serviceScopes: scopes({ messaging: 'approved' }),
          }),
        ),
      ),
    ).toContain('routes[0].serviceScopes.messaging');
  });

  it('honours a caller-supplied review-required list in place of the document one', () => {
    const document = documentOf(
      route({
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        productionApproved: true,
        technicalEvidence: { ...MEASURED },
        humanReviewStatus: 'required-not-done',
        serviceScopes: scopes({ messaging: 'approved' }),
      }),
    );

    expect(parseRouteDocument(document).ok).toBe(true);
    expect(parseRouteDocument(document, { reviewRequiredLanguages: ['fr'] }).ok).toBe(false);
  });
});

describe('scopes narrow production approval and cannot grant it', () => {
  it('refuses an approved scope on a route that is not productionApproved', () => {
    const problems = problemsFor(
      documentOf(
        route({
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'passed',
          serviceScopes: scopes({ 'call-live': 'approved' }),
        }),
      ),
    );
    expect(problems.map((problem) => problem.path)).toContain('routes[0].serviceScopes.call-live');
    expect(problems.some((problem) => problem.message.includes('can never grant it'))).toBe(true);
  });

  it('refuses a missing scope rather than defaulting it to unapproved', () => {
    expect(
      paths(
        documentOf(
          route({ serviceScopes: { messaging: 'unapproved', 'programme-live': 'unapproved' } }),
        ),
      ),
    ).toContain('routes[0].serviceScopes.call-live');
  });

  it('refuses a scope the registry does not know', () => {
    expect(
      paths(
        documentOf(
          route({ serviceScopes: { ...scopes(), 'programme-uploaded': 'approved' } }),
        ),
      ),
    ).toContain('routes[0].serviceScopes.programme-uploaded');
  });
});

describe('a direction with no model behind it cannot be approved', () => {
  it('refuses production approval on the unassigned provider', () => {
    const problems = paths(
      documentOf(
        route({
          sourceLanguage: 'en',
          targetLanguage: 'pcm',
          provider: 'unassigned',
          modelId: 'unassigned',
          productionApproved: true,
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'passed',
          serviceScopes: scopes({ messaging: 'approved' }),
        }),
      ),
    );
    expect(problems).toContain('routes[0].provider');
    expect(problems).toContain('routes[0].serviceScopes.messaging');
  });
});

describe('the document must be readable as what it claims to be', () => {
  it('refuses an unknown field on a record rather than ignoring it', () => {
    // A typo'd field name is the quiet version of a missing rule: the intent was
    // written down and nothing read it.
    expect(paths(documentOf(route({ productionApprovedd: true })))).toContain(
      'routes[0].productionApprovedd',
    );
  });

  it('refuses an unknown field at document level', () => {
    expect(paths({ ...documentOf(route()), globalOpusSwitch: true })).toContain('globalOpusSwitch');
  });

  it('refuses a technicalEvidence field that is absent rather than null', () => {
    const bare = route();
    delete (bare as Record<string, unknown>)['technicalEvidence'];
    expect(paths(documentOf(bare))).toContain('routes[0].technicalEvidence');
  });

  it('refuses a latency profile whose numbers cannot all be true at once', () => {
    expect(
      paths(
        documentOf(
          route({
            productionApproved: true,
            humanReviewStatus: 'passed',
            technicalEvidence: {
              ...MEASURED,
              latencyMs: { min: 900, median: 180, mean: 190, max: 260 },
            },
          }),
        ),
      ),
    ).toContain('routes[0].technicalEvidence.latencyMs');
  });

  it('refuses a success rate outside 0..1 and a sample count below one', () => {
    const problems = paths(
      documentOf(
        route({ technicalEvidence: { ...MEASURED, successRate: 1.5, sampleCount: 0 } }),
      ),
    );
    expect(problems).toContain('routes[0].technicalEvidence.successRate');
    expect(problems).toContain('routes[0].technicalEvidence.sampleCount');
  });

  it('refuses the same direction declared twice', () => {
    const problems = problemsFor(
      documentOf(
        route({ sourceLanguage: 'en', targetLanguage: 'yo', modelId: 'first' }),
        route({ sourceLanguage: 'EN', targetLanguage: 'yo', modelId: 'second' }),
      ),
    );
    expect(problems.map((problem) => problem.path)).toContain('routes[1]');
    expect(problems.some((problem) => problem.message.includes('en->yo'))).toBe(true);
  });

  it('accepts the mirrored direction, which is not a duplicate', () => {
    expect(
      parseRouteDocument(
        documentOf(
          route({ sourceLanguage: 'en', targetLanguage: 'yo' }),
          route({ sourceLanguage: 'yo', targetLanguage: 'en' }),
        ),
      ).ok,
    ).toBe(true);
  });

  it('refuses a route whose source and target are the same language', () => {
    expect(paths(documentOf(route({ sourceLanguage: 'en', targetLanguage: 'EN' })))).toContain(
      'routes[0]',
    );
  });

  it('refuses a document that is not an object, and one with no routes array', () => {
    expect(parseRouteDocument(null).ok).toBe(false);
    expect(parseRouteDocument('[]').ok).toBe(false);
    expect(paths({ version: 1 })).toContain('routes');
  });
});
