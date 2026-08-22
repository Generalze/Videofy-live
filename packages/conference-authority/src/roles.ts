/**
 * Conference roles. SESSION-scoped, never account types.
 *
 * The same C7 account can be Chairman of one conference, Secretary of another
 * and Participant in a third, simultaneously. That is the ordinary case, not an
 * edge case, which is why there is deliberately no `account.role` field
 * anywhere: a global role column cannot represent it, and the moment one exists
 * somebody writes `account.role = 'chairman'` and the contradiction becomes
 * data rather than a bug.
 */

export type ConferenceRole = 'chair' | 'administrator' | 'secretary' | 'participant';

export const CONFERENCE_ROLES: readonly ConferenceRole[] = [
  'chair',
  'administrator',
  'secretary',
  'participant',
];

/**
 * What a human is called, kept apart from what the code calls them.
 *
 * The wire value is `chair`; the person is a Chairman. Storing the display
 * string would make every future rename a data migration, and translating in
 * each UI separately would make them disagree.
 */
export const CONFERENCE_ROLE_LABELS: Readonly<Record<ConferenceRole, string>> = {
  chair: 'Chairman',
  administrator: 'Administrator',
  secretary: 'Secretary',
  participant: 'Participant',
};

export function isConferenceRole(value: unknown): value is ConferenceRole {
  return typeof value === 'string' && (CONFERENCE_ROLES as readonly string[]).includes(value);
}

/**
 * Every capability the conference authority can grant.
 *
 * Transcript and recording capabilities exist HERE in P7.0A while transcript
 * storage and the recording service do not exist at all. That is deliberate:
 * the authority contract is the part that must be settled before either
 * subsystem is written, so that P7.0B and P7.0C connect to a decided model
 * instead of reopening who may do what.
 */
export type ConferenceCapability =
  // -- meeting operation --
  | 'manageParticipants'
  | 'manageMeetingSettings'
  // -- governance --
  | 'appointAdministrators'
  | 'appointSecretaries'
  | 'transferChair'
  | 'endConference'
  // -- transcript (contract only in P7.0A; see P7.0B) --
  | 'viewTranscript'
  | 'downloadTranscript'
  // -- recording (contract only in P7.0A; see P7.0C) --
  | 'requestRecording'
  | 'startRecording'
  | 'stopRecording'
  | 'viewRecording'
  | 'requestRecordingDownload'
  | 'approveRecordingRequest'
  | 'approveRecordingDownload'
  | 'downloadRecording'
  | 'deleteRecording';

export const CONFERENCE_CAPABILITIES: readonly ConferenceCapability[] = [
  'manageParticipants',
  'manageMeetingSettings',
  'appointAdministrators',
  'appointSecretaries',
  'transferChair',
  'endConference',
  'viewTranscript',
  'downloadTranscript',
  'requestRecording',
  'startRecording',
  'stopRecording',
  'viewRecording',
  'requestRecordingDownload',
  'approveRecordingRequest',
  'approveRecordingDownload',
  'downloadRecording',
  'deleteRecording',
];
