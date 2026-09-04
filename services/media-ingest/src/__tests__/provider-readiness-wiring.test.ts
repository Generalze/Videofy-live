/** @author masterzee001 */
/**
 * The rung a provider is actually standing on.
 *
 * Five rungs existed, were tested, were exported, and nothing constructed one.
 * A ladder nobody climbs reports no rung, so no console could show one and no
 * deployment could be refused for standing on the wrong step -- which is the
 * same defect shape as a route nobody registers, wearing different clothes.
 *
 * THE RUNG THAT MATTERS HERE IS WARM. 9jaLingo's capacity scales to zero. It
 * answers a probe healthily, because the probe is what woke it, and returns
 * 503 to the first real request after it sleeps -- and that request is the one
 * that opens a broadcast. Every assertion about warmth below is about not
 * calling that deployment ready.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nigerianReadiness, type RouteEvidence } from '../provider-readiness-wiring.js';
import type { NigerianSynthesisState } from '../nigerian-synthesis-route.js';

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

function specialist(
  over: Partial<NigerianSynthesisState & { warm: boolean }> = {},
): NigerianSynthesisState & { warm: boolean } {
  return {
    specialistConfigured: true,
    specialistProviderId: 'naijalingo',
    fallbackProviderId: 'azure',
    languages: ['yo'],
    renderingByLanguage: { yo: 'specialist' },
    specialistSentences: 10,
    degradedSentences: 0,
    preflight: {
      keyConfigured: true,
      reachable: true,
      problem: null,
    } as NigerianSynthesisState['preflight'],
    degraded: false,
    degradedReason: null,
    warm: true,
    ...over,
  };
}

function evidenceOf(over: Record<string, unknown> = {}): RouteEvidence {
  return {
    routes: () => [
      {
        sourceLanguage: 'en',
        targetLanguage: 'yo',
        modelId: 'naija-1',
        humanReviewStatus: 'passed',
        reviewEvidence: {
          engine: 'naijalingo',
          model: 'naija',
          modelVersion: 'naija-1',
          corpusHash: 'abc123',
          corpusVersion: '2026.09',
          evaluator: 'a Yoruba speaker',
          assessedAt: '2026-09-01T00:00:00.000Z',
          method: 'native-listener',
          score: 4,
          scale: '1-5',
          evidenceReference: 'docs/certification/translation-quality-nigerian.md',
        },
        ...over,
      },
    ],
    approvedScopes: () => ['programme-live'],
  };
}

const read = (
  state: NigerianSynthesisState & { warm: boolean },
  evidence: RouteEvidence | null = evidenceOf(),
) =>
  nigerianReadiness({
    nigerian: () => state,
    registry: () => evidence,
    scope: 'programme-live',
    sourceLanguage: () => 'en',
  })[0];

describe('climbing the ladder', () => {
  it('reaches approved when every question is answered yes', () => {
    expect(read(specialist())?.level).toBe('approved');
    expect(read(specialist())?.eligibility.eligible).toBe(true);
  });

  it('stops at configured when nobody has probed the vendor', () => {
    /*
     * A provider nobody has asked is not healthy, it is unknown, and
     * presenting unknown as working is how a deployment ships with a vendor it
     * has never spoken to.
     */
    expect(read(specialist({ preflight: null }))?.level).toBe('configured');
  });

  it('STOPS AT HEALTHY WHEN THE CAPACITY IS COLD', () => {
    /*
     * The whole point. Everything else is green: a key, a successful probe, a
     * human review, an approving document. And the first sentence of the next
     * broadcast will be served by the fallback that mispronounces it, because
     * the capacity went back to sleep.
     */
    const cold = read(specialist({ warm: false }));
    expect(cold?.level).toBe('healthy');
    expect(cold?.eligibility.eligible).toBe(false);
  });

  it('names the cold capacity as the blocker, in words somebody can act on', () => {
    const cold = read(specialist({ warm: false }));
    if (cold?.eligibility.eligible !== false) throw new Error('unreachable');
    // The service's own words, which name the cause rather than the symptom.
    expect(cold.eligibility.blockers.join(' ')).toMatch(/scales to zero/iu);
  });
});

describe('what counts as reviewed', () => {
  it('refuses to call a route reviewed when no document is loaded', () => {
    // Nobody has judged anything. Reporting that as reviewed would put an
    // unreviewed language to air on the strength of a review that never was.
    expect(read(specialist(), null)?.readiness.qualified.assessed).toBe(false);
  });

  it('refuses a pass that carries no evidence', () => {
    /*
     * A verdict without its subject is not evidence. Without a model version
     * and a corpus hash there is nothing to check the judgement against, and
     * nothing to notice going stale when either moves on.
     */
    const view = read(specialist(), evidenceOf({ reviewEvidence: undefined }));
    expect(view?.readiness.qualified.assessed).toBe(false);
    expect(view?.level).toBe('warm');
  });

  it('reports a review of a DIFFERENT model version as stale, not as a pass', () => {
    // The route now runs naija-2; the review was of naija-1. That evidence
    // describes something that is no longer there.
    const view = read(specialist(), evidenceOf({ modelId: 'naija-2' }));
    expect(view?.readiness.qualified.assessed).toBe(false);
    expect(view?.level).toBe('warm');
  });

  it('does not treat "review not required" as a review', () => {
    // A language exempt from review has not been reviewed either.
    const view = read(specialist(), evidenceOf({ humanReviewStatus: 'not-required' }));
    expect(view?.readiness.qualified.assessed).toBe(false);
  });
});

describe('what an unconfigured deployment reports', () => {
  it('says nothing is warm when there is nothing to keep warm', () => {
    const view = read(specialist({ specialistConfigured: false }));
    expect(view?.readiness.warm).toBeNull();
    /*
     * `unconfigured`, a rung below `configured`. The ladder distinguishes "no
     * credential" from "a credential and nothing proven", which are different
     * things to fix and would otherwise read identically.
     */
    expect(view?.level).toBe('unconfigured');
  });

  it('reports no providers at all when synthesis is off', () => {
    const views = nigerianReadiness({
      nigerian: () => null,
      registry: () => null,
      scope: 'programme-live',
      sourceLanguage: () => 'en',
    });
    // Empty, not a row of unknowns: a deployment with no synthesis has no
    // provider to describe.
    expect(views).toEqual([]);
  });
});

describe('the composition root climbs it', () => {
  it('builds the ladder from the keeper own answer, not from configuration', () => {
    expect(INDEX).toContain('nigerianReadiness({');
    expect(INDEX).toContain('liveSynthesis.nigerian?.warm === true');
  });

  it('says the rung out loud at boot', () => {
    // Otherwise a deployment standing on `healthy` looks exactly like one
    // standing on `approved` until somebody opens a console.
    expect(INDEX).toContain("logger.info('Provider readiness ladder ready'");
  });

  it('keeps the readiness surface behind the operator guard', () => {
    // It names providers, models and review evidence: C7's account of its own
    // supply chain, not something a viewer needs.
    expect(INDEX).toContain("app.get('/providers/readiness', operatorOnly");
  });
});
