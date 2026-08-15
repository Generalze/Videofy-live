/** @owner masterzee001 */
/**
 * Theme selection (§5.1.11 "light/dark/brand theme tokens where required").
 *
 * Dark is not a mode in Videofy, it is the product. A call stage and a
 * programme stage are dark by design, so tokens.css does NOT honour
 * `prefers-color-scheme` at the CSS level — see the README "Theme story" for
 * the full reasoning.
 *
 * Surfaces that genuinely are documents rather than stages (marketing, admin,
 * docs) can opt into light by setting `data-vf-theme="light"` on any element;
 * the semantic layer re-points beneath it. If such a surface also wants to
 * follow the operating system, it resolves the preference here in JS and sets
 * the attribute. Doing it this way rather than with a `prefers-color-scheme`
 * block in CSS keeps the palette declared exactly once: a media query would
 * force the whole light mapping to be duplicated for the "system" case, and a
 * duplicated palette drifts.
 */

export const VF_THEME_ATTRIBUTE = 'data-vf-theme';

export const VF_THEMES = ['dark', 'light'] as const;

export type VfTheme = (typeof VF_THEMES)[number];

/** Dark, unconditionally. Every Videofy surface is dark until it opts out. */
export const VF_DEFAULT_THEME: VfTheme = 'dark';

export function isVfTheme(value: unknown): value is VfTheme {
  return typeof value === 'string' && (VF_THEMES as readonly string[]).includes(value);
}

/**
 * A structural stand-in for `window.matchMedia`; see the same note in
 * motion.ts for why this package does not take TypeScript's DOM lib.
 */
interface MediaQueryListLike {
  readonly matches: boolean;
}

type MatchMediaLike = (query: string) => MediaQueryListLike;

export const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

/**
 * The theme the operating system is asking for.
 *
 * Falls back to `dark` when the preference cannot be read (SSR, tests) and
 * when the OS expresses no preference at all — `no-preference` must resolve to
 * the product default, not to light. Only call this on surfaces that have
 * decided to follow the OS; the call and programme stages should not.
 */
export function resolveSystemTheme(): VfTheme {
  const candidate = (globalThis as { matchMedia?: unknown }).matchMedia;
  if (typeof candidate !== 'function') {
    return VF_DEFAULT_THEME;
  }
  return (candidate as MatchMediaLike)(LIGHT_SCHEME_QUERY).matches ? 'light' : VF_DEFAULT_THEME;
}
