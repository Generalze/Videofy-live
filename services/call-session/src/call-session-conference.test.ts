/** @owner masterzee001 */
/**
 * P6.4-W1 — does the existing session architecture actually work N-way?
 *
 * The architecture pass found that session state, routing, language grouping
 * and revision rejection were already written for N participants — and that
 * every test exercised exactly two. "Written for N" and "proven at N" are
 * different claims, and the whole point of this wave is to convert one into the
 * other BEFORE the media topology is touched in W2.
 *
 * Deliberately boring. A wave that finds nothing here is a wave that has earned
 * the right to change WebRTC next.
 */
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  type CallCaptionSourceEvent,
  type CallGeneratedAudioSourceEvent,
  type CallJoinInput,
  type CallJoinResult,
  type CallLanguage,
} from './call-session-store.js';

const CALL = 'conf-1';

function joinInput(overrides: Partial<CallJoinInput> = {}): CallJoinInput {
  return {
    callId: CALL,
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
  if (!result.ok) throw new Error(`join failed: ${result.code} — ${result.message}`);
  return result;
}

interface Seat {
  name: string;
  speak: CallLanguage;
  hear: CallLanguage;
}

/** Join a whole conference in one call, returning participantId by display name. */
function conference(store: CallSessionStore, seats: Seat[]): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const seat of seats) {
    ids[seat.name] = mustJoin(store, {
      displayName: seat.name,
      speakLanguage: seat.speak,
      hearLanguage: seat.hear,
    }).participantId;
  }
  return ids;
}

/** The four-seat conference used throughout: one speaker, three listeners, three languages. */
const QUARTET: Seat[] = [
  { name: 'Ana', speak: 'en', hear: 'en' },
  { name: 'Bruno', speak: 'fr', hear: 'fr' },
  { name: 'Chloe', speak: 'fr', hear: 'fr' },
  { name: 'Diego', speak: 'es', hear: 'es' },
];

function planFor(store: CallSessionStore, participantId: string) {
  const plan = store.ingestPlan(CALL, participantId);
  if (!plan) throw new Error(`no ingest plan for ${participantId}`);
  return plan;
}

function captionFrom(
  store: CallSessionStore,
  speakerId: string,
  overrides: Partial<CallCaptionSourceEvent> = {},
): CallCaptionSourceEvent {
  const plan = planFor(store, speakerId);
  return {
    sourceLanguage: plan.sourceLanguage,
    targetLanguage: plan.targetLanguages[0] ?? null,
    originalText: 'hello everyone',
    translatedText: 'bonjour tout le monde',
    sequence: 0,
    mediaRevision: plan.mediaRevision,
    languageRevision: plan.languageRevision,
    startMs: 0,
    endMs: 1_000,
    isFinal: true,
    ...overrides,
  } as CallCaptionSourceEvent;
}

function audioFrom(
  store: CallSessionStore,
  speakerId: string,
  overrides: Partial<CallGeneratedAudioSourceEvent> = {},
): CallGeneratedAudioSourceEvent {
  const plan = planFor(store, speakerId);
  return {
    targetLanguage: plan.targetLanguages[0] ?? 'fr',
    voiceId: 'standard',
    audioUrl: 'http://host/clip.wav',
    sequence: 0,
    startMs: 0,
    durationMs: 900,
    mediaRevision: plan.mediaRevision,
    languageRevision: plan.languageRevision,
    ...overrides,
  } as CallGeneratedAudioSourceEvent;
}

describe('conference capacity', () => {
  it('seats four and refuses the fifth', () => {
    const store = new CallSessionStore();
    conference(store, QUARTET);

    const fifth = store.createOrJoin(joinInput({ displayName: 'Eve' }));

    expect(fifth).toMatchObject({ ok: false, code: 'call-full' });
  });

  it('refuses with capacity-neutral wording', () => {
    // The old copy said "already has two participants", which became false the
    // moment the cap moved. Copy that names a configured number is copy with an
    // expiry date.
    const store = new CallSessionStore();
    conference(store, QUARTET);

    const fifth = store.createOrJoin(joinInput({ displayName: 'Eve' }));

    if (fifth.ok) throw new Error('expected the fifth join to be refused');
    expect(fifth.message).not.toMatch(/\btwo\b|\b2\b/i);
    expect(fifth.message.toLowerCase()).toContain('full');
  });

  it('leaves the seated four untouched when a fifth is refused', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    store.createOrJoin(joinInput({ displayName: 'Eve' }));

    const snapshot = store.snapshot(CALL);
    expect(snapshot?.participants).toHaveLength(4);
    expect(snapshot?.participants.map((p) => p.participantId).sort()).toEqual(
      Object.values(ids).sort(),
    );
  });

  it('is still configurable, and never below a pair', () => {
    expect(
      new CallSessionStore({ maxParticipants: 2 }).createOrJoin.bind(null),
    ).toBeInstanceOf(Function);
    const two = new CallSessionStore({ maxParticipants: 2 });
    mustJoin(two, { displayName: 'A' });
    mustJoin(two, { displayName: 'B' });
    expect(two.createOrJoin(joinInput({ displayName: 'C' }))).toMatchObject({ code: 'call-full' });

    // A configured value below 2 would make a call impossible; the floor holds.
    const floored = new CallSessionStore({ maxParticipants: 1 });
    mustJoin(floored, { displayName: 'A' });
    expect(floored.createOrJoin(joinInput({ displayName: 'B' })).ok).toBe(true);
  });
});

describe('lifecycle state does not depend on the seat cap', () => {
  it('reports active with two people even though four may sit down', () => {
    // Raising the cap must not make ordinary calls report `waiting`. The label
    // used to read the cap, which was correct only while the cap happened to be
    // the same number as "enough people to talk to".
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Ana' });
    expect(store.snapshot(CALL)?.lifecycleState).toBe('waiting');

    mustJoin(store, { displayName: 'Bruno' });
    expect(store.snapshot(CALL)?.lifecycleState).toBe('active');

    mustJoin(store, { displayName: 'Chloe' });
    expect(store.snapshot(CALL)?.lifecycleState).toBe('active');
  });

  it('reports reconnecting while any seat is disconnected, at any size', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    store.markDisconnected(CALL, ids['Chloe']!);

    expect(store.snapshot(CALL)?.lifecycleState).toBe('reconnecting');
  });
});

describe('membership at N > 2', () => {
  it('assigns distinct ids and never reuses a departed one', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    expect(new Set(Object.values(ids)).size).toBe(4);

    store.leave(CALL, ids['Diego']!);
    const replacement = mustJoin(store, { displayName: 'Elena', speakLanguage: 'es', hearLanguage: 'es' });

    expect(replacement.participantId).not.toBe(ids['Diego']);
    expect(store.snapshot(CALL)?.participants).toHaveLength(4);
  });

  it('goes from four to three on leave, without disturbing the rest', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    store.leave(CALL, ids['Chloe']!);
    const remaining = store.snapshot(CALL)?.participants ?? [];

    expect(remaining).toHaveLength(3);
    expect(remaining.map((p) => p.displayName).sort()).toEqual(['Ana', 'Bruno', 'Diego']);
  });

  it('resumes a disconnected seat without duplicating it', () => {
    // The failure this guards: a resume that creates a second seat quietly
    // consumes conference capacity and splits one person's revisions in two.
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Ana', speakLanguage: 'en', hearLanguage: 'en' });
    const bruno = mustJoin(store, { displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' });
    mustJoin(store, { displayName: 'Chloe', speakLanguage: 'fr', hearLanguage: 'fr' });
    mustJoin(store, { displayName: 'Diego', speakLanguage: 'es', hearLanguage: 'es' });
    store.markDisconnected(CALL, bruno.participantId);

    const resumed = store.createOrJoin(
      joinInput({
        displayName: 'Bruno',
        speakLanguage: 'fr',
        hearLanguage: 'fr',
        resumeParticipantId: bruno.participantId,
        resumeToken: bruno.resumeToken,
      }),
    );

    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.participantId).toBe(bruno.participantId);
    expect(store.snapshot(CALL)?.participants).toHaveLength(4);
    expect(
      store.snapshot(CALL)?.participants.filter((p) => p.displayName === 'Bruno'),
    ).toHaveLength(1);
  });

  it('keeps a disconnected seat reserved rather than freeing it for a stranger', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    store.markDisconnected(CALL, ids['Diego']!);

    // The seat is held for resume, so the call is still full.
    expect(store.createOrJoin(joinInput({ displayName: 'Eve' }))).toMatchObject({
      code: 'call-full',
    });
  });

  it('preserves join order in the snapshot', () => {
    const store = new CallSessionStore();
    conference(store, QUARTET);

    expect(store.snapshot(CALL)?.participants.map((p) => p.displayName)).toEqual([
      'Ana',
      'Bruno',
      'Chloe',
      'Diego',
    ]);
  });
});

describe('caption routing at N=3 and N=4', () => {
  it('delivers a speaker caption to every other participant and never back', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const deliveries = store.routeCaption(CALL, ids['Ana']!, captionFrom(store, ids['Ana']!));
    const recipients = deliveries.map((d) => d.recipientParticipantId);

    expect(recipients).not.toContain(ids['Ana']);
    // Ana speaks English; Bruno and Chloe hear French, so both get the French
    // caption. Diego hears Spanish, which this event does not carry.
    expect(recipients).toEqual(expect.arrayContaining([ids['Bruno']!, ids['Chloe']!]));
  });

  it('routes each speaker independently', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const fromBruno = store
      .routeCaption(CALL, ids['Bruno']!, captionFrom(store, ids['Bruno']!))
      .map((d) => d.recipientParticipantId);

    expect(fromBruno).not.toContain(ids['Bruno']);
    expect(fromBruno.length).toBeGreaterThan(0);
  });

  it('works the same at three seats', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET.slice(0, 3));

    const recipients = store
      .routeCaption(CALL, ids['Ana']!, captionFrom(store, ids['Ana']!))
      .map((d) => d.recipientParticipantId);

    expect(recipients).not.toContain(ids['Ana']);
    expect(new Set(recipients).size).toBe(recipients.length);
  });

  it('never crosses a call boundary', () => {
    // Two conferences running at once must not see each other's captions, which
    // at N=2 could pass by accident and at N=4 is a real isolation claim.
    const store = new CallSessionStore();
    const here = conference(store, QUARTET);
    const thereAna = store.createOrJoin(joinInput({ callId: 'conf-2', displayName: 'Ana' }));
    if (!thereAna.ok) throw new Error('second call join failed');

    const deliveries = store.routeCaption(CALL, here['Ana']!, captionFrom(store, here['Ana']!));

    expect(deliveries.map((d) => d.recipientParticipantId)).not.toContain(thereAna.participantId);
  });

  it('routes an interim caption to the same recipients as a final one', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const interim = store
      .routeCaption(CALL, ids['Ana']!, captionFrom(store, ids['Ana']!, { isFinal: false }))
      .map((d) => d.recipientParticipantId)
      .sort();
    const final = store
      .routeCaption(CALL, ids['Ana']!, captionFrom(store, ids['Ana']!, { isFinal: true }))
      .map((d) => d.recipientParticipantId)
      .sort();

    expect(interim).toEqual(final);
  });
});

describe('generated-audio routing at N=3 and N=4', () => {
  it('reaches every eligible listener and never the speaker', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const deliveries = store.routeGeneratedAudio(
      CALL,
      ids['Ana']!,
      audioFrom(store, ids['Ana']!, { targetLanguage: 'fr' }),
    );
    const recipients = deliveries.map((d) => d.recipientParticipantId);

    expect(recipients).not.toContain(ids['Ana']);
    // Both French listeners, from ONE synthesis.
    expect(recipients.sort()).toEqual([ids['Bruno']!, ids['Chloe']!].sort());
    // And not the Spanish listener, who is not expecting French.
    expect(recipients).not.toContain(ids['Diego']);
  });

  it('delivers the Spanish clip to exactly the Spanish listener', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const recipients = store
      .routeGeneratedAudio(CALL, ids['Ana']!, audioFrom(store, ids['Ana']!, { targetLanguage: 'es' }))
      .map((d) => d.recipientParticipantId);

    expect(recipients).toEqual([ids['Diego']]);
  });

  it('preserves speaker attribution in the payload', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    const [delivery] = store.routeGeneratedAudio(
      CALL,
      ids['Ana']!,
      audioFrom(store, ids['Ana']!, { targetLanguage: 'fr' }),
    );

    expect(delivery?.payload).toMatchObject({ speakerParticipantId: ids['Ana'] });
  });

  it('never crosses a call boundary', () => {
    const store = new CallSessionStore();
    const here = conference(store, QUARTET);
    const there = store.createOrJoin(
      joinInput({ callId: 'conf-2', displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' }),
    );
    if (!there.ok) throw new Error('second call join failed');

    const recipients = store
      .routeGeneratedAudio(CALL, here['Ana']!, audioFrom(store, here['Ana']!, { targetLanguage: 'fr' }))
      .map((d) => d.recipientParticipantId);

    expect(recipients).not.toContain(there.participantId);
  });
});

describe('language work planning stays deduplicated', () => {
  it('asks for fr and es ONCE for two French listeners and one Spanish', () => {
    // The claim the architecture pass made and this wave has to prove: two
    // listeners sharing a language cost one translation, not two.
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    expect(planFor(store, ids['Ana']!).targetLanguages.sort()).toEqual(['es', 'fr']);
  });

  it('asks for one language when every listener shares it', () => {
    const store = new CallSessionStore();
    const ids = conference(store, [
      { name: 'Ana', speak: 'en', hear: 'en' },
      { name: 'Bruno', speak: 'fr', hear: 'fr' },
      { name: 'Chloe', speak: 'fr', hear: 'fr' },
    ]);

    expect(planFor(store, ids['Ana']!).targetLanguages).toEqual(['fr']);
  });

  it('asks for nothing when everyone already shares the speaker language', () => {
    const store = new CallSessionStore();
    const ids = conference(store, [
      { name: 'Ana', speak: 'en', hear: 'en' },
      { name: 'Bruno', speak: 'en', hear: 'en' },
      { name: 'Chloe', speak: 'en', hear: 'en' },
    ]);

    expect(planFor(store, ids['Ana']!).targetLanguages).toEqual([]);
  });

  it('asks for three languages when three listeners differ', () => {
    const store = new CallSessionStore();
    const ids = conference(store, [
      { name: 'Ana', speak: 'en', hear: 'en' },
      { name: 'Bruno', speak: 'fr', hear: 'fr' },
      { name: 'Diego', speak: 'es', hear: 'es' },
      { name: 'Emil', speak: 'en', hear: 'en' },
    ]);

    // Emil hears English, the speaker's own language: no target for him.
    expect(planFor(store, ids['Ana']!).targetLanguages.sort()).toEqual(['es', 'fr']);
  });

  it('drops target work when the listener needing it leaves', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    expect(planFor(store, ids['Ana']!).targetLanguages.sort()).toEqual(['es', 'fr']);

    store.leave(CALL, ids['Diego']!);

    // Spanish is nobody's language now; synthesising it would be work for an
    // empty room.
    expect(planFor(store, ids['Ana']!).targetLanguages).toEqual(['fr']);
  });

  it('keeps a language while ONE of its listeners remains', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    store.leave(CALL, ids['Chloe']!);

    expect(planFor(store, ids['Ana']!).targetLanguages.sort()).toEqual(['es', 'fr']);
  });

  it('gives every speaker their own plan', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);

    // Bruno speaks French; English and Spanish listeners need him translated.
    expect(planFor(store, ids['Bruno']!).targetLanguages.sort()).toEqual(['en', 'es']);
    expect(planFor(store, ids['Diego']!).targetLanguages.sort()).toEqual(['en', 'fr']);
  });

  it('scopes ingest identity per participant and revision', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    const plans = Object.values(ids).map((id) => planFor(store, id).ingestSessionId);

    expect(new Set(plans).size).toBe(4);
    for (const id of Object.values(ids)) {
      expect(planFor(store, id).ingestSessionId).toMatch(
        new RegExp(`^call_${CALL}_${id}_r\\d+$`),
      );
    }
  });
});

describe('revision safety at conference size', () => {
  it('bumps every connected participant when somebody joins', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET.slice(0, 3));
    const before = Object.values(ids).map((id) => planFor(store, id).mediaRevision);

    mustJoin(store, { displayName: 'Diego', speakLanguage: 'es', hearLanguage: 'es' });
    const after = Object.values(ids).map((id) => planFor(store, id).mediaRevision);

    for (const [index, revision] of after.entries()) {
      expect(revision).toBeGreaterThan(before[index]!);
    }
  });

  it('rejects a caption planned against a superseded media revision', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET.slice(0, 3));
    const stale = captionFrom(store, ids['Ana']!);

    mustJoin(store, { displayName: 'Diego', speakLanguage: 'es', hearLanguage: 'es' });

    expect(store.routeCaption(CALL, ids['Ana']!, stale)).toEqual([]);
  });

  it('rejects generated audio planned against a superseded revision', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET.slice(0, 3));
    const stale = audioFrom(store, ids['Ana']!, { targetLanguage: 'fr' });

    mustJoin(store, { displayName: 'Diego', speakLanguage: 'es', hearLanguage: 'es' });

    expect(store.routeGeneratedAudio(CALL, ids['Ana']!, stale)).toEqual([]);
  });

  it('rejects output planned before a listener changed their language', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    const stale = captionFrom(store, ids['Ana']!);

    store.setCaptionLanguage(CALL, ids['Diego']!, 'fr');

    expect(store.routeCaption(CALL, ids['Ana']!, stale)).toEqual([]);
  });

  /**
   * The W1 FINDING that leave was asymmetric with join — the departed
   * listener's language stayed in the speakers' LIVE ingest sessions — got
   * its decision in W5: leave (and the grace-expiry reap, which arrives as a
   * leave) reconciles membership. Speakers whose target set changed are
   * bumped and their sessions replaced, an EXPLICIT cutoff of in-flight
   * output; speakers whose target set did not change are left untouched, so
   * nobody loses a sentence over a departure that never concerned them.
   */
  it('cuts off in-flight output from speakers whose target set changed (W5 cutoff)', () => {
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    const inFlight = captionFrom(store, ids['Ana']!);

    const result = store.leave(CALL, ids['Diego']!);

    // Diego was the only Spanish listener: Ana's session is replaced, so a
    // caption planned before the leave is stale and delivers to nobody.
    expect(store.routeCaption(CALL, ids['Ana']!, inFlight)).toEqual([]);
    expect(planFor(store, ids['Ana']!).mediaRevision).toBe(inFlight.mediaRevision + 1);
    // The replacement plan has already dropped Spanish.
    expect(planFor(store, ids['Ana']!).targetLanguages).toEqual(['fr']);
    // Every remaining speaker had Diego's language in their targets, so every
    // remaining speaker's session is replaced by the returned plans.
    expect(result.ingestPlans.map((plan) => plan.ingestSessionId).sort()).toEqual([
      'call_conf-1_participant_1_r5',
      'call_conf-1_participant_2_r4',
      'call_conf-1_participant_3_r3',
    ]);
  });

  it('accepts output planned against the CURRENT revision after all that churn', () => {
    // Rejection is only useful if acceptance still works. A guard that refuses
    // everything would pass every test above and deliver nothing.
    const store = new CallSessionStore();
    const ids = conference(store, QUARTET);
    store.setCaptionLanguage(CALL, ids['Diego']!, 'fr');
    store.leave(CALL, ids['Chloe']!);

    const fresh = captionFrom(store, ids['Ana']!);

    expect(store.routeCaption(CALL, ids['Ana']!, fresh).length).toBeGreaterThan(0);
  });
});
