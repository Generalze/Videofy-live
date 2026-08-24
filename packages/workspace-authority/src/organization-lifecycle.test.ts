/**
 * The organization lifecycle, including its end.
 *
 * The valuable tests here are the ones about IRREVERSIBILITY and its opposite:
 * that closure is final, that closure REQUESTED is not, and that verification
 * and rejection can both be revisited without the organization being destroyed
 * and recreated to express it.
 */
import { describe, expect, it } from 'vitest';
import {
  INACTIVE_ORGANIZATION_STATES,
  TERMINAL_ORGANIZATION_STATES,
  can,
  isLegalOrganizationTransition,
  type AuthorizationContext,
  type OrganizationState,
} from './index.js';

describe('lifecycle transitions', () => {
  it('permits a no-op so idempotent writes need no special case', () => {
    expect(isLegalOrganizationTransition('verified', 'verified')).toBe(true);
    expect(isLegalOrganizationTransition('closed', 'closed')).toBe(true);
  });

  /*
   * The defect this table was written for: setState accepted anything from
   * anything, so one mistaken call could resurrect a closed organization and
   * make every audit statement about it conditional.
   */
  it('makes closure terminal', () => {
    const everywhere: readonly OrganizationState[] = [
      'draft',
      'verification_required',
      'pending',
      'under_review',
      'verified',
      'restricted',
      'rejected',
      'suspended',
      'closure_pending',
      'archived',
    ];
    for (const state of everywhere) {
      expect(isLegalOrganizationTransition('closed', state)).toBe(false);
    }
  });

  it('keeps closure_pending reversible, because a request is not the act', () => {
    expect(isLegalOrganizationTransition('closure_pending', 'verified')).toBe(true);
    expect(isLegalOrganizationTransition('closure_pending', 'restricted')).toBe(true);
    expect(isLegalOrganizationTransition('closure_pending', 'closed')).toBe(true);
  });

  /*
   * Verification is not an eternal boolean. An expiring check, a provider
   * revocation or a material change in the business must be expressible
   * without destroying identity or history.
   */
  it('lets a verified organization return to review', () => {
    expect(isLegalOrganizationTransition('verified', 'under_review')).toBe(true);
    expect(isLegalOrganizationTransition('verified', 'restricted')).toBe(true);
    expect(isLegalOrganizationTransition('verified', 'suspended')).toBe(true);
  });

  /* External providers produce false positives as a matter of routine. */
  it('lets a rejected organization be appealed back into review', () => {
    expect(isLegalOrganizationTransition('rejected', 'under_review')).toBe(true);
  });

  it('never lets rejection jump straight back to verified', () => {
    expect(isLegalOrganizationTransition('rejected', 'verified')).toBe(false);
  });

  /* Whatever was true when it was archived may no longer be. */
  it('restores an archived organization into review rather than verified', () => {
    expect(isLegalOrganizationTransition('archived', 'under_review')).toBe(true);
    expect(isLegalOrganizationTransition('archived', 'verified')).toBe(false);
  });

  it('accepts a terminal outcome straight from draft, as KYB providers emit it', () => {
    expect(isLegalOrganizationTransition('draft', 'verified')).toBe(true);
    expect(isLegalOrganizationTransition('draft', 'rejected')).toBe(true);
  });
});

describe('lifecycle and capability', () => {
  function context(state: OrganizationState): AuthorizationContext {
    return {
      accountId: 'account_1',
      trust: {
        email: 'verified',
        phone: 'verified',
        identity: 'verified',
        risk: 'normal',
        restriction: 'none',
      },
      workspaceKind: 'organization',
      membership: {
        organizationId: 'org_1',
        accountId: 'account_1',
        role: 'organization-owner',
        active: true,
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
      organizationState: state,
    };
  }

  /* A control, so the assertions below cannot pass for an unrelated reason. */
  it('permits an owner in a verified organization', () => {
    expect(can(context('verified'), 'organization.view')).toBe(true);
    expect(can(context('verified'), 'organization.managePeople')).toBe(true);
  });

  /*
   * Closure must actually stop work rather than relabel a dashboard.
   */
  it('refuses even viewing a closed organization', () => {
    expect(can(context('closed'), 'organization.view')).toBe(false);
    expect(can(context('closed'), 'organization.managePeople')).toBe(false);
  });

  it('leaves a read-only window on the other inactive states', () => {
    for (const state of ['suspended', 'archived', 'closure_pending'] as const) {
      expect(can(context(state), 'organization.view')).toBe(true);
      expect(can(context(state), 'organization.managePeople')).toBe(false);
    }
  });

  it('classifies the inactive states consistently', () => {
    expect(INACTIVE_ORGANIZATION_STATES.has('closed')).toBe(true);
    expect(INACTIVE_ORGANIZATION_STATES.has('archived')).toBe(true);
    expect(INACTIVE_ORGANIZATION_STATES.has('verified')).toBe(false);
    expect(TERMINAL_ORGANIZATION_STATES.has('closed')).toBe(true);
    expect(TERMINAL_ORGANIZATION_STATES.has('archived')).toBe(false);
  });
});
