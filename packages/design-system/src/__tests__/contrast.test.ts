/** @owner masterzee001 */
/**
 * Contrast conformance (§5.1.13 "contrast-compliant text and controls").
 *
 * These assertions are the reason the contrast figures quoted in tokens.css and
 * the README can be trusted. They resolve each semantic token through the
 * indirection layer down to the primitive it actually points at and measure the
 * real pairing, so a well-meaning edit — nudging a surface a shade lighter,
 * re-pointing "muted" one step down the ramp — fails here rather than in an
 * audit six months later.
 *
 * Thresholds used:
 *   7.0  WCAG AAA normal text. Required of `--vf-text-primary` only.
 *   6.0  our own floor for `--vf-text-secondary`, so the hierarchy step from
 *        primary to secondary is a design choice and never an a11y cost.
 *   4.5  WCAG AA normal text. Everything else that carries words.
 *   3.0  WCAG 1.4.11 non-text contrast. Control boundaries and focus rings.
 */
import { describe, expect, it } from 'vitest';
import {
  blackAlpha,
  compositeBlackOver,
  contrastRatio,
  darkTokens,
  lightTokens,
  resolveHex,
} from './css-source.js';

const AAA_TEXT = 7;
const SECONDARY_FLOOR = 6;
const AA_TEXT = 4.5;
const NON_TEXT = 3;

/** Every surface a themed token is allowed to sit on. */
const SURFACES = [
  '--vf-surface-canvas',
  '--vf-surface-sunken',
  '--vf-surface-1',
  '--vf-surface-2',
  '--vf-surface-3',
  '--vf-surface-4',
] as const;

const TEXT_MINIMUMS: ReadonlyArray<readonly [token: string, minimum: number]> = [
  ['--vf-text-primary', AAA_TEXT],
  ['--vf-text-secondary', SECONDARY_FLOOR],
  ['--vf-text-muted', AA_TEXT],
  ['--vf-text-accent', AA_TEXT],
  ['--vf-status-success-text', AA_TEXT],
  ['--vf-status-warn-text', AA_TEXT],
  ['--vf-status-danger-text', AA_TEXT],
  ['--vf-status-info-text', AA_TEXT],
  ['--vf-status-neutral-text', AA_TEXT],
  ['--vf-caption-final-color', AA_TEXT],
  // Interim captions are dimmed only slightly and still have to clear AA: a
  // partial caption is the user's only access to what is being said right now.
  ['--vf-caption-interim-color', AA_TEXT],
  ['--vf-caption-speaker-color', AA_TEXT],
  ['--vf-empty-text', AA_TEXT],
];

const NON_TEXT_MINIMUMS: ReadonlyArray<readonly [token: string, minimum: number]> = [
  ['--vf-border-interactive', NON_TEXT],
  ['--vf-focus-color', NON_TEXT],
];

function ratio(
  tokens: Map<string, string>,
  foregroundToken: string,
  backgroundToken: string,
): number {
  const foreground = resolveHex(tokens, foregroundToken);
  const background = resolveHex(tokens, backgroundToken);
  expect(foreground, `${foregroundToken} must resolve to a hex primitive`).not.toBeNull();
  expect(background, `${backgroundToken} must resolve to a hex primitive`).not.toBeNull();
  return contrastRatio(foreground as string, background as string);
}

describe.each([
  ['dark', darkTokens()],
  ['light', lightTokens()],
])('%s theme', (theme, tokens) => {
  it.each(TEXT_MINIMUMS)('%s clears its minimum on every surface', (token, minimum) => {
    for (const surface of SURFACES) {
      const measured = ratio(tokens, token, surface);
      expect(
        measured,
        `${theme}: ${token} on ${surface} measured ${measured.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  it.each(NON_TEXT_MINIMUMS)('%s clears 3:1 on every surface', (token, minimum) => {
    for (const surface of SURFACES) {
      const measured = ratio(tokens, token, surface);
      expect(
        measured,
        `${theme}: ${token} on ${surface} measured ${measured.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('keeps text on an accent fill readable', () => {
    // `--vf-text-primary` on the brand fill measures 3.4:1 and fails, which is
    // exactly why `--vf-text-on-accent` exists as a separate token.
    expect(ratio(tokens, '--vf-text-on-accent', '--vf-border-accent')).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });

  it('keeps text on every status fill readable', () => {
    // One `on-solid` token serves all four families because near-black clears
    // AA on all of them and white clears it on none.
    for (const family of ['success', 'warn', 'danger', 'info', 'neutral']) {
      const measured = ratio(tokens, '--vf-status-on-solid', `--vf-status-${family}-solid`);
      expect(
        measured,
        `${theme}: ${family} measured ${measured.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('never lets disabled text be mistaken for muted text', () => {
    // Disabled is deliberately below AA (WCAG 1.4.3 exempts inactive
    // controls), so it must stay clearly dimmer than the dimmest token that
    // still carries information — otherwise it reads as content.
    const disabled = ratio(tokens, '--vf-text-disabled', '--vf-surface-1');
    const muted = ratio(tokens, '--vf-text-muted', '--vf-surface-1');
    expect(disabled).toBeLessThan(muted);
  });
});

describe('focus ring over media', () => {
  const tokens = darkTokens();

  it('survives the brightest possible video frame', () => {
    // A violet ring alone measures 2.72:1 against a white frame and fails WCAG
    // 2.4.11. The dual ring works because one of its two colours always wins:
    // the near-black inner ring against bright content, the violet outer ring
    // against dark content.
    const white = '#ffffff';
    const black = '#000000';
    const focus = resolveHex(tokens, '--vf-focus-color') as string;
    const contrast = resolveHex(tokens, '--vf-focus-contrast-color') as string;

    expect(
      Math.max(contrastRatio(focus, white), contrastRatio(contrast, white)),
    ).toBeGreaterThanOrEqual(NON_TEXT);
    expect(
      Math.max(contrastRatio(focus, black), contrastRatio(contrast, black)),
    ).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

describe('captions over video', () => {
  const tokens = darkTokens();

  it('uses a scrim heavy enough for the caption colours on a white frame', () => {
    // The scrim is the only reason caption text has a guaranteed contrast
    // floor over content we do not control. At the more conventional 0.5 the
    // final caption measures 3.32:1 and fails; the value here is chosen from
    // this measurement, not from taste.
    const alpha = blackAlpha(tokens.get('--vf-caption-background') ?? '');
    expect(alpha, '--vf-caption-background must be a black scrim').not.toBeNull();

    const worstCase = compositeBlackOver(alpha as number, '#ffffff');
    for (const token of [
      '--vf-caption-final-color',
      '--vf-caption-interim-color',
      '--vf-caption-overlay-speaker-color',
    ]) {
      const colour = resolveHex(tokens, token);
      expect(colour, token).not.toBeNull();
      const measured = contrastRatio(colour as string, worstCase);
      expect(
        measured,
        `${token} measured ${measured.toFixed(2)}:1 through the scrim`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe.each([
  ['dark', darkTokens()],
  ['light', lightTokens()],
])('%s theme interim captions', (theme, tokens) => {
  it('is distinguishable from final but never quieter than muted text', () => {
    // Dimming a partial caption hard is a tempting design and an accessibility
    // mistake: it is the caption most likely to be read under time pressure.
    // There must be a colour step (so sighted users get the cue for free) but
    // it must land above the quietest tier that still carries information.
    const final = ratio(tokens, '--vf-caption-final-color', '--vf-surface-1');
    const interim = ratio(tokens, '--vf-caption-interim-color', '--vf-surface-1');
    const muted = ratio(tokens, '--vf-text-muted', '--vf-surface-1');

    expect(interim, `${theme}: interim must differ from final`).toBeLessThan(final);
    expect(interim, `${theme}: interim must out-read muted`).toBeGreaterThan(muted);
  });
});
