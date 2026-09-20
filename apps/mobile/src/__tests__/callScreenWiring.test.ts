/** @author masterzee001 */
/**
 * THE FOUR SEAMS A PURE MODEL CANNOT REACH -- and what this file is worth.
 *
 * BE CLEAR ABOUT THE INSTRUMENT. Every assertion here matches SOURCE TEXT. That
 * is the weakest kind of test in this repository and it is used only where
 * there is no stronger one available: this app has no react-test-renderer and
 * no @testing-library/react-native, and adding React Native to node would be a
 * mocking scaffold larger than the seam it covered. Everything a seam could get
 * WRONG -- which sentence, which prop, which control, in which phase -- is
 * measured for real in callScreenModel.test.ts. What is left, and only what is
 * left, is whether the screen is still plugged into it at all.
 *
 * Each of these has been cut once, by a mutant, with the whole suite green:
 *
 *   the caption seam       `onCaption` removed from the CallConnection options.
 *                          The socket-side half was the September defect; this
 *                          is the same cut at the far end.
 *   the translated-audio   the diagnostics no longer folded into the signals,
 *   seam                   so refusals and the audible proof are lost again.
 *   the view model         the screen stops rendering from `callScreenView`, and
 *                          every decision proven next door stops applying.
 *   the caption merge      the slot takes whatever arrives instead of asking
 *                          the shared rules.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const screen = readFileSync(
  fileURLToPath(new URL('../screens/CallScreen.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

describe('the screen is still plugged into the decisions', () => {
  it('renders from the view model', () => {
    expect(screen).toContain('const view = callScreenView({');
    // And the parts of it that carry the two named defects.
    expect(screen).toContain('translation={view.caption.translation}');
    expect(screen).toContain('{view.readinessLine !== null && (');
    expect(screen).toContain('remaining={view.halo.remaining}');
    expect(screen).toContain('{view.dock.map((control) => (');
  });

  it('subscribes to captions, and asks the shared merge what to show', () => {
    expect(screen).toContain('onCaption: (event: CallCaptionEvent, origin) => {');
    expect(screen).toContain('const accepted = nextCaption(current?.event ?? null, event);');
    // Whose words. The seat id lives in the connection and nowhere above it.
    expect(screen).toContain('self: origin.self');
  });

  it('folds every translated-audio diagnostic into the measured picture', () => {
    expect(screen).toContain('setSignals((current) => applyTranslatedAudioDiagnostic(current, event));');
    expect(screen).toContain('setSignals((current) => applyCaptionEvidence(current, event));');
  });
});
