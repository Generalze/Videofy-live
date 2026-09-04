/** @owner masterzee001 */
/**
 * Conference setup (founder canon 29 Aug): title, privacy tier, restricted
 * admission and offered target languages. Every rule here is about what the
 * CREATING join decides and what everybody after them cannot change.
 */
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  MAX_TARGET_LANGUAGES,
  type CallJoinInput,
  type CallJoinResult,
  type CallPrivacy,
} from './call-session-store.js';

function joinInput(overrides: Partial<CallJoinInput> = {}): CallJoinInput {
  return {
    callId: 'room-1',
    displayName: 'Someone',
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    ...overrides,
  };
}

function mustJoin(store: CallSessionStore, overrides: Partial<CallJoinInput> = {}): CallJoinResult {
  const result = store.createOrJoin(joinInput(overrides));
  if (!result.ok) throw new Error(`join failed: ${result.code} - ${result.message}`);
  return result;
}

function invalidMessage(store: CallSessionStore, overrides: Partial<CallJoinInput>): string {
  const result = store.createOrJoin(joinInput(overrides));
  if (result.ok) throw new Error('expected the join to be refused');
  expect(result.code).toBe('invalid-input');
  return result.message;
}

describe('title and privacy defaults', () => {
  it('defaults a conference to untitled, private, no offered languages, nobody knocking', () => {
    const store = new CallSessionStore();
    const result = mustJoin(store, { displayName: 'Host' });
    expect(result.snapshot).toMatchObject({
      callType: 'conference',
      title: null,
      privacy: 'private',
      targetLanguages: [],
      knocking: [],
    });
    expect(result.admission).toBeUndefined();
  });

  it('stores a trimmed title and the chosen privacy from the creating join only', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Host', title: '  Board meeting  ', privacy: 'public' });
    const joiner = mustJoin(store, {
      displayName: 'Guest',
      title: 'Hijacked',
      privacy: 'restricted',
      targetLanguages: ['yo'],
    });
    expect(joiner.snapshot).toMatchObject({
      title: 'Board meeting',
      privacy: 'public',
      targetLanguages: [],
    });
    expect(joiner.admission).toBeUndefined();
  });

  it('gives a personal call no title, no listing and no admission gate', () => {
    const store = new CallSessionStore();
    mustJoin(store, {
      displayName: 'Caller',
      callType: 'personal',
      title: 'Ignored',
      privacy: 'restricted',
      targetLanguages: ['fr'],
    });
    const callee = mustJoin(store, { displayName: 'Callee' });
    expect(callee.admission).toBeUndefined();
    expect(callee.snapshot).toMatchObject({
      callType: 'personal',
      title: null,
      privacy: 'private',
      targetLanguages: [],
    });
    expect(store.listPublicConferences()).toEqual([]);
  });

  it('refuses an empty, blank or over-long title', () => {
    const store = new CallSessionStore();
    expect(invalidMessage(store, { title: '' })).toMatch(/title/i);
    expect(invalidMessage(store, { title: '   ' })).toMatch(/title/i);
    expect(invalidMessage(store, { title: 'x'.repeat(81) })).toMatch(/title/i);
    expect(mustJoin(store, { title: 'x'.repeat(80) }).snapshot.title).toBe('x'.repeat(80));
  });

  it('refuses a privacy outside the vocabulary rather than ignoring it', () => {
    const store = new CallSessionStore();
    expect(
      invalidMessage(store, { privacy: 'secret' as unknown as CallPrivacy }),
    ).toMatch(/privacy/i);
  });

  it('a preregistered call carries the defaults', () => {
    const store = new CallSessionStore();
    const result = store.preregisterCall('pre-1', { callType: 'conference', callMode: 'normal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toMatchObject({ title: null, privacy: 'private', targetLanguages: [] });
  });
});

describe('public listing', () => {
  it('lists public conferences with a seated participant, and nothing else', () => {
    const store = new CallSessionStore({ now: () => '2026-08-29T10:00:00.000Z' });
    mustJoin(store, { callId: 'pub', displayName: 'A', title: 'Open house', privacy: 'public' });
    mustJoin(store, { callId: 'pub', displayName: 'B' });
    mustJoin(store, { callId: 'priv', displayName: 'C', privacy: 'private' });
    mustJoin(store, { callId: 'restricted', displayName: 'D', privacy: 'restricted' });
    mustJoin(store, { callId: 'personal', displayName: 'E', callType: 'personal', privacy: 'public' });
    store.preregisterCall('empty-public', { callType: 'conference', callMode: 'translated' });

    expect(store.listPublicConferences()).toEqual([
      {
        callId: 'pub',
        title: 'Open house',
        participantCount: 2,
        createdAtMs: Date.parse('2026-08-29T10:00:00.000Z'),
      },
    ]);
  });

  it('counts seated people only: a disconnected seat in grace is not present', () => {
    const store = new CallSessionStore();
    const host = mustJoin(store, { callId: 'pub', displayName: 'A', privacy: 'public' });
    mustJoin(store, { callId: 'pub', displayName: 'B' });
    store.markDisconnected('pub', host.participantId);
    expect(store.listPublicConferences()[0]?.participantCount).toBe(1);
  });

  it('drops a listing once its last seat leaves', () => {
    const store = new CallSessionStore();
    const host = mustJoin(store, { callId: 'pub', displayName: 'A', privacy: 'public' });
    store.leave('pub', host.participantId);
    expect(store.listPublicConferences()).toEqual([]);
  });
});

describe('restricted admission', () => {
  function restricted() {
    const store = new CallSessionStore();
    const host = mustJoin(store, { displayName: 'Host', privacy: 'restricted', speakLanguage: 'en' });
    const knock = mustJoin(store, { displayName: 'Guest', speakLanguage: 'es', hearLanguage: 'es' });
    return { store, host, knock };
  }

  it('seats the host directly and everyone after them as knocking', () => {
    const { store, host, knock } = restricted();
    expect(host.admission).toBeUndefined();
    expect(knock.admission).toBe('pending');
    expect(knock.ingestPlans).toEqual([]);
    const snapshot = store.snapshot('room-1');
    expect(snapshot?.participants.map((p) => p.displayName)).toEqual(['Host']);
    expect(snapshot?.knocking).toEqual([{ participantId: knock.participantId, displayName: 'Guest' }]);
    expect(snapshot?.lifecycleState).toBe('waiting');
    expect(store.isKnocking('room-1', knock.participantId)).toBe(true);
    // Nobody was re-planned for a seat that has no media.
    expect(store.ingestPlan('room-1', host.participantId)?.targetLanguages).toEqual([]);
    expect(store.ingestPlan('room-1', host.participantId)?.mediaRevision).toBe(1);
  });

  it('the first join into a preregistered restricted call is the host', () => {
    const store = new CallSessionStore();
    store.preregisterCall('pre', { callType: 'conference', callMode: 'translated' });
    // Preregistration has no privacy input; the creating-join semantics still
    // apply to whoever seats first, and the call stays private.
    const first = mustJoin(store, { callId: 'pre', displayName: 'First' });
    expect(first.admission).toBeUndefined();
    expect(first.snapshot.privacy).toBe('private');
  });

  it('admit turns the knock into an ordinary join: roster, plans, revisions', () => {
    const { store, host, knock } = restricted();
    const result = store.admitKnock('room-1', host.participantId, knock.participantId);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.admitted) throw new Error('expected admission');
    expect(result.snapshot.knocking).toEqual([]);
    expect(result.snapshot.participants.map((p) => p.displayName)).toEqual(['Host', 'Guest']);
    expect(result.snapshot.lifecycleState).toBe('active');
    // The host was re-planned for the new Spanish listener, with a bumped revision.
    const hostPlan = result.ingestPlans.find((plan) => plan.ingestSessionId.includes(host.participantId));
    expect(hostPlan?.targetLanguages).toEqual(['es']);
    expect(hostPlan?.mediaRevision).toBe(2);
    expect(store.isKnocking('room-1', knock.participantId)).toBe(false);
  });

  it('refuse releases the seat and re-plans nobody', () => {
    const { store, host, knock } = restricted();
    const result = store.refuseKnock('room-1', host.participantId, knock.participantId);
    expect(result).toMatchObject({ ok: true, admitted: false, participantId: knock.participantId });
    expect(store.snapshot('room-1')?.knocking).toEqual([]);
    expect(store.ingestPlan('room-1', host.participantId)?.mediaRevision).toBe(1);
    // The released id is never reused.
    const again = mustJoin(store, { displayName: 'Guest' });
    expect(again.participantId).not.toBe(knock.participantId);
  });

  it('only the owner answers a knock; a knocker cannot admit themselves', () => {
    const { store, host, knock } = restricted();
    store.admitKnock('room-1', host.participantId, knock.participantId);
    const second = mustJoin(store, { displayName: 'Third' });
    expect(second.admission).toBe('pending');
    expect(store.admitKnock('room-1', knock.participantId, second.participantId)).toEqual({
      ok: false,
      reason: 'not-owner',
    });
    expect(store.admitKnock('room-1', second.participantId, second.participantId)).toEqual({
      ok: false,
      reason: 'not-owner',
    });
    expect(store.admitKnock('room-1', host.participantId, host.participantId)).toEqual({
      ok: false,
      reason: 'not-knocking',
    });
    expect(store.admitKnock('nope', host.participantId, second.participantId)).toEqual({
      ok: false,
      reason: 'unknown-call',
    });
    expect(store.admitKnock('room-1', host.participantId, 'participant_99')).toEqual({
      ok: false,
      reason: 'unknown-participant',
    });
  });

  it('withdraw (timeout or the joiner leaving) needs no host and ends an otherwise empty call', () => {
    const { store, host, knock } = restricted();
    expect(store.withdrawKnock('room-1', host.participantId)).toEqual({ removed: false, callEnded: false });
    expect(store.withdrawKnock('room-1', knock.participantId)).toEqual({ removed: true, callEnded: false });
    expect(store.snapshot('room-1')?.knocking).toEqual([]);

    const lonely = mustJoin(store, { displayName: 'Late' });
    store.leave('room-1', host.participantId);
    expect(store.withdrawKnock('room-1', lonely.participantId)).toEqual({ removed: true, callEnded: true });
    expect(store.snapshot('room-1')).toBeNull();
  });

  it('a knocking seat cannot resume, holds capacity, and never routes', () => {
    const store = new CallSessionStore({ maxParticipants: 2 });
    const host = mustJoin(store, { displayName: 'Host', privacy: 'restricted' });
    const knock = mustJoin(store, { displayName: 'Guest' });
    expect(
      store.createOrJoin(
        joinInput({
          displayName: 'Guest',
          resumeParticipantId: knock.participantId,
          resumeToken: knock.resumeToken,
        }),
      ),
    ).toMatchObject({ ok: false, code: 'unknown-participant' });
    expect(store.createOrJoin(joinInput({ displayName: 'Third' }))).toMatchObject({
      ok: false,
      code: 'call-full',
    });
    expect(
      store.routeCaption('room-1', host.participantId, {
        sourceLanguage: 'en',
        targetLanguage: null,
        originalText: 'hello',
        translatedText: null,
        sequence: 1,
        mediaRevision: 1,
        languageRevision: 1,
        startMs: 0,
        endMs: 100,
        isFinal: true,
      }).map((delivery) => delivery.recipientParticipantId),
    ).toEqual([host.participantId]);
  });

  it('public and private conferences never make anyone knock', () => {
    for (const privacy of ['public', 'private'] as const) {
      const store = new CallSessionStore();
      mustJoin(store, { displayName: 'Host', privacy });
      expect(mustJoin(store, { displayName: 'Guest' }).admission).toBeUndefined();
    }
  });
});

describe('target languages', () => {
  it('stores a de-duplicated list from the creating join and carries it in every snapshot', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Host', targetLanguages: ['yo', 'pt-BR', 'yo'] });
    const joiner = mustJoin(store, { displayName: 'Guest', targetLanguages: ['fr'] });
    expect(joiner.snapshot.targetLanguages).toEqual(['yo', 'pt-BR']);
    expect(store.snapshot('room-1')?.targetLanguages).toEqual(['yo', 'pt-BR']);
  });

  it('refuses more than the cap and any code outside the pattern', () => {
    const store = new CallSessionStore();
    const tooMany = Array.from({ length: MAX_TARGET_LANGUAGES + 1 }, (_, i) => `a${String.fromCharCode(97 + i)}`);
    expect(invalidMessage(store, { targetLanguages: tooMany })).toMatch(/at most 8/);
    for (const bad of ['EN', 'e', 'engl', 'en-us', 'en_US', 'yo-', '', ' yo']) {
      expect(invalidMessage(store, { targetLanguages: [bad] })).toMatch(/language code/);
    }
    expect(invalidMessage(store, { targetLanguages: 'yo' as unknown as string[] })).toMatch(/list/);
    expect(invalidMessage(store, { targetLanguages: [7 as unknown as string] })).toMatch(/language code/);
    expect(mustJoin(store, { targetLanguages: ['en', 'yo', 'ha', 'ig', 'pt-BR'] }).ok).toBe(true);
  });

  it('SEAM: offered languages do not change plan building; listeners still decide', () => {
    const store = new CallSessionStore();
    const host = mustJoin(store, { displayName: 'Host', targetLanguages: ['es'], speakLanguage: 'en' });
    mustJoin(store, { displayName: 'Guest', speakLanguage: 'fr', hearLanguage: 'fr' });
    expect(store.ingestPlan('room-1', host.participantId)?.targetLanguages).toEqual(['fr']);
  });
});
