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
  endedTranslationVerdict,
  NO_TRANSLATION_SIGNALS,
  PRESENT_MS,
  translationReadiness,
  type TranslationSignals,
} from '../call/translationReadiness';

/** A call that started at t=0 on the phone's clock. */
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;

const signals = (over: Partial<TranslationSignals>): TranslationSignals => ({
  mode: 'translated',
  engine: null,
  playback: null,
  playedAtMs: null,
  refusedAtMs: null,
  captionedAtMs: null,
  ...over,
});

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
    expect(endedTranslationVerdict(state)).toBe('not-translated');
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
    // It did play once, so the call is not "not translated" -- it stopped.
    expect(endedTranslationVerdict(state)).toBe('interrupted');
  });

  it('says only what a caption proves: the engine ran, not that it was heard', () => {
    const state = signals({ playback: 'listening', captionedAtMs: NOW - 200 });
    const readiness = translationReadiness(state, NOW);
    expect(readiness.kind).toBe('captioning');
    expect(readiness.words).toBe('Translated text is arriving');
    expect(readiness.words).not.toMatch(/playing|hearing/iu);
    expect(readiness.warn).toBe(false);
    // Weaker than heard, and the ended screen says so in its own words.
    expect(endedTranslationVerdict(state)).toBe('text-only');
  });

  it('stops claiming to be playing once nothing has played for a while', () => {
    const state = signals({ playback: 'listening', playedAtMs: T0 });
    expect(translationReadiness(state, T0 + PRESENT_MS).kind).toBe('ready');
    const later = translationReadiness(state, T0 + PRESENT_MS + 1);
    // Nothing is arriving and nothing was refused: the honest state is the one
    // it started in -- subscribed, waiting -- not a fault and not a claim.
    expect(later.kind).toBe('waiting');
    expect(later.words).toBe('Listening for translated speech');
    // The call still ends as translated: something WAS heard.
    expect(endedTranslationVerdict(state)).toBe('translated');
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
    expect(
      applyTranslatedAudioDiagnostic(refused, { kind: 'refused', reason: 'no-session' }, T0 + 1_000)
        .refusedAtMs,
    ).toBe(T0 + 1_000);
  });

  it('stamps the audible proof, and keeps stamping it as the audio continues', () => {
    const played = applyTranslatedAudioDiagnostic(
      NO_TRANSLATION_SIGNALS,
      { kind: 'played', playedMs: 20 },
      T0,
    );
    expect(played.playedAtMs).toBe(T0);
    const later = applyTranslatedAudioDiagnostic(played, { kind: 'played', playedMs: 1_020 }, T0 + 1_000);
    expect(later.playedAtMs).toBe(T0 + 1_000);
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
    expect(endedTranslationVerdict(signals({ engine: false, playback: 'listening' }))).toBe(
      'not-translated',
    );
  });

  it('will not certify a call this phone could not play', () => {
    expect(endedTranslationVerdict(signals({ playback: 'unavailable' }))).toBe('not-translated');
  });

  it('certifies as translated only where audio was actually played', () => {
    expect(endedTranslationVerdict(signals({ playback: 'listening', playedAtMs: T0 }))).toBe(
      'translated',
    );
    // Text alone is a weaker, honest verdict of its own -- never 'translated'.
    expect(endedTranslationVerdict(signals({ captionedAtMs: T0 }))).not.toBe('translated');
    expect(endedTranslationVerdict(signals({ captionedAtMs: T0 }))).toBe('text-only');
  });

  it('says frames were turned away when none was ever played', () => {
    expect(
      endedTranslationVerdict(signals({ playback: 'listening', refusedAtMs: T0, captionedAtMs: T0 })),
    ).toBe('not-translated');
  });

  it('says UNPROVEN for a translated call in which nothing was ever measured', () => {
    // Configured translated, subscribed, and not one frame or caption. The mode
    // alone is not evidence, and the ended line says nothing about translation.
    expect(endedTranslationVerdict(signals({ playback: 'listening' }))).toBe('unproven');
    expect(endedTranslationVerdict(signals({}))).toBe('unproven');
  });
});
