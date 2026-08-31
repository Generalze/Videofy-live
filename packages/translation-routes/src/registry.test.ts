/** @author masterzee001 */
/**
 * The guarantees. Each block below is a defect that has cost this project real
 * time, written as a test so it cannot cost it again.
 */
import { describe, expect, it } from 'vitest';

import { MEASURED, PERMISSIVE_LICENCE, documentOf, route, scopes } from './document.fixtures.js';
import { TranslationRouteRegistry, createTranslationRouteRegistry } from './registry.js';
import * as publicApi from './index.js';

function registryOf(document: unknown): TranslationRouteRegistry {
  const created = TranslationRouteRegistry.fromDocument(document);
  if (!created.ok) {
    throw new Error(
      `fixture document was refused: ${created.problems
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join('; ')}`,
    );
  }
  return created.registry;
}

/** A route that is live for every scope: measured, licensed, reviewed. */
function approved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return route({
    productionApproved: true,
    technicalEvidence: { ...MEASURED },
    humanReviewStatus: 'passed',
    licenceStatus: { ...PERMISSIVE_LICENCE },
    serviceScopes: scopes({
      messaging: 'approved',
      'programme-live': 'approved',
      'call-live': 'approved',
    }),
    ...overrides,
  });
}

describe('direction is the unit of approval', () => {
  it('approving en->yo leaves yo->en refused', () => {
    const registry = registryOf(
      documentOf(
        approved({ sourceLanguage: 'en', targetLanguage: 'yo' }),
        route({ sourceLanguage: 'yo', targetLanguage: 'en' }),
      ),
    );

    expect(registry.mayTranslate('en', 'yo', 'messaging').allowed).toBe(true);

    const reverse = registry.mayTranslate('yo', 'en', 'messaging');
    expect(reverse.allowed).toBe(false);
    expect(reverse.allowed === false && reverse.reason).toBe('no-approved-route');
  });

  it('approving yo->en leaves en->yo refused', () => {
    const registry = registryOf(
      documentOf(
        route({ sourceLanguage: 'en', targetLanguage: 'yo' }),
        approved({ sourceLanguage: 'yo', targetLanguage: 'en' }),
      ),
    );

    expect(registry.mayTranslate('yo', 'en', 'call-live').allowed).toBe(true);
    expect(registry.mayTranslate('en', 'yo', 'call-live').allowed).toBe(false);
  });

  it('refuses the reverse of an approved direction that has no record of its own', () => {
    // The document names ONE direction. Asking for its mirror must be
    // `unknown-direction` -- not "we have en->yo, close enough". A registry
    // holding both records can hide a reverse-lookup fallback completely, which
    // is why this case is written one-sided on purpose.
    const registry = registryOf(documentOf(approved({ sourceLanguage: 'en', targetLanguage: 'yo' })));

    for (const scope of ['messaging', 'programme-live', 'call-live'] as const) {
      const decision = registry.mayTranslate('yo', 'en', scope);
      expect(decision.allowed, scope).toBe(false);
      expect(decision.allowed === false && decision.reason, scope).toBe('unknown-direction');
      expect(decision.allowed === false && decision.route, scope).toBeNull();
    }
    expect(registry.lookup('yo', 'en')).toBeUndefined();
    expect(registry.approvedScopes('yo', 'en')).toEqual([]);
  });

  it('lookup answers per direction and never folds the pair together', () => {
    const registry = registryOf(
      documentOf(
        approved({ sourceLanguage: 'en', targetLanguage: 'yo', modelId: 'forward-model' }),
        route({ sourceLanguage: 'yo', targetLanguage: 'en', modelId: 'reverse-model' }),
      ),
    );

    expect(registry.lookup('en', 'yo')?.modelId).toBe('forward-model');
    expect(registry.lookup('yo', 'en')?.modelId).toBe('reverse-model');
    expect(registry.lookup('en', 'yo')).not.toBe(registry.lookup('yo', 'en'));
  });

  it('normalises case and whitespace without widening the lookup', () => {
    const registry = registryOf(documentOf(approved({ sourceLanguage: 'en', targetLanguage: 'yo' })));

    expect(registry.mayTranslate(' EN ', 'YO', 'messaging').allowed).toBe(true);
    // `yor` is a different tag, not a near miss to be helpful about.
    expect(registry.mayTranslate('en', 'yor', 'messaging').allowed).toBe(false);
  });
});

describe('a scope approval is not a licence to run everywhere', () => {
  it('refuses programme-live for a route approved only for messaging', () => {
    const registry = registryOf(
      documentOf(
        approved({
          serviceScopes: scopes({ messaging: 'approved' }),
        }),
      ),
    );

    expect(registry.mayTranslate('en', 'yo', 'messaging').allowed).toBe(true);

    const live = registry.mayTranslate('en', 'yo', 'programme-live');
    expect(live.allowed).toBe(false);
    expect(live.allowed === false && live.reason).toBe('not-approved-for-scope');
    expect(live.allowed === false && live.explanation).toContain('programme-live');
  });

  it('refuses call-live when the document explicitly refused it', () => {
    const registry = registryOf(
      documentOf(
        approved({
          serviceScopes: scopes({
            messaging: 'approved',
            'programme-live': 'approved',
            'call-live': 'refused',
          }),
        }),
      ),
    );

    expect(registry.approvedScopes('en', 'yo')).toEqual(['messaging', 'programme-live']);
    const decision = registry.mayTranslate('en', 'yo', 'call-live');
    expect(decision.allowed === false && decision.reason).toBe('not-approved-for-scope');
  });

  it('refuses a scope name it does not know rather than treating it as approved', () => {
    const registry = registryOf(documentOf(approved()));

    const decision = registry.mayTranslate(
      'en',
      'yo',
      'programme-uploaded' as unknown as 'messaging',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('not-approved-for-scope');
  });
});

describe('an unknown direction is refused, never defaulted', () => {
  it('names unknown-direction and returns no route', () => {
    const registry = registryOf(documentOf(approved({ sourceLanguage: 'en', targetLanguage: 'yo' })));

    const decision = registry.mayTranslate('en', 'ha', 'messaging');
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('unknown-direction');
    expect(decision.allowed === false && decision.route).toBeNull();
    expect(registry.lookup('en', 'ha')).toBeUndefined();
  });

  it('does not fall back to another approved direction that shares a language', () => {
    const registry = registryOf(
      documentOf(
        approved({ sourceLanguage: 'en', targetLanguage: 'yo' }),
        approved({ sourceLanguage: 'en', targetLanguage: 'fr', humanReviewStatus: 'not-required' }),
      ),
    );

    expect(registry.mayTranslate('en', 'ig', 'messaging').allowed).toBe(false);
    expect(registry.mayTranslate('fr', 'yo', 'messaging').allowed).toBe(false);
  });
});

describe('there is no global switch', () => {
  it('approving one OPUS-MT direction leaves every other OPUS-MT direction refused', () => {
    const registry = registryOf(
      documentOf(
        approved({
          sourceLanguage: 'en',
          targetLanguage: 'es',
          provider: 'opus-mt',
          modelId: 'Helsinki-NLP/opus-mt-en-es',
          humanReviewStatus: 'not-required',
        }),
        route({
          sourceLanguage: 'es',
          targetLanguage: 'en',
          provider: 'opus-mt',
          modelId: 'Helsinki-NLP/opus-mt-es-en',
        }),
        route({
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          provider: 'opus-mt',
          modelId: 'Helsinki-NLP/opus-mt-en-fr',
        }),
      ),
    );

    expect(registry.mayTranslate('en', 'es', 'messaging').allowed).toBe(true);
    expect(registry.mayTranslate('es', 'en', 'messaging').allowed).toBe(false);
    expect(registry.mayTranslate('en', 'fr', 'messaging').allowed).toBe(false);
  });

  it('exports nothing that enables a provider, a model or an engine', () => {
    const forbidden = /opus|engine|enableall|globals?witch|approveall|allowall/i;
    const mutators = /^(enable|approve|allow|activate|turnon|set)/i;

    for (const name of Object.keys(publicApi)) {
      expect(name, `${name} looks like a provider-wide switch`).not.toMatch(forbidden);
      expect(name, `${name} looks like a mutator of approval state`).not.toMatch(mutators);
    }
  });

  it('freezes loaded records so nobody can flip an approval through a reference', () => {
    const registry = registryOf(documentOf(route()));
    const record = registry.lookup('en', 'yo');
    expect(record).toBeDefined();

    expect(() => {
      (record as unknown as { productionApproved: boolean }).productionApproved = true;
    }).toThrow();
    expect(() => {
      (record as unknown as { serviceScopes: Record<string, string> }).serviceScopes[
        'call-live'
      ] = 'approved';
    }).toThrow();

    expect(registry.mayTranslate('en', 'yo', 'call-live').allowed).toBe(false);
  });
});

describe('the refusal says which person can fix it', () => {
  it('reports the missing production approval before sending anybody hunting for a reviewer', () => {
    // Approved and measured, but the licence question is still open. Sending
    // somebody to find a Yoruba reviewer here wastes their afternoon on a route
    // that could not ship even if they passed it.
    const registry = registryOf(
      documentOf(
        route({
          productionApproved: false,
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'passed',
          licenceStatus: {
            licence: 'CC-BY-NC-4.0',
            commercialUse: 'restricted',
            evidence: 'fixture',
          },
        }),
      ),
    );
    // Not production-approved yet, so that is the first thing reported.
    const first = registry.mayTranslate('en', 'yo', 'messaging');
    expect(first.allowed === false && first.reason).toBe('no-approved-route');
  });

  it('refuses the document that would put a non-permissive licence into production', () => {
    // The gate carries the same licence check, but the document path can never
    // deliver such a record to it: validation refuses the combination first. The
    // gate keeps its copy anyway -- a guard that only works when the other guard
    // worked is not a guard -- and this is where the rule is observable.
    const created = createTranslationRouteRegistry(
      documentOf(
        approved({
          licenceStatus: {
            licence: 'CC-BY-NC-4.0',
            commercialUse: 'restricted',
            evidence: 'fixture',
          },
        }),
      ),
    );
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.problems.map((problem) => problem.path)).toContain(
      'routes[0].licenceStatus.commercialUse',
    );
  });

  it('reports human-review-outstanding for a review-required language before the scope', () => {
    const registry = registryOf(
      documentOf(
        route({
          sourceLanguage: 'en',
          targetLanguage: 'yo',
          productionApproved: true,
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'required-not-done',
          serviceScopes: scopes(),
        }),
      ),
    );

    const decision = registry.mayTranslate('en', 'yo', 'messaging');
    expect(decision.allowed === false && decision.reason).toBe('human-review-outstanding');
    expect(decision.allowed === false && decision.explanation).toContain('speaker of the language');
  });

  it('reports human-review-outstanding when a review has FAILED, whatever else is green', () => {
    const registry = registryOf(
      documentOf(
        route({
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          productionApproved: true,
          technicalEvidence: { ...MEASURED },
          humanReviewStatus: 'failed',
          serviceScopes: scopes(),
        }),
      ),
    );

    const decision = registry.mayTranslate('en', 'fr', 'call-live');
    expect(decision.allowed === false && decision.reason).toBe('human-review-outstanding');
  });

  it('lets a route with review not-required through when nothing else is missing', () => {
    const registry = registryOf(
      documentOf(
        approved({
          sourceLanguage: 'en',
          targetLanguage: 'fr',
          humanReviewStatus: 'not-required',
        }),
      ),
    );

    const decision = registry.mayTranslate('en', 'fr', 'programme-live');
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.route.targetLanguage).toBe('fr');
  });
});

describe('the review-required list is configurable and only ever tightens', () => {
  it('applies an override in place of the list the document declared', () => {
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

    const asWritten = TranslationRouteRegistry.fromDocument(document);
    expect(asWritten.ok).toBe(true);
    expect(asWritten.ok === true && asWritten.registry.mayTranslate('en', 'fr', 'messaging').allowed).toBe(
      true,
    );

    const stricter = TranslationRouteRegistry.fromDocument(document, {
      reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm', 'fr'],
    });
    expect(stricter.ok).toBe(false);
    expect(
      stricter.ok === false && stricter.problems.some((problem) => problem.message.includes('human review')),
    ).toBe(true);
  });

  it('reports which languages it will not approve without a human', () => {
    const registry = registryOf(documentOf(route()));
    expect(registry.reviewRequiredLanguages()).toEqual(['ha', 'ig', 'pcm', 'yo']);
    expect(registry.requiresHumanReview('YO')).toBe(true);
    expect(registry.requiresHumanReview('fr')).toBe(false);
  });
});

describe('an unusable document yields no registry at all', () => {
  it('returns problems rather than a partly-loaded registry', () => {
    const created = TranslationRouteRegistry.fromDocument(
      documentOf(approved(), route({ sourceLanguage: 'en', targetLanguage: 'en' })),
    );
    expect(created.ok).toBe(false);
    // Not "one good route loaded": nothing loaded. A registry that silently
    // dropped a record would answer confidently about a document nobody could
    // read.
    expect(created.ok === false && created.problems.length).toBeGreaterThan(0);
  });
});
