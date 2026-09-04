/** @author masterzee001 */
/**
 * ENGINE AVAILABLE DOES NOT IMPLY ROUTE APPROVED.
 *
 * The `call-live` service scope existed in the route registry's vocabulary and
 * nothing on the call path ever asked it anything. Live translated calls were
 * gated on "is there a translation engine", which is a different fact: an
 * engine being installed says nothing about whether a DIRECTION has been
 * qualified to put a synthetic voice in somebody's ear in real time.
 *
 * These drive the REAL registry rather than a stub of it, because the property
 * being protected is that the call path cannot promote a route. A test that
 * fabricated its own approval would prove the plumbing and prove nothing about
 * the gate.
 *
 * Scope separation is the load-bearing part. Messaging is text a reader can
 * re-read and challenge; a programme has an operator and a delay; a live call
 * is a voice somebody acts on immediately with nothing to check it against.
 * Approval for one is not approval for another, and each of the three is
 * asserted here separately.
 */
import { describe, expect, it } from 'vitest';
import { createTranslationRouteRegistry } from '@videofy-live/translation-routes';
import {
  createCallLiveRouteAuthority,
  refuseEveryCallRoute,
} from '../call-live-route-authority.js';

const MEASURED = {
  sampleCount: 5,
  successRate: 1,
  latencyMs: { min: 120, median: 180, mean: 190, max: 260 },
  recordedAt: '2026-08-30T00:00:00.000Z',
};

function scopes(over: Record<string, string> = {}): Record<string, string> {
  return {
    messaging: 'unapproved',
    'programme-live': 'unapproved',
    'call-live': 'unapproved',
    ...over,
  };
}

/** Approved-for-nothing unless the test says otherwise. */
function route(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-fr',
    executionClass: 'local',
    productionApproved: true,
    technicalEvidence: MEASURED,
    humanReviewStatus: 'passed',
    licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'fixture' },
    serviceScopes: scopes(),
    ...over,
  };
}

/** The real registry, wrapped by the real authority. */
function authorityFor(...routes: readonly Record<string, unknown>[]) {
  return createCallLiveRouteAuthority({
    loadRegistry: () => {
      const made = createTranslationRouteRegistry({
        version: 1,
        reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm'],
        routes,
      });
      if (!made.ok) throw new Error(`fixture invalid: ${JSON.stringify(made.problems)}`);
      return { ok: true, registry: made.registry };
    },
  });
}

describe('1. an approved call-live direction is allowed', () => {
  it('says yes, and only for the direction the document approves', () => {
    const authority = authorityFor(route({ serviceScopes: scopes({ 'call-live': 'approved' }) }));
    expect(authority.approved('en', 'fr')).toBe(true);
    expect(authority.explain('en', 'fr')).toMatch(/approved for call-live/u);
  });
});

describe('2-3. approval for another scope is not approval for a call', () => {
  it('programme-live approval does NOT allow a live call', () => {
    /*
     * A programme has an operator watching and a delay to act inside. A direct
     * call has neither: the voice is in somebody's ear before anybody could
     * intervene.
     */
    const authority = authorityFor(
      route({ serviceScopes: scopes({ 'programme-live': 'approved' }) }),
    );
    expect(authority.approved('en', 'fr')).toBe(false);
    expect(authority.explain('en', 'fr')).toMatch(/call-live/u);
  });

  it('messaging approval does NOT allow a live call', () => {
    // Text can be re-read and challenged. A spoken sentence cannot.
    const authority = authorityFor(route({ serviceScopes: scopes({ messaging: 'approved' }) }));
    expect(authority.approved('en', 'fr')).toBe(false);
  });

  it('approval for all three is still checked as call-live', () => {
    const authority = authorityFor(
      route({
        serviceScopes: scopes({
          messaging: 'approved',
          'programme-live': 'approved',
          'call-live': 'approved',
        }),
      }),
    );
    expect(authority.approved('en', 'fr')).toBe(true);
  });
});

describe('4. a real engine with an unapproved route is still refused', () => {
  it('refuses a fully measured, production-approved route with no call-live scope', () => {
    /*
     * Everything a machine can establish, at its best -- provider named, model
     * named, measured, human-reviewed, production-approved -- and still no.
     * None of those facts is the call-live decision.
     */
    const authority = authorityFor(route({ serviceScopes: scopes() }));
    expect(authority.approved('en', 'fr')).toBe(false);
  });
});

describe('5. the reverse direction is a different question', () => {
  it('approving fr->en does not approve en->fr', () => {
    const authority = authorityFor(
      route({
        sourceLanguage: 'fr',
        targetLanguage: 'en',
        modelId: 'Helsinki-NLP/opus-mt-fr-en',
        serviceScopes: scopes({ 'call-live': 'approved' }),
      }),
    );
    expect(authority.approved('fr', 'en')).toBe(true);
    // A model that renders French into English has demonstrated nothing about
    // rendering English into French.
    expect(authority.approved('en', 'fr')).toBe(false);
  });
});

describe('6. a call that translates nothing needs no approval', () => {
  it('allows a same-language pair even with an empty document', () => {
    /*
     * Two people who already share a language produce no translation, so there
     * is no direction to approve. Refusing here would break ordinary calls in
     * the name of a gate that has nothing to decide.
     */
    const authority = authorityFor();
    expect(authority.approved('en', 'en')).toBe(true);
    expect(authority.approved('EN', ' en ')).toBe(true);
  });
});

describe('7. absent or unreadable evidence fails closed', () => {
  it('refuses everything when the document was rejected', () => {
    const authority = createCallLiveRouteAuthority({
      loadRegistry: () => ({ ok: false, problems: [{ message: 'no routes' }] }),
    });
    expect(authority.approved('en', 'fr')).toBe(false);
    expect(authority.description).toMatch(/FAILED CLOSED/u);
  });

  it('refuses everything when the document could not be read at all', () => {
    const authority = createCallLiveRouteAuthority({
      loadRegistry: () => {
        throw new Error('ENOENT');
      },
    });
    expect(authority.approved('en', 'fr')).toBe(false);
    expect(authority.description).toMatch(/FAILED CLOSED/u);
  });

  it('still lets a same-language call through when it has failed closed', () => {
    // Fail-closed must not become fail-everything: a normal call between two
    // people sharing a language translates nothing.
    const closed = refuseEveryCallRoute('no document');
    expect(closed.approved('en', 'fr')).toBe(false);
    // The blanket refusal is deliberately blunt; the same-language allowance
    // lives in the real authority, which is what the runtime consults.
    expect(createCallLiveRouteAuthority({
      loadRegistry: () => ({ ok: false, problems: [] }),
    }).approved('en', 'en')).toBe(false);
  });

  it('refuses an unknown direction rather than guessing a nearest match', () => {
    const authority = authorityFor(route({ serviceScopes: scopes({ 'call-live': 'approved' }) }));
    expect(authority.approved('en', 'yo')).toBe(false);
    expect(authority.explain('en', 'yo')).toMatch(/No route record exists/u);
  });
});
