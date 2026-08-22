import { describe, expect, it } from 'vitest';
import {
  CONFERENCE_CAPABILITIES,
  CONFERENCE_ROLE_LABELS,
  canInConference,
  decideGovernance,
  isConferenceRole,
  resolveConferenceAuthority,
  type ConferenceAuthorityInput,
  type ConferenceRole,
} from './index.js';

const ACCOUNT = 'acct_7f2c';

function member(role: ConferenceRole, over: Partial<ConferenceAuthorityInput> = {}) {
  return { role, accountId: ACCOUNT, isMember: true, ...over } satisfies ConferenceAuthorityInput;
}

describe('conference capability authority', () => {
  it('gives the Chairman every capability', () => {
    const chair = resolveConferenceAuthority(member('chair'));
    for (const capability of CONFERENCE_CAPABILITIES) {
      expect(chair.can(capability), capability).toBe(true);
    }
  });

  it('PIN: an Administrator runs the meeting but cannot change who holds power', () => {
    const admin = resolveConferenceAuthority(member('administrator'));
    expect(admin.can('manageParticipants')).toBe(true);
    expect(admin.can('manageMeetingSettings')).toBe(true);

    // The whole point of the role. If any of these ever flips, an
    // Administrator can promote itself and the hierarchy is decorative.
    expect(admin.can('appointAdministrators')).toBe(false);
    expect(admin.can('appointSecretaries')).toBe(false);
    expect(admin.can('transferChair')).toBe(false);
    expect(admin.can('endConference')).toBe(false);
    expect(admin.can('approveRecordingRequest')).toBe(false);
    expect(admin.can('approveRecordingDownload')).toBe(false);
    expect(admin.can('deleteRecording')).toBe(false);
    // Recording arrives only by explicit delegation, never by being an admin.
    expect(admin.can('startRecording')).toBe(false);
    expect(admin.can('stopRecording')).toBe(false);
  });

  it('PIN: a Secretary is a records officer, not a junior Administrator', () => {
    const secretary = resolveConferenceAuthority(member('secretary'));
    expect(secretary.can('viewTranscript')).toBe(true);
    expect(secretary.can('requestRecording')).toBe(true);
    expect(secretary.can('requestRecordingDownload')).toBe(true);

    // Not a moderator.
    expect(secretary.can('manageParticipants')).toBe(false);
    expect(secretary.can('manageMeetingSettings')).toBe(false);

    // Never its own approver. This is the load-bearing one: a Secretary that
    // could approve its own request turns the approval step into ceremony.
    expect(secretary.can('approveRecordingRequest')).toBe(false);
    expect(secretary.can('approveRecordingDownload')).toBe(false);
    expect(secretary.can('deleteRecording')).toBe(false);

    // Whether a Secretary may take a copy away is Chairman POLICY (P7.0B).
    // Granting it by role here would decide that question by accident.
    expect(secretary.can('downloadTranscript')).toBe(false);
  });

  it('gives a Participant no privileged capability at all', () => {
    const participant = resolveConferenceAuthority(member('participant'));
    expect(participant.capabilities.size).toBe(0);
  });

  it('PIN: a guest holds no durable authority, whatever role is attached', () => {
    // Should never happen -- but if a role ever reaches a guest seat, the
    // account check is the floor that still refuses. A guest cannot survive a
    // reconnect as the same person, so authority cannot be bound to them.
    for (const role of ['chair', 'administrator', 'secretary'] as const) {
      const guest = resolveConferenceAuthority(member(role, { accountId: null }));
      expect(guest.capabilities.size, role).toBe(0);
    }
  });

  it('a non-member has no authority even holding a role', () => {
    const removed = resolveConferenceAuthority(member('chair', { isMember: false }));
    expect(removed.capabilities.size).toBe(0);
  });

  it('records outlive the meeting; operating it does not', () => {
    const chair = resolveConferenceAuthority(member('chair', { conferenceEnded: true }));
    expect(chair.can('viewTranscript')).toBe(true);
    expect(chair.can('downloadTranscript')).toBe(true);
    expect(chair.can('downloadRecording')).toBe(true);

    expect(chair.can('manageParticipants')).toBe(false);
    expect(chair.can('startRecording')).toBe(false);
    expect(chair.can('transferChair')).toBe(false);
  });

  it('standing delegation adds start/stop to a Secretary and nothing else', () => {
    const delegated = resolveConferenceAuthority(
      member('secretary', { standingRecordingDelegation: true }),
    );
    expect(delegated.can('startRecording')).toBe(true);
    expect(delegated.can('stopRecording')).toBe(true);
    // Delegation is not promotion.
    expect(delegated.can('approveRecordingRequest')).toBe(false);
    expect(delegated.can('manageParticipants')).toBe(false);

    // And it does nothing for anyone else.
    const admin = resolveConferenceAuthority(
      member('administrator', { standingRecordingDelegation: true }),
    );
    expect(admin.can('startRecording')).toBe(false);
  });

  it('labels stay separate from wire values', () => {
    expect(CONFERENCE_ROLE_LABELS.chair).toBe('Chairman');
    expect(isConferenceRole('chair')).toBe(true);
    expect(isConferenceRole('Chairman')).toBe(false);
    expect(isConferenceRole('owner')).toBe(false);
  });

  it('canInConference asks the same question as the resolver', () => {
    expect(canInConference(member('chair'), 'endConference')).toBe(true);
    expect(canInConference(member('secretary'), 'endConference')).toBe(false);
  });
});

describe('governance transitions', () => {
  const chair = member('chair');

  function request(over: Partial<Parameters<typeof decideGovernance>[0]> = {}) {
    return decideGovernance({
      action: 'appoint-administrator',
      actor: chair,
      actorParticipantId: 'p1',
      targetParticipantId: 'p2',
      targetRole: 'participant',
      targetAccountId: 'acct_other',
      ...over,
    });
  }

  it('lets the Chairman appoint and revoke', () => {
    expect(request()).toEqual({
      ok: true,
      nextTargetRole: 'administrator',
      chairMovesToTarget: false,
    });
    expect(request({ action: 'appoint-secretary' })).toMatchObject({
      ok: true,
      nextTargetRole: 'secretary',
    });
    expect(
      request({ action: 'revoke-administrator', targetRole: 'administrator' }),
    ).toMatchObject({ ok: true, nextTargetRole: 'participant' });
  });

  it('PIN: nobody but the Chairman may appoint', () => {
    for (const role of ['administrator', 'secretary', 'participant'] as const) {
      expect(request({ actor: member(role) }), role).toEqual({
        ok: false,
        reason: 'not-authorised',
      });
    }
  });

  it('PIN: revoking a role the target does not hold is refused, not silently applied', () => {
    // Otherwise "revoke Secretary" aimed at an Administrator quietly demotes
    // them to Participant -- a governance change nobody asked for.
    expect(request({ action: 'revoke-secretary', targetRole: 'administrator' })).toEqual({
      ok: false,
      reason: 'target-role-mismatch',
    });
  });

  it('refuses to grant durable privilege to a guest', () => {
    expect(request({ targetAccountId: null })).toEqual({
      ok: false,
      reason: 'target-not-authenticated',
    });
    expect(request({ action: 'transfer-chair', targetAccountId: null })).toEqual({
      ok: false,
      reason: 'target-not-authenticated',
    });
  });

  it('refuses to demote the Chair through a side door', () => {
    expect(request({ targetRole: 'chair' })).toEqual({ ok: false, reason: 'target-is-chair' });
  });

  it('refuses self-targeting, including a no-op chair transfer', () => {
    expect(request({ targetParticipantId: 'p1' })).toEqual({
      ok: false,
      reason: 'cannot-target-self',
    });
    expect(request({ action: 'transfer-chair', targetParticipantId: 'p1' })).toEqual({
      ok: false,
      reason: 'cannot-target-self',
    });
  });

  it('transfers the Chair, and says so explicitly', () => {
    expect(request({ action: 'transfer-chair' })).toEqual({
      ok: true,
      nextTargetRole: 'chair',
      chairMovesToTarget: true,
    });
  });

  it('refuses everything once the conference has ended', () => {
    expect(request({ actor: member('chair', { conferenceEnded: true }) })).toEqual({
      ok: false,
      reason: 'conference-ended',
    });
  });

  it('refuses an unknown target', () => {
    expect(request({ targetRole: null })).toEqual({ ok: false, reason: 'unknown-target' });
  });
});
