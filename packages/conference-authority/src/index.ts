export {
  CONFERENCE_CAPABILITIES,
  CONFERENCE_ROLE_LABELS,
  CONFERENCE_ROLES,
  isConferenceRole,
  type ConferenceCapability,
  type ConferenceRole,
} from './roles.js';
export {
  canInConference,
  resolveConferenceAuthority,
  type ConferenceAuthority,
  type ConferenceAuthorityInput,
} from './capabilities.js';
export {
  decideGovernance,
  ROLE_AFTER_CHAIR_TRANSFER,
  type GovernanceAction,
  type GovernanceAuditEvent,
  type GovernanceDecision,
  type GovernanceRefusal,
  type GovernanceRequest,
} from './governance.js';
