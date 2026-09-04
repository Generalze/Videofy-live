/** @author masterzee001 */
/**
 * Builders for the tests. Every fixture starts from a route that is REFUSED for
 * everything, so each test turns on exactly the one thing it is about and a
 * reader can see what that thing is. A fixture that starts approved would let a
 * test pass because of a default nobody wrote down.
 *
 * Not part of the built package: excluded in tsconfig.json alongside the tests.
 */
import type { ScopeApproval, ServiceScope } from './route-record.js';

export const MEASURED = {
  sampleCount: 5,
  successRate: 1,
  latencyMs: { min: 120, median: 180, mean: 190, max: 260 },
  recordedAt: '2026-08-30T00:00:00.000Z',
  notes: 'fixture measurement; availability and latency only',
};

export const PERMISSIVE_LICENCE = {
  licence: 'Apache-2.0',
  commercialUse: 'permitted',
  evidence: 'fixture',
};

export function scopes(
  overrides: Partial<Record<ServiceScope, ScopeApproval>> = {},
): Record<ServiceScope, ScopeApproval> {
  return {
    messaging: 'unapproved',
    'programme-live': 'unapproved',
    'call-live': 'unapproved',
    ...overrides,
  };
}

/** A refused-everywhere route. Override only what the test is about. */
export function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'm2m100',
    modelId: 'facebook/m2m100_418M',
    executionClass: 'local',
    productionApproved: false,
    technicalEvidence: null,
    humanReviewStatus: 'required-not-done',
    licenceStatus: { ...PERMISSIVE_LICENCE },
    serviceScopes: scopes(),
    ...overrides,
  };
}

export function documentOf(...routes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: 1,
    reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm'],
    routes,
  };
}
