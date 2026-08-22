/**
 * Governance transitions: appoint, revoke, transfer.
 *
 * The DECISION lives here, pure and total. The store applies the decision but
 * never makes one -- otherwise there are two authorities on who may appoint
 * whom, and the second one is always discovered later, disagreeing.
 */
import { resolveConferenceAuthority, type ConferenceAuthorityInput } from './capabilities.js';
import type { ConferenceRole } from './roles.js';

export type GovernanceAction =
  | 'appoint-administrator'
  | 'revoke-administrator'
  | 'appoint-secretary'
  | 'revoke-secretary'
  | 'transfer-chair';

export type GovernanceRefusal =
  | 'not-authorised'
  | 'unknown-target'
  | 'target-not-authenticated'
  | 'target-is-chair'
  | 'target-role-mismatch'
  | 'cannot-target-self'
  | 'conference-ended';

export interface GovernanceRequest {
  readonly action: GovernanceAction;
  /** The member attempting the change, as the SERVER knows them. */
  readonly actor: ConferenceAuthorityInput;
  readonly actorParticipantId: string;
  readonly targetParticipantId: string;
  /** The target's current role, or null if they are not in this conference. */
  readonly targetRole: ConferenceRole | null;
  /** The target's authenticated account, or null for a guest. */
  readonly targetAccountId: string | null;
}

export type GovernanceDecision =
  | { readonly ok: true; readonly nextTargetRole: ConferenceRole; readonly chairMovesToTarget: boolean }
  | { readonly ok: false; readonly reason: GovernanceRefusal };

function requiredCapability(action: GovernanceAction) {
  switch (action) {
    case 'appoint-administrator':
    case 'revoke-administrator':
      return 'appointAdministrators' as const;
    case 'appoint-secretary':
    case 'revoke-secretary':
      return 'appointSecretaries' as const;
    case 'transfer-chair':
      return 'transferChair' as const;
  }
}

export function decideGovernance(request: GovernanceRequest): GovernanceDecision {
  const { action, actor, targetRole, targetAccountId } = request;

  if (actor.conferenceEnded === true) return { ok: false, reason: 'conference-ended' };

  // Authority first, and from the resolver rather than from a role comparison
  // written here. Only the Chairman holds any of these capabilities today, but
  // asking the resolver means a future delegation cannot be silently bypassed
  // by this file having its own opinion.
  const authority = resolveConferenceAuthority(actor);
  if (!authority.can(requiredCapability(action))) return { ok: false, reason: 'not-authorised' };

  if (targetRole === null) return { ok: false, reason: 'unknown-target' };

  // Self-targeting is refused for every action here INCLUDING transfer: a Chair
  // transferring to itself is a no-op that would still emit an audit event
  // saying the Chair changed, and an audit trail that records changes which did
  // not happen is worse than none.
  if (request.targetParticipantId === request.actorParticipantId) {
    return { ok: false, reason: 'cannot-target-self' };
  }

  // Durable privilege is account-bound. A guest seat cannot survive a reconnect
  // as anything but a new guest, so granting it authority would create a role
  // that silently evaporates -- or worse, lands on whoever takes the seat next.
  const targetAuthenticated =
    typeof targetAccountId === 'string' && targetAccountId.length > 0;

  switch (action) {
    case 'appoint-administrator':
    case 'appoint-secretary': {
      if (!targetAuthenticated) return { ok: false, reason: 'target-not-authenticated' };
      // The Chair is not demoted by being appointed something else. Removing
      // the only root authority through a side door is exactly the kind of
      // move this model exists to make impossible.
      if (targetRole === 'chair') return { ok: false, reason: 'target-is-chair' };
      return {
        ok: true,
        nextTargetRole: action === 'appoint-administrator' ? 'administrator' : 'secretary',
        chairMovesToTarget: false,
      };
    }

    case 'revoke-administrator':
    case 'revoke-secretary': {
      const expected: ConferenceRole =
        action === 'revoke-administrator' ? 'administrator' : 'secretary';
      // Revoking a role the target does not hold is refused rather than
      // silently treated as success: "revoke Secretary" against an
      // Administrator would otherwise quietly demote them to Participant.
      if (targetRole !== expected) return { ok: false, reason: 'target-role-mismatch' };
      return { ok: true, nextTargetRole: 'participant', chairMovesToTarget: false };
    }

    case 'transfer-chair': {
      if (!targetAuthenticated) return { ok: false, reason: 'target-not-authenticated' };
      if (targetRole === 'chair') return { ok: false, reason: 'target-is-chair' };
      // Atomic by construction: the caller is told the Chair moves, and the
      // outgoing Chair's next role is decided here rather than left to the
      // store to improvise. Exactly one Chairman before, exactly one after.
      return { ok: true, nextTargetRole: 'chair', chairMovesToTarget: true };
    }
  }
}

/** What the outgoing Chairman becomes after a transfer. */
export const ROLE_AFTER_CHAIR_TRANSFER: ConferenceRole = 'participant';

export interface GovernanceAuditEvent {
  readonly conferenceId: string;
  readonly action: GovernanceAction;
  readonly actorParticipantId: string;
  readonly actorAccountId: string | null;
  readonly targetParticipantId: string;
  readonly targetAccountId: string | null;
  readonly occurredAtIso: string;
}
