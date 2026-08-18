/**
 * P6.4 integrated acceptance — the deterministic four-person conference the
 * completion wave is gated on (locked 2026-08-18).
 *
 *   A speaks English.
 *   B: hears French,  Audio Mode Translated  → needs fr generated audio.
 *   C: hears Spanish, Audio Mode Translated  → needs es generated audio.
 *   D: reads French captions, Audio Mode Original → original audio, fr TEXT.
 *
 * The locked invariants under test, end to end at the planning layer:
 *   caption target ≠ audio target;
 *   multiple audio target languages → multiple legitimate generated outputs;
 *   membership changes reconcile ONLY affected speakers;
 *   Normal Call Mode → no targets, no engine work at all.
 *
 * (The media-ingest half — every audio-flagged language actually synthesized,
 * order-independent — is pinned in services/media-ingest
 * src/__tests__/text-only-targets.test.ts, "multi-audio-target synthesis".)
 */
import { describe, expect, it } from 'vitest';
import {
  CallSessionStore,
  type CallIngestPlan,
  type CallJoinInput,
  type CallJoinResult,
} from './call-session-store';

const CALL = 'matrix-1';

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

/** The four seats, joined in order; A is the creator and therefore the owner. */
function matrixConference(store: CallSessionStore): Record<'a' | 'b' | 'c' | 'd', string> {
  const a = mustJoin(store, { displayName: 'A', speakLanguage: 'en', hearLanguage: 'en' });
  const b = mustJoin(store, {
    displayName: 'B',
    speakLanguage: 'fr',
    hearLanguage: 'fr',
    audioMode: 'translated',
  });
  const c = mustJoin(store, {
    displayName: 'C',
    speakLanguage: 'es',
    hearLanguage: 'es',
    audioMode: 'translated',
  });
  const d = mustJoin(store, {
    displayName: 'D',
    speakLanguage: 'en',
    hearLanguage: 'fr',
    captionsEnabled: true,
    audioMode: 'original',
  });
  return { a: a.participantId, b: b.participantId, c: c.participantId, d: d.participantId };
}

function planFor(store: CallSessionStore, participantId: string): CallIngestPlan {
  const plan = store.ingestPlan(CALL, participantId);
  if (!plan) throw new Error(`no ingest plan for ${participantId}`);
  return plan;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('four-person deterministic conference matrix', () => {
  it("A's one plan carries BOTH audio languages, D's caption need adds no synthesis", () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    const plan = planFor(store, seats.a);

    // fr (B audio + D captions) and es (C audio): both translated once each.
    expect(sorted(plan.targetLanguages)).toEqual(['es', 'fr']);
    // BOTH are audio targets — B and C each get generated speech. D's caption
    // requirement created no third audio demand and no text-only demotion,
    // because B independently needs fr audio.
    expect(plan.textOnlyLanguages).toEqual([]);
    expect(sorted(Object.keys(plan.voiceIdsByLanguage))).toEqual(['es', 'fr']);
    // A has no same-language caption reader (D reads fr).
    expect(plan.sameLanguageCaptionsNeeded).toBe(false);
  });

  it('B leaves → fr collapses to caption-only for D; only CHANGED speakers are re-planned', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);
    const beforeC = planFor(store, seats.c);

    const left = store.leave(CALL, seats.b);
    expect(left.ok).toBe(true);

    // A's fresh plan: fr survives as a TRANSLATION target for D's captions,
    // demoted to text-only (nobody needs fr audio now); es keeps its voice.
    const afterA = left.ingestPlans.find((plan) => plan.ingestSessionId.includes(seats.a));
    expect(afterA).toBeDefined();
    expect(sorted(afterA!.targetLanguages)).toEqual(['es', 'fr']);
    expect(afterA!.textOnlyLanguages).toEqual(['fr']);
    expect(sorted(Object.keys(afterA!.voiceIdsByLanguage))).toEqual(['es']);

    // Reconciliation is selective: every returned plan belongs to a speaker
    // whose target set actually changed, and each carries a bumped revision
    // (an explicit cutoff), while the store never re-plans the leaver.
    expect(left.ingestPlans.some((plan) => plan.ingestSessionId.includes(seats.b))).toBe(false);
    for (const plan of left.ingestPlans) {
      expect(plan.mediaRevision).toBeGreaterThan(1);
    }
    // C's plan keeps fr — D still reads French captions — but demoted to
    // text-only: B's audio requirement left with B, D's caption need stayed.
    const afterC = planFor(store, seats.c);
    expect(sorted(afterC.targetLanguages)).toEqual(sorted(beforeC.targetLanguages));
    expect(afterC.textOnlyLanguages).toEqual(['fr']);
  });

  it('C switches Translated → Original MID-CALL: es captions continue, es synthesis stops — no rejoin', () => {
    // The real transition, through the store method the `call:audio-mode:set`
    // event drives. This is the contradiction the final review closed: the
    // planner must react to the live change, not to the next resume.
    const store = new CallSessionStore();
    const seats = matrixConference(store);
    const beforeA = planFor(store, seats.a);

    const result = store.setAudioMode(CALL, seats.c, 'original');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);

    // A's session is REPLACED (bumped id) with es demoted to caption-only.
    const afterA = result.ingestPlans.find((plan) => plan.ingestSessionId.includes(seats.a));
    expect(afterA).toBeDefined();
    expect(afterA!.ingestSessionId).not.toBe(beforeA.ingestSessionId);
    expect(sorted(afterA!.targetLanguages)).toEqual(['es', 'fr']);
    expect(afterA!.textOnlyLanguages).toEqual(['es']);
    expect(sorted(Object.keys(afterA!.voiceIdsByLanguage))).toEqual(['fr']);
  });

  it('the full Audio Mode cycle: Original stops synthesis, Interpretation restores it, Translated adds no redundant work', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    store.setAudioMode(CALL, seats.c, 'original');
    expect(planFor(store, seats.a).textOnlyLanguages).toEqual(['es']);

    const restore = store.setAudioMode(CALL, seats.c, 'interpretation');
    expect(restore.ok && restore.changed).toBe(true);
    if (!restore.ok) return;
    const restoredA = restore.ingestPlans.find((plan) => plan.ingestSessionId.includes(seats.a));
    expect(restoredA).toBeDefined();
    expect(restoredA!.textOnlyLanguages).toEqual([]);
    expect(sorted(Object.keys(restoredA!.voiceIdsByLanguage))).toEqual(['es', 'fr']);

    // interpretation → translated: both want generated audio, so no work
    // order changes and NOTHING is replaced.
    const same = store.setAudioMode(CALL, seats.c, 'translated');
    expect(same.ok && same.changed).toBe(true);
    if (!same.ok) return;
    expect(same.ingestPlans).toEqual([]);

    // Repeating the same value is a pure no-op.
    const repeat = store.setAudioMode(CALL, seats.c, 'translated');
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    expect(repeat.changed).toBe(false);
    expect(repeat.ingestPlans).toEqual([]);
  });

  it('setAudioMode refuses unknown participants and invalid modes', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    expect(store.setAudioMode(CALL, 'participant_9', 'original')).toMatchObject({
      ok: false,
      reason: 'unknown-participant',
    });
    expect(
      store.setAudioMode(CALL, seats.c, 'loud' as unknown as 'original'),
    ).toMatchObject({ ok: false, reason: 'invalid-audio-mode' });
    // A departed seat cannot be mutated either (leave-during-change safety).
    store.leave(CALL, seats.c);
    expect(store.setAudioMode(CALL, seats.c, 'original')).toMatchObject({
      ok: false,
      reason: 'unknown-participant',
    });
  });

  it('B returns → fr generated delivery resumes', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);
    store.leave(CALL, seats.b);
    expect(planFor(store, seats.a).textOnlyLanguages).toEqual(['fr']);

    mustJoin(store, {
      displayName: 'B2',
      speakLanguage: 'fr',
      hearLanguage: 'fr',
      audioMode: 'translated',
    });

    const plan = planFor(store, seats.a);
    expect(plan.textOnlyLanguages).toEqual([]);
    expect(sorted(Object.keys(plan.voiceIdsByLanguage))).toEqual(['es', 'fr']);
  });

  it('Normal Call Mode → STT-only captions, zero translation/TTS; Translated restores the full matrix', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    const toNormal = store.setCallMode(CALL, seats.a, 'normal');
    expect(toNormal.ok).toBe(true);
    if (!toNormal.ok) return;
    // Sessions are REPLACED with STT-only work orders: the transcript
    // survives Normal, translation and synthesis do not (18 Aug feedback:
    // captions must not be translation-gated).
    expect(toNormal.ingestPlans.length).toBeGreaterThan(0);
    for (const plan of toNormal.ingestPlans) {
      expect(plan.targetLanguages).toEqual([]);
      expect(plan.voiceIdsByLanguage).toEqual({});
    }
    expect(store.ingestPlan(CALL, seats.a)!.sameLanguageCaptionsNeeded).toBe(true);
    const live = store.ingestPlan(CALL, seats.a)!;

    // Late engine output is refused at routing, not just by revision.
    const straggler = store.routeCaption(CALL, seats.a, {
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      originalText: 'hello',
      translatedText: 'bonjour',
      sequence: 1,
      mediaRevision: live.mediaRevision,
      languageRevision: live.languageRevision,
      startMs: 0,
      endMs: 1000,
      isFinal: true,
    });
    expect(straggler).toEqual([]);
    // The ORIGINAL transcript flows to the whole room.
    const originals = store.routeCaption(CALL, seats.a, {
      sourceLanguage: 'en',
      targetLanguage: null,
      originalText: 'hello everyone',
      translatedText: null,
      sequence: 2,
      mediaRevision: live.mediaRevision,
      languageRevision: live.languageRevision,
      startMs: 0,
      endMs: 1000,
      isFinal: true,
    });
    expect(originals).toHaveLength(4);
    for (const delivery of originals) {
      expect((delivery.payload as { translatedText: string | null }).translatedText).toBeNull();
    }

    const back = store.setCallMode(CALL, seats.a, 'translated');
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const restored = back.ingestPlans.find((plan) => plan.ingestSessionId.includes(seats.a));
    expect(restored).toBeDefined();
    expect(sorted(restored!.targetLanguages)).toEqual(['es', 'fr']);
    expect(sorted(Object.keys(restored!.voiceIdsByLanguage))).toEqual(['es', 'fr']);
  });

  it('only the owner can flip the mode, and a non-owner attempt changes nothing', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    const refused = store.setCallMode(CALL, seats.b, 'normal');
    expect(refused).toMatchObject({ ok: false, reason: 'not-owner' });
    expect(store.snapshot(CALL)?.callMode).toBe('translated');
    expect(planFor(store, seats.a)).toBeDefined();
  });
});

describe('mid-call caption-language change replaces exactly the affected sessions', () => {
  it("B switches captions fr → es: A's session is replaced with the new target set", () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);
    const beforeA = planFor(store, seats.a);

    const result = store.setCaptionLanguage(CALL, seats.b, 'es');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const afterA = result.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(seats.a),
    );
    expect(afterA).toBeDefined();
    // The id moved — the gateway can actually retire and recreate.
    expect(afterA!.ingestSessionId).not.toBe(beforeA.ingestSessionId);
    expect(afterA!.mediaRevision).toBeGreaterThan(beforeA.mediaRevision);
    // fr is still needed (D reads fr); es gained B as an AUDIO listener.
    expect(sorted(afterA!.targetLanguages)).toEqual(['es', 'fr']);
    expect(sorted(Object.keys(afterA!.voiceIdsByLanguage))).toContain('es');
  });

  it('a speaker whose work order did not change keeps their session id', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);
    // D's own SPEAKER plan targets B(fr audio), C(es audio) — unaffected by
    // D changing what D reads.
    const beforeD = planFor(store, seats.d);

    const result = store.setCaptionLanguage(CALL, seats.d, 'en');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const afterD = result.ingestPlans.find((plan) =>
      plan.ingestSessionId.includes(seats.d),
    );
    expect(afterD).toBeDefined();
    expect(afterD!.ingestSessionId).toBe(beforeD.ingestSessionId);
    // Unchanged speakers still travel in the list so the gateway can refresh
    // their languageRevision stamp in place.
    expect(afterD!.languageRevision).toBeGreaterThan(beforeD.languageRevision);
  });
});

describe('transcript-download policy (owner-only, default on)', () => {
  it('defaults ON, only the owner can switch it, and the snapshot carries it', () => {
    const store = new CallSessionStore();
    const seats = matrixConference(store);

    expect(store.snapshot(CALL)?.transcriptDownloadAllowed).toBe(true);

    expect(store.setTranscriptDownloadAllowed(CALL, seats.b, false)).toMatchObject({
      ok: false,
      reason: 'not-owner',
    });
    expect(store.snapshot(CALL)?.transcriptDownloadAllowed).toBe(true);

    const off = store.setTranscriptDownloadAllowed(CALL, seats.a, false);
    expect(off).toMatchObject({ ok: true, changed: true });
    expect(store.snapshot(CALL)?.transcriptDownloadAllowed).toBe(false);

    // Idempotent repeat: no change signalled.
    expect(store.setTranscriptDownloadAllowed(CALL, seats.a, false)).toMatchObject({
      ok: true,
      changed: false,
    });
  });
});
