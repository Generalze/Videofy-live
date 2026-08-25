/**
 * A1a — the authorization spine, and the IDOR suite.
 *
 * The attack this exists to stop is not clever: change the organization id in
 * the URL and see what happens. It works far more often than it should, because
 * the id was valid, the route existed, and nobody asked whether the caller was
 * a member.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETURN_TO,
  authorize,
  can,
  grantedCapabilities,
  isSafeReturnTo,
  personalWorkspaceId,
  safeReturnTo,
  type AuthorizationContext,
  type Capability,
  type OrganizationMembership,
  type OrganizationRole,
  entitlementForPackage,
  entitles,
  limitOf,
  noEntitlement,
} from './index.js';
import { INITIAL_TRUST, type AccountTrust } from '@videofy-live/account-trust';

const VERIFIED: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

function membership(role: OrganizationRole, over: Partial<OrganizationMembership> = {}) {
  return {
    organizationId: 'org_a',
    accountId: 'account_1',
    role,
    active: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } satisfies OrganizationMembership;
}

function orgContext(
  role: OrganizationRole,
  over: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    accountId: 'account_1',
    trust: VERIFIED,
    workspaceKind: 'organization',
    membership: membership(role),
    organizationState: 'verified',
    ...over,
  };
}

const personal: AuthorizationContext = {
  accountId: 'account_1',
  trust: VERIFIED,
  workspaceKind: 'personal',
};

describe('trust gates', () => {
  it('PIN: an unverified account reaches the shell and nothing else', () => {
    const unverified: AuthorizationContext = { ...personal, trust: INITIAL_TRUST };
    expect(can(unverified, 'workspace.view')).toBe(true);
    expect(can(unverified, 'session.host')).toBe(false);
    expect(can(unverified, 'organization.create')).toBe(false);
    expect(can(unverified, 'session.holdPrivilegedRole')).toBe(false);
    expect(can(unverified, 'product.activate')).toBe(false);
  });

  it('PIN: suspension outranks every role and entitlement', () => {
    const suspended = orgContext('organization-owner', {
      trust: { ...VERIFIED, restriction: 'suspended' },
    });
    // Owner of a verified organization, and still stopped.
    expect(can(suspended, 'organization.managePeople')).toBe(false);
    expect(can(suspended, 'organization.transferOwnership')).toBe(false);
    expect(authorize(suspended, 'organization.invite')).toEqual({
      ok: false,
      reason: 'account-restricted',
    });
    // Can still see where they stand.
    expect(can(suspended, 'workspace.view')).toBe(true);
  });

  it('PIN: a verified account under step-up cannot create durable authority', () => {
    const stepUp: AuthorizationContext = { ...personal, trust: { ...VERIFIED, risk: 'step_up_required' } };
    expect(can(stepUp, 'session.host')).toBe(false);
    expect(can(stepUp, 'organization.create')).toBe(false);
    expect(can(stepUp, 'workspace.view')).toBe(true);
  });
});

describe('IDOR: membership is the answer, the URL is the question', () => {
  it('PIN: a non-member is refused every organization capability', () => {
    // The whole attack: Org A member requests an Org B path. The id is valid,
    // the route exists, and this is the line that stops it.
    const outsider = orgContext('organization-owner', { membership: null });
    for (const capability of [
      'organization.view',
      'organization.managePeople',
      'organization.invite',
      'organization.removeMember',
      'organization.manageProducts',
      'organization.managePlan',
      'organization.manageSecurity',
      'organization.manageSettings',
      'organization.transferOwnership',
      'organization.delete',
    ] as const) {
      expect(authorize(outsider, capability), capability).toEqual({
        ok: false,
        reason: 'not-a-member',
      });
    }
  });

  it('PIN: an INACTIVE membership grants nothing', () => {
    // Offboarding must actually remove authority, not merely hide the nav.
    const removed = orgContext('organization-admin', {
      membership: membership('organization-admin', { active: false }),
    });
    expect(authorize(removed, 'organization.view')).toEqual({ ok: false, reason: 'not-a-member' });
    expect(can(removed, 'organization.invite')).toBe(false);
  });

  it('PIN: personal-workspace context never grants organization capabilities', () => {
    expect(authorize(personal, 'organization.managePeople')).toEqual({
      ok: false,
      reason: 'not-a-member',
    });
  });
});

describe('organization roles', () => {
  it('PIN: an Administrator cannot change who holds power', () => {
    const admin = orgContext('organization-admin');
    expect(can(admin, 'organization.managePeople')).toBe(true);
    expect(can(admin, 'organization.invite')).toBe(true);

    // The escalation that matters.
    expect(authorize(admin, 'organization.transferOwnership')).toEqual({
      ok: false,
      reason: 'insufficient-role',
    });
    expect(can(admin, 'organization.delete')).toBe(false);
    expect(can(admin, 'organization.manageSecurity')).toBe(false);
    expect(can(admin, 'organization.managePlan')).toBe(false);
  });

  it('PIN: a Billing Admin gets billing authority and nothing else', () => {
    const billing = orgContext('billing-admin');
    expect(can(billing, 'organization.managePlan')).toBe(true);
    // Managing the plan is not managing the people or the security policy.
    expect(can(billing, 'organization.managePeople')).toBe(false);
    expect(can(billing, 'organization.invite')).toBe(false);
    expect(can(billing, 'organization.manageSecurity')).toBe(false);
    expect(can(billing, 'organization.removeMember')).toBe(false);
  });

  it('a Member may use products and change nothing', () => {
    const member = orgContext('member');
    expect(can(member, 'organization.view')).toBe(true);
    expect(can(member, 'product.use')).toBe(true);
    expect(can(member, 'organization.invite')).toBe(false);
    expect(can(member, 'organization.manageSettings')).toBe(false);
  });

  it('an Owner holds the governance capabilities', () => {
    const owner = orgContext('organization-owner');
    for (const capability of [
      'organization.transferOwnership',
      'organization.delete',
      'organization.manageSecurity',
      'organization.managePlan',
      'organization.managePeople',
    ] as const) {
      expect(can(owner, capability), capability).toBe(true);
    }
  });
});

describe('organization state', () => {
  it('PIN: a suspended organization cannot be used by its own Owner', () => {
    const suspended = orgContext('organization-owner', { organizationState: 'suspended' });
    expect(authorize(suspended, 'organization.invite')).toEqual({
      ok: false,
      reason: 'organization-not-active',
    });
    expect(can(suspended, 'organization.view')).toBe(true);
  });

  it('an unverified organization can be worked on, not used against people', () => {
    const pending = orgContext('organization-owner', { organizationState: 'pending' });
    expect(can(pending, 'organization.view')).toBe(true);
    expect(can(pending, 'organization.manageSettings')).toBe(true);
    // Inviting staff into an unverified organization is the thing to refuse.
    expect(can(pending, 'organization.invite')).toBe(false);
    expect(can(pending, 'organization.managePeople')).toBe(false);
  });

  it('PIN: a verified organization does not verify its unverified members', () => {
    const newStarter = orgContext('organization-admin', { trust: INITIAL_TRUST });
    expect(can(newStarter, 'organization.view')).toBe(true);
    expect(authorize(newStarter, 'organization.invite')).toEqual({
      ok: false,
      reason: 'not-verified',
    });
  });
});

describe('granted capability set', () => {
  it('matches the individual decisions exactly', () => {
    const admin = orgContext('organization-admin');
    const granted = grantedCapabilities(admin);
    const every: Capability[] = [
      'organization.invite',
      'organization.transferOwnership',
      'product.use',
      'session.host',
    ];
    for (const capability of every) {
      expect(granted.has(capability), capability).toBe(can(admin, capability));
    }
  });
});

describe('personal workspace', () => {
  it('derives its id from the account, so it cannot be forged or mistyped', () => {
    expect(personalWorkspaceId('account_7')).toBe('ws_personal_account_7');
  });
});

describe('returnTo open-redirect defence', () => {
  it('PIN: refuses everything that leaves the origin', () => {
    for (const hostile of [
      'https://evil.example/',
      'http://evil.example',
      '//evil.example/',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>',
      'vbscript:msgbox',
      '%2f%2fevil.example',
      '%252f%252fevil.example',
      'https:evil.example',
      '/app/../../etc/passwd',
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe(DEFAULT_RETURN_TO);
      expect(isSafeReturnTo(hostile), hostile).toBe(false);
    }
  });

  it('accepts real internal application paths', () => {
    for (const safe of [
      '/app/',
      '/app/verification/',
      '/app/organizations/org_a/people/',
      '/call/',
      '/listen/',
      '/operator/',
      '/app/?tab=security',
    ]) {
      expect(safeReturnTo(safe), safe).toBe(safe);
    }
  });

  it('PIN: refuses public paths that are not application destinations', () => {
    // Returning somebody to the marketing site after they signed in is at best
    // confusing; more importantly, an unbounded allow-list is not an allow-list.
    expect(safeReturnTo('/')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/videofy/')).toBe(DEFAULT_RETURN_TO);
  });

  it('refuses nonsense without throwing', () => {
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(null)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(42)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/app/' + 'x'.repeat(1000))).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/app/%E0%A4%A')).toBe(DEFAULT_RETURN_TO);
  });
});

describe('product entitlements', () => {
  it('PIN: a plan NAME is never the check — a grant is', () => {
    const corporate = entitlementForPackage({ workspaceId: 'ws_1', packageId: 'corporate' });
    expect(entitles(corporate, 'call')).toBe(true);
    expect(entitles(corporate, 'conference')).toBe(true);
    expect(entitles(corporate, 'programme')).toBe(true);
  });

  it('PIN: nothing is entitled to a subsystem that does not exist yet', () => {
    // Recording and SIP have names and no implementation. An entitlement to
    // either would be a promise the product cannot keep.
    for (const packageId of ['personal', 'corporate', 'enterprise'] as const) {
      const entitlement = entitlementForPackage({ workspaceId: 'ws_1', packageId });
      expect(entitles(entitlement, 'recording'), packageId).toBe(false);
      expect(entitles(entitlement, 'sip'), packageId).toBe(false);
    }
  });

  it('PIN: a disabled entitlement denies everything it lists', () => {
    const suspended = entitlementForPackage({
      workspaceId: 'ws_1',
      packageId: 'enterprise',
      enabled: false,
    });
    // A suspended plan must not be one forgotten check away from working.
    expect(suspended.capabilities.has('conference')).toBe(true);
    expect(entitles(suspended, 'conference')).toBe(false);
  });

  it('PIN: a missing limit is NOT unlimited', () => {
    const entitlement = entitlementForPackage({ workspaceId: 'ws_1', packageId: 'corporate' });
    // A gap in provisioning must not read as permission.
    expect(limitOf(entitlement, 'maxParticipants')).toBeNull();
    expect(limitOf(null, 'maxParticipants')).toBeNull();
  });

  it('an absent entitlement grants nothing', () => {
    expect(entitles(noEntitlement('ws_1', 'videofy-live'), 'call')).toBe(false);
    expect(entitles(null, 'call')).toBe(false);
    expect(entitles(undefined, 'call')).toBe(false);
  });

  it('a personal workspace gets calls, not conferences', () => {
    const personalPlan = entitlementForPackage({ workspaceId: 'ws_1', packageId: 'personal' });
    expect(entitles(personalPlan, 'call')).toBe(true);
    expect(entitles(personalPlan, 'conference')).toBe(false);
  });
});

/**
 * The graduated trust gate, seen from the surface that enforces it.
 *
 * trust-model.ts decides what a set of components grants; this is where that
 * decision actually stops or allows a request, so the policy is pinned at both
 * ends. Before graduation this whole block was impossible: every capability
 * required email AND phone AND identity, and identity is synthetic.
 */
describe('a verified email is enough to use the product', () => {
  const EMAIL_ONLY: AccountTrust = {
    email: 'verified',
    phone: 'unverified',
    identity: 'unverified',
    risk: 'normal',
    restriction: 'none',
  };

  it('hosts a call from a personal workspace', () => {
    const context: AuthorizationContext = {
      accountId: 'account_1',
      trust: EMAIL_ONLY,
      workspaceKind: 'personal',
    };
    expect(can(context, 'session.host')).toBe(true);
    expect(can(context, 'organization.create')).toBe(true);
  });

  it('acts inside a verified organization rather than only viewing it', () => {
    const context = orgContext('organization-admin', { trust: EMAIL_ONLY });
    expect(can(context, 'organization.view')).toBe(true);
    // The gate that made organizations unusable for an email-verified member.
    expect(can(context, 'organization.managePeople')).toBe(true);
    expect(can(context, 'organization.invite')).toBe(true);
  });

  /* Money still waits for identity; nothing reaches this today. */
  it('cannot activate a commercial product', () => {
    const context: AuthorizationContext = {
      accountId: 'account_1',
      trust: EMAIL_ONLY,
      workspaceKind: 'personal',
    };
    expect(can(context, 'product.activate')).toBe(false);
  });

  /* The organization's own state is the other gate, and it still applies. */
  it('is still bounded by the organization state', () => {
    const draft = orgContext('organization-admin', {
      trust: EMAIL_ONLY,
      organizationState: 'draft',
    });
    expect(can(draft, 'organization.view')).toBe(true);
    expect(can(draft, 'organization.managePeople')).toBe(false);
  });

  it('is still bounded by the role', () => {
    const member = orgContext('member', { trust: EMAIL_ONLY });
    expect(can(member, 'organization.view')).toBe(true);
    expect(can(member, 'organization.managePeople')).toBe(false);
  });
});
