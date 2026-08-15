/** @owner masterzee001 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isVfTheme,
  LIGHT_SCHEME_QUERY,
  resolveSystemTheme,
  VF_DEFAULT_THEME,
  VF_THEME_ATTRIBUTE,
  VF_THEMES,
} from '../theme.js';
import { lightThemeBody, TOKENS_CSS } from './css-source.js';

const globalWithMatchMedia = globalThis as { matchMedia?: unknown };

function stubMatchMedia(matching: readonly string[]): void {
  globalWithMatchMedia.matchMedia = (query: string) => ({
    matches: matching.includes(query),
  });
}

afterEach(() => {
  delete globalWithMatchMedia.matchMedia;
});

describe('theme identity', () => {
  it('defaults to dark', () => {
    // Dark is not a mode in Videofy, it is the product: the call and programme
    // stages are dark by design.
    expect(VF_DEFAULT_THEME).toBe('dark');
    expect(VF_THEMES).toContain('dark');
  });

  it('uses the attribute the stylesheet actually selects on', () => {
    // If these drift, `applyTheme` writes an attribute nothing styles and the
    // failure is silent.
    expect(TOKENS_CSS).toContain(`[${VF_THEME_ATTRIBUTE}='light']`);
    expect(TOKENS_CSS).toContain(`[${VF_THEME_ATTRIBUTE}='dark']`);
  });

  it('names exactly the themes the stylesheet implements', () => {
    for (const theme of VF_THEMES) {
      expect(TOKENS_CSS).toContain(`[${VF_THEME_ATTRIBUTE}='${theme}']`);
    }
    // No 'system' theme: honouring prefers-color-scheme in CSS would mean
    // declaring the light palette twice, so system-following is resolved in JS
    // and written as one of these two values.
    expect(VF_THEMES).toHaveLength(2);
  });

  it('rejects anything that is not a declared theme', () => {
    expect(isVfTheme('light')).toBe(true);
    expect(isVfTheme('dark')).toBe(true);
    expect(isVfTheme('system')).toBe(false);
    expect(isVfTheme('')).toBe(false);
    expect(isVfTheme(undefined)).toBe(false);
    expect(isVfTheme(null)).toBe(false);
  });
});

describe('resolveSystemTheme', () => {
  it('falls back to the product default when the preference cannot be read', () => {
    expect(resolveSystemTheme()).toBe(VF_DEFAULT_THEME);
  });

  it('resolves an explicit light preference to light', () => {
    stubMatchMedia([LIGHT_SCHEME_QUERY]);
    expect(resolveSystemTheme()).toBe('light');
  });

  it('resolves "no preference" to dark rather than light', () => {
    // `prefers-color-scheme: light` not matching covers both "dark" and
    // "no-preference". Neither should hand a user a light call stage.
    stubMatchMedia([]);
    expect(resolveSystemTheme()).toBe('dark');
  });
});

describe('light theme completeness', () => {
  it('re-points the semantic roles a light surface cannot function without', () => {
    // The point of the semantic layer is that a theme is a re-point and
    // nothing else. If any of these were missing, a light surface would
    // inherit a dark value and be unreadable rather than merely off-brand.
    const body = lightThemeBody();
    for (const token of [
      '--vf-surface-canvas',
      '--vf-surface-1',
      '--vf-surface-2',
      '--vf-text-primary',
      '--vf-text-secondary',
      '--vf-text-muted',
      '--vf-text-accent',
      '--vf-border-default',
      '--vf-border-interactive',
      '--vf-focus-color',
      '--vf-focus-contrast-color',
      '--vf-elevation-2',
    ]) {
      expect(body, token).toContain(`${token}:`);
    }
  });

  it('sets color-scheme so native controls follow the theme', () => {
    // Scrollbars, date pickers and autofill are painted by the UA, not by us.
    expect(lightThemeBody()).toContain('color-scheme: light');
  });
});
