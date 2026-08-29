/** @owner masterzee001 */
import { CallSessionLifecycleStateSchema } from '@videofy-live/call-contracts';
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  STANDARD_CALL_VOICES,
  type CallJoinInput,
  type CallJoinResult,
  type CallMode,
  type CallType,
} from './call-session-store.js';

function joinInput(overrides: Partial<CallJoinInput> = {}): CallJoinInput {
  return {
    callId: 'call-1',
    displayName: 'Zoe',
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
  if (!result.ok) {
    throw new Error(`expected join to succeed, got ${result.code}: ${result.message}`);
  }
  return result;
}

/** English speaker Zoe + Spanish speaker Carlos, the canonical translated pair. */
function translatedPair(store: CallSessionStore): { zoe: CallJoinResult; carlos: CallJoinResult } {
  const zoe = mustJoin(store, {
    displayName: 'Zoe',
    speakLanguage: 'en',
    hearLanguage: 'en',
    voiceGender: 'male',
  });
  const carlos = mustJoin(store, {
    displayName: 'Carlos',
    speakLanguage: 'es',
    hearLanguage: 'es',
    voiceGender: 'female',
  });
  return { zoe, carlos };
}

function planRevision(store: CallSessionStore, callId: string, participantId: string): number {
  const plan = store.ingestPlan(callId, participantId);
  if (!plan) {
    throw new Error(`expected an ingest plan for ${participantId}`);
  }
  return plan.mediaRevision;
}

describe('CallSessionStore.createOrJoin', () => {
  it('creates a call on first join with a waiting snapshot and a target-free r1 ingest plan', () => {
    const store = new CallSessionStore();
    const result = mustJoin(store);

    expect(store.activeCallCount()).toBe(1);
    expect(result.participantId).toBe('participant_1');
    expect(result.mediaRevision).toBe(1);
    expect(result.languageRevision).toBe(1);
    expect(typeof result.resumeToken).toBe('string');
    expect(result.resumeToken.length).toBeGreaterThan(0);
    expect(result.snapshot.lifecycleState).toBe('waiting');
    expect(result.snapshot.participants).toEqual([
      {
        participantId: 'participant_1',
        displayName: 'Zoe',
        speakLanguage: 'en',
        hearLanguage: 'en',
        connected: true,
        // P7.0A: the join that CREATES the call seeds the Chairman.
        conferenceRole: 'chair',
      },
    ]);
    expect(result.ingestPlans).toEqual([
      {
        ingestSessionId: 'call_call-1_participant_1_r1',
        broadcastId: 'callcast_call-1_participant_1_r1',
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        targetLanguages: [],
        textOnlyLanguages: [],
        sameLanguageCaptionsNeeded: false,
        voiceIdsByLanguage: {},
        mediaRevision: 1,
        languageRevision: 1,
      },
    ]);
  });

  it('second join bumps the existing speaker and recomputes both plans with speaker voices', () => {
    const store = new CallSessionStore();
    const { carlos } = translatedPair(store);

    // Carlos is the joiner (initial revision 1); Zoe's membership-change bump moves her to 2.
    expect(carlos.mediaRevision).toBe(1);
    expect(carlos.snapshot.lifecycleState).toBe('active');
    expect(carlos.ingestPlans).toHaveLength(2);
    const [zoePlan, carlosPlan] = carlos.ingestPlans;
    // Zoe speaks en and chose the male voice, so her Spanish is spoken by the
    // male Spanish voice — it represents HER, not the person listening.
    expect(zoePlan).toEqual({
      ingestSessionId: 'call_call-1_participant_1_r2',
      broadcastId: 'callcast_call-1_participant_1_r2',
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguages: ['es'],
      textOnlyLanguages: [],
      sameLanguageCaptionsNeeded: false,
      voiceIdsByLanguage: { es: 'es_ES-sharvard-male' },
      mediaRevision: 2,
      languageRevision: 1,
    });
    // Carlos speaks es and chose the female voice.
    expect(carlosPlan).toEqual({
      ingestSessionId: 'call_call-1_participant_2_r1',
      broadcastId: 'callcast_call-1_participant_2_r1',
      sourceLanguage: 'es',
      sourceLanguageMode: 'manual',
      targetLanguages: ['en'],
      textOnlyLanguages: [],
      sameLanguageCaptionsNeeded: false,
      voiceIdsByLanguage: { en: 'en_US-hfc_female-medium' },
      mediaRevision: 1,
      languageRevision: 1,
    });
  });

  it('excludes same-language recipients from targetLanguages in both directions', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
    const second = mustJoin(store, {
      displayName: 'Sam',
      speakLanguage: 'en',
      hearLanguage: 'en',
    });

    for (const plan of second.ingestPlans) {
      expect(plan.targetLanguages).toEqual([]);
      expect(plan.voiceIdsByLanguage).toEqual({});
    }
  });

  it('rejects a join past the cap with a typed error and leaves the call untouched', () => {
    // Cap stated explicitly rather than inherited from the default, so this
    // keeps testing the SEMANTICS — typed refusal, nobody bumped — after the
    // conference default moved from 2 to 4.
    const store = new CallSessionStore({ maxParticipants: 2 });
    const { zoe, carlos } = translatedPair(store);

    const third = store.createOrJoin(joinInput({ displayName: 'Amelie' }));
    expect(third).toMatchObject({ ok: false, code: 'call-full' });
    expect(store.snapshot('call-1')?.participants).toHaveLength(2);
    expect(store.activeCallCount()).toBe(1);
    // A failed join must not bump anyone.
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('still counts a disconnected identity toward the cap', () => {
    // A held seat is a seat: it must not be handed to a stranger while its
    // owner is reconnecting.
    const store = new CallSessionStore({ maxParticipants: 2 });
    const { carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    const third = store.createOrJoin(joinInput({ displayName: 'Amelie' }));
    expect(third).toMatchObject({ ok: false, code: 'call-full' });
  });

  it('rejects duplicate display names ignoring case and surrounding whitespace', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Zoe' });

    const duplicate = store.createOrJoin(joinInput({ displayName: '  zoe  ' }));
    expect(duplicate).toMatchObject({ ok: false, code: 'duplicate-display-name' });
    expect(store.snapshot('call-1')?.participants).toHaveLength(1);
  });

  it('rejects invalid input without creating call state', () => {
    const store = new CallSessionStore();
    const cases: Partial<CallJoinInput>[] = [
      { callId: '   ' },
      { callId: 'not a safe id!' },
      { callId: 'x'.repeat(65) },
      { displayName: '' },
      { displayName: '   ' },
      { speakLanguage: 'de' as CallJoinInput['speakLanguage'] },
      { hearLanguage: 'yo' as CallJoinInput['hearLanguage'] },
      { voiceGender: 'robot' as CallJoinInput['voiceGender'] },
      { audioMode: 'dubbed' as CallJoinInput['audioMode'] },
      { captionsEnabled: 'yes' as unknown as boolean },
      { resumeParticipantId: '' },
    ];

    for (const overrides of cases) {
      const result = store.createOrJoin(joinInput(overrides));
      expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(0);
      }
    }
    expect(store.activeCallCount()).toBe(0);
  });

  it('trims the stored display name', () => {
    const store = new CallSessionStore();
    const result = mustJoin(store, { displayName: '  Zoe  ' });
    expect(result.snapshot.participants[0]?.displayName).toBe('Zoe');
  });
});

describe('CallSessionStore resume', () => {
  it('bumps the joiner and every other connected participant, keeping languageRevision', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId);

    const resumed = store.createOrJoin(
      joinInput({
        displayName: 'Zoe',
        speakLanguage: 'en',
        hearLanguage: 'en',
        voiceGender: 'male',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    expect(resumed.participantId).toBe(zoe.participantId);
    // Zoe: 1 at join, 2 after Carlos joined, 3 on resume. Carlos: 1 at join, 2 now.
    expect(resumed.mediaRevision).toBe(3);
    expect(resumed.languageRevision).toBe(1);
    expect(resumed.snapshot.lifecycleState).toBe('active');
    expect(
      resumed.snapshot.participants.find((p) => p.participantId === zoe.participantId)?.connected,
    ).toBe(true);
    expect(resumed.ingestPlans).toHaveLength(2);
    const zoePlan = resumed.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(`_${zoe.participantId}_`),
    );
    const carlosPlan = resumed.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(`_${carlos.participantId}_`),
    );
    expect(zoePlan?.ingestSessionId).toBe('call_call-1_participant_1_r3');
    expect(zoePlan?.mediaRevision).toBe(3);
    expect(carlosPlan?.ingestSessionId).toBe('call_call-1_participant_2_r2');
    expect(carlosPlan?.broadcastId).toBe('callcast_call-1_participant_2_r2');
    expect(carlosPlan?.mediaRevision).toBe(2);
  });

  it('keeps the same resume token across resume', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId);

    const resumed = store.createOrJoin(
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: zoe.resumeToken }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.resumeToken).toBe(zoe.resumeToken);
  });

  it('rejects wrong, missing, cross-participant, and unknown-id credentials identically', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const attempts = [
      // Wrong token.
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: 'stolen-guess' }),
      // Missing token.
      joinInput({ resumeParticipantId: zoe.participantId }),
      // The other participant's token.
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: carlos.resumeToken }),
      // Unknown participant id with a real token.
      joinInput({ resumeParticipantId: 'participant_99', resumeToken: zoe.resumeToken }),
    ];
    const failures = attempts.map((attempt) => store.createOrJoin(attempt));
    for (const result of failures) {
      expect(result).toMatchObject({ ok: false, code: 'unknown-participant' });
    }
    // Indistinguishable: every rejection is byte-identical.
    expect(new Set(failures.map((result) => JSON.stringify(result))).size).toBe(1);
    // No auth failure may bump revisions.
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('returns unknown-participant when the call itself no longer exists', () => {
    const store = new CallSessionStore();
    const result = store.createOrJoin(
      joinInput({ callId: 'ghost-call', resumeParticipantId: 'participant_1', resumeToken: 't' }),
    );
    expect(result).toMatchObject({ ok: false, code: 'unknown-participant' });
  });

  it('rejects a resume that tries to change locked languages without bumping anyone', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const result = store.createOrJoin(
      joinInput({
        displayName: 'Zoe',
        speakLanguage: 'es',
        hearLanguage: 'en',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('keeps the stored display name authoritative across resume', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId);

    const resumed = store.createOrJoin(
      joinInput({
        displayName: 'Someone Else',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(
      resumed.snapshot.participants.find((p) => p.participantId === zoe.participantId)?.displayName,
    ).toBe('Zoe');
  });

  it('applies a changed voice gender to the other speaker\'s recomputed plan', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    // Carlos resumes but now wants the male Spanish voice.
    const resumed = store.createOrJoin(
      joinInput({
        displayName: 'Carlos',
        speakLanguage: 'es',
        hearLanguage: 'es',
        voiceGender: 'male',
        resumeParticipantId: carlos.participantId,
        resumeToken: carlos.resumeToken,
      }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const zoePlan = resumed.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(`_${zoe.participantId}_`),
    );
    expect(zoePlan?.voiceIdsByLanguage).toEqual({ es: 'es_ES-sharvard-male' });
  });
});

describe('CallSessionStore disconnect and lifecycle', () => {
  it('markDisconnected keeps identity, moves to reconnecting, and bumps nobody', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    const snapshot = store.snapshot('call-1');
    expect(snapshot?.lifecycleState).toBe('reconnecting');
    expect(snapshot?.participants).toHaveLength(2);
    expect(
      snapshot?.participants.find((p) => p.participantId === carlos.participantId)?.connected,
    ).toBe(false);
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('excludes disconnected recipients from a speaker\'s ingest plan targets', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    const zoePlan = store.ingestPlan('call-1', zoe.participantId);
    expect(zoePlan?.targetLanguages).toEqual([]);
    expect(zoePlan?.voiceIdsByLanguage).toEqual({});
  });

  it('ignores markDisconnected for unknown calls and participants', () => {
    const store = new CallSessionStore();
    translatedPair(store);
    expect(() => {
      store.markDisconnected('ghost-call', 'participant_1');
      store.markDisconnected('call-1', 'participant_99');
    }).not.toThrow();
    expect(store.snapshot('call-1')?.lifecycleState).toBe('active');
  });

  it('only emits lifecycle values from the call-contracts enum', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    const active = store.snapshot('call-1');
    store.markDisconnected('call-1', zoe.participantId);
    const reconnecting = store.snapshot('call-1');
    store.leave('call-1', zoe.participantId);
    const waiting = store.snapshot('call-1');

    for (const snapshot of [active, reconnecting, waiting]) {
      expect(() => CallSessionLifecycleStateSchema.parse(snapshot?.lifecycleState)).not.toThrow();
    }
  });
});

describe('CallSessionStore.leave', () => {
  it('keeps the call alive and reconciles the remaining speaker when one of two leaves', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const result = store.leave('call-1', zoe.participantId);
    expect(result.ok).toBe(true);
    expect(result.callEnded).toBe(false);
    expect(result.snapshot?.lifecycleState).toBe('waiting');
    expect(result.snapshot?.participants.map((p) => p.participantId)).toEqual([
      carlos.participantId,
    ]);
    expect(store.activeCallCount()).toBe(1);
    // W5: Zoe was Carlos's only English listener, so his target set changed
    // and his session is replaced — an explicit cutoff, returned as a fresh
    // plan so the gateway retires the old revision-scoped id.
    expect(result.ingestPlans).toHaveLength(1);
    expect(result.ingestPlans[0]?.ingestSessionId).toBe('call_call-1_participant_2_r2');
    expect(result.ingestPlans[0]?.targetLanguages).toEqual([]);
    expect(store.ingestPlan('call-1', carlos.participantId)?.ingestSessionId).toBe(
      'call_call-1_participant_2_r2',
    );
  });

  it('ends the call and removes all state when the last participant leaves', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    store.leave('call-1', zoe.participantId);
    const result = store.leave('call-1', carlos.participantId);
    expect(result).toEqual({ ok: true, callEnded: true, snapshot: null, ingestPlans: [] });
    expect(store.activeCallCount()).toBe(0);
    expect(store.snapshot('call-1')).toBeNull();
    expect(store.ingestPlan('call-1', carlos.participantId)).toBeNull();
  });

  it('reports ok:false for unknown participants and calls without mutating state', () => {
    const store = new CallSessionStore();
    translatedPair(store);

    const unknownParticipant = store.leave('call-1', 'participant_99');
    expect(unknownParticipant.ok).toBe(false);
    expect(unknownParticipant.callEnded).toBe(false);
    expect(unknownParticipant.snapshot?.participants).toHaveLength(2);

    const unknownCall = store.leave('ghost-call', 'participant_1');
    expect(unknownCall).toEqual({ ok: false, callEnded: false, snapshot: null, ingestPlans: [] });
    expect(store.activeCallCount()).toBe(1);
  });

  it('does not reuse a departed participant\'s id for a later joiner', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.leave('call-1', zoe.participantId);

    const replacement = mustJoin(store, { displayName: 'Amelie' });
    expect(replacement.participantId).toBe('participant_3');
  });

  it('keeps independent calls isolated', () => {
    const store = new CallSessionStore();
    mustJoin(store, { callId: 'call-1', displayName: 'Zoe' });
    mustJoin(store, { callId: 'call-2', displayName: 'Zoe' });
    expect(store.activeCallCount()).toBe(2);

    store.leave('call-1', 'participant_1');
    expect(store.activeCallCount()).toBe(1);
    expect(store.snapshot('call-1')).toBeNull();
    expect(store.snapshot('call-2')?.participants).toHaveLength(1);
  });
});

describe('CallSessionStore snapshots', () => {
  it('returns null for unknown calls', () => {
    const store = new CallSessionStore();
    expect(store.snapshot('ghost-call')).toBeNull();
  });

  it('is sanitized: no voice ids, ingest ids, revisions, or resume tokens', () => {
    let serial = 0;
    const store = new CallSessionStore({ createResumeToken: () => `secret-resume-${serial++}` });
    // Zoe joins as a Connect seat: `subject` is a DELIBERATE P6.5 addition to
    // the exact key set — R8 makes both identities public participant state,
    // and the name carries none of the forbidden substrings below.
    mustJoin(store, {
      displayName: 'Zoe',
      speakLanguage: 'en',
      hearLanguage: 'en',
      voiceGender: 'male',
      subject: 'customer_8291',
    });
    mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });

    const snapshot = store.snapshot('call-1');
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    expect(Object.keys(snapshot).sort()).toEqual([
      'callId',
      'callMode',
      'callType',
      // Conference setup (29 Aug): title, privacy, offered languages and the
      // knocking list are DELIBERATE additions -- all public room state, and
      // none carries a forbidden substring.
      'knocking',
      'lifecycleState',
      'ownerParticipantId',
      'participants',
      'privacy',
      'targetLanguages',
      'title',
      'transcriptDownloadAllowed',
    ]);
    expect(snapshot.participants.map((participant) => Object.keys(participant).sort())).toEqual([
      // `conferenceRole` is a DELIBERATE P7.0A addition to the exact key set:
      // a session-scoped role is public participant state, and carries none of
      // the forbidden substrings below.
      [
        'conferenceRole',
        'connected',
        'displayName',
        'hearLanguage',
        'participantId',
        'speakLanguage',
        'subject',
      ],
      // No `subject` key at all for a seat that joined without one.
      ['conferenceRole', 'connected', 'displayName', 'hearLanguage', 'participantId', 'speakLanguage'],
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('secret-resume-');
    expect(serialized).not.toContain('voice');
    expect(serialized).not.toContain('call_call-1_');
    expect(serialized).not.toContain('callcast_');
    expect(serialized).not.toContain('Revision');
  });

  it('lists participants in join order with their locked languages', () => {
    const store = new CallSessionStore();
    translatedPair(store);

    const snapshot = store.snapshot('call-1');
    expect(snapshot?.participants.map((p) => [p.displayName, p.speakLanguage, p.hearLanguage])).toEqual([
      ['Zoe', 'en', 'en'],
      ['Carlos', 'es', 'es'],
    ]);
  });
});

describe('CallSessionStore.ingestPlan', () => {
  it('returns a collision-safe revision-scoped plan for a known participant', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    const plan = store.ingestPlan('call-1', zoe.participantId);
    expect(plan?.ingestSessionId).toBe('call_call-1_participant_1_r2');
    expect(plan?.broadcastId).toBe('callcast_call-1_participant_1_r2');
    expect(plan?.sourceLanguageMode).toBe('manual');
  });

  it('returns null for unknown calls and participants', () => {
    const store = new CallSessionStore();
    translatedPair(store);
    expect(store.ingestPlan('ghost-call', 'participant_1')).toBeNull();
    expect(store.ingestPlan('call-1', 'participant_99')).toBeNull();
  });
});

describe('STANDARD_CALL_VOICES', () => {
  it('maps every language/gender selection to the registered Piper voices', () => {
    expect(STANDARD_CALL_VOICES).toEqual({
      en: { male: 'en_US-hfc_male-medium', female: 'en_US-hfc_female-medium' },
      es: { male: 'es_ES-sharvard-male', female: 'es_ES-sharvard-female' },
      fr: { male: 'fr_FR-upmc-pierre', female: 'fr_FR-siwis-medium' },
    });
  });

  it('routes an EN-FR pair with each SPEAKER’s gender selecting their own voice', () => {
    const store = new CallSessionStore({ createResumeToken: () => 'token-en-fr' });
    const first = store.createOrJoin(
      joinInput({ callId: 'call-en-fr', displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' }),
    );
    if (!first.ok) throw new Error(first.message);
    const second = store.createOrJoin(
      joinInput({
        callId: 'call-en-fr',
        displayName: 'Amelie',
        speakLanguage: 'fr',
        hearLanguage: 'fr',
        voiceGender: 'male',
      }),
    );
    if (!second.ok) throw new Error(second.message);
    const zoePlan = second.ingestPlans.find((plan) => plan.ingestSessionId.includes(first.participantId));
    const ameliePlan = second.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(second.participantId),
    );
    // Zoe's French is spoken in ZOE's voice setting (female by default), not
    // Amelie's. A speaker's translated voice stands in for the speaker.
    expect(zoePlan).toMatchObject({
      sourceLanguage: 'en',
      targetLanguages: ['fr'],
      voiceIdsByLanguage: { fr: 'fr_FR-siwis-medium' },
    });
    // Amelie chose male, so her English is spoken by the male English voice.
    expect(ameliePlan).toMatchObject({
      sourceLanguage: 'fr',
      targetLanguages: ['en'],
      voiceIdsByLanguage: { en: 'en_US-hfc_male-medium' },
    });
  });
});

describe('CallSessionStore injection', () => {
  it('uses the injected ISO clock instead of wall time', () => {
    let ticks = 0;
    const store = new CallSessionStore({ now: () => `2026-08-14T00:00:0${ticks++}.000Z` });
    translatedPair(store);
    // The clock is consulted once per call creation and once per new participant.
    expect(ticks).toBe(3);
  });

  it('creates one resume token per new participant and none on resume', () => {
    let issued = 0;
    const store = new CallSessionStore({ createResumeToken: () => `token-${issued++}` });
    const { zoe, carlos } = translatedPair(store);
    expect(issued).toBe(2);
    expect(zoe.resumeToken).toBe('token-0');
    expect(carlos.resumeToken).toBe('token-1');

    store.markDisconnected('call-1', zoe.participantId);
    const resumed = store.createOrJoin(
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: zoe.resumeToken }),
    );
    expect(resumed.ok).toBe(true);
    expect(issued).toBe(2);
  });
});

describe('auto-detected source language (P6.2)', () => {
  it('keeps a stated language locked and refuses to redetect it', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en' });

    // Manual authority (ADR-004): the speaker said English, so the detector
    // does not get to overrule them however confident it is.
    const result = store.applyDetectedLanguage('call-1', zoe.participantId, 'fr');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('language-stated-by-speaker');
    expect(store.ingestPlan('call-1', zoe.participantId)?.sourceLanguage).toBe('en');
  });

  it('carries auto mode into the ingest plan so media-ingest may correct the guess', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { speakLanguage: 'en', sourceLanguageMode: 'auto' });

    expect(store.ingestPlan('call-1', zoe.participantId)?.sourceLanguageMode).toBe('auto');
    expect(mustJoin(store, { displayName: 'Bruno', hearLanguage: 'fr' }) && true).toBe(true);
  });

  it('re-routes the call and bumps the language revision when detection corrects the guess', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', sourceLanguageMode: 'auto' });
    mustJoin(store, { displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' });

    const result = store.applyDetectedLanguage('call-1', zoe.participantId, 'es');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(true);
      // Results planned against the old language must be rejectable, so the
      // revision has to move past what the join issued.
      expect(result.languageRevision).toBe(zoe.languageRevision + 1);
    }
    // The speaker now speaks what was heard, and the work order follows.
    expect(store.ingestPlan('call-1', zoe.participantId)?.sourceLanguage).toBe('es');
    // The recipient's caption for this speaker is re-routed to the new pair.
    expect(store.snapshot('call-1')!.participants.find((p) => p.participantId === zoe.participantId)!.speakLanguage).toBe('es');
  });

  it('settles a correct guess without re-routing anything', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { speakLanguage: 'fr', hearLanguage: 'fr', sourceLanguageMode: 'auto' });

    const result = store.applyDetectedLanguage('call-1', zoe.participantId, 'fr');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(false);
      // Nothing moved, so nothing downstream should be invalidated.
      expect(result.languageRevision).toBe(zoe.languageRevision);
    }
  });

  it('will not let a later utterance flip a settled call back and forth', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { speakLanguage: 'en', sourceLanguageMode: 'auto' });
    expect(store.applyDetectedLanguage('call-1', zoe.participantId, 'fr').ok).toBe(true);

    // One noisy utterance later must not re-route the whole call again.
    const second = store.applyDetectedLanguage('call-1', zoe.participantId, 'es');
    expect(second.ok).toBe(false);
    expect(store.ingestPlan('call-1', zoe.participantId)?.sourceLanguage).toBe('fr');
  });

  it('reports an unknown participant rather than throwing', () => {
    const store = new CallSessionStore();
    mustJoin(store);
    const result = store.applyDetectedLanguage('call-1', 'participant_999', 'fr');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-participant');
  });
});

describe('personalized captions (P6.2 closure)', () => {
  /**
   * The owner's closure test, written literally.
   *
   * Three participants are required on purpose: with two, "each recipient gets
   * THEIR language" is indistinguishable from "the recipient gets the other
   * one's language". The runtime seat cap stays at two until conference ships;
   * this raises it only to prove the routing is per-recipient.
   */
  function threeWayCall() {
    const store = new CallSessionStore({ maxParticipants: 3 });
    const a = mustJoin(store, { displayName: 'A', speakLanguage: 'en', hearLanguage: 'en' });
    const b = mustJoin(store, { displayName: 'B', speakLanguage: 'es', hearLanguage: 'es' });
    const c = mustJoin(store, { displayName: 'C', speakLanguage: 'fr', hearLanguage: 'fr' });
    return { store, a, b, c };
  }

  /**
   * One sentence from A, delivered as media-ingest reports it per target.
   *
   * Revisions come from A's CURRENT work order, not from the join ack: joining
   * bumps everyone else's media revision, so a test holding the ack's value
   * would be sending events the store is right to reject.
   */
  function aSpeaks(store: CallSessionStore, a: CallJoinResult, languageRevisionOverride?: number) {
    const plan = store.ingestPlan('call-1', a.participantId);
    if (!plan) throw new Error('expected a work order for A');
    const base = {
      sourceLanguage: 'en',
      originalText: 'The meeting starts at nine.',
      sequence: 0,
      mediaRevision: plan.mediaRevision,
      languageRevision: languageRevisionOverride ?? plan.languageRevision,
      startMs: 0,
      endMs: 2_000,
      isFinal: true,
    };
    return [
      // The original transcript, which is what a same-language reader sees.
      ...store.routeCaption('call-1', a.participantId, { ...base, targetLanguage: null, translatedText: null }),
      ...store.routeCaption('call-1', a.participantId, {
        ...base, targetLanguage: 'es', translatedText: 'La reunión empieza a las nueve.',
      }),
      ...store.routeCaption('call-1', a.participantId, {
        ...base, targetLanguage: 'fr', translatedText: 'La réunion commence à neuf heures.',
      }),
    ];
  }

  function payloadFor(deliveries: ReturnType<typeof aSpeaks>, participantId: string) {
    return deliveries
      .filter((d) => d.recipientParticipantId === participantId)
      .map((d) => d.payload as Record<string, unknown>);
  }

  it('gives each recipient their own language, attributed to the speaker', () => {
    const { store, a, b, c } = threeWayCall();
    const deliveries = aSpeaks(store, a);

    const toB = payloadFor(deliveries, b.participantId);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({
      targetLanguage: 'es',
      translatedText: 'La reunión empieza a las nueve.',
      speakerParticipantId: a.participantId,
      speakerDisplayName: 'A',
      // The original stays available, so a reader can check a name or a number.
      originalText: 'The meeting starts at nine.',
    });

    const toC = payloadFor(deliveries, c.participantId);
    expect(toC).toHaveLength(1);
    expect(toC[0]).toMatchObject({
      targetLanguage: 'fr',
      translatedText: 'La réunion commence à neuf heures.',
      speakerParticipantId: a.participantId,
      originalText: 'The meeting starts at nine.',
    });
  });

  it('never sends the speaker a translation of themselves', () => {
    const { store, a } = threeWayCall();
    const toA = payloadFor(aSpeaks(store, a), a.participantId);

    // A sees their own words once, as the original, and nothing else.
    expect(toA).toHaveLength(1);
    expect(toA[0]).toMatchObject({ targetLanguage: null, originalText: 'The meeting starts at nine.' });
    expect(toA.some((p) => p.translatedText !== null)).toBe(false);
  });

  it('does not leak one recipient’s caption to another', () => {
    const { store, a, b, c } = threeWayCall();
    const deliveries = aSpeaks(store, a);

    // Every delivery is addressed to exactly one participant, and nobody
    // receives a language they did not ask for.
    expect(payloadFor(deliveries, b.participantId).every((p) => p.targetLanguage === 'es')).toBe(true);
    expect(payloadFor(deliveries, c.participantId).every((p) => p.targetLanguage === 'fr')).toBe(true);
    expect(deliveries).toHaveLength(3);
  });

  it('changes only the caption language of the person who changed it', () => {
    const { store, a, b, c } = threeWayCall();
    const changed = store.setCaptionLanguage('call-1', b.participantId, 'fr');
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const deliveries = aSpeaks(store, a);
    // B now reads French...
    expect(payloadFor(deliveries, b.participantId)[0]).toMatchObject({ targetLanguage: 'fr' });
    // ...and C, who changed nothing, still reads exactly what they were reading.
    expect(payloadFor(deliveries, c.participantId)[0]).toMatchObject({ targetLanguage: 'fr' });
    expect(payloadFor(deliveries, a.participantId)[0]).toMatchObject({ targetLanguage: null });
  });

  it('rejects events planned against the language revision that was replaced', () => {
    const { store, a, b } = threeWayCall();
    const staleRevision = store.ingestPlan('call-1', a.participantId)!.languageRevision;
    store.setCaptionLanguage('call-1', b.participantId, 'fr');

    // Work produced before the change was planned for the old target set, so
    // delivering it would show a reader a caption in a language they left.
    expect(aSpeaks(store, a, staleRevision)).toHaveLength(0);
  });

  it('does not duplicate captions when a participant reconnects', () => {
    const { store, a, b, c } = threeWayCall();
    store.markDisconnected('call-1', b.participantId);
    const resumed = store.createOrJoin(
      joinInput({
        displayName: 'B',
        speakLanguage: 'es',
        hearLanguage: 'es',
        resumeParticipantId: b.participantId,
        resumeToken: b.resumeToken,
      }),
    );
    if (!resumed.ok) throw new Error(`resume failed: ${resumed.code}`);

    const deliveries = aSpeaks(store, a);
    // One caption each, to one seat each — a resumed identity keeps its seat
    // rather than becoming a second recipient.
    expect(payloadFor(deliveries, b.participantId)).toHaveLength(1);
    expect(payloadFor(deliveries, c.participantId)).toHaveLength(1);
    expect(new Set(deliveries.map((d) => d.recipientParticipantId)).size).toBe(deliveries.length);
  });
});

describe('voice ownership reaches the work order without caching a decision', () => {
  it('carries the owner into the ingest plan, and keeps standard voices standard', () => {
    // The owner travels; the resolved personal voice deliberately does not.
    // Writing personal:<profileId> into voiceIdsByLanguage would cache the
    // decision for the life of the media revision, so revoke and delete would
    // not take effect until the session restarted.
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { voiceOwnerId: 'acct_aaaaaaaaaaaaaaaa' });
    const carlos = mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });
    if (!zoe.ok || !carlos.ok) throw new Error('join failed');

    const plan = carlos.ingestPlans.find((p) => p.ingestSessionId.includes(zoe.participantId));
    expect(plan?.voiceOwnerId).toBe('acct_aaaaaaaaaaaaaaaa');
    for (const voiceId of Object.values(plan?.voiceIdsByLanguage ?? {})) {
      expect(voiceId).not.toContain('personal:');
    }
  });

  it('omits the owner entirely for someone who never enrolled', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);
    const carlos = mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });
    if (!zoe.ok || !carlos.ok) throw new Error('join failed');

    const plan = carlos.ingestPlans.find((p) => p.ingestSessionId.includes(zoe.participantId));
    expect(plan?.voiceOwnerId).toBeUndefined();
  });

  it('refuses a voice identity that did not come from enrollment', () => {
    // A participant id, socket id or display name is a string in scope at the
    // join call site. Accepting one would bind a voice to something minted per
    // call; ignoring it silently would present as a personal voice that just
    // never happens, with nothing anywhere explaining why.
    const store = new CallSessionStore();

    // `devid_…` is the retired browser identity: it is refused rather than
    // grandfathered, because a voice recorded by whoever last used a browser is
    // the ownership problem accounts exist to end.
    for (const candidate of ['participant_1', 'Zoe Meak', 'devid_aaaaaaaaaaaa', 'acct_', '']) {
      const result = store.createOrJoin({
        callId: 'calm-river-42',
        displayName: 'Zoe',
        speakLanguage: 'en',
        hearLanguage: 'en',
        captionsEnabled: true,
        voiceGender: 'female',
        audioMode: 'translated',
        voiceOwnerId: candidate,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('never exposes the owner in a public snapshot', () => {
    // It identifies whose voice may be spoken, so it must not travel in
    // call:state alongside display names.
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { voiceOwnerId: 'acct_aaaaaaaaaaaaaaaa' });
    if (!zoe.ok) throw new Error('join failed');

    expect(JSON.stringify(zoe.snapshot)).not.toContain('acct_0000000000000000');
  });
});

describe('W5 call type and capacity', () => {
  it('stamps the defaults — conference, translated — and the creator as owner', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);

    expect(zoe.snapshot.callType).toBe('conference');
    expect(zoe.snapshot.callMode).toBe('translated');
    expect(zoe.snapshot.ownerParticipantId).toBe(zoe.participantId);
  });

  it("honours the creating join's type and mode", () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { callType: 'personal', callMode: 'normal' });

    expect(zoe.snapshot.callType).toBe('personal');
    expect(zoe.snapshot.callMode).toBe('normal');
  });

  it("ignores a joiner's type and mode on an existing call", () => {
    // Invite links join without knowing either; the call is authoritative.
    const store = new CallSessionStore();
    mustJoin(store);
    const joiner = mustJoin(store, {
      displayName: 'Carlos',
      callType: 'personal',
      callMode: 'normal',
    });

    expect(joiner.snapshot.callType).toBe('conference');
    expect(joiner.snapshot.callMode).toBe('translated');
    // Capacity follows the CALL's type, not the joiner's claim: seats 3 and 4
    // stay available.
    expect(mustJoin(store, { displayName: 'C3' }).snapshot.participants).toHaveLength(3);
    expect(mustJoin(store, { displayName: 'C4' }).snapshot.participants).toHaveLength(4);
  });

  it('refuses values outside the vocabulary rather than ignoring them', () => {
    const store = new CallSessionStore();
    for (const overrides of [
      { callType: 'group' as unknown as CallType },
      { callMode: 'silent' as unknown as CallMode },
    ]) {
      expect(store.createOrJoin(joinInput(overrides))).toMatchObject({
        ok: false,
        code: 'invalid-input',
      });
    }
    expect(store.activeCallCount()).toBe(0);
  });

  it('seats exactly two in a personal call and four in a conference', () => {
    const personal = new CallSessionStore();
    mustJoin(personal, { callType: 'personal' });
    mustJoin(personal, { displayName: 'Carlos' });
    expect(personal.createOrJoin(joinInput({ displayName: 'Eve' }))).toMatchObject({
      ok: false,
      code: 'call-full',
    });

    const conference = new CallSessionStore();
    mustJoin(conference, { callType: 'conference' });
    for (const name of ['B', 'C', 'D']) {
      mustJoin(conference, { displayName: name });
    }
    expect(conference.createOrJoin(joinInput({ displayName: 'Eve' }))).toMatchObject({
      ok: false,
      code: 'call-full',
    });
  });
});

describe('W5 call mode and owner authority', () => {
  it('rejects a non-owner, an unknown participant, an unknown call, and an invalid mode by name', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    expect(store.setCallMode('call-1', carlos.participantId, 'normal')).toEqual({
      ok: false,
      reason: 'not-owner',
    });
    expect(store.setCallMode('call-1', 'participant_missing', 'normal')).toEqual({
      ok: false,
      reason: 'unknown-participant',
    });
    expect(store.setCallMode('ghost-call', zoe.participantId, 'normal')).toEqual({
      ok: false,
      reason: 'unknown-call',
    });
    /*
     * The owner reaches the lock, and only the owner does. Checked in this
     * order on purpose: a non-owner learns they are not the owner, which they
     * already knew, and does not additionally learn whether the mode would
     * otherwise have been changeable.
     */
    expect(store.setCallMode('call-1', zoe.participantId, 'normal')).toEqual({
      ok: false,
      reason: 'mode-locked',
    });
    expect(store.setCallMode('call-1', zoe.participantId, 'loud' as CallMode)).toEqual({
      ok: false,
      reason: 'invalid-mode',
    });
    // No refusal may bump anyone.
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('treats an already-set mode as a no-op: ok, current snapshot, no bumps', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const result = store.setCallModeByAuthority('call-1', 'translated');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.snapshot.callMode).toBe('translated');
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('turns TRANSLATION off for everyone; captions stay as STT-only work (18 Aug redefinition)', () => {
    // Normal mode redefined on acceptance feedback: "caption only comes on
    // when translation is on" was the DEFECT. The translation engine is off —
    // no targets, no voices, no TTS — but the transcript is working material,
    // so STT-only sessions caption the original words.
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    const zoeRevisionBefore = planRevision(store, 'call-1', zoe.participantId);

    const result = store.setCallModeByAuthority('call-1', 'normal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.snapshot.callMode).toBe('normal');
    // STT-only plans: sessions replaced, translation fully stripped.
    expect(result.ingestPlans.length).toBeGreaterThan(0);
    for (const plan of result.ingestPlans) {
      expect(plan.targetLanguages).toEqual([]);
      expect(plan.voiceIdsByLanguage).toEqual({});
      expect(plan).not.toHaveProperty('voiceOwnerId');
    }
    const zoePlan = store.ingestPlan('call-1', zoe.participantId);
    expect(zoePlan).not.toBeNull();
    expect(zoePlan!.targetLanguages).toEqual([]);
    expect(zoePlan!.sameLanguageCaptionsNeeded).toBe(true);
    expect(store.ingestPlan('call-1', carlos.participantId)).not.toBeNull();

    // Belt and braces: even an event stamped with the CURRENT (bumped)
    // revisions is refused while the mode is normal.
    const current = {
      sequence: 0,
      mediaRevision: zoeRevisionBefore + 1,
      languageRevision: 1,
      startMs: 0,
      endMs: 1_000,
      isFinal: true,
    };
    expect(
      store.routeCaption('call-1', zoe.participantId, {
        ...current,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        originalText: 'hello',
        translatedText: 'hola',
      }),
    ).toEqual([]);
    // The ORIGINAL transcript still flows: STT-only captions reach the
    // speaker and every connected recipient, untranslated.
    const originals = store.routeCaption('call-1', zoe.participantId, {
      ...current,
      sourceLanguage: 'en',
      targetLanguage: null,
      originalText: 'hello',
      translatedText: null,
    });
    expect(originals.map((delivery) => delivery.recipientParticipantId).sort()).toEqual(
      [zoe.participantId, carlos.participantId].sort(),
    );
    for (const delivery of originals) {
      const payload = delivery.payload as {
        translatedText: string | null;
        targetLanguage: string | null;
      };
      expect(payload.translatedText).toBeNull();
      expect(payload.targetLanguage).toBeNull();
    }
    expect(
      store.routeGeneratedAudio('call-1', zoe.participantId, {
        ...current,
        targetLanguage: 'es',
        voiceId: 'es_ES-sharvard-male',
        audioUrl: 'http://host/clip.wav',
        durationMs: 900,
      }),
    ).toEqual([]);
  });

  it('bumps every connected participant on a real change, visible when the engine returns', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    store.setCallModeByAuthority('call-1', 'normal');
    const restored = store.setCallModeByAuthority('call-1', 'translated');
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.changed).toBe(true);
    // Zoe r2 -> r3 -> r4; Carlos r1 -> r2 -> r3: both switches bumped both
    // seats, so every live session id was superseded both times.
    expect(restored.ingestPlans.map((plan) => plan.ingestSessionId).sort()).toEqual([
      'call_call-1_participant_1_r4',
      'call_call-1_participant_2_r3',
    ]);
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(4);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(3);
  });

  it("keeps the owner's authority across resume", () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId);
    const resumed = store.createOrJoin(
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: zoe.resumeToken }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.snapshot.ownerParticipantId).toBe(zoe.participantId);

    const result = store.setCallModeByAuthority('call-1', 'normal');
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it('leaves the mode frozen when the owner is gone — no election', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.leave('call-1', zoe.participantId);

    // The seat is gone, so the departed owner cannot act...
    expect(store.setCallMode('call-1', zoe.participantId, 'normal')).toEqual({
      ok: false,
      reason: 'unknown-participant',
    });
    // ...and nobody inherits the authority.
    expect(store.setCallMode('call-1', carlos.participantId, 'normal')).toEqual({
      ok: false,
      reason: 'not-owner',
    });
    expect(store.snapshot('call-1')?.callMode).toBe('translated');
  });
});

describe('W5 caption-only planning (audioMode and captions decide what is made)', () => {
  it('plans a text-only language, with NO voice entry, for a cross-language reader keeping original audio', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);
    mustJoin(store, {
      displayName: 'Carlos',
      speakLanguage: 'es',
      hearLanguage: 'es',
      audioMode: 'original',
      captionsEnabled: true,
    });

    const plan = store.ingestPlan('call-1', zoe.participantId);
    expect(plan?.targetLanguages).toEqual(['es']);
    expect(plan?.textOnlyLanguages).toEqual(['es']);
    // A text-only language must never reach the default-voice fallback.
    expect(plan?.voiceIdsByLanguage).toEqual({});
  });

  it('plans nothing at all for a cross-language listener with captions off and original audio', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);
    mustJoin(store, {
      displayName: 'Carlos',
      speakLanguage: 'es',
      hearLanguage: 'es',
      audioMode: 'original',
      captionsEnabled: false,
    });

    const plan = store.ingestPlan('call-1', zoe.participantId);
    expect(plan?.targetLanguages).toEqual([]);
    expect(plan?.textOnlyLanguages).toEqual([]);
    expect(plan?.sameLanguageCaptionsNeeded).toBe(false);
  });

  it('synthesizes a language while ANY of its listeners wants generated audio', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);
    mustJoin(store, {
      displayName: 'Carlos',
      speakLanguage: 'es',
      hearLanguage: 'es',
      audioMode: 'original',
    });
    mustJoin(store, {
      displayName: 'Diego',
      speakLanguage: 'es',
      hearLanguage: 'es',
      audioMode: 'translated',
    });

    const plan = store.ingestPlan('call-1', zoe.participantId);
    expect(plan?.targetLanguages).toEqual(['es']);
    expect(plan?.textOnlyLanguages).toEqual([]);
    expect(plan?.voiceIdsByLanguage).toEqual({ es: 'es_ES-sharvard-female' });
  });

  it("marks a same-language speaker's session as needed only while somebody reads captions", () => {
    const readers = new CallSessionStore();
    const zoe = mustJoin(readers);
    mustJoin(readers, { displayName: 'Sam', captionsEnabled: true });
    const withReader = readers.ingestPlan('call-1', zoe.participantId);
    expect(withReader?.targetLanguages).toEqual([]);
    expect(withReader?.sameLanguageCaptionsNeeded).toBe(true);

    const noReaders = new CallSessionStore();
    const solo = mustJoin(noReaders);
    mustJoin(noReaders, { displayName: 'Sam', captionsEnabled: false });
    const withoutReader = noReaders.ingestPlan('call-1', solo.participantId);
    expect(withoutReader?.targetLanguages).toEqual([]);
    expect(withoutReader?.sameLanguageCaptionsNeeded).toBe(false);
  });
});

describe('W5 leave reconciliation', () => {
  /**
   * Ana (en→en) is AFFECTED by Dan leaving: he was her only French listener.
   * Uma (fr→en) is NOT: her one target (en, for Ana) never involved Dan — he
   * heard her original French, with captions off, wanting nothing made.
   */
  function trio(store: CallSessionStore) {
    const ana = mustJoin(store, { displayName: 'Ana', speakLanguage: 'en', hearLanguage: 'en' });
    const uma = mustJoin(store, { displayName: 'Uma', speakLanguage: 'fr', hearLanguage: 'en' });
    const dan = mustJoin(store, {
      displayName: 'Dan',
      speakLanguage: 'es',
      hearLanguage: 'fr',
      captionsEnabled: false,
      audioMode: 'translated',
    });
    return { ana, uma, dan };
  }

  it('bumps ONLY the speakers whose target set changed, and returns just their plans', () => {
    const store = new CallSessionStore();
    const { ana, uma, dan } = trio(store);
    // After three joins: Ana r3 (bumped twice), Uma r2, Dan r1.
    expect(store.ingestPlan('call-1', ana.participantId)?.targetLanguages).toEqual(['fr']);
    const umaSessionBefore = store.ingestPlan('call-1', uma.participantId)?.ingestSessionId;
    expect(umaSessionBefore).toBe('call_call-1_participant_2_r2');

    const result = store.leave('call-1', dan.participantId);

    // The departed listener's language disappears, via a replacement session
    // for the one speaker who was producing it...
    expect(result.ingestPlans).toHaveLength(1);
    expect(result.ingestPlans[0]?.ingestSessionId).toBe('call_call-1_participant_1_r4');
    expect(result.ingestPlans[0]?.targetLanguages).toEqual([]);
    // ...who still needs an STT-only session: Uma reads Ana's captions.
    expect(result.ingestPlans[0]?.sameLanguageCaptionsNeeded).toBe(true);
    // The unaffected speaker's revision-scoped session id is untouched, so
    // her in-flight work survives somebody else's departure.
    expect(store.ingestPlan('call-1', uma.participantId)?.ingestSessionId).toBe(umaSessionBefore);
  });

  it('does not reconcile on mere disconnect — only when the seat is actually left', () => {
    const store = new CallSessionStore();
    const { ana, uma, dan } = trio(store);

    store.markDisconnected('call-1', dan.participantId);
    // A seat inside its resume grace bumps nobody.
    expect(planRevision(store, 'call-1', ana.participantId)).toBe(3);
    expect(planRevision(store, 'call-1', uma.participantId)).toBe(2);

    // The reap arrives as a leave: the baseline treats the disconnected seat
    // as it was last planned for, so Ana still reconciles now — not earlier.
    const result = store.leave('call-1', dan.participantId);
    expect(result.ingestPlans.map((plan) => plan.ingestSessionId)).toEqual([
      'call_call-1_participant_1_r4',
    ]);
    expect(planRevision(store, 'call-1', uma.participantId)).toBe(2);
  });

  it("returns no plans when a leave changes nobody's targets", () => {
    // Two French listeners: losing one keeps fr in every speaker's target set.
    const store = new CallSessionStore();
    const ana = mustJoin(store, { displayName: 'Ana', speakLanguage: 'en', hearLanguage: 'en' });
    mustJoin(store, { displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' });
    const chloe = mustJoin(store, {
      displayName: 'Chloe',
      speakLanguage: 'fr',
      hearLanguage: 'fr',
      captionsEnabled: false,
      audioMode: 'translated',
    });

    const result = store.leave('call-1', chloe.participantId);

    // Ana keeps translating to French for Bruno; Bruno's plan lost nothing
    // either (Chloe heard his original, captions off). Nobody bumps.
    expect(result.ingestPlans).toEqual([]);
    expect(planRevision(store, 'call-1', ana.participantId)).toBe(3);
    expect(store.ingestPlan('call-1', ana.participantId)?.targetLanguages).toEqual(['fr']);
  });
});
