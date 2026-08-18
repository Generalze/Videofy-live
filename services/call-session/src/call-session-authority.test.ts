/** @owner masterzee001 */
/**
 * P6.5 FE1 — the store's server-authority extensions behind Videofy Connect:
 * preregistered calls (type/mode fixed before anyone joins), project-authority
 * mode changes and whole-call teardown, and the partner-supplied `subject`
 * seat identity.
 *
 * Store-side truth only. The gateway owns rule ENFORCEMENT (who may call the
 * authority methods, one connected seat per subject), so these tests prove the
 * store's answers, never the refusals built on top of them.
 */
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  type CallCaptionSourceEvent,
  type CallGeneratedAudioSourceEvent,
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
  });
  return { zoe, carlos };
}

/** Deterministic clock and tokens, so two stores driven identically stay identical. */
function deterministicStore(): CallSessionStore {
  let serial = 0;
  return new CallSessionStore({
    now: () => '2026-08-18T00:00:00.000Z',
    createResumeToken: () => `resume-${serial++}`,
  });
}

function mustPlan(store: CallSessionStore, callId: string, participantId: string) {
  const plan = store.ingestPlan(callId, participantId);
  if (!plan) throw new Error(`expected an ingest plan for ${participantId}`);
  return plan;
}

describe('CallSessionStore.preregisterCall', () => {
  it('creates an empty waiting call whose snapshot shows the preregistered type and mode', () => {
    const store = new CallSessionStore();
    const result = store.preregisterCall('call-1', { callType: 'personal', callMode: 'normal' });

    expect(result).toEqual({
      ok: true,
      snapshot: {
        callId: 'call-1',
        lifecycleState: 'waiting',
        callType: 'personal',
        callMode: 'normal',
        // No seats yet, so no authority yet: '' until the first join.
        ownerParticipantId: '',
        transcriptDownloadAllowed: true,
        participants: [],
      },
    });
    expect(store.activeCallCount()).toBe(1);
    expect(store.snapshot('call-1')).toEqual(result.ok ? result.snapshot : null);
  });

  it('refuses malformed ids, out-of-vocabulary types and modes, and existing calls', () => {
    const store = new CallSessionStore();
    const preregister = { callType: 'conference', callMode: 'translated' } as const;

    expect(store.preregisterCall('has spaces!', preregister)).toEqual({
      ok: false,
      reason: 'invalid-call-id',
    });
    expect(store.preregisterCall('', preregister)).toEqual({ ok: false, reason: 'invalid-call-id' });
    expect(store.preregisterCall('x'.repeat(65), preregister)).toEqual({
      ok: false,
      reason: 'invalid-call-id',
    });
    expect(
      store.preregisterCall('call-1', {
        callType: 'group' as unknown as CallType,
        callMode: 'translated',
      }),
    ).toEqual({ ok: false, reason: 'invalid-call-type' });
    expect(
      store.preregisterCall('call-1', {
        callType: 'conference',
        callMode: 'silent' as unknown as CallMode,
      }),
    ).toEqual({ ok: false, reason: 'invalid-call-mode' });
    // Nothing above created anything.
    expect(store.activeCallCount()).toBe(0);

    expect(store.preregisterCall('call-1', preregister).ok).toBe(true);
    expect(store.preregisterCall('call-1', preregister)).toEqual({
      ok: false,
      reason: 'call-already-exists',
    });
    // An organically created call occupies its id just the same.
    mustJoin(store, { callId: 'call-2' });
    expect(store.preregisterCall('call-2', preregister)).toEqual({
      ok: false,
      reason: 'call-already-exists',
    });
  });

  it('first join takes ownership and its callType/callMode inputs are ignored', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'normal' });

    // The join ARGUES for conference/translated; the preregistration wins,
    // exactly as any existing call wins over a joiner's stated intent.
    const creator = mustJoin(store, { callType: 'conference', callMode: 'translated' });
    expect(creator.snapshot.callType).toBe('personal');
    expect(creator.snapshot.callMode).toBe('normal');
    expect(creator.snapshot.ownerParticipantId).toBe(creator.participantId);

    // Ownership is real: the first join can switch the mode, a later one cannot.
    const second = mustJoin(store, { displayName: 'Carlos' });
    expect(store.setCallMode('call-1', second.participantId, 'translated')).toEqual({
      ok: false,
      reason: 'not-owner',
    });
    const byOwner = store.setCallMode('call-1', creator.participantId, 'translated');
    expect(byOwner.ok && byOwner.changed).toBe(true);
  });

  it('still refuses out-of-vocabulary type/mode on the join even though they are ignored', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'normal' });
    const result = store.createOrJoin(joinInput({ callType: 'group' as unknown as CallType }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-input');
  });

  it('resolves capacity from the preregistered type: a personal call seats exactly two', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'translated' });
    mustJoin(store, { displayName: 'Zoe' });
    mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });
    const third = store.createOrJoin(joinInput({ displayName: 'Maya' }));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe('call-full');
  });

  it('a preregistered conference keeps the conference cap', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'conference', callMode: 'translated' });
    for (const name of ['Ana', 'Bruno', 'Chloe', 'Diego']) {
      mustJoin(store, { displayName: name });
    }
    const fifth = store.createOrJoin(joinInput({ displayName: 'Eva' }));
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.code).toBe('call-full');
  });

  it('dies with its last seat and does not revert to the empty preregistered state', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'normal' });
    const creator = mustJoin(store);

    const left = store.leave('call-1', creator.participantId);
    expect(left.callEnded).toBe(true);
    expect(store.snapshot('call-1')).toBeNull();
    expect(store.activeCallCount()).toBe(0);

    // A later join to the same id creates a FRESH call with join defaults —
    // the preregistration went down with the call.
    const rejoined = mustJoin(store);
    expect(rejoined.snapshot.callType).toBe('conference');
    expect(rejoined.snapshot.callMode).toBe('translated');
  });

  it('an abandoned empty call is reaped by the host through endCall', () => {
    // The lifecycle ruling this suite pins down: the store keeps no timers
    // (P6.1B no-I/O charter), so empty preregistered calls are counted as
    // active until the Connect registry — which owns idle-expiry — ends them.
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'conference', callMode: 'translated' });
    expect(store.activeCallCount()).toBe(1);

    const ended = store.endCall('call-1');
    expect(ended).toEqual({
      ok: true,
      snapshot: {
        callId: 'call-1',
        lifecycleState: 'waiting',
        callType: 'conference',
        callMode: 'translated',
        ownerParticipantId: '',
        transcriptDownloadAllowed: true,
        participants: [],
      },
      retiredIngestSessionIds: [],
    });
    expect(store.activeCallCount()).toBe(0);
  });

  it('accepts authority mode changes while still empty; owner-gated changes have no one to accept', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'normal' });

    expect(store.setCallMode('call-1', 'participant_1', 'translated')).toEqual({
      ok: false,
      reason: 'unknown-participant',
    });

    const changed = store.setCallModeByAuthority('call-1', 'translated');
    expect(changed).toEqual({
      ok: true,
      changed: true,
      snapshot: expect.objectContaining({ callMode: 'translated' }),
      ingestPlans: [],
    });
    // The changed mode is now the call's authority for the creating join.
    const creator = mustJoin(store, { callMode: 'normal' });
    expect(creator.snapshot.callMode).toBe('translated');
  });

  it('keeps the projectTag out of snapshots and plans', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', {
      callType: 'conference',
      callMode: 'translated',
      projectTag: 'proj_tag_9f3a',
    });
    const { zoe } = translatedPair(store);
    expect(JSON.stringify(store.snapshot('call-1'))).not.toContain('proj_tag_9f3a');
    expect(JSON.stringify(mustPlan(store, 'call-1', zoe.participantId))).not.toContain(
      'proj_tag_9f3a',
    );
  });
});

describe('CallSessionStore.setCallModeByAuthority', () => {
  it('returns byte-identical results to the owner path, both directions', () => {
    const ownerStore = deterministicStore();
    const authorityStore = deterministicStore();
    const { zoe } = translatedPair(ownerStore);
    translatedPair(authorityStore);

    const ownerOff = ownerStore.setCallMode('call-1', zoe.participantId, 'normal');
    const authorityOff = authorityStore.setCallModeByAuthority('call-1', 'normal');
    expect(authorityOff).toEqual(ownerOff);

    const ownerOn = ownerStore.setCallMode('call-1', zoe.participantId, 'translated');
    const authorityOn = authorityStore.setCallModeByAuthority('call-1', 'translated');
    expect(authorityOn).toEqual(ownerOn);

    // Not just the result objects: the stores themselves ended up identical.
    expect(authorityStore.snapshot('call-1')).toEqual(ownerStore.snapshot('call-1'));
    expect(mustPlan(authorityStore, 'call-1', 'participant_1')).toEqual(
      mustPlan(ownerStore, 'call-1', 'participant_1'),
    );
    expect(mustPlan(authorityStore, 'call-1', 'participant_2')).toEqual(
      mustPlan(ownerStore, 'call-1', 'participant_2'),
    );
  });

  it('bumps every connected participant so all live session ids are superseded at once', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    const zoeBefore = mustPlan(store, 'call-1', zoe.participantId).mediaRevision;
    const carlosBefore = mustPlan(store, 'call-1', carlos.participantId).mediaRevision;

    const result = store.setCallModeByAuthority('call-1', 'normal');
    expect(result.ok && result.changed).toBe(true);
    expect(mustPlan(store, 'call-1', zoe.participantId).mediaRevision).toBe(zoeBefore + 1);
    expect(mustPlan(store, 'call-1', carlos.participantId).mediaRevision).toBe(carlosBefore + 1);
    if (!result.ok) return;
    // Normal mode: the engine is off, so the fresh plans are STT-only.
    expect(result.ingestPlans).toHaveLength(2);
    for (const plan of result.ingestPlans) {
      expect(plan.targetLanguages).toEqual([]);
      expect(plan.voiceIdsByLanguage).toEqual({});
    }
  });

  it('does not bump a disconnected-in-grace seat, exactly like the owner path', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);
    const carlosBefore = mustPlan(store, 'call-1', carlos.participantId).mediaRevision;

    const result = store.setCallModeByAuthority('call-1', 'normal');
    expect(result.ok && result.changed).toBe(true);
    expect(mustPlan(store, 'call-1', carlos.participantId).mediaRevision).toBe(carlosBefore);
    if (!result.ok) return;
    // Plans cover CONNECTED participants only, through the same join path.
    expect(result.ingestPlans.map((plan) => plan.ingestSessionId)).toEqual([
      `call_call-1_${zoe.participantId}_r3`,
    ]);
  });

  it('reports changed: false without bumping when the mode is already set', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    const before = mustPlan(store, 'call-1', zoe.participantId).mediaRevision;

    const result = store.setCallModeByAuthority('call-1', 'translated');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.ingestPlans).toHaveLength(2);
    expect(mustPlan(store, 'call-1', zoe.participantId).mediaRevision).toBe(before);
  });

  it('refuses unknown calls and out-of-vocabulary modes', () => {
    const store = new CallSessionStore();
    translatedPair(store);
    expect(store.setCallModeByAuthority('ghost-call', 'normal')).toEqual({
      ok: false,
      reason: 'unknown-call',
    });
    expect(store.setCallModeByAuthority('call-1', 'loud' as unknown as CallMode)).toEqual({
      ok: false,
      reason: 'invalid-mode',
    });
  });

  it('needs no owner: the change lands even while the owner seat is disconnected', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId); // Zoe created the call.

    const result = store.setCallModeByAuthority('call-1', 'normal');
    expect(result.ok && result.changed).toBe(true);
    expect(store.snapshot('call-1')?.callMode).toBe('normal');
  });

  it('routing follows the authority change: generated audio stops, original captions keep flowing', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.setCallModeByAuthority('call-1', 'normal');
    const zoePlan = mustPlan(store, 'call-1', zoe.participantId);

    const audioEvent: CallGeneratedAudioSourceEvent = {
      targetLanguage: 'es',
      voiceId: 'en_US-hfc_male-medium',
      audioUrl: 'https://example.test/clip.wav',
      sequence: 1,
      startMs: 0,
      durationMs: 900,
      mediaRevision: zoePlan.mediaRevision,
      languageRevision: zoePlan.languageRevision,
    };
    expect(store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent)).toEqual([]);

    const captionEvent: CallCaptionSourceEvent = {
      sourceLanguage: 'en',
      targetLanguage: null,
      originalText: 'hello there',
      translatedText: null,
      sequence: 2,
      mediaRevision: zoePlan.mediaRevision,
      languageRevision: zoePlan.languageRevision,
      startMs: 0,
      endMs: 800,
      isFinal: true,
    };
    const deliveries = store.routeCaption('call-1', zoe.participantId, captionEvent);
    expect(deliveries.map((delivery) => delivery.recipientParticipantId).sort()).toEqual(
      [zoe.participantId, carlos.participantId].sort(),
    );
  });
});

describe('CallSessionStore.endCall', () => {
  it('returns the final pre-deletion snapshot and every seat’s current work-order id', () => {
    const store = deterministicStore();
    const { zoe, carlos } = translatedPair(store);
    const liveIds = [
      mustPlan(store, 'call-1', zoe.participantId).ingestSessionId,
      mustPlan(store, 'call-1', carlos.participantId).ingestSessionId,
    ];

    const result = store.endCall('call-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.participants.map((participant) => participant.participantId)).toEqual([
      zoe.participantId,
      carlos.participantId,
    ]);
    // No revision moved: the ids retired are exactly the ids that were live.
    expect(result.retiredIngestSessionIds).toEqual(liveIds);
    expect(result.retiredIngestSessionIds).toEqual([
      'call_call-1_participant_1_r2',
      'call_call-1_participant_2_r1',
    ]);
    expect(store.snapshot('call-1')).toBeNull();
    expect(store.activeCallCount()).toBe(0);
  });

  it('includes disconnected-in-grace seats — their sessions must die with the call', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);
    const carlosLiveId = mustPlan(store, 'call-1', carlos.participantId).ingestSessionId;

    const result = store.endCall('call-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.lifecycleState).toBe('reconnecting');
    expect(
      result.snapshot.participants.map((participant) => [
        participant.participantId,
        participant.connected,
      ]),
    ).toEqual([
      [zoe.participantId, true],
      [carlos.participantId, false],
    ]);
    expect(result.retiredIngestSessionIds).toContain(carlosLiveId);
    expect(result.retiredIngestSessionIds).toHaveLength(2);
  });

  it('is unknown-call for calls that never existed or already ended', () => {
    const store = new CallSessionStore();
    expect(store.endCall('ghost-call')).toEqual({ ok: false, reason: 'unknown-call' });
    translatedPair(store);
    expect(store.endCall('call-1').ok).toBe(true);
    expect(store.endCall('call-1')).toEqual({ ok: false, reason: 'unknown-call' });
  });

  it('leaves no zombies: old resume credentials are dead and the id is reusable fresh', () => {
    const store = deterministicStore();
    const { zoe } = translatedPair(store);
    store.endCall('call-1');

    const rejoined = mustJoin(store, { displayName: 'Maya' });
    expect(rejoined.participantId).toBe('participant_1');
    expect(rejoined.mediaRevision).toBe(1);
    expect(rejoined.snapshot.callType).toBe('conference');

    // Zoe held participant_1 of the ENDED call; her token must not reclaim
    // the new call's participant_1.
    const resumeAttempt = store.createOrJoin(
      joinInput({
        displayName: 'Zoe',
        voiceGender: 'male',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(resumeAttempt.ok).toBe(false);
    if (!resumeAttempt.ok) expect(resumeAttempt.code).toBe('unknown-participant');

    // leave() on the ended call's seat is a no-op failure, not a crash.
    expect(store.leave('call-1', 'participant_2').ok).toBe(false);
  });
});

describe('CallSessionStore subject identity (R8)', () => {
  it('stores the subject on the seat and exposes it in the snapshot entry', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { subject: 'customer_8291' });
    mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });

    const participants = store.snapshot('call-1')?.participants ?? [];
    expect(participants.map((participant) => participant.subject)).toEqual([
      'customer_8291',
      undefined,
    ]);
    expect(zoe.snapshot.participants[0]?.subject).toBe('customer_8291');
  });

  it('validates length only — 1..128 characters, content stays opaque', () => {
    const store = new CallSessionStore();
    for (const subject of ['', 'x'.repeat(129), 42 as unknown as string]) {
      const result = store.createOrJoin(joinInput({ subject }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid-input');
        expect(result.message).toBe('A subject must be between 1 and 128 characters.');
      }
    }
    // Opaque: whitespace, unicode, and a full-length value are all admitted.
    expect(store.createOrJoin(joinInput({ subject: ' späce/∆ ' })).ok).toBe(true);
    expect(
      store.createOrJoin(
        joinInput({ callId: 'call-2', subject: 'x'.repeat(128) }),
      ).ok,
    ).toBe(true);
  });

  it('allows two seats to share a subject — the one-connected rule is the gateway’s', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Zoe', subject: 'customer_8291' });
    mustJoin(store, {
      displayName: 'Zoe on tablet',
      speakLanguage: 'es',
      hearLanguage: 'es',
      subject: 'customer_8291',
    });
    const participants = store.snapshot('call-1')?.participants ?? [];
    expect(participants.filter((participant) => participant.subject === 'customer_8291')).toHaveLength(2);
  });

  it('survives resume, and a resume cannot rewrite it', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { subject: 'customer_8291' });
    mustJoin(store, { displayName: 'Carlos', speakLanguage: 'es', hearLanguage: 'es' });

    store.markDisconnected('call-1', zoe.participantId);
    // A resume that says nothing about subject keeps the seat's identity...
    const resumedQuiet = store.createOrJoin(
      joinInput({
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(resumedQuiet.ok).toBe(true);
    expect(store.snapshot('call-1')?.participants[0]?.subject).toBe('customer_8291');

    store.markDisconnected('call-1', zoe.participantId);
    // ...and a resume that argues for a DIFFERENT one is ignored: the seat
    // was stamped at creation and identity is not renegotiable mid-call.
    const resumedLoud = store.createOrJoin(
      joinInput({
        subject: 'customer_9999',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );
    expect(resumedLoud.ok).toBe(true);
    expect(store.snapshot('call-1')?.participants[0]?.subject).toBe('customer_8291');
  });

  it('hasConnectedSubject tracks CONNECTION, not seat existence', () => {
    const store = new CallSessionStore();
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(false);

    const zoe = mustJoin(store, { subject: 'customer_8291' });
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(true);
    expect(store.hasConnectedSubject('call-1', 'customer_0000')).toBe(false);
    // Another call never sees this subject.
    expect(store.hasConnectedSubject('call-2', 'customer_8291')).toBe(false);

    // Disconnected-in-grace does NOT block (R8): the recovery path — a fresh
    // join while the old seat awaits its reap — must stay open.
    store.markDisconnected('call-1', zoe.participantId);
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(false);

    const resumed = store.createOrJoin(
      joinInput({ resumeParticipantId: zoe.participantId, resumeToken: zoe.resumeToken }),
    );
    expect(resumed.ok).toBe(true);
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(true);

    store.leave('call-1', zoe.participantId);
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(false);
  });

  it('never travels into ingest plans or routed caption payloads', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { subject: 'customer_8291' });
    const carlos = mustJoin(store, {
      displayName: 'Carlos',
      speakLanguage: 'es',
      hearLanguage: 'es',
      subject: 'customer_5150',
    });

    expect(JSON.stringify(carlos.ingestPlans)).not.toContain('customer_');
    const zoePlan = mustPlan(store, 'call-1', zoe.participantId);
    const deliveries = store.routeCaption('call-1', zoe.participantId, {
      sourceLanguage: 'en',
      targetLanguage: 'es',
      originalText: 'hello there',
      translatedText: 'hola',
      sequence: 1,
      mediaRevision: zoePlan.mediaRevision,
      languageRevision: zoePlan.languageRevision,
      startMs: 0,
      endMs: 500,
      isFinal: true,
    });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(JSON.stringify(deliveries)).not.toContain('customer_');
  });

  it('joins with a subject into a preregistered call exactly like any other seat', () => {
    const store = new CallSessionStore();
    store.preregisterCall('call-1', { callType: 'personal', callMode: 'translated' });
    const creator = mustJoin(store, { subject: 'customer_8291' });

    expect(creator.snapshot.ownerParticipantId).toBe(creator.participantId);
    expect(creator.snapshot.participants[0]?.subject).toBe('customer_8291');
    expect(store.hasConnectedSubject('call-1', 'customer_8291')).toBe(true);
  });
});
