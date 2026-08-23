/**
 * The authorization spine.
 *
 * PATH HIDING IS NOT AUTHORIZATION. A hidden button, an absent nav item and a
 * client-side route guard are all UX: they shape what somebody is invited to
 * do. None of them stop a request. Every protected action resolves HERE, from
 * facts the server established.
 *
 * The inputs are deliberately awkward to fake, because each one has a source:
 *
 *   accountId       from a verified session token
 *   trust           from the account record
 *   membership      from the organization's own member list
 *   entitlement     from the workspace's product grants
 *
 * Nothing is read from a URL, a request body, or a header the caller controls.
 * `organizationId` appearing in a path is a QUESTION, never an answer.
 */
import { resolveTrustState, trustCapabilities, type AccountTrust } from '@videofy-live/account-trust';
import type { OrganizationMembership, OrganizationRole, OrganizationState } from './workspace.js';

export type Capability =
  // workspace
  | 'workspace.view'
  | 'workspace.switch'
  // organization management
  | 'organization.create'
  | 'organization.view'
  | 'organization.managePeople'
  | 'organization.invite'
  | 'organization.removeMember'
  | 'organization.manageProducts'
  | 'organization.managePlan'
  | 'organization.manageSecurity'
  | 'organization.manageSettings'
  | 'organization.transferOwnership'
  | 'organization.delete'
  // products
  | 'product.use'
  | 'product.activate'
  // sessions
  | 'session.host'
  | 'session.holdPrivilegedRole';

export interface AuthorizationContext {
  readonly accountId: string;
  readonly trust: AccountTrust;
  /**
   * The workspace the request is FOR, and the membership the server found for
   * this account in it. `null` membership on an organization workspace means
   * exactly one thing: this account is not a member, whatever the URL said.
   */
  readonly workspaceKind: 'personal' | 'organization';
  readonly membership?: OrganizationMembership | null;
  readonly organizationState?: OrganizationState;
  /** Products granted to this workspace. */
  readonly entitlements?: ReadonlySet<string>;
}

export type Denial =
  | 'not-authenticated'
  | 'not-verified'
  | 'account-restricted'
  | 'not-a-member'
  | 'organization-not-active'
  | 'insufficient-role'
  | 'no-entitlement';

export type Decision = { readonly ok: true } | { readonly ok: false; readonly reason: Denial };

const ALLOW: Decision = { ok: true };
const deny = (reason: Denial): Decision => ({ ok: false, reason });

/**
 * Organization capabilities by role.
 *
 * Owner is the only role that can change WHO HOLDS POWER. An administrator runs
 * the organization and cannot promote itself, transfer ownership or delete the
 * organization — the same shape as the conference model, for the same reason.
 */
const ROLE_CAPABILITIES: Readonly<Record<OrganizationRole, readonly Capability[]>> = {
  'organization-owner': [
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
    'product.use',
    'product.activate',
  ],
  'organization-admin': [
    'organization.view',
    'organization.managePeople',
    'organization.invite',
    'organization.removeMember',
    'organization.manageProducts',
    'organization.manageSettings',
    'product.use',
  ],
  // Billing authority ONLY. A billing administrator manages the plan and the
  // seats and gains nothing over people or security by doing so — those are
  // different jobs that happen to be held by the same person in a small company.
  'billing-admin': ['organization.view', 'organization.managePlan', 'product.use'],
  member: ['organization.view', 'product.use'],
};

/**
 * Decide one capability.
 *
 * Deny is the default at every step, and the checks run from the broadest to
 * the narrowest so a later grant can never rescue an earlier refusal.
 */
export function authorize(
  context: AuthorizationContext,
  capability: Capability,
): Decision {
  if (!context.accountId) return deny('not-authenticated');

  const state = resolveTrustState(context.trust);
  const trustGrants = trustCapabilities(context.trust);

  // Suspension and rejection stop everything except looking at your own
  // standing. Checked before anything else so no role or entitlement can
  // outrank them.
  if (state === 'suspended' || state === 'rejected') {
    return capability === 'workspace.view' ? ALLOW : deny('account-restricted');
  }
  if (state === 'restricted') {
    return capability === 'workspace.view' ? ALLOW : deny('account-restricted');
  }

  // Reaching the shell and seeing your own workspace never requires
  // verification: somebody mid-verification must be able to see what is left.
  if (capability === 'workspace.view' || capability === 'workspace.switch') return ALLOW;

  if (!trustGrants.canAccessApp) return deny('not-verified');

  if (capability === 'organization.create') {
    return trustGrants.canCreateOrganization ? ALLOW : deny('not-verified');
  }
  if (capability === 'session.host') {
    return trustGrants.canHostSessions ? ALLOW : deny('not-verified');
  }
  if (capability === 'session.holdPrivilegedRole') {
    return trustGrants.canHoldPrivilegedRole ? ALLOW : deny('not-verified');
  }
  if (capability === 'product.activate' && context.workspaceKind === 'personal') {
    return trustGrants.canActivateProducts ? ALLOW : deny('not-verified');
  }

  if (context.workspaceKind === 'personal') {
    // A personal workspace has no roles: the owner is the only member, and the
    // organization capabilities simply do not apply there.
    if (capability.startsWith('organization.')) return deny('not-a-member');
    return trustGrants.canActivateProducts ? ALLOW : deny('not-verified');
  }

  // --- organization workspace ---------------------------------------------
  const membership = context.membership ?? null;
  // The single most important line here. An id in a URL is a question; this is
  // the answer, and it comes from the organization's own member list.
  if (membership === null || !membership.active) return deny('not-a-member');

  const organizationState = context.organizationState ?? 'draft';
  if (organizationState === 'suspended' || organizationState === 'rejected') {
    return capability === 'organization.view' ? ALLOW : deny('organization-not-active');
  }
  if (organizationState !== 'verified' && capability !== 'organization.view') {
    // An unverified organization can be looked at and worked on toward
    // verification; it cannot yet be used to do things to other people.
    if (capability !== 'organization.manageSettings' && capability !== 'organization.managePlan') {
      return deny('organization-not-active');
    }
  }

  // Individual trust is still required inside an organization. An invitation
  // from a verified company does not verify the person it invited.
  if (!trustGrants.canHoldPrivilegedRole && capability !== 'organization.view') {
    return deny('not-verified');
  }

  const granted = ROLE_CAPABILITIES[membership.role] ?? [];
  if (!granted.includes(capability)) return deny('insufficient-role');

  return ALLOW;
}

export function can(context: AuthorizationContext, capability: Capability): boolean {
  return authorize(context, capability).ok;
}

/** Every capability this context actually holds — for rendering, not deciding. */
export function grantedCapabilities(context: AuthorizationContext): ReadonlySet<Capability> {
  const all: Capability[] = [
    'workspace.view',
    'workspace.switch',
    'organization.create',
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
    'product.use',
    'product.activate',
    'session.host',
    'session.holdPrivilegedRole',
  ];
  return new Set(all.filter((capability) => can(context, capability)));
}
