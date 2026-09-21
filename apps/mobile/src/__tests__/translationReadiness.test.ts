/** @author masterzee001 */
/**
 * "CONNECTING TRANSLATION SERVICE…" HAS TO BE TRUE.
 *
 * The line the founder's board puts under the outgoing ring is the single
 * easiest place in this app to reproduce the night it spent saying "Hearing
 * translated voice" over silence: a three-second timer, a hopeful sentence,
 * and nothing behind either.
 *
 * AND A CAPTION IS NOT PROOF OF AUDIO. The previous version of this file pinned
 * the defect it was written to prevent: it asserted that `proof: 'caption'`
 * produced the 'ready' kind, and `proof` was tested before refusals and never
 * expired. So the first translated caption of any working call silenced the
 * refusal warning for good and certified the ended screen as "· translated" --
 * on a call where every translated frame was turned away and the person heard
 * nothing but original voices. That is the 19 Sep production failure exactly,
 * and it is the case this file now leads with.
 *
 * These pin the signals the phone genuinely holds -- the server-owned call
 * mode, the gateway's own `translation-engine-unavailable`, this handset's
 * translated-audio diagnostic, the two SEPARATE facts (a frame PLAYED, a
 * translated caption ARRIVED) and the REFUSALS -- the ORDER they overrule each
 * other in, and the fact that every present-tense sentence expires.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCaptionEvidence,
  applyTranslatedAudioDiagnostic,
  COVERAGE_BRIDGE_MS,
  endedTranslationOutcome,
  MOSTLY_OF_THE_CALL,
  NO_TRANSLATION_SIGNALS,
  PRESENT_MS,
  translationReadiness,
  type TranslationSignals,
} from '../call/translationReadiness';

/** A call that started at t=0 on the phone's clock. */
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
/** The call the reviewers' probes all use: four minutes fifty-one. */
const LONG_CALL_MS = 291_000;

const signals = (over: Partial<TranslationSignals>): TranslationSignals => ({
  mode: 'translated',
  engine: null,
  playback: null,
  playedAtMs: null,
  refusedAtMs: null,
  captionedAtMs: null,
  playedCoveredMs: 0,
  refusedCoveredMs: 0,
  ...over,
});

/** The verdict alone, where the share is not what is being asserted. */
const verdictOf = (state: TranslationSignals, elapsedMs: number | null = LONG_CALL_MS): string =>
  endedTranslationOutcome(state, elapsedMs).verdict;

/**
 * A call in which translated audio really was playing throughout: the sink
 * heartbeats once a second while the peer talks, and the coverage bridges the
 * user's own turns. Built by driving the real fold rather than by asserting a
 * figure into the state, so the two halves are two witnesses.
 */
function playedThroughout(callMs: number): TranslationSignals {
  let state: TranslationSignals = signals({ playback: 'listening' });
  for (let at = 0; at < callMs; at += 1_000) {
    state = {
      ...state,
      ...applyTranslatedAudioDiagnostic(state, { kind: 'played', playedMs: at }, T0 + at),
    };
  }
  return state;
}

describe('a caption is not proof that anybody heard anything', () => {
  it('lets refusals contradict a caption -- the defect this round exists to close', () => {
    /*
     * The probe three reviewers ran independently: a translated call whose
     * captions arrive normally and whose audio frames are all turned away. The
     * caption used to win, silently, for the rest of the call.
     */
    const state = signals({
      playback: 'listening',
      captionedAtMs: NOW - 500,
      refusedAtMs: NOW - 500,
    });
    const readiness = translationReadiness(state, NOW);
    expect(readiness.kind).toBe('refusing');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/not playing it/iu);
    // And the call does not end certified as translated.
    expect(verdictOf({ ...state, refusedCoveredMs: 60_000 })).toBe('not-translated');
  });

  it('will not let ONE frame from second three speak for the whole call', () => {
    /*
     * One accepted 20 ms frame, then every later frame refused. The sentence
     * "Playing translated speech" is present tense and the state it described
     * is three seconds old and over.
     */
    const state = signals({
      playback: 'listening',
      playedAtMs: T0 + 3_000,
      refusedAtMs: T0 + 50_000,
    });
    const readiness = translationReadiness(state, T0 + 50_500);
    expect(readiness.kind).toBe('refusing');
    expect(readiness.warn).toBe(true);
    // It did play once, so the call is not "not translated" -- it stopped. And
    // "once" is all it did: four seconds of a 291-second call.
    const outcome = endedTranslationOutcome(
      { ...state, playedCoveredMs: PRESENT_MS, refusedCoveredMs: 40_000 },
      LONG_CALL_MS,
    );
    expect(outcome.verdict).toBe('interrupted');
    expect(outcome.playedShare).toBeLessThan(0.02);
  });

  it('says only what a caption proves: the engine ran, not that it was heard', () => {
    const state = signals({ playback: 'listening', captionedAtMs: NOW - 200 });
    const readiness = translationReadiness(state, NOW);
    expect(readiness.kind).toBe('captioning');
    expect(readiness.words).toBe('Translated text is arriving');
    expect(readiness.words).not.toMatch(/playing|hearing/iu);
    expect(readiness.warn).toBe(false);
    // Weaker than heard, and the ended screen says so in its own words.
    expect(verdictOf(state)).toBe('text-only');
  });

  it('stops claiming to be playing once nothing has played for a while', () => {
    const state = signals({ playback: 'listening', playedAtMs: T0 });
    expect(translationReadiness(state, T0 + PRESENT_MS).kind).toBe('ready');
    const later = translationReadiness(state, T0 + PRESENT_MS + 1);
    // Nothing is arriving and nothing was refused: the honest state is the one
    // it started in -- subscribed, waiting -- not a fault and not a claim.
    expect(later.kind).toBe('waiting');
    expect(later.words).toBe('Listening for translated speech');
    // What the WHOLE call ended as is a different question, and it is answered
    // by how much of the call this covered -- see the ended-verdict block.
  });
});

describe('a call the server did not call translated says nothing', () => {
  it('shows no line on a normal call, whatever the phone is doing', () => {
    expect(
      translationReadiness(signals({ mode: 'normal', playback: 'listening' }), NOW).words,
    ).toBeNull();
    expect(
      translationReadiness(signals({ mode: 'normal', engine: false, playback: 'unavailable' }), NOW)
        .words,
    ).toBeNull();
    expect(translationReadiness(signals({ mode: 'normal' }), NOW).kind).toBe('off');
    // Not even a translation that played: a normal call has no translation line.
    expect(
      translationReadiness(signals({ mode: 'normal', playedAtMs: NOW }), NOW).words,
    ).toBeNull();
  });

  it('shows no line before the telephone has stated a mode', () => {
    // Guessing 'pending' here would put a translation sentence on every call in
    // the product for as long as the first `call:direct:state` takes to arrive.
    const readiness = translationReadiness(signals({ mode: null }), NOW);
    expect(readiness.kind).toBe('off');
    expect(readiness.words).toBeNull();
  });
});

describe('a translated call says what has actually been measured', () => {
  it('is connecting while nothing has reported yet', () => {
    const readiness = translationReadiness(signals({}), NOW);
    expect(readiness.kind).toBe('pending');
    expect(readiness.words).toBe('Connecting translation service…');
    expect(readiness.warn).toBe(false);
  });

  it('is WAITING, not ready, once this phone has merely subscribed', () => {
    /*
     * `listening` is emitted the instant `attach()` returns. It means a socket
     * handler is bound -- not that translated speech is arriving -- and it used
     * to be reported as the 'ready' kind, which read to everything downstream
     * (including the ended screen) as a working translation.
     */
    const readiness = translationReadiness(signals({ playback: 'listening' }), NOW);
    expect(readiness.kind).toBe('waiting');
    expect(readiness.words).toBe('Listening for translated speech');
    expect(readiness.words).not.toMatch(/hearing|playing/iu);
    expect(readiness.warn).toBe(false);
  });

  it('claims somebody is hearing a translation only from a RECENT played frame', () => {
    const played = translationReadiness(
      signals({ playback: 'listening', playedAtMs: NOW - 100 }),
      NOW,
    );
    expect(played.kind).toBe('ready');
    expect(played.words).toBe('Playing translated speech');
  });

  it('lets REFUSED contradict listening', () => {
    /*
     * The 19 Sep post-mortem's worst state: a subscription that reports
     * `listening` and then refuses every frame it is sent is, from the screen,
     * indistinguishable from an engine that never ran. It is now distinguished.
     */
    const readiness = translationReadiness(
      signals({ playback: 'listening', refusedAtMs: NOW - 100 }),
      NOW,
    );
    expect(readiness.kind).toBe('refusing');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/not playing it/iu);
  });

  it('keeps reporting a refusal that nothing has ever answered', () => {
    // The refusals stopped a minute ago and not one frame was ever played:
    // nothing has happened since that undoes the fault.
    const readiness = translationReadiness(
      signals({ playback: 'listening', refusedAtMs: T0, captionedAtMs: NOW - 100 }),
      NOW,
    );
    expect(readiness.kind).toBe('refusing');
    expect(readiness.warn).toBe(true);
  });

  it('lets audio playing NOW outrank a refusal a moment ago', () => {
    const readiness = translationReadiness(
      signals({ playback: 'listening', refusedAtMs: NOW - 900, playedAtMs: NOW - 100 }),
      NOW,
    );
    expect(readiness.kind).toBe('ready');
  });

  it('says so when THIS PHONE cannot play translated speech', () => {
    const readiness = translationReadiness(signals({ playback: 'unavailable' }), NOW);
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/phone/iu);
  });

  it('says so when THE SERVER has no translation engine', () => {
    const readiness = translationReadiness(signals({ engine: false }), NOW);
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/server/iu);
  });

  it('lets the server outrank a phone that has merely subscribed', () => {
    /*
     * The whole point of the ordering. The handset attaches its subscription on
     * every translated call and reports `listening` whether or not anything is
     * ever going to be sent to it; the gateway's verdict is the one that knows.
     */
    const readiness = translationReadiness(
      signals({ engine: false, playback: 'listening' }),
      NOW,
    );
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.words).toMatch(/server/iu);
  });

  it('marks every sentence that means the person is MISSING the translation', () => {
    /*
     * `warn` is "is this amber" and `unheard` is "is the person missing the
     * translation", and the video branch was gated on the first while needing
     * the second: the caption-only state -- the 19 Sep failure, captions
     * arriving and no audio played -- is not amber, so a video call showed
     * nothing at all during exactly that call.
     */
    const unheardOf = (over: Partial<TranslationSignals>, atMs = NOW): boolean =>
      translationReadiness(signals(over), atMs).unheard;
    expect(unheardOf({ playback: 'listening', captionedAtMs: NOW - 200 })).toBe(true);
    expect(unheardOf({ playback: 'listening', refusedAtMs: NOW - 200 })).toBe(true);
    expect(unheardOf({ engine: false })).toBe(true);
    expect(unheardOf({ playback: 'unavailable' })).toBe(true);
    // And progress is not a fault: neither of these belongs over a video call.
    expect(unheardOf({ playback: 'listening' })).toBe(false);
    expect(unheardOf({})).toBe(false);
    expect(unheardOf({ playback: 'listening', playedAtMs: NOW - 100 })).toBe(false);
    expect(unheardOf({ mode: 'normal', playback: 'listening' })).toBe(false);
    // The caption-only state is the one that is unheard WITHOUT being a warning.
    const captioning = translationReadiness(
      signals({ playback: 'listening', captionedAtMs: NOW - 200 }),
      NOW,
    );
    expect(captioning.warn).toBe(false);
    expect(captioning.unheard).toBe(true);
  });

  it('does not downgrade a working call because the engine was never mentioned', () => {
    // `engine: null` is "the gateway said nothing", which is the NORMAL case --
    // the error is only sent by a deployment whose engine is not real.
    expect(
      translationReadiness(signals({ playback: 'listening', playedAtMs: NOW }), NOW).kind,
    ).toBe('ready');
    expect(
      translationReadiness(
        signals({ engine: true, playback: 'listening', playedAtMs: NOW }),
        NOW,
      ).kind,
    ).toBe('ready');
  });
});

describe('the diagnostics are folded into one measured picture', () => {
  it('records the subscription, and never lets it undo an unavailable verdict', () => {
    const listening = applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, { kind: 'listening' }, T0);
    expect(listening.playback).toBe('listening');
    const broke = applyTranslatedAudioDiagnostic(listening, { kind: 'unavailable', error: 'threw' }, T0);
    expect(broke.playback).toBe('unavailable');
    // A re-attach after the native track has thrown does not heal the track.
    expect(applyTranslatedAudioDiagnostic(broke, { kind: 'listening' }, T0).playback).toBe(
      'unavailable',
    );
  });

  it('stamps the refusals, which the screen used to drop on the floor', () => {
    const refused = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'refused', reason: 'language-not-mine' },
      T0,
    );
    expect(refused.refusedAtMs).toBe(T0);
    // Refusals arrive per frame -- fifty a second. An unchanged picture is the
    // same object, so a refused stream cannot re-render the screen fifty times
    // a second; a second later the stamp moves, so the measurement stays live.
    expect(
      applyTranslatedAudioDiagnostic(refused, { kind: 'refused', reason: 'no-session' }, T0 + 20),
    ).toBe(refused);
    const second = applyTranslatedAudioDiagnostic(
      refused,
      { kind: 'refused', reason: 'no-session' },
      T0 + 1_000,
    );
    expect(second.refusedAtMs).toBe(T0 + 1_000);
    // And the DURATION grows with them, which is what an ended verdict about a
    // whole call needs and what a stamp on its own could never give it.
    expect(refused.refusedCoveredMs).toBe(PRESENT_MS);
    expect(second.refusedCoveredMs).toBe(PRESENT_MS + 1_000);
  });

  it('counts the AUDIO the heartbeat carries, not the time since the last one', () => {
    /*
     * THE NUMBER HAS TO BE THE THING IT CLAIMS TO BE. This credited each
     * heartbeat with the wall-clock gap back to its predecessor, so
     * `playedCoveredMs` measured "time spent near a played frame" while the
     * screen printed it as a share of the call that was translated. Two
     * reviewers independently showed ten one-second heartbeats spread across a
     * 291-second call crediting 274 seconds, and the ended screen reporting
     * 94% of the call translated on nine seconds of sound.
     *
     * `playedMs` is the sink's own running total of translated audio the
     * platform accepted, so the honest credit is how far it MOVED.
     */
    const played = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'played', playedMs: 20 },
      T0,
    );
    expect(played.playedAtMs).toBe(T0);
    expect(played.playedCoveredMs, 'twenty milliseconds of sound is twenty').toBe(20);

    const later = applyTranslatedAudioDiagnostic(
      played,
      { kind: 'played', playedMs: 1_020 },
      T0 + 1_000,
    );
    expect(later.playedAtMs).toBe(T0 + 1_000);
    expect(later.playedCoveredMs).toBe(1_020);
    // A refusal never adds to the played duration, nor the other way round.
    expect(later.refusedCoveredMs).toBe(0);
  });

  it('credits audio from a heartbeat too soon to move the stamp', () => {
    /*
     * The stamp is throttled so a fifty-a-second diagnostic cannot re-render
     * the screen; the DURATION must not be, or a working call undercounts
     * itself and ends up described as partly translated.
     */
    const first = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'played', playedMs: 1_000 },
      T0,
    );
    const soon = applyTranslatedAudioDiagnostic(first, { kind: 'played', playedMs: 1_500 }, T0 + 40);
    expect(soon.playedAtMs, 'the stamp stays quiet').toBe(T0);
    expect(soon.playedCoveredMs, 'the audio still counts').toBe(1_500);
  });

  it('ignores a total that stood still or went backwards', () => {
    const first = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'played', playedMs: 5_000 },
      T0,
    );
    const stalled = applyTranslatedAudioDiagnostic(
      first,
      { kind: 'played', playedMs: 5_000 },
      T0 + 10_000,
    );
    expect(stalled.playedCoveredMs).toBe(5_000);
    const backwards = applyTranslatedAudioDiagnostic(
      first,
      { kind: 'played', playedMs: 10 },
      T0 + 20_000,
    );
    expect(backwards.playedCoveredMs).toBe(5_000);
  });

  it('keeps the caption evidence in a field of its OWN, never as a rank of audio', () => {
    const captioned = applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: 'Bawo ni' }, T0);
    expect(captioned.captionedAtMs).toBe(T0);
    expect(captioned.playedAtMs).toBeNull();
    // Blank is not a choice, and a same-language caption carries null.
    expect(
      applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: null }, T0).captionedAtMs,
    ).toBeNull();
    expect(
      applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: '  ' }, T0).captionedAtMs,
    ).toBeNull();
    // And a caption never touches the audio stamp, in either direction.
    const played = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'played', playedMs: 20 },
      T0,
    );
    expect(applyCaptionEvidence(played, { translatedText: 'Bawo ni' }, T0 + 10).playedAtMs).toBe(T0);
  });

  it('reads the originals policy as saying nothing about translation', () => {
    expect(
      applyTranslatedAudioDiagnostic(
        NO_TRANSLATION_SIGNALS,
        { kind: 'originals', suppressed: true },
        T0,
      ),
    ).toBe(NO_TRANSLATION_SIGNALS);
  });
});

describe('what the ENDED screen is allowed to certify', () => {
  it('will not certify a call the server said it could not translate', () => {
    // The worst defect this wave exists to fix: the screen warned "This server
    // cannot translate" for four minutes and then wrote "· translated".
    expect(verdictOf(signals({ engine: false, playback: 'listening' }))).toBe('not-translated');
  });

  it('will not certify a call this phone could not play', () => {
    expect(verdictOf(signals({ playback: 'unavailable' }))).toBe('not-translated');
  });

  it('says frames were turned away when none was ever played', () => {
    expect(
      verdictOf(
        signals({
          playback: 'listening',
          refusedAtMs: T0,
          refusedCoveredMs: 120_000,
          captionedAtMs: T0,
        }),
      ),
    ).toBe('not-translated');
  });

  it('says UNPROVEN for a translated call in which nothing was ever measured', () => {
    // Configured translated, subscribed, and not one frame or caption. The mode
    // alone is not evidence, and the ended line says nothing about translation.
    expect(verdictOf(signals({ playback: 'listening' }))).toBe('unproven');
    expect(verdictOf(signals({}))).toBe('unproven');
  });
});

describe('the ended verdict measures HOW MUCH, not WHETHER', () => {
  it('WILL NOT let one frame at second three certify a 291-second call', () => {
    /*
     * The reviewer's probe, and the reason this block exists. One played frame,
     * no refusal ever, and the screen used to end "4 min 51 s · translated"
     * with the language pair printed beside it -- four elements agreeing, none
     * of them measuring what it claimed. It is the September shape in
     * miniature: audio starts, the subscription dies, and nothing is refused
     * because nothing arrives to refuse.
     */
    const base = signals({ playback: 'listening' });
    const state: TranslationSignals = {
      ...base,
      ...applyTranslatedAudioDiagnostic(base, { kind: 'played', playedMs: 20 }, T0 + 3_000),
    };
    const outcome = endedTranslationOutcome(state, LONG_CALL_MS);
    expect(outcome.verdict).toBe('partly');
    expect(outcome.verdict).not.toBe('translated');
    // Four seconds of 291: about one per cent, and the screen prints it.
    expect(outcome.playedShare).toBeLessThan(0.02);
    expect(outcome.playedShare).toBeGreaterThan(0);
  });

  it('WILL NOT let ten seconds at the end certify four minutes fifty of refusals', () => {
    // The mirror case. A person who heard original voices for the whole call
    // except the last ten seconds was handed "translated" plus a language pair.
    const outcome = endedTranslationOutcome(
      signals({
        playback: 'listening',
        refusedAtMs: T0 + 280_000,
        refusedCoveredMs: 280_000,
        playedAtMs: T0 + 290_000,
        playedCoveredMs: 14_000,
      }),
      LONG_CALL_MS,
    );
    expect(outcome.verdict).not.toBe('translated');
    expect(outcome.playedShare).toBeLessThan(0.05);
  });

  it('certifies a call whose translated audio really did run through it', () => {
    /*
     * The other direction, and the one that keeps this from being a threshold
     * nobody can meet: a real stream heartbeating once a second, folded by the
     * real reducer, covers the call and ends as translated.
     */
    const outcome = endedTranslationOutcome(playedThroughout(LONG_CALL_MS), LONG_CALL_MS);
    expect(outcome.verdict).toBe('translated');
    expect(outcome.playedShare).toBeGreaterThanOrEqual(MOSTLY_OF_THE_CALL);
  });

  it('does not count an ordinary conversational turn against a working translation', () => {
    /*
     * On a two-party call this phone plays translated audio only while the OTHER
     * person is speaking, so a turn taken by the user is a gap in the heartbeat
     * of a translation that is working perfectly. Twenty seconds of the user
     * talking, between two stretches of translated speech, is bridged.
     */
    let state: TranslationSignals = signals({ playback: 'listening' });
    const beat = (atMs: number): void => {
      state = {
        ...state,
        ...applyTranslatedAudioDiagnostic(state, { kind: 'played', playedMs: atMs }, T0 + atMs),
      };
    };
    for (let at = 0; at < 40_000; at += 1_000) beat(at);
    for (let at = 60_000; at < 100_000; at += 1_000) beat(at);
    const outcome = endedTranslationOutcome(state, 100_000);
    expect(outcome.verdict).toBe('translated');
  });

  it('a silence credits NOTHING, however long or short it was', () => {
    /*
     * Two twenty-millisecond stretches four minutes apart is a subscription
     * that died, not somebody taking their turn -- and the old wall-clock
     * credit gave that call thirty-four seconds of "translated audio" it never
     * played. Measuring the sound itself makes the bridge unnecessary: silence
     * cannot be miscounted as coverage because silence moves no total.
     */
    let state: TranslationSignals = signals({ playback: 'listening' });
    state = {
      ...state,
      ...applyTranslatedAudioDiagnostic(state, { kind: 'played', playedMs: 20 }, T0),
    };
    state = {
      ...state,
      ...applyTranslatedAudioDiagnostic(state, { kind: 'played', playedMs: 40 }, T0 + 240_000),
    };
    expect(state.playedCoveredMs, 'forty milliseconds of sound, and no more').toBe(40);
    expect(endedTranslationOutcome(state, LONG_CALL_MS).verdict).toBe('partly');
  });

  it('WILL NOT call a call translated on sparse heartbeats spread across it', () => {
    /*
     * THE REVIEWERS' PROBE, kept verbatim as the regression it is: ten
     * one-second heartbeats spaced thirty seconds apart over a 291-second
     * call. Under the wall-clock credit this reported 94% of the call
     * translated on nine seconds of audio.
     */
    let state: TranslationSignals = signals({ playback: 'listening' });
    for (let index = 1; index <= 10; index += 1) {
      state = {
        ...state,
        ...applyTranslatedAudioDiagnostic(
          state,
          { kind: 'played', playedMs: index * 1_000 },
          T0 + index * 30_000,
        ),
      };
    }
    expect(state.playedCoveredMs, 'ten seconds of sound').toBe(10_000);
    const outcome = endedTranslationOutcome(state, 291_000);
    expect(outcome.verdict).not.toBe('translated');
    expect(outcome.playedShare).toBeLessThan(0.05);
  });

  it('a player that died mid-call does not erase the audio that WAS heard', () => {
    /*
     * `unavailable` used to short-circuit to 'not translated' before any
     * duration was read, so a call that translated for four minutes and then
     * lost its player was reported as never translated at all. That is false
     * in the other direction: those minutes happened.
     */
    let state: TranslationSignals = signals({ playback: 'listening' });
    state = {
      ...state,
      ...applyTranslatedAudioDiagnostic(state, { kind: 'played', playedMs: 240_000 }, T0),
    };
    state = { ...state, playback: 'unavailable' };
    const outcome = endedTranslationOutcome(state, 291_000);
    expect(outcome.verdict, 'it stopped; it did not never happen').toBe('interrupted');
    expect(outcome.playedShare).toBeGreaterThan(0.6);
    // And with nothing ever played, the latched verdict still decides.
    expect(
      endedTranslationOutcome(signals({ playback: 'unavailable' }), 291_000).verdict,
    ).toBe('not-translated');
  });

  it('refusals covering more of the call than audio outrank a strong share', () => {
    /*
     * Both durations were accumulated and only one was read, so a call that
     * spent most of itself turning translated frames away could still be
     * certified translated on a high played share. The person did not get a
     * translated call.
     */
    const state: TranslationSignals = {
      ...signals({ playback: 'listening' }),
      playedAtMs: T0,
      playedCoveredMs: 200_000,
      refusedAtMs: T0,
      refusedCoveredMs: 250_000,
    };
    const outcome = endedTranslationOutcome(state, 291_000);
    expect(outcome.verdict).toBe('interrupted');
    expect(outcome.verdict).not.toBe('translated');
  });

  it('puts "most of the call" between two thirds and two fifths, in figures', () => {
    /*
     * The threshold, pinned to something other than itself. Asserting against
     * MOSTLY_OF_THE_CALL would agree with any value it was moved to; these are
     * absolute, and they bracket it: seven tenths of a call is translated, two
     * fifths of one is not, and no reading of "most" puts the line outside
     * that.
     */
    const covered = (share: number): TranslationSignals =>
      signals({
        playback: 'listening',
        playedAtMs: T0 + 1_000,
        playedCoveredMs: Math.round(LONG_CALL_MS * share),
      });
    expect(endedTranslationOutcome(covered(0.7), LONG_CALL_MS).verdict).toBe('translated');
    expect(endedTranslationOutcome(covered(0.4), LONG_CALL_MS).verdict).toBe('partly');
    expect(MOSTLY_OF_THE_CALL).toBeGreaterThan(0.4);
    expect(MOSTLY_OF_THE_CALL).toBeLessThanOrEqual(0.7);
  });

  it('calls it INTERRUPTED where the partial call finished being refused', () => {
    // Played, then turned away, with none played since. The two partials are
    // told apart by which one the call ENDED in.
    const outcome = endedTranslationOutcome(
      signals({
        playback: 'listening',
        playedAtMs: T0 + 60_000,
        playedCoveredMs: 60_000,
        refusedAtMs: T0 + 200_000,
        refusedCoveredMs: 140_000,
      }),
      LONG_CALL_MS,
    );
    expect(outcome.verdict).toBe('interrupted');
  });

  it('gives the UNPROVEN verdict, never the flattering one, when there is no duration', () => {
    /*
     * A proportion needs a denominator. Where the call has none -- it never
     * connected -- the gap in the evidence lands on 'unproven'; it does not
     * fall back to the stamp, because falling back to the stamp is what
     * certified 291 seconds on the strength of one frame.
     */
    const played = signals({
      playback: 'listening',
      playedAtMs: T0,
      playedCoveredMs: PRESENT_MS,
    });
    expect(endedTranslationOutcome(played, null).verdict).toBe('unproven');
    expect(endedTranslationOutcome(played, 0).verdict).toBe('unproven');
    expect(endedTranslationOutcome(played, null).playedShare).toBeNull();
  });
});
