/**
 * Workspaces — where a C7 account does things.
 *
 * ONE global identity, MANY workspaces. A person has a personal workspace and
 * may belong to organizations, and those are different containers rather than
 * different accounts. The alternative — a separate login per context — is how
 * somebody ends up with two accounts, one of which holds the thing they need.
 *
 * A personal workspace is created at signup and outlives every organization
 * membership. Being removed from a company must never take away the account, or
 * the personal workspace, or anything in it.
 */

export type WorkspaceKind = 'personal' | 'organization';

export type OrganizationRole =
  | 'organization-owner'
  | 'organization-admin'
  | 'billing-admin'
  | 'member';

export const ORGANIZATION_ROLE_LABELS: Readonly<Record<OrganizationRole, string>> = {
  'organization-owner': 'Owner',
  'organization-admin': 'Administrator',
  'billing-admin': 'Billing administrator',
  member: 'Member',
};

/**
 * Organization lifecycle, mirroring the account trust vocabulary on purpose:
 * an organization is verified or not for the same kinds of reasons a person is.
 */
/**
 * The life of an organization, including its end.
 *
 * THE CLOSURE STATES ARE NOT DECORATION. "Delete the organization" sounds like
 * one action and is at least four: memberships end, entitlements stop, owned
 * resources are dealt with, and audit records are retained because a
 * disappearing organization is exactly what somebody covering their tracks
 * would want. Modelling closure as a PROCESS rather than a row deletion is what
 * makes each of those separable and reversible up to the point it should not be.
 *
 *  - `closure_pending` -- closure requested and reversible. Nothing is
 *    destroyed; the organization stops being usable.
 *  - `archived` -- retained, inert, restorable. The state for an organization
 *    that stopped paying rather than one that did something wrong.
 *  - `closed` -- terminal. Records that must be retained are retained; nothing
 *    transitions out, because a closed organization coming back to life would
 *    make every audit statement about it conditional.
 */
export type OrganizationState =
  | 'draft'
  | 'verification_required'
  | 'pending'
  | 'under_review'
  | 'verified'
  | 'restricted'
  | 'rejected'
  | 'suspended'
  | 'closure_pending'
  | 'archived'
  | 'closed';

export interface Workspace {
  readonly workspaceId: string;
  readonly kind: WorkspaceKind;
  /** Present only for an organization workspace. */
  readonly organizationId?: string;
  /** The account that owns a PERSONAL workspace. */
  readonly ownerAccountId?: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface OrganizationMembership {
  readonly organizationId: string;
  readonly accountId: string;
  readonly role: OrganizationRole;
  /**
   * A membership can exist before the person is verified — an invitation
   * accepted by somebody mid-verification is normal. It confers no authority
   * until trust allows, which is decided by the resolver, not here.
   */
  readonly active: boolean;
  readonly joinedAt: string;
}

/** The personal workspace id is DERIVED, so it can never be mistyped or forged. */
export function personalWorkspaceId(accountId: string): string {
  return `ws_personal_${accountId}`;
}

export function createPersonalWorkspace(accountId: string, createdAt: string): Workspace {
  return {
    workspaceId: personalWorkspaceId(accountId),
    kind: 'personal',
    ownerAccountId: accountId,
    displayName: 'Personal',
    createdAt,
  };
}

export function organizationWorkspaceId(organizationId: string): string {
  return `ws_org_${organizationId}`;
}
