/** @owner masterzee001 */
import { CallSessionLifecycleStateSchema } from '@videofy-live/call-contracts';
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  STANDARD_CALL_VOICES,
  type CallJoinInput,
  type CallJoinResult,
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
      },
    ]);
    expect(result.ingestPlans).toEqual([
      {
        ingestSessionId: 'call_call-1_participant_1_r1',
        broadcastId: 'callcast_call-1_participant_1_r1',
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        targetLanguages: [],
        voiceIdsByLanguage: {},
        mediaRevision: 1,
      },
    ]);
  });

  it('second join bumps the existing speaker and recomputes both plans with recipient voices', () => {
    const store = new CallSessionStore();
    const { carlos } = translatedPair(store);

    // Carlos is the joiner (initial revision 1); Zoe's membership-change bump moves her to 2.
    expect(carlos.mediaRevision).toBe(1);
    expect(carlos.snapshot.lifecycleState).toBe('active');
    expect(carlos.ingestPlans).toHaveLength(2);
    const [zoePlan, carlosPlan] = carlos.ingestPlans;
    // Zoe speaks en; Carlos hears es and picked the female voice.
    expect(zoePlan).toEqual({
      ingestSessionId: 'call_call-1_participant_1_r2',
      broadcastId: 'callcast_call-1_participant_1_r2',
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
      targetLanguages: ['es'],
      voiceIdsByLanguage: { es: 'es_ES-sharvard-female' },
      mediaRevision: 2,
    });
    // Carlos speaks es; Zoe hears en and picked the male voice.
    expect(carlosPlan).toEqual({
      ingestSessionId: 'call_call-1_participant_2_r1',
      broadcastId: 'callcast_call-1_participant_2_r1',
      sourceLanguage: 'es',
      sourceLanguageMode: 'manual',
      targetLanguages: ['en'],
      voiceIdsByLanguage: { en: 'en_US-hfc_male-medium' },
      mediaRevision: 1,
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

  it('rejects a third join with a typed call-full error and leaves the call untouched', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const third = store.createOrJoin(joinInput({ displayName: 'Amelie' }));
    expect(third).toMatchObject({ ok: false, code: 'call-full' });
    expect(store.snapshot('call-1')?.participants).toHaveLength(2);
    expect(store.activeCallCount()).toBe(1);
    // A failed join must not bump anyone.
    expect(planRevision(store, 'call-1', zoe.participantId)).toBe(2);
    expect(planRevision(store, 'call-1', carlos.participantId)).toBe(1);
  });

  it('still counts a disconnected identity toward the two-participant cap', () => {
    const store = new CallSessionStore();
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
      { speakLanguage: 'fr' as CallJoinInput['speakLanguage'] },
      { hearLanguage: 'de' as CallJoinInput['hearLanguage'] },
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
  it('keeps the call alive and bumps nobody when one of two participants leaves', () => {
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
    // leave() is bump-free: the remaining speaker's session id stays valid.
    expect(store.ingestPlan('call-1', carlos.participantId)?.ingestSessionId).toBe(
      'call_call-1_participant_2_r1',
    );
  });

  it('ends the call and removes all state when the last participant leaves', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    store.leave('call-1', zoe.participantId);
    const result = store.leave('call-1', carlos.participantId);
    expect(result).toEqual({ ok: true, callEnded: true, snapshot: null });
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
    expect(unknownCall).toEqual({ ok: false, callEnded: false, snapshot: null });
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
    translatedPair(store);

    const snapshot = store.snapshot('call-1');
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    expect(Object.keys(snapshot).sort()).toEqual(['callId', 'lifecycleState', 'participants']);
    for (const participant of snapshot.participants) {
      expect(Object.keys(participant).sort()).toEqual([
        'connected',
        'displayName',
        'hearLanguage',
        'participantId',
        'speakLanguage',
      ]);
    }
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
  it('maps all four language/gender selections to the registered Piper voices', () => {
    expect(STANDARD_CALL_VOICES).toEqual({
      en: { male: 'en_US-hfc_male-medium', female: 'en_US-hfc_female-medium' },
      es: { male: 'es_ES-sharvard-male', female: 'es_ES-sharvard-female' },
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
