/**
 * Consent versioning.
 *
 * The tests that matter here are all about the passage of TIME: what happens
 * when a policy is revised after somebody accepted the previous one, and
 * whether the record still answers "which version, on what date" afterwards.
 * A boolean passes none of these.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptedVersionOf,
  consentSatisfied,
  outstandingConsents,
  recordConsent,
  type ConsentRecord,
  type PolicyRequirement,
} from './index.js';

const NOW = 1_700_000_000_000;
const ACCOUNT = 'acc_1';

const REQUIRED: readonly PolicyRequirement[] = [
  { policyType: 'terms-of-service', requiredVersion: '2026-01-15' },
  { policyType: 'privacy-policy', requiredVersion: '2026-01-15' },
];

function accept(
  held: readonly ConsentRecord[],
  policyType: ConsentRecord['policyType'],
  policyVersion: string,
  nowMs = NOW,
  accountId = ACCOUNT,
): readonly ConsentRecord[] {
  return recordConsent({ held, accountId, policyType, policyVersion, nowMs });
}

describe('outstanding consent', () => {
  it('reports every required policy for a new account', () => {
    const outstanding = outstandingConsents({ required: REQUIRED, held: [], accountId: ACCOUNT });
    expect(outstanding.map((entry) => entry.policyType)).toEqual([
      'terms-of-service',
      'privacy-policy',
    ]);
  });

  it('is satisfied once every required policy is accepted at the required version', () => {
    let held = accept([], 'terms-of-service', '2026-01-15');
    held = accept(held, 'privacy-policy', '2026-01-15');
    expect(consentSatisfied({ required: REQUIRED, held, accountId: ACCOUNT })).toBe(true);
  });

  /*
   * The whole reason this module exists. Nothing is migrated and no flag is
   * cleared: publishing a new version simply stops matching, and consent
   * re-opens by itself.
   */
  it('re-opens consent when a policy is revised', () => {
    let held = accept([], 'terms-of-service', '2026-01-15');
    held = accept(held, 'privacy-policy', '2026-01-15');

    const revised: readonly PolicyRequirement[] = [
      { policyType: 'terms-of-service', requiredVersion: '2026-06-01' },
      { policyType: 'privacy-policy', requiredVersion: '2026-01-15' },
    ];

    const outstanding = outstandingConsents({ required: revised, held, accountId: ACCOUNT });
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.policyType).toBe('terms-of-service');
    expect(outstanding[0]?.requiredVersion).toBe('2026-06-01');
  });

  /*
   * Version strings are compared for equality, never ordered. A scheme that
   * sorted unexpectedly would otherwise mark an unread policy as accepted.
   */
  it('does not treat an older acceptance as covering a newer version', () => {
    const held = accept([], 'terms-of-service', '9.9.9');
    const required: readonly PolicyRequirement[] = [
      { policyType: 'terms-of-service', requiredVersion: '10.0.0' },
    ];
    expect(consentSatisfied({ required, held, accountId: ACCOUNT })).toBe(false);
  });

  it("never lets one account's consent satisfy another's", () => {
    const held = accept([], 'terms-of-service', '2026-01-15', NOW, 'acc_other');
    const required: readonly PolicyRequirement[] = [
      { policyType: 'terms-of-service', requiredVersion: '2026-01-15' },
    ];
    expect(consentSatisfied({ required, held, accountId: ACCOUNT })).toBe(false);
  });
});

describe('recording consent', () => {
  it('keeps the superseded version as evidence', () => {
    let held = accept([], 'terms-of-service', '2026-01-15');
    held = accept(held, 'terms-of-service', '2026-06-01', NOW + 90 * 86_400_000);

    expect(held).toHaveLength(2);
    expect(held.map((record) => record.policyVersion)).toEqual(['2026-01-15', '2026-06-01']);
  });

  /*
   * Re-clicking accept must not move the date consent was actually given —
   * that date is the evidentiary value of the whole record.
   */
  it('collapses a duplicate of the same version and preserves the original date', () => {
    let held = accept([], 'terms-of-service', '2026-01-15');
    held = accept(held, 'terms-of-service', '2026-01-15', NOW + 86_400_000);

    expect(held).toHaveLength(1);
    expect(held[0]?.acceptedAtMs).toBe(NOW);
  });

  it('reports the most recent acceptance of a policy', () => {
    let held = accept([], 'terms-of-service', '2026-01-15');
    held = accept(held, 'terms-of-service', '2026-06-01', NOW + 90 * 86_400_000);

    const latest = acceptedVersionOf({ held, accountId: ACCOUNT, policyType: 'terms-of-service' });
    expect(latest?.policyVersion).toBe('2026-06-01');
  });

  it('reports nothing for a policy never accepted', () => {
    expect(
      acceptedVersionOf({ held: [], accountId: ACCOUNT, policyType: 'data-processing' }),
    ).toBeNull();
  });
});
