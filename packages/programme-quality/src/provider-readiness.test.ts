/** @author masterzee001 */
/**
 * The five facts, and the ways they get collapsed into one.
 *
 * Each test here corresponds to a way this product has been, or could be,
 * misled by a provider that looked ready. The scale-to-zero case is not
 * hypothetical: a live translation provider on this deployment sleeps, and the
 * request that wakes it is the one that opens a broadcast.
 */
import { describe, expect, it } from 'vitest';
import { NOT_ASSESSED, type ReviewedQuality, type ReviewEvidence } from './reviewed.js';
import {
  liveRouteEligibility,
  readinessLevel,
  type ProviderReadiness,
} from './provider-readiness.js';

const evidence: ReviewEvidence = {
  sourceLanguage: 'en',
  targetLanguage: 'yo',
  scope: 'programme-live',
  engine: 'naijalingo',
  model: 'yo-general',
  modelVersion: '2026.08',
  corpusHash: 'c0ffee',
  corpusVersion: 'ng-business-v3',
  evaluator: 'A. Adeyemi',
  assessedAt: '2026-08-20T10:00:00.000Z',
  method: 'human-review',
  score: 4.4,
  scale: '1-5 adequacy',
  evidenceReference: 'QUAL-114',
};

const ASSESSED: ReviewedQuality = { assessed: true, evidence };

function readiness(over: Partial<ProviderReadiness> = {}): ProviderReadiness {
  return {
    provider: 'naijalingo',
    configured: true,
    healthy: true,
    warm: true,
    qualified: ASSESSED,
    approved: true,
    ...over,
  };
}

describe('every one of the five has to hold', () => {
  it('admits a provider that satisfies all of them', () => {
    expect(liveRouteEligibility(readiness())).toEqual({ eligible: true });
    expect(readinessLevel(readiness())).toBe('approved');
  });

  it('refuses a provider that is merely configured', () => {
    // The whole point: a credential proves somebody pasted a string.
    const only = readiness({ healthy: null, warm: null, qualified: NOT_ASSESSED, approved: false });
    const verdict = liveRouteEligibility(only);
    expect(verdict.eligible).toBe(false);
    expect(readinessLevel(only)).toBe('configured');
  });

  it('lists every blocker at once rather than one per day', () => {
    const verdict = liveRouteEligibility(
      readiness({ healthy: false, warm: false, qualified: NOT_ASSESSED, approved: false }),
    );
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers).toHaveLength(4);
  });
});

describe('a scale-to-zero provider cannot carry a live route', () => {
  it('is refused even when it is healthy, configured, qualified and approved', () => {
    // It IS healthy: the probe is what woke it. The next real request, the one
    // that opens a broadcast, meets a cold start and a 503.
    const sleeper = readiness({ warm: false });
    const verdict = liveRouteEligibility(sleeper);
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('scales to zero');
  });

  it('treats unknown warmth as a blocker, not as warm', () => {
    const verdict = liveRouteEligibility(readiness({ warm: null }));
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('warmth is unknown');
  });
});

describe('unknown is not the same as false', () => {
  it('says a provider has never been probed rather than that it failed', () => {
    const verdict = liveRouteEligibility(readiness({ healthy: null }));
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('never been probed');
    expect(verdict.blockers.join(' ')).not.toContain('did not answer');
  });

  it('says a probe failed when it actually failed', () => {
    const verdict = liveRouteEligibility(readiness({ healthy: false }));
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('did not answer');
  });
});

describe('a linguistic assessment is required, and must be current', () => {
  it('refuses a route nobody has judged', () => {
    const verdict = liveRouteEligibility(readiness({ qualified: NOT_ASSESSED }));
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('no linguistic assessment');
  });

  it('refuses a route whose assessment is about an older model', () => {
    // The Hausa lesson: an engine can be fast, healthy, approved and wrong.
    const stale: ReviewedQuality = { assessed: false, reason: 'stale', evidence };
    const verdict = liveRouteEligibility(readiness({ qualified: stale }));
    if (verdict.eligible) throw new Error('unreachable');
    expect(verdict.blockers.join(' ')).toContain('earlier model or corpus');
  });
});

describe('the word shown never outruns the evidence', () => {
  it('never says approved for a provider that is not eligible', () => {
    for (const over of [
      { configured: false },
      { healthy: null },
      { healthy: false },
      { warm: false },
      { qualified: NOT_ASSESSED },
      { approved: false },
    ] as Partial<ProviderReadiness>[]) {
      expect(readinessLevel(readiness(over))).not.toBe('approved');
    }
  });

  it('does not call a sleeping provider warm', () => {
    expect(readinessLevel(readiness({ warm: false, approved: false }))).toBe('healthy');
  });
});
