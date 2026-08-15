/** @owner masterzee001 */
/**
 * Responsive breakpoints (§5.1.11).
 *
 * These exist in TypeScript because CSS cannot use them everywhere they are
 * needed. A custom property is not valid inside a media-query prelude —
 * `@media (min-width: var(--vf-breakpoint-md))` never matches, it does not
 * error — so any app that wants a breakpoint in JS (a `matchMedia` listener
 * deciding whether captions render in a side panel or over the stage, a
 * layout hook, a Playwright viewport) would otherwise hard-code the number.
 * That is exactly the drift the design system exists to prevent.
 *
 * The same values are mirrored as `--vf-breakpoint-*` in tokens.css; a test
 * asserts the two agree.
 */

/**
 * Mobile-first min-width thresholds, in CSS pixels.
 *
 * There is deliberately no 640 stop. Videofy has no layout that changes
 * between 480 and 768, and an unused breakpoint is an invitation to invent one
 * inconsistently.
 */
export const BREAKPOINTS = {
  /** Large phone. Two-up controls become possible. */
  sm: 480,
  /** Tablet portrait. The stacked call layout ends here. */
  md: 768,
  /** Laptop. Captions can move out of the stage into a side panel. */
  lg: 1024,
  /** Desktop. Stage, roster and captions coexist. */
  xl: 1280,
  /** Large desktop. Operator multi-zone console. */
  '2xl': 1536,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

/**
 * Ascending order. Declared explicitly rather than derived from `Object.keys`
 * so the ordering is a stated contract rather than an accident of key
 * insertion, and so a test can assert the two agree.
 */
export const BREAKPOINT_ORDER: readonly BreakpointName[] = ['sm', 'md', 'lg', 'xl', '2xl'];

/**
 * The implicit tier below `sm`. It has no threshold because it starts at zero;
 * `@media (min-width: 0)` is noise, and mobile-first styles are simply the
 * unqualified ones.
 */
export const BASE_VIEWPORT_TIER = 'xs';

export type ViewportTier = typeof BASE_VIEWPORT_TIER | BreakpointName;

/**
 * The gap subtracted from a min-width to build the matching max-width.
 *
 * Not 1px. Browsers report fractional viewport widths under page zoom and on
 * scaled displays, so `max-width: 767px` plus `min-width: 768px` leaves 767.5px
 * matching neither query — a real, reproducible dead zone where a layout loses
 * both its mobile and its desktop rules. 0.02px is the smallest step every
 * current engine handles without rounding it away.
 */
const RANGE_EPSILON_PX = 0.02;

/** `(min-width: 768px)` — everything from this tier upward. */
export function mediaQueryUp(name: BreakpointName): string {
  return `(min-width: ${BREAKPOINTS[name]}px)`;
}

/** `(max-width: 767.98px)` — everything strictly below this tier. */
export function mediaQueryDown(name: BreakpointName): string {
  return `(max-width: ${BREAKPOINTS[name] - RANGE_EPSILON_PX}px)`;
}

/**
 * `(min-width: 768px) and (max-width: 1023.98px)` — a half-open band, so
 * adjacent bands tile the axis without overlapping.
 */
export function mediaQueryBetween(from: BreakpointName, to: BreakpointName): string {
  return `${mediaQueryUp(from)} and ${mediaQueryDown(to)}`;
}

/**
 * The tier a given viewport width falls in.
 *
 * Boundaries are inclusive at the bottom: a viewport of exactly 768px is `md`,
 * matching `(min-width: 768px)`. Anything below `sm` is the implicit base tier.
 */
export function resolveViewportTier(width: number): ViewportTier {
  let tier: ViewportTier = BASE_VIEWPORT_TIER;
  for (const name of BREAKPOINT_ORDER) {
    if (width >= BREAKPOINTS[name]) {
      tier = name;
    }
  }
  return tier;
}

/** Whether a width satisfies `mediaQueryUp(name)`. */
export function isAtLeast(width: number, name: BreakpointName): boolean {
  return width >= BREAKPOINTS[name];
}
