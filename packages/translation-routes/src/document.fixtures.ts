/** @author masterzee001 */
/**
 * Builders for the tests. Every fixture starts from a route that is REFUSED for
 * everything, so each test turns on exactly the one thing it is about and a
 * reader can see what that thing is. A fixture that starts approved would let a
 * test pass because of a default nobody wrote down.
 *
 * Not part of the built package: excluded in tsconfig.json alongside the tests.
 */
import { SERVICE_SCOPES, type ScopeApproval, type ServiceScope } from './route-record.js';

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

/**
 * A complete review block. `model` matches `route()`'s `modelId` on purpose: a
 * review of another model is refused, and a fixture that quietly disagreed
 * would make every test using it a test of that refusal.
 */
export const REVIEWED = {
  engine: 'opus-mt',
  model: 'facebook/m2m100_418M',
  modelVersion: 'a1b2c3d',
  corpusHash: 'sha256:9f2c',
  corpusVersion: '2026-09-01',
  evaluator: 'A. Reader',
  assessedAt: '2026-09-19T09:00:00.000Z',
  method: 'read all eight lines against the source',
  score: 8,
  scale: 'sentences materially correct out of 8',
  scaleMaximum: 8,
  passThreshold: 7,
  evidenceReference: 'docs/reviews/fixture.md',
};

/**
 * Who signed it. The validator refuses an approved route that does not say, so
 * a fixture that approves a scope says who. Named explicitly at each call site
 * rather than defaulted into `route()`, because an approval nobody wrote down
 * is the thing this field exists to prevent.
 */
export function approvedBy(...approved: readonly ServiceScope[]): Record<string, unknown> {
  return {
    approvedBy: 'a fixture approver',
    approvedAt: '2026-09-20T12:00:00.000Z',
    scopes: approved.length === 0 ? [...SERVICE_SCOPES] : [...approved],
  };
}

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
