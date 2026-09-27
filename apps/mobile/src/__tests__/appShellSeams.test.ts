/** @author masterzee001 */
/**
 * THE APP SHELL OBEYS ITS MODULES -- a guard on the last unguarded inch.
 *
 * WHAT THIS IS, AND IS NOT. App.tsx cannot be mounted in this suite: it pulls
 * in the splash screen, the notification runtime, the WebRTC screen and the
 * secure store at import. Every DECISION that used to live in it now lives
 * in a module with a behavioural test (call/translatedVoiceSeam,
 * push/ringingReadiness, push/unreportedTimelines), and this file holds the
 * shell to passing those modules' answers through UNCHANGED. It reads the
 * source, which is the weakest kind of test in this repository, and it is
 * here only beside the behavioural ones -- never as the proof itself.
 *
 * WHY IT EXISTS ANYWAY. Two reviewer edits to App.tsx on 27 Sep 2026 --
 * replacing the voice spread with the literal `translatedVoice="female"`,
 * and emptying the change handler -- each restored a shipped defect and left
 * a 688-test suite green. Each of those edits, and the ones like them for
 * the ringing banner and the timeline sweep, fails a line below.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8').replace(/\r\n/gu, '\n');

/** The one `<CallScreen ... />` element the shell renders, as text. */
function callScreenElement(): string {
  const start = SOURCE.indexOf('<CallScreen');
  expect(start).toBeGreaterThan(0);
  const end = SOURCE.indexOf('/>', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** The one `<ProfileScreen ... />` element, as text. */
function profileScreenElement(): string {
  const start = SOURCE.indexOf('<ProfileScreen');
  expect(start).toBeGreaterThan(0);
  const end = SOURCE.indexOf('/>', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('the voice on the join comes from the seam and nowhere else', () => {
  it('spreads the seam’s join props onto the call screen', () => {
    expect(callScreenElement()).toContain('{...translatedVoiceSeam.joinProps()}');
  });

  it('never states a voice as a literal, anywhere in the shell', () => {
    // `translatedVoice="female"`, `translatedVoice: 'female'`, and the
    // shorthand object `{ translatedVoice }` that spread a render copy onto
    // the call screen. (`={translatedVoice}` is the profile prop and is
    // allowed; the lookbehind keeps it apart.)
    expect(SOURCE).not.toMatch(/translatedVoice\s*[=:]\s*["'`]/u);
    expect(SOURCE).not.toMatch(/(?<!=)\{\s*translatedVoice\s*\}/u);
    expect(SOURCE).not.toMatch(/translatedVoice\s*:/u);
  });

  it('hands the call screen no voice prop of its own', () => {
    const element = callScreenElement();
    expect(element).not.toMatch(/\btranslatedVoice\s*=/u);
    expect(element.match(/translatedVoice/gu)).toEqual(['translatedVoice']);
  });

  it('hands the profile the seam’s accept as the change handler, unwrapped', () => {
    expect(profileScreenElement()).toContain('onTranslatedVoice={translatedVoiceSeam.accept}');
    expect(SOURCE.match(/onTranslatedVoice=/gu)).toHaveLength(1);
  });

  it('never reads or writes the session’s voice itself', () => {
    expect(SOURCE).not.toContain('rememberTranslatedVoice');
    expect(SOURCE).not.toContain('auth.translatedVoice(');
  });

  it('re-reads through the seam when the session changes, and renders what the seam reports', () => {
    expect(SOURCE.match(/translatedVoiceSeam\.refresh\(\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(SOURCE).toContain('translatedVoiceSeam.watch(setTranslatedVoice)');
    expect(SOURCE).toContain('createTranslatedVoiceSeam(auth)');
  });
});

describe('the ringing banner shows when the module says so', () => {
  it('is gated on the banner rule, which knows about the vendor sentence, and not on the request alone', () => {
    expect(SOURCE).toContain('shouldShowRingingBanner(ringing, ringingNotNow)');
    expect(SOURCE).not.toMatch(/shouldOfferExemption\s*\(/u);
  });
});

describe('the push that arrived and rang nobody is swept to the gateway', () => {
  it('runs the sweep from the shell against the native store, excluding the calls on screen', () => {
    const start = SOURCE.indexOf('flushUnreportedTimelines({');
    expect(start).toBeGreaterThan(0);
    const call = SOURCE.slice(start, SOURCE.indexOf('});', start));
    expect(call).toContain('store: videofyCall');
    expect(call).toContain('sessionToken: auth.callSessionToken()');
    expect(call).toContain('liveCallIds: liveCallIds.current');
  });

  it('runs it where the readiness is read: on a session and on every return to the foreground', () => {
    const readStart = SOURCE.indexOf('const read = (): void => {');
    expect(readStart).toBeGreaterThan(0);
    const read = SOURCE.slice(readStart, SOURCE.indexOf('};', readStart));
    expect(read).toContain('readRingingReadiness(videofyCall, MANUFACTURER)');
    expect(read).toContain('flushUnreportedTimelines({');
    expect(SOURCE).toContain("if (next === 'active') read();");
  });
});
