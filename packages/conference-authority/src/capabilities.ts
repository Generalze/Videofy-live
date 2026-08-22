/**
 * The ONE authority that decides what a conference member may do.
 *
 * Nothing outside this file should ever write `if (role === 'chair')`. Scatter
 * that test through the codebase and the rules stop being a model and become a
 * habit: each site drifts, and the one that drifts is discovered when somebody
 * does something they should not have been able to do.
 *
 * Effective authority is a function of:
 *
 *   authenticated C7 account
 *   + conference membership
 *   + conference role
 *   + conference state
 *   + later, explicit delegation
 *
 * It is NEVER a function of what the client said it was.
 */
import {
  CONFERENCE_CAPABILITIES,
  type ConferenceCapability,
  type ConferenceRole,
} from './roles.js';

export interface ConferenceAuthorityInput {
  /**
   * The role this member holds IN THIS CONFERENCE, as the server recorded it.
   *
   * Never a value the client sent. A client that could name its own role could
   * name `chair`, and the entire model would be decoration.
   */
  readonly role: ConferenceRole;
  /**
   * The authenticated C7 account behind this seat, or null for a guest.
   *
   * Privilege is account-bound. A guest may take part in a conference, but may
   * not hold durable authority over it: authority has to survive a reconnect,
   * and there is nothing durable about an anonymous socket.
   */
  readonly accountId: string | null;
  /** Whether the member is currently a member of this conference at all. */
  readonly isMember: boolean;
  /** A conference that has ended grants no operational authority. */
  readonly conferenceEnded?: boolean;
  /**
   * P7.0C seam. A Chairman may later grant a specific Secretary standing
   * authority to start and stop recording. Nothing produces this yet, and the
   * recording service does not exist; the parameter exists so that adding it
   * later does not require reopening who may record.
   */
  readonly standingRecordingDelegation?: boolean;
}

/** Capabilities by role, for an AUTHENTICATED member of a live conference. */
const BY_ROLE: Readonly<Record<ConferenceRole, readonly ConferenceCapability[]>> = {
  // Root authority. Everything, by definition -- including the approvals that
  // exist precisely so nobody else can grant themselves the thing.
  chair: CONFERENCE_CAPABILITIES,

  // Operational management, and nothing that changes WHO HOLDS POWER.
  //
  // An Administrator runs the meeting; it cannot appoint, cannot revoke, cannot
  // take the Chair and cannot end the conference. Recording is absent
  // deliberately: it arrives only by explicit delegation, because "can manage
  // participants" is not the same claim as "may create a durable recording of
  // people talking".
  administrator: [
    'manageParticipants',
    'manageMeetingSettings',
    'viewTranscript',
    'downloadTranscript',
  ],

  // The conference RECORDS OFFICER -- deliberately not an Administrator with
  // extra powers, and not an Administrator with fewer.
  //
  // A Secretary requests and views; it does not approve, and it never approves
  // its own request. `downloadTranscript` is absent on purpose: whether a
  // Secretary may take a copy away is Chairman POLICY (P7.0B), and granting it
  // by role here would decide that question by accident.
  secretary: [
    'viewTranscript',
    'requestRecording',
    'viewRecording',
    'requestRecordingDownload',
  ],

  // Ordinary participation. Live captions are a product feature, not an
  // authority, and are deliberately not a capability: being able to read
  // captions as they pass is not access to the canonical record.
  participant: [],
};

/**
 * Capabilities that require an authenticated account, no matter the role.
 *
 * Everything durable, in other words. If a role were somehow assigned to a
 * guest, this is the floor that still refuses.
 */
const REQUIRES_ACCOUNT: ReadonlySet<ConferenceCapability> = new Set(CONFERENCE_CAPABILITIES);

/**
 * Capabilities that survive the conference ending.
 *
 * The records outlive the meeting: somebody has to be able to read and hand
 * over the transcript afterwards, which is when that mostly happens. Operating
 * the meeting does not outlive it -- there is no meeting left to manage.
 */
const SURVIVES_END: ReadonlySet<ConferenceCapability> = new Set<ConferenceCapability>([
  'viewTranscript',
  'downloadTranscript',
  'viewRecording',
  'requestRecordingDownload',
  'approveRecordingDownload',
  'downloadRecording',
]);

export interface ConferenceAuthority {
  readonly role: ConferenceRole;
  readonly capabilities: ReadonlySet<ConferenceCapability>;
  can(capability: ConferenceCapability): boolean;
}

/**
 * Resolve effective capability. Pure: same inputs, same answer, no I/O.
 *
 * Deny is the default at every step. A question this function cannot answer
 * confidently is answered `false`.
 */
export function resolveConferenceAuthority(
  input: ConferenceAuthorityInput,
): ConferenceAuthority {
  const granted = new Set<ConferenceCapability>();

  // A non-member has no authority over a conference regardless of any role
  // string attached to them -- that is what removal has to MEAN.
  if (input.isMember) {
    for (const capability of BY_ROLE[input.role] ?? []) {
      granted.add(capability);
    }

    // P7.0C seam: standing delegation adds exactly start/stop, and only for a
    // Secretary. It never adds approval -- delegated authority that could
    // approve its own requests would make the approval step ceremonial.
    if (input.standingRecordingDelegation === true && input.role === 'secretary') {
      granted.add('startRecording');
      granted.add('stopRecording');
    }
  }

  const authenticated = typeof input.accountId === 'string' && input.accountId.length > 0;
  const ended = input.conferenceEnded === true;

  for (const capability of [...granted]) {
    if (!authenticated && REQUIRES_ACCOUNT.has(capability)) granted.delete(capability);
    if (ended && !SURVIVES_END.has(capability)) granted.delete(capability);
  }

  return {
    role: input.role,
    capabilities: granted,
    can: (capability) => granted.has(capability),
  };
}

/**
 * Convenience for call sites that only ask one question.
 *
 * Deliberately takes the same input as the full resolver rather than accepting
 * a pre-resolved role string, so there is no shortcut that skips the account
 * and conference-state checks.
 */
export function canInConference(
  input: ConferenceAuthorityInput,
  capability: ConferenceCapability,
): boolean {
  return resolveConferenceAuthority(input).can(capability);
}
