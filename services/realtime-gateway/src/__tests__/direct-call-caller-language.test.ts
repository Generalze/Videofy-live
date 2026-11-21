/** @author masterzee001 */
/**
 * THE RINGING SCREEN'S HALF OF THE LANGUAGE PAIR.
 *
 * The founder's board puts a language pill on every call screen, including the
 * one that asks you whether to answer. It could not be drawn there: the
 * pre-answer wire carried ring, state, mode, caller account and caller name,
 * and no language of any kind. The only record of a seat's languages is
 * `call:state`, which does not exist until somebody has joined -- one moment
 * after the screen that needs it.
 *
 * So the caller's spoken language now travels with the call from the moment it
 * is created. These tests hold the two properties that make that safe to show
 * to another person:
 *
 *   IT IS CHECKED BEFORE IT IS STORED. One person supplies the string and a
 *   different person reads it, so a tag that is not shaped like a tag never
 *   reaches the second person's screen.
 *
 *   BLANK IS NOT A CHOICE. Absent, empty and malformed all answer null, and
 *   null means the screen draws NO pill -- never a default, never a guess.
 *   This app has spent a night showing a state nobody measured; two letters
 *   invented under somebody's name is the same defect, smaller.
 */
import { describe, expect, it } from 'vitest';
import { DirectCallLifecycle, directCallLanguageTag } from '../direct-call-lifecycle.js';

function callWith(callerSpeakLanguage: unknown) {
  const lifecycle = new DirectCallLifecycle({ now: () => 1_000, setTimer: () => 0, clearTimer: () => {} });
  return lifecycle.create({
    callId: 'ring-lang-1',
    callerAccountId: 'acct_caller',
    peerAccountId: 'acct_peer',
    callerName: 'Zoe',
    mode: 'translated',
    callerSpeakLanguage,
    peerBusy: false,
  });
}

describe('the caller’s spoken language reaches the ringing screen', () => {
  it('carries a stated language on the wire the callee reads before answering', () => {
    expect(callWith('yo').callerSpeakLanguage).toBe('yo');
  });

  it('keeps a regional tag whole, because the phone decides what it can name', () => {
    // The gateway is not the language authority and holds no catalogue. It
    // must not quietly truncate `pt-BR` to `pt` on behalf of a client that
    // knows the difference.
    expect(callWith('pt-BR').callerSpeakLanguage).toBe('pt-BR');
  });

  it('answers null when the caller stated nothing, so no pill is drawn', () => {
    for (const nothing of [undefined, null, '', '   ']) {
      expect(callWith(nothing).callerSpeakLanguage).toBeNull();
    }
  });

  it('REFUSES anything not shaped like a language tag', () => {
    /*
     * The decisive case: this string is chosen by one account and rendered on
     * a different person's lock screen. A gateway that echoed it unchecked
     * would let a caller write on the callee's screen.
     */
    for (const notATag of [
      '<script>alert(1)</script>',
      'Call me back urgently',
      '../../etc/passwd',
      'e',
      'englishlanguage',
      '12',
      'en_US',
      42,
      { code: 'en' },
    ]) {
      expect(directCallLanguageTag(notATag)).toBeNull();
      expect(callWith(notATag).callerSpeakLanguage).toBeNull();
    }
  });

  it('refuses a tag long enough to break the screen it lands on', () => {
    /*
     * WELL-FORMED AND STILL TOO LONG, which is the only case that tests the
     * ceiling. The first version of this test used forty repeated letters in
     * one subtag; that fails the PATTERN (a subtag is at most eight), so it
     * passed whether or not a ceiling existed, and a mutation run that lifted
     * the ceiling survived. Chaining legal subtags is what gets past the
     * pattern and has to be stopped by length alone.
     */
    const legalButAbsurd = `en-${Array.from({ length: 5 }, () => 'abcdefgh').join('-')}`;
    expect(legalButAbsurd.length).toBeGreaterThan(35);
    // The SAME shape, short enough, is accepted -- so length is demonstrably
    // the only thing refusing the one above. Asserted through the function
    // rather than against the pattern, which is private and should stay so.
    expect(directCallLanguageTag('en-abcdefgh')).toBe('en-abcdefgh');
    expect(directCallLanguageTag(legalButAbsurd)).toBeNull();
  });

  it('survives every state change, because the screen reads it late', () => {
    /*
     * The callee's screen fetches the call AFTER the push wakes it, by which
     * time the state has usually moved on. A language that only existed in the
     * `calling` state would be absent exactly when it is read.
     */
    const lifecycle = new DirectCallLifecycle({ now: () => 1_000, setTimer: () => 0, clearTimer: () => {} });
    lifecycle.create({
      callId: 'ring-lang-2',
      callerAccountId: 'acct_caller',
      peerAccountId: 'acct_peer',
      callerName: 'Zoe',
      mode: 'translated',
      callerSpeakLanguage: 'ha',
      peerBusy: false,
    });
    lifecycle.ringingAck('ring-lang-2', 'acct_peer');
    /*
     * `get` is what GET /calls/direct/:callId serves, spread whole into the
     * response body, so this IS the shape the waking handset parses.
     */
    const served = lifecycle.get('ring-lang-2');
    expect(served).not.toBeNull();
    if (served === null) return;
    expect(served.state).toBe('ringing');
    expect(served.callerSpeakLanguage).toBe('ha');
  });

  it('is stated on a NORMAL call too, so the screen can stay silent by mode', () => {
    /*
     * Deliberate: the language is a fact about the caller, not about the mode.
     * Whether to SHOW it is the screen's decision -- and on a normal call the
     * honest answer is not to -- but a gateway that withheld the fact would
     * force the screen to guess if that ruling ever changed.
     */
    const lifecycle = new DirectCallLifecycle({ now: () => 1_000, setTimer: () => 0, clearTimer: () => {} });
    const wire = lifecycle.create({
      callId: 'ring-lang-3',
      callerAccountId: 'acct_caller',
      peerAccountId: 'acct_peer',
      callerName: 'Zoe',
      mode: 'normal',
      callerSpeakLanguage: 'en',
      peerBusy: false,
    });
    expect(wire.mode).toBe('normal');
    expect(wire.callerSpeakLanguage).toBe('en');
  });
});
