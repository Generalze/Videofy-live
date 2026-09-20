/** @author masterzee001 */
/**
 * "CONNECTING TRANSLATION SERVICE…" HAS TO BE TRUE.
 *
 * The line the founder's board puts under the outgoing ring is the single
 * easiest place in this app to reproduce the night it spent saying "Hearing
 * translated voice" over silence: a three-second timer, a hopeful sentence,
 * and nothing behind either.
 *
 * These pin the three things the phone genuinely knows -- the server-owned call
 * mode, the gateway's own `translation-engine-unavailable`, and this handset's
 * translated-audio diagnostic -- and pin the ORDER they overrule each other in,
 * because the server saying its engine is missing must not be overwritten by a
 * handset that has merely subscribed.
 */
import { describe, expect, it } from 'vitest';
import { translationReadiness } from '../call/translationReadiness';

describe('a call the server did not call translated says nothing', () => {
  it('shows no line on a normal call, whatever the phone is doing', () => {
    expect(translationReadiness({ mode: 'normal', engine: null, playback: 'listening' }).words).toBeNull();
    expect(translationReadiness({ mode: 'normal', engine: false, playback: 'unavailable' }).words).toBeNull();
    expect(translationReadiness({ mode: 'normal', engine: null, playback: null }).kind).toBe('off');
  });

  it('shows no line before the telephone has stated a mode', () => {
    // Guessing 'pending' here would put a translation sentence on every call in
    // the product for as long as the first `call:direct:state` takes to arrive.
    const readiness = translationReadiness({ mode: null, engine: null, playback: null });
    expect(readiness.kind).toBe('off');
    expect(readiness.words).toBeNull();
  });
});

describe('a translated call says what has actually been measured', () => {
  it('is connecting while nothing has reported yet', () => {
    const readiness = translationReadiness({ mode: 'translated', engine: null, playback: null });
    expect(readiness.kind).toBe('pending');
    expect(readiness.words).toBe('Connecting translation service…');
    expect(readiness.warn).toBe(false);
  });

  it('stops saying connecting once this phone is subscribed', () => {
    const readiness = translationReadiness({ mode: 'translated', engine: null, playback: 'listening' });
    expect(readiness.kind).toBe('ready');
    expect(readiness.words).toBe('Listening for translated speech');
    // It does NOT claim a translation has been produced. Only a caption or a
    // frame is evidence of that, and neither is an input here.
    expect(readiness.words).not.toMatch(/hearing/iu);
  });

  it('says so when THIS PHONE cannot play translated speech', () => {
    const readiness = translationReadiness({ mode: 'translated', engine: null, playback: 'unavailable' });
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/phone/iu);
  });

  it('says so when THE SERVER has no translation engine', () => {
    const readiness = translationReadiness({ mode: 'translated', engine: false, playback: null });
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.warn).toBe(true);
    expect(readiness.words).toMatch(/server/iu);
  });

  it('lets the server outrank a phone that has merely subscribed', () => {
    /*
     * The whole point of the ordering. The handset attaches its subscription on
     * every translated call and reports `listening` whether or not anything is
     * ever going to be sent to it; the gateway's verdict is the one that knows.
     * Read the other way round, this screen would say "Listening for translated
     * speech" on a deployment that had just said it cannot translate.
     */
    const readiness = translationReadiness({ mode: 'translated', engine: false, playback: 'listening' });
    expect(readiness.kind).toBe('unavailable');
    expect(readiness.words).toMatch(/server/iu);
  });

  it('does not downgrade a working call because the engine was never mentioned', () => {
    // `engine: null` is "the gateway said nothing", which is the NORMAL case --
    // the error is only sent by a deployment whose engine is not real.
    expect(translationReadiness({ mode: 'translated', engine: null, playback: 'listening' }).kind).toBe('ready');
    expect(translationReadiness({ mode: 'translated', engine: true, playback: 'listening' }).kind).toBe('ready');
  });
});
