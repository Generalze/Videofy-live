/** @author masterzee001 */
/**
 * "CONNECTING TRANSLATION SERVICE…" HAS TO BE TRUE.
 *
 * The line the founder's board puts under the outgoing ring is the single
 * easiest place in this app to reproduce the night it spent saying "Hearing
 * translated voice" over silence: a three-second timer, a hopeful sentence,
 * and nothing behind either.
 *
 * These pin the signals the phone genuinely holds -- the server-owned call
 * mode, the gateway's own `translation-engine-unavailable`, this handset's
 * translated-audio diagnostic, the two PROOFS (a frame played, a translated
 * caption) and the REFUSALS -- and pin the ORDER they overrule each other in,
 * because the server saying its engine is missing must not be overwritten by a
 * handset that has merely subscribed, and a handset that has merely subscribed
 * must not read like one that is playing something.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCaptionEvidence,
  applyTranslatedAudioDiagnostic,
  endedTranslationVerdict,
  NO_TRANSLATION_SIGNALS,
  translationReadiness,
  type TranslationSignals,
} from '../call/translationReadiness';

const signals = (over: Partial<TranslationSignals>): TranslationSignals => ({
  mode: 'translated',
  engine: null,
  playback: null,
  proof: null,
  refused: false,
  ...over,
});

describe('a call the server did not call translated says nothing', () => {
  it('shows no line on a normal call, whatever the phone is doing', () => {
    expect(translationReadiness(signals({ mode: 'normal', playback: 'listening' })).words).toBeNull();
    expect(
      translationReadiness(signals({ mode: 'normal', engine: false, playback: 'unavailable' })).words,
    ).toBeNull();
    expect(translationReadiness(signals({ mode: 'normal' })).kind).toBe('off');
    // Not even a translation that played: a normal call has no translation line.
    expect(translationReadiness(signals({ mode: 'normal', proof: 'audio' })).words).toBeNull();
  });

  it('shows no line before the telephone has stated a mode', () => {
    // Guessing 'pending' here would put a translation sentence on every call in
    // the product for as long as the first `call:direct:state` takes to arrive.
    const readiness = translationReadiness(signals({ mode: null }));
    expect(readiness.kind).toBe('off');
    expect(readiness.words).toBeNull();
  });
});

describe('a translated call says what has actually been measured', () => {
  it('is connecting while nothing has reported yet', () => {
    const readiness = translationReadiness(signals({}));
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
    const readiness = translationReadiness(signals({ playback: 'listening' }));
    expect(readiness.kind).toBe('waiting');
    expect(readiness.words).toBe('Listening for translated speech');
    expect(readiness.words).not.toMatch(/hearing|playing/iu);
    expect(readiness.warn).toBe(false);
  });

  it('claims translation is running only from a PROOF', () => {
    const played = translationReadiness(signals({ playback: 'listening', proof: 'audio' }));
    expect(played.kind).toBe('ready');
    expect(played.words).toBe('Playing translated speech');

    const captioned = translationReadiness(signals({ playback: 'listening', proof: 'caption' }));
    expect(captioned.kind).toBe('ready');
    // A caption is evidence the engine produced something and it arrived. It is
    // NOT evidence anybody heard it, and the sentence does not say they did.
    expect(captioned.words).toBe('Translated text is arriving');
    expect(captioned.words).not.toMatch(/playing|hearing/iu);
  });

  it('lets REFUSED contradict listening', () => {
    /*
     * The 19 Sep post-mortem's worst state: a subscription that reports
     * `listening` and then refuses every frame it is sent is, from the screen,
     * indistinguishable from an engine that never ran. It is now distinguished.
     */
    const readiness = translationReadiness(signals({ playback: 'listening', refused: true }));
    expect(readiness.kind).toBe('refusing');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/not playing it/iu);
  });

  it('does not let a later refusal undo something that played', () => {
    const readiness = translationReadiness(
      signals({ playback: 'listening', refused: true, proof: 'audio' }),
    );
    expect(readiness.kind).toBe('ready');
  });

  it('says so when THIS PHONE cannot play translated speech', () => {
    const readiness = translationReadiness(signals({ playback: 'unavailable' }));
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/phone/iu);
  });

  it('says so when THE SERVER has no translation engine', () => {
    const readiness = translationReadiness(signals({ engine: false }));
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
    const readiness = translationReadiness(signals({ engine: false, playback: 'listening' }));
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.words).toMatch(/server/iu);
  });

  it('does not downgrade a working call because the engine was never mentioned', () => {
    // `engine: null` is "the gateway said nothing", which is the NORMAL case --
    // the error is only sent by a deployment whose engine is not real.
    expect(translationReadiness(signals({ playback: 'listening', proof: 'audio' })).kind).toBe('ready');
    expect(
      translationReadiness(signals({ engine: true, playback: 'listening', proof: 'audio' })).kind,
    ).toBe('ready');
  });
});

describe('the diagnostics are folded into one measured picture', () => {
  it('records the subscription, and never lets it undo an unavailable verdict', () => {
    const listening = applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, { kind: 'listening' });
    expect(listening.playback).toBe('listening');
    const broke = applyTranslatedAudioDiagnostic(listening, { kind: 'unavailable', error: 'threw' });
    expect(broke.playback).toBe('unavailable');
    // A re-attach after the native track has thrown does not heal the track.
    expect(applyTranslatedAudioDiagnostic(broke, { kind: 'listening' }).playback).toBe('unavailable');
  });

  it('keeps the refusals, which the screen used to drop on the floor', () => {
    const refused = applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, {
      kind: 'refused',
      reason: 'language-not-mine',
    });
    expect(refused.refused).toBe(true);
    // Refusals arrive per frame; an unchanged picture is the same object, so a
    // refused stream cannot re-render the screen fifty times a second.
    expect(applyTranslatedAudioDiagnostic(refused, { kind: 'refused', reason: 'no-session' })).toBe(
      refused,
    );
  });

  it('keeps the audible proof, which nothing outside the sink had ever read', () => {
    const played = applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, {
      kind: 'played',
      playedMs: 20,
    });
    expect(played.proof).toBe('audio');
  });

  it('takes a translated caption as proof, and never lets it displace audio', () => {
    const captioned = applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: 'Bawo ni' });
    expect(captioned.proof).toBe('caption');
    // Blank is not a choice, and a same-language caption carries null.
    expect(applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: null }).proof).toBeNull();
    expect(applyCaptionEvidence(NO_TRANSLATION_SIGNALS, { translatedText: '  ' }).proof).toBeNull();
    const played = applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, {
      kind: 'played',
      playedMs: 20,
    });
    expect(applyCaptionEvidence(played, { translatedText: 'Bawo ni' }).proof).toBe('audio');
  });

  it('reads the originals policy as saying nothing about translation', () => {
    expect(
      applyTranslatedAudioDiagnostic(NO_TRANSLATION_SIGNALS, { kind: 'originals', suppressed: true }),
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

  it('certifies only what was proven', () => {
    expect(endedTranslationVerdict(signals({ playback: 'listening', proof: 'audio' }))).toBe('translated');
    expect(endedTranslationVerdict(signals({ proof: 'caption' }))).toBe('translated');
  });

  it('says UNPROVEN for a translated call in which nothing was ever measured', () => {
    // Configured translated, subscribed, and not one frame or caption. The mode
    // alone is not evidence, and the ended line says nothing about translation.
    expect(endedTranslationVerdict(signals({ playback: 'listening' }))).toBe('unproven');
    expect(endedTranslationVerdict(signals({}))).toBe('unproven');
  });
});
