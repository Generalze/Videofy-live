/**
 * THE MESSAGING TRANSLATION RULING, PINNED.
 *
 * These are the rules a reviewer should be able to read off the test names:
 * same language never translates, an approved LOCAL route translates and
 * OPUS-MT wins where it stands, and every other shape -- no record, a refusal,
 * an unapproved scope, a missing licence, an absent evidence block, a cloud
 * route, the OPPOSITE direction -- refuses with a reason. The refusal is the
 * point: refusing means the original is delivered, not that anything fails.
 *
 * The function under test is pure, so none of these can pass for the wrong
 * reason -- there is no vendor, no clock and no network to be lucky with.
 */
import { describe, expect, it } from 'vitest';
import {
  createTranslationRouteRegistryFromGate,
  createTranslationRouteRegistryFromRecords,
  decideMessagingRoute,
  isApprovedForMessaging,
  type TranslationRouteRecord,
} from '../translation-route-policy.js';

/** A record with every approval clause satisfied; tests spoil one at a time. */
function route(overrides: Partial<TranslationRouteRecord> = {}): TranslationRouteRecord {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-yo',
    executionClass: 'local',
    productionApproved: true,
    technicalEvidence: {
      sampleCount: 50,
      successRate: 0.98,
      latencyMs: { min: 30, median: 80, mean: 90, max: 400 },
      recordedAt: '2026-08-30T00:00:00.000Z',
    },
    humanReviewStatus: 'passed',
    licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'model card' },
    serviceScopes: {
      messaging: 'approved',
      'programme-live': 'unapproved',
      'call-live': 'unapproved',
    },
    ...overrides,
  };
}

describe('same language bypasses translation entirely', () => {
  it('is a bypass, decided from the languages alone', () => {
    expect(decideMessagingRoute({ sourceLanguage: 'yo', targetLanguage: 'yo', records: [] })).toEqual(
      { kind: 'bypass' },
    );
  });

  it('bypasses even where a perfectly approved route exists', () => {
    // Nothing may turn a same-language message into a translation event.
    expect(
      decideMessagingRoute({
        sourceLanguage: 'en',
        targetLanguage: 'en',
        records: [route({ targetLanguage: 'en' })],
      }),
    ).toEqual({ kind: 'bypass' });
  });

  it('a reader with no language is unavailable, not a bypass', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: null, records: [] }),
    ).toEqual({ kind: 'unavailable', reason: 'no-target-language' });
  });
});

describe('an approved local route translates', () => {
  it('names the provider and model the registry approved', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [route()] }),
    ).toEqual({
      kind: 'approved',
      provider: 'opus-mt',
      modelId: 'Helsinki-NLP/opus-mt-en-yo',
      executionClass: 'local',
    });
  });

  it('prefers OPUS-MT even when another approved local route scores higher', () => {
    const rival = route({
      provider: 'nllb-200',
      modelId: 'facebook/nllb-200',
      technicalEvidence: {
        sampleCount: 500,
        successRate: 1,
        latencyMs: { min: 1, median: 2, mean: 2, max: 3 },
        recordedAt: '2026-08-30T00:00:00.000Z',
      },
    });
    const decision = decideMessagingRoute({
      sourceLanguage: 'en',
      targetLanguage: 'yo',
      records: [rival, route()],
    });
    expect(decision).toMatchObject({ kind: 'approved', provider: 'opus-mt' });
  });

  it('falls to the best-evidenced approved local route where OPUS-MT is absent', () => {
    const strong = route({
      provider: 'nllb-200',
      modelId: 'facebook/nllb-200-distilled',
      technicalEvidence: {
        sampleCount: 500,
        successRate: 0.99,
        latencyMs: { min: 1, median: 2, mean: 2, max: 3 },
        recordedAt: '2026-08-30T00:00:00.000Z',
      },
    });
    const weak = route({
      provider: 'm2m100',
      modelId: 'facebook/m2m100_418M',
      technicalEvidence: {
        sampleCount: 500,
        successRate: 0.4,
        latencyMs: { min: 1, median: 2, mean: 2, max: 3 },
        recordedAt: '2026-08-30T00:00:00.000Z',
      },
    });
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [weak, strong] }),
    ).toMatchObject({ kind: 'approved', provider: 'nllb-200' });
  });
});

describe('directions are separate records', () => {
  it('en->yo approved says nothing about yo->en', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'yo', targetLanguage: 'en', records: [route()] }),
    ).toEqual({ kind: 'unavailable', reason: 'no-route' });
  });

  it('a record for another pair entirely is not a route for this one', () => {
    expect(
      decideMessagingRoute({
        sourceLanguage: 'en',
        targetLanguage: 'ha',
        records: [route(), route({ targetLanguage: 'ig' })],
      }),
    ).toEqual({ kind: 'unavailable', reason: 'no-route' });
  });
});

describe('service scopes are separate approvals', () => {
  it('approved for the live programme is NOT approved for messaging', () => {
    const liveOnly = route({
      serviceScopes: {
        messaging: 'unapproved',
        'programme-live': 'approved',
        'call-live': 'approved',
      },
    });
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [liveOnly] }),
    ).toEqual({ kind: 'unavailable', reason: 'unapproved' });
  });

  it('a refusal for messaging is reported as a refusal', () => {
    const refused = route({
      serviceScopes: {
        messaging: 'refused',
        'programme-live': 'approved',
        'call-live': 'approved',
      },
    });
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [refused] }),
    ).toEqual({ kind: 'unavailable', reason: 'refused' });
  });
});

describe('no automatic paid cloud fallback', () => {
  it('an approved CLOUD route is never taken automatically', () => {
    const cloud = route({ executionClass: 'cloud', provider: 'a-paid-vendor' });
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [cloud] }),
    ).toEqual({ kind: 'unavailable', reason: 'cloud-only' });
  });

  it('a cloud route beside an approved local one does not displace it', () => {
    const cloud = route({ executionClass: 'cloud', provider: 'a-paid-vendor' });
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [cloud, route()] }),
    ).toMatchObject({ kind: 'approved', provider: 'opus-mt', executionClass: 'local' });
  });
});

describe('every approval clause refuses on its own', () => {
  const spoiled: [string, Partial<TranslationRouteRecord>][] = [
    ['production approval withheld', { productionApproved: false }],
    ['human review never done', { humanReviewStatus: 'required-not-done' }],
    ['human review failed', { humanReviewStatus: 'failed' }],
    [
      'licence restricted',
      {
        licenceStatus: {
          licence: 'CC-BY-NC-4.0',
          commercialUse: 'restricted',
          evidence: 'model card',
        },
      },
    ],
    [
      'licence unknown',
      { licenceStatus: { licence: 'unstated', commercialUse: 'unknown', evidence: 'none' } },
    ],
    ['no technical evidence at all', { technicalEvidence: null }],
    [
      'an evidence block with no samples in it',
      {
        technicalEvidence: {
          sampleCount: 0,
          successRate: 0,
          latencyMs: { min: 0, median: 0, mean: 0, max: 0 },
          recordedAt: '2026-08-30T00:00:00.000Z',
        },
      },
    ],
  ];

  for (const [name, overrides] of spoiled) {
    it(`refuses on ${name}`, () => {
      expect(isApprovedForMessaging(route(overrides), 'en', 'yo')).toBe(false);
      expect(
        decideMessagingRoute({
          sourceLanguage: 'en',
          targetLanguage: 'yo',
          records: [route(overrides)],
        }),
      ).toEqual({ kind: 'unavailable', reason: 'unapproved' });
    });
  }
});

describe('the registry adapter', () => {
  it('answers only for the exact direction asked', async () => {
    const registry = createTranslationRouteRegistryFromRecords([route()]);
    expect(await registry.routesFor('en', 'yo')).toHaveLength(1);
    expect(await registry.routesFor('yo', 'en')).toHaveLength(0);
  });

  it('an empty registry approves nothing', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records: [] }),
    ).toEqual({ kind: 'unavailable', reason: 'no-route' });
  });
});

describe('the gate adapter', () => {
  /** Records the scope asked for, so nothing can quietly ask a wider question. */
  function gate(
    answer:
      | { allowed: true; route: TranslationRouteRecord }
      | { allowed: false; route: TranslationRouteRecord | null },
  ) {
    const scopes: string[] = [];
    return {
      scopes,
      registry: createTranslationRouteRegistryFromGate({
        mayTranslate: (_source, _target, scope) => {
          scopes.push(scope);
          return answer;
        },
      }),
    };
  }

  it('asks the messaging scope and only the messaging scope', async () => {
    const { scopes, registry } = gate({ allowed: true, route: route() });
    await registry.routesFor('en', 'yo');
    expect(scopes).toEqual(['messaging']);
  });

  it('passes an allowed route through to the policy', async () => {
    const { registry } = gate({ allowed: true, route: route() });
    const records = await registry.routesFor('en', 'yo');
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records }),
    ).toMatchObject({ kind: 'approved', provider: 'opus-mt' });
  });

  it('keeps a refusal READABLE rather than flattening it to "no route"', async () => {
    const refused = route({
      serviceScopes: {
        messaging: 'refused',
        'programme-live': 'approved',
        'call-live': 'approved',
      },
    });
    const { registry } = gate({ allowed: false, route: refused });
    const records = await registry.routesFor('en', 'yo');
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records }),
    ).toEqual({ kind: 'unavailable', reason: 'refused' });
  });

  it('an unknown direction stays unknown -- nothing is substituted', async () => {
    const { registry } = gate({ allowed: false, route: null });
    expect(await registry.routesFor('en', 'ha')).toHaveLength(0);
  });

  it('an allowed CLOUD route is still refused by the messaging rule', async () => {
    // The registry may approve a cloud route for messaging; this path still
    // will not take it automatically. Rule 4 lives here, above the gate.
    const cloud = route({ executionClass: 'cloud', provider: 'a-paid-vendor' });
    const { registry } = gate({ allowed: true, route: cloud });
    const records = await registry.routesFor('en', 'yo');
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yo', records }),
    ).toEqual({ kind: 'unavailable', reason: 'cloud-only' });
  });
});

describe('language tags are compared the way the registry keys them', () => {
  it('an account language in a different case still finds its route', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'EN', targetLanguage: 'Yo', records: [route()] }),
    ).toMatchObject({ kind: 'approved', provider: 'opus-mt' });
  });

  it('and still bypasses when both sides are the same language', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'EN', targetLanguage: ' en ', records: [] }),
    ).toEqual({ kind: 'bypass' });
  });

  it('but a different language is never folded into a neighbour', () => {
    expect(
      decideMessagingRoute({ sourceLanguage: 'en', targetLanguage: 'yor', records: [route()] }),
    ).toEqual({ kind: 'unavailable', reason: 'no-route' });
  });
});
