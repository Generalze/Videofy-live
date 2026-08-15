/** @owner masterzee001 */
/**
 * @videofy-live/design-system
 *
 * The shared Videofy visual language (master architecture §5.1.11).
 *
 * The design system is CSS first. `src/tokens.css` is the canonical source of
 * truth for every value — colour, type, space, depth, motion, media framing,
 * captions, status. This TypeScript entry point exists only for the values
 * that JavaScript genuinely cannot read out of a stylesheet at the moment it
 * needs them:
 *
 *   - breakpoints, because a custom property is not valid inside a media-query
 *     prelude and `matchMedia` callers would otherwise hard-code the number;
 *   - motion durations, because JS-sequenced delays must match the CSS
 *     transitions they are waiting on, and must collapse under reduced motion;
 *   - the theme attribute, because switching themes is a DOM write.
 *
 * The colour palette is deliberately NOT mirrored here. Duplicating it would
 * create a second place for a colour to be wrong, and any component that needs
 * a Videofy colour in JS is a component that should have been styled in CSS.
 *
 * Usage:
 *   import '@videofy-live/design-system/base.css';    // reset + tokens
 *   import '@videofy-live/design-system/tokens.css';  // tokens alone
 *   import { BREAKPOINTS, durationMs } from '@videofy-live/design-system';
 */

export {
  BASE_VIEWPORT_TIER,
  BREAKPOINT_ORDER,
  BREAKPOINTS,
  isAtLeast,
  mediaQueryBetween,
  mediaQueryDown,
  mediaQueryUp,
  resolveViewportTier,
} from './breakpoints.js';
export type { BreakpointName, ViewportTier } from './breakpoints.js';

export {
  CAPTION_ARRIVAL_MS,
  DURATION_ORDER,
  DURATIONS_MS,
  durationMs,
  EASINGS,
  prefersReducedMotion,
  REDUCED_MOTION_DURATION_MS,
  REDUCED_MOTION_QUERY,
} from './motion.js';
export type { DurationName, EasingName } from './motion.js';

export {
  isVfTheme,
  LIGHT_SCHEME_QUERY,
  resolveSystemTheme,
  VF_DEFAULT_THEME,
  VF_THEME_ATTRIBUTE,
  VF_THEMES,
} from './theme.js';
export type { VfTheme } from './theme.js';
