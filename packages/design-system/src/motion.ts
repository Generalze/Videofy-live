/** @owner masterzee001 */
/**
 * Motion durations and easing (§5.1.11, §5.1.12).
 *
 * Motion in Videofy is functional: it reports state changes on a live call.
 * Some of those state changes are sequenced from JavaScript rather than CSS —
 * "wait for the drawer to finish closing, then move focus", "hold the recovery
 * banner until the reconnect animation lands" — and those timeouts must use
 * the same numbers as the stylesheet, or focus lands on a moving target.
 *
 * The values are mirrored as `--vf-duration-*` / `--vf-ease-*` in tokens.css;
 * a test asserts the two agree, because two sources of truth that nobody
 * checks are one source of truth and one bug.
 */

/**
 * The duration scale, in milliseconds.
 *
 * Nothing here is under 80ms (below roughly 60ms a transition reads as an
 * instant jump, so the motion is cost without signal) and nothing is over
 * 480ms (on a live call, anything slower makes the interface feel like it is
 * lagging the conversation).
 */
export const DURATIONS_MS = {
  /** Press feedback. */
  instant: 80,
  /** Hover and focus colour changes. */
  fast: 120,
  /** Control state, small reveals. */
  normal: 200,
  /** Drawers, sheets, expanding panels. */
  slow: 320,
  /** Stage transitions, participant entry and exit. */
  slower: 480,
} as const;

export type DurationName = keyof typeof DURATIONS_MS;

/** Ascending order, stated rather than derived. */
export const DURATION_ORDER: readonly DurationName[] = [
  'instant',
  'fast',
  'normal',
  'slow',
  'slower',
];

/**
 * Caption arrival, deliberately outside the ordered scale because it is a
 * product decision rather than a rung: a caption that fades in slowly is a
 * caption that lags the speech it transcribes, and captions are a safety
 * fallback (§12), not decoration. Capped below `normal`.
 */
export const CAPTION_ARRIVAL_MS = 160;

/**
 * Easing curves.
 *
 * `standard` is asymmetric — leaves fast, arrives slow — which is what makes an
 * element look like it has mass. Nothing overshoots: a spring on a call
 * surface reads as instability, and beside live video it competes with the
 * thing the user is actually watching.
 */
export const EASINGS = {
  /** The workhorse. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Entering: arrives and settles. */
  decelerate: 'cubic-bezier(0, 0, 0, 1)',
  /** Leaving: commits and goes. */
  accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  /** Large surfaces that need a moment of presence (stage, sheet). */
  emphasized: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  /**
   * Audio level meters and determinate progress only. An eased level meter
   * accelerates and decelerates independently of the signal, which means it
   * misreports the thing it exists to show.
   */
  linear: 'linear',
} as const;

export type EasingName = keyof typeof EASINGS;

/**
 * What every duration collapses to when the user asks for reduced motion.
 *
 * 1ms, not 0. At zero, browsers may skip `transitionend` / `animationend`
 * entirely, and any logic sequenced on those events hangs forever. 1ms is
 * imperceptible and still fires. base.css re-points the CSS duration tokens to
 * the same value.
 */
export const REDUCED_MOTION_DURATION_MS = 1;

/**
 * A structural stand-in for `window.matchMedia`.
 *
 * The package deliberately does not pull in TypeScript's DOM lib: it is
 * consumed by browser apps but is not itself a DOM library, and widening the
 * lib for one call would let DOM globals leak into everything else here.
 */
interface MediaQueryListLike {
  readonly matches: boolean;
}

type MatchMediaLike = (query: string) => MediaQueryListLike;

function getMatchMedia(): MatchMediaLike | undefined {
  const candidate = (globalThis as { matchMedia?: unknown }).matchMedia;
  return typeof candidate === 'function' ? (candidate as MatchMediaLike) : undefined;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user has asked for reduced motion.
 *
 * Returns `false` where `matchMedia` is unavailable (SSR, tests, workers).
 * Defaulting to "motion is fine" is the right failure mode for a query that
 * only ever *removes* animation: the alternative would strip motion from every
 * server-rendered first paint for users who never asked for that.
 */
export function prefersReducedMotion(): boolean {
  return getMatchMedia()?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/**
 * The duration to use for a JS-sequenced delay, honouring reduced motion.
 *
 * Use this instead of reading `DURATIONS_MS` directly whenever the number
 * feeds a `setTimeout`. CSS transitions already collapse via the token
 * override in base.css; JS timers do not, and a 480ms wait before focus moves
 * is exactly the kind of unexplained pause reduced-motion users are asking to
 * be rid of.
 */
export function durationMs(name: DurationName): number {
  return prefersReducedMotion() ? REDUCED_MOTION_DURATION_MS : DURATIONS_MS[name];
}
