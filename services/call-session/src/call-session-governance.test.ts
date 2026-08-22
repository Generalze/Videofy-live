/**
 * P7.0A governance, at the store.
 *
 * The authority package decides; this proves the store carries the decision out
 * and that authority is bound to the ACCOUNT rather than to a seat, a socket or
 * a display name.
 */
import { describe, expect, it } from 'vitest';
import { CallSessionStore } from './call-session-store.js';

function joinAs(
  store: CallSessionStore,
  callId: string,
  displayName: string,
  accountId: string | null,
) {
  const result = store.createOrJoin({
    callId,
    displayName,
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    callType: 'conference',
    accountId,
  } as never);
  if (!result.ok) throw new Error(`join failed: ${JSON.stringify(result)}`);
  return result;
}

function roleOf(store: CallSessionStore, callId: string, participantId: string) {
  return store.snapshot(callId)?.participants.find((p) => p.participantId === participantId)
    ?.conferenceRole;
}

function chairsIn(store: CallSessionStore, callId: string) {
  return (store.snapshot(callId)?.participants ?? []).filter((p) => p.conferenceRole === 'chair');
}

describe('P7.0A conference governance', () => {
  it('seeds the creating join as Chairman, and only that join', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF1', 'Chair', 'acct_chair');
    const other = joinAs(store, 'CONF1', 'Other', 'acct_other');

    expect(roleOf(store, 'CONF1', chair.participantId)).toBe('chair');
    expect(roleOf(store, 'CONF1', other.participantId)).toBe('participant');
    expect(chairsIn(store, 'CONF1')).toHaveLength(1);
  });

  it('lets the Chairman appoint and revoke Administrators and Secretaries', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF2', 'Chair', 'acct_chair');
    const admin = joinAs(store, 'CONF2', 'Admin', 'acct_admin');
    const sec = joinAs(store, 'CONF2', 'Sec', 'acct_sec');

    expect(
      store.applyGovernance({
        callId: 'CONF2',
        actorParticipantId: chair.participantId,
        targetParticipantId: admin.participantId,
        action: 'appoint-administrator',
      }).ok,
    ).toBe(true);
    expect(roleOf(store, 'CONF2', admin.participantId)).toBe('administrator');

    store.applyGovernance({
      callId: 'CONF2',
      actorParticipantId: chair.participantId,
      targetParticipantId: sec.participantId,
      action: 'appoint-secretary',
    });
    expect(roleOf(store, 'CONF2', sec.participantId)).toBe('secretary');

    store.applyGovernance({
      callId: 'CONF2',
      actorParticipantId: chair.participantId,
      targetParticipantId: admin.participantId,
      action: 'revoke-administrator',
    });
    expect(roleOf(store, 'CONF2', admin.participantId)).toBe('participant');
  });

  it('PIN: an Administrator cannot alter the governance hierarchy', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF3', 'Chair', 'acct_chair');
    const admin = joinAs(store, 'CONF3', 'Admin', 'acct_admin');
    const victim = joinAs(store, 'CONF3', 'Victim', 'acct_victim');
    store.applyGovernance({
      callId: 'CONF3',
      actorParticipantId: chair.participantId,
      targetParticipantId: admin.participantId,
      action: 'appoint-administrator',
    });

    // The escalation that matters: an Administrator promoting anyone -- most of
    // all itself -- or taking the Chair.
    for (const action of ['appoint-administrator', 'appoint-secretary', 'transfer-chair'] as const) {
      const attempt = store.applyGovernance({
        callId: 'CONF3',
        actorParticipantId: admin.participantId,
        targetParticipantId: victim.participantId,
        action,
      });
      expect(attempt, action).toEqual({ ok: false, reason: 'not-authorised' });
    }
    expect(roleOf(store, 'CONF3', victim.participantId)).toBe('participant');
    expect(chairsIn(store, 'CONF3')).toHaveLength(1);
  });

  it('PIN: a Secretary cannot appoint, and a Participant cannot do anything', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF4', 'Chair', 'acct_chair');
    const sec = joinAs(store, 'CONF4', 'Sec', 'acct_sec');
    const plain = joinAs(store, 'CONF4', 'Plain', 'acct_plain');
    store.applyGovernance({
      callId: 'CONF4',
      actorParticipantId: chair.participantId,
      targetParticipantId: sec.participantId,
      action: 'appoint-secretary',
    });

    for (const actor of [sec, plain]) {
      expect(
        store.applyGovernance({
          callId: 'CONF4',
          actorParticipantId: actor.participantId,
          targetParticipantId: plain.participantId,
          action: 'appoint-administrator',
        }),
      ).toEqual({ ok: false, reason: 'not-authorised' });
    }
  });

  it('PIN: chair transfer is atomic — exactly one Chairman before and after', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF5', 'Chair', 'acct_chair');
    const successor = joinAs(store, 'CONF5', 'Next', 'acct_next');
    expect(chairsIn(store, 'CONF5')).toHaveLength(1);

    const result = store.applyGovernance({
      callId: 'CONF5',
      actorParticipantId: chair.participantId,
      targetParticipantId: successor.participantId,
      action: 'transfer-chair',
    });
    expect(result.ok).toBe(true);

    expect(chairsIn(store, 'CONF5')).toHaveLength(1);
    expect(roleOf(store, 'CONF5', successor.participantId)).toBe('chair');
    expect(roleOf(store, 'CONF5', chair.participantId)).toBe('participant');

    // The legacy owner pointer moves WITH the Chair. Left behind, the previous
    // Chairman would keep call-mode and transcript authority through an older
    // code path -- authority split across two records, disagreeing.
    expect(store.snapshot('CONF5')?.ownerParticipantId).toBe(successor.participantId);

    // And the outgoing Chairman really has lost root authority.
    expect(
      store.applyGovernance({
        callId: 'CONF5',
        actorParticipantId: chair.participantId,
        targetParticipantId: successor.participantId,
        action: 'appoint-administrator',
      }),
    ).toEqual({ ok: false, reason: 'not-authorised' });
  });

  it('PIN: a guest cannot be given durable privilege', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF6', 'Chair', 'acct_chair');
    const guest = joinAs(store, 'CONF6', 'Guest', null);

    expect(
      store.applyGovernance({
        callId: 'CONF6',
        actorParticipantId: chair.participantId,
        targetParticipantId: guest.participantId,
        action: 'appoint-administrator',
      }),
    ).toEqual({ ok: false, reason: 'target-not-authenticated' });
    expect(roleOf(store, 'CONF6', guest.participantId)).toBe('participant');
  });

  it('PIN: the same account holds independent roles in different conferences', () => {
    const store = new CallSessionStore();
    // One person, three meetings, three different standings. This is the
    // ordinary case, and the reason there is no account.role field anywhere.
    const a = joinAs(store, 'ROOMA', 'Zoe', 'acct_zoe');
    expect(roleOf(store, 'ROOMA', a.participantId)).toBe('chair');

    joinAs(store, 'ROOMB', 'Host', 'acct_host');
    const b = joinAs(store, 'ROOMB', 'Zoe', 'acct_zoe');
    const hostB = store.snapshot('ROOMB')!.participants[0]!.participantId;
    store.applyGovernance({
      callId: 'ROOMB',
      actorParticipantId: hostB,
      targetParticipantId: b.participantId,
      action: 'appoint-secretary',
    });

    joinAs(store, 'ROOMC', 'Host', 'acct_host');
    const c = joinAs(store, 'ROOMC', 'Zoe', 'acct_zoe');

    expect(roleOf(store, 'ROOMA', a.participantId)).toBe('chair');
    expect(roleOf(store, 'ROOMB', b.participantId)).toBe('secretary');
    expect(roleOf(store, 'ROOMC', c.participantId)).toBe('participant');
  });

  it('PIN: authority is bound to the account, and revocation survives reconnect', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF7', 'Chair', 'acct_chair');
    const admin = joinAs(store, 'CONF7', 'Admin', 'acct_admin');
    store.applyGovernance({
      callId: 'CONF7',
      actorParticipantId: chair.participantId,
      targetParticipantId: admin.participantId,
      action: 'appoint-administrator',
    });
    store.applyGovernance({
      callId: 'CONF7',
      actorParticipantId: chair.participantId,
      targetParticipantId: admin.participantId,
      action: 'revoke-administrator',
    });

    // Reconnecting with the same seat credentials must not restore what was
    // taken away. A revocation that a refresh undoes is not a revocation.
    const resumed = store.createOrJoin({
      callId: 'CONF7',
      displayName: 'Admin',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
      accountId: 'acct_admin',
      resumeParticipantId: admin.participantId,
      resumeToken: admin.resumeToken,
    } as never);
    expect(resumed.ok).toBe(true);
    expect(roleOf(store, 'CONF7', admin.participantId)).toBe('participant');
  });

  it('PIN: a forged role on the join payload is ignored', () => {
    const store = new CallSessionStore();
    joinAs(store, 'CONF8', 'Chair', 'acct_chair');
    // A client that could name its own role could name `chair`. The store takes
    // the role from its own record, never from the wire.
    const liar = store.createOrJoin({
      callId: 'CONF8',
      displayName: 'Liar',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
      accountId: 'acct_liar',
      conferenceRole: 'chair',
      role: 'chair',
    } as never);
    expect(liar.ok).toBe(true);
    if (!liar.ok) return;
    expect(roleOf(store, 'CONF8', liar.participantId)).toBe('participant');
    expect(chairsIn(store, 'CONF8')).toHaveLength(1);
  });

  it('records a governance audit event naming actor, target and action', () => {
    const store = new CallSessionStore();
    const chair = joinAs(store, 'CONF9', 'Chair', 'acct_chair');
    const admin = joinAs(store, 'CONF9', 'Admin', 'acct_admin');
    const result = store.applyGovernance({
      callId: 'CONF9',
      actorParticipantId: chair.participantId,
      targetParticipantId: admin.participantId,
      action: 'appoint-administrator',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit).toMatchObject({
      conferenceId: 'CONF9',
      action: 'appoint-administrator',
      actorParticipantId: chair.participantId,
      actorAccountId: 'acct_chair',
      targetParticipantId: admin.participantId,
      targetAccountId: 'acct_admin',
    });
    expect(typeof result.audit.occurredAtIso).toBe('string');
  });

  it('personal calls are untouched: the creator still owns them', () => {
    const store = new CallSessionStore();
    const owner = store.createOrJoin({
      callId: 'PERS1',
      displayName: 'Owner',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
      callType: 'personal',
      accountId: 'acct_owner',
    } as never);
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const snapshot = store.snapshot('PERS1')!;
    expect(snapshot.callType).toBe('personal');
    expect(snapshot.ownerParticipantId).toBe(owner.participantId);
    expect(snapshot.transcriptDownloadAllowed).toBe(true);
  });
});
