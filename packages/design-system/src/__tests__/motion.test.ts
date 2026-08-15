/** @owner masterzee001 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTION_ARRIVAL_MS,
  DURATION_ORDER,
  DURATIONS_MS,
  durationMs,
  EASINGS,
  prefersReducedMotion,
  REDUCED_MOTION_DURATION_MS,
  REDUCED_MOTION_QUERY,
  type DurationName,
} from '../motion.js';

/**
 * The package reads `matchMedia` off `globalThis` structurally rather than
 * taking TypeScript's DOM lib, so a stub is all that is needed to exercise
 * both branches under the node test environment.
 */
const globalWithMatchMedia = globalThis as { matchMedia?: unknown };

function stubMatchMedia(matching: readonly string[]): void {
  globalWithMatchMedia.matchMedia = (query: string) => ({
    matches: matching.includes(query),
  });
}

afterEach(() => {
  delete globalWithMatchMedia.matchMedia;
});

describe('duration scale', () => {
  it('declares the order exhaustively and without repeats', () => {
    expect([...DURATION_ORDER].sort()).toEqual(Object.keys(DURATIONS_MS).sort());
    expect(new Set(DURATION_ORDER).size).toBe(DURATION_ORDER.length);
  });

  it('ascends strictly', () => {
    const values = DURATION_ORDER.map((name) => DURATIONS_MS[name]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
  });

  it('stays inside the range that reads as motion on a live call', () => {
    for (const name of DURATION_ORDER) {
      // Below ~60ms a transition is an instant jump: cost without signal.
      // Above ~500ms the interface feels like it is lagging the conversation.
      expect(DURATIONS_MS[name]).toBeGreaterThanOrEqual(60);
      expect(DURATIONS_MS[name]).toBeLessThanOrEqual(500);
    }
  });

  it('keeps caption arrival below the normal step', () => {
    // A caption that fades in slowly is a caption that lags the speech it
    // transcribes, and captions are a safety fallback (§12), not decoration.
    expect(CAPTION_ARRIVAL_MS).toBeLessThan(DURATIONS_MS.normal);
    expect(CAPTION_ARRIVAL_MS).toBeGreaterThan(0);
  });
});

describe('easing curves', () => {
  it('are syntactically valid CSS timing functions', () => {
    for (const [name, curve] of Object.entries(EASINGS)) {
      if (curve === 'linear') {
        continue;
      }
      expect(curve, name).toMatch(/^cubic-bezier\(-?[\d.]+, -?[\d.]+, -?[\d.]+, -?[\d.]+\)$/);
    }
  });

  it('keep control-point x inside [0, 1]', () => {
    // x outside the unit interval is not a slow curve, it is an invalid one:
    // the browser rejects the whole declaration and the transition silently
    // falls back to `ease`.
    for (const [name, curve] of Object.entries(EASINGS)) {
      const points = /^cubic-bezier\((.+)\)$/.exec(curve)?.[1];
      if (points === undefined) {
        continue;
      }
      const [x1, , x2] = points.split(',').map((part) => Number(part.trim()));
      expect(x1, `${name} x1`).toBeGreaterThanOrEqual(0);
      expect(x1, `${name} x1`).toBeLessThanOrEqual(1);
      expect(x2, `${name} x2`).toBeGreaterThanOrEqual(0);
      expect(x2, `${name} x2`).toBeLessThanOrEqual(1);
    }
  });

  it('never overshoot', () => {
    // y outside [0, 1] is a bounce. Nothing bounces near live video: it reads
    // as instability and competes with the thing the user is watching.
    for (const [name, curve] of Object.entries(EASINGS)) {
      const points = /^cubic-bezier\((.+)\)$/.exec(curve)?.[1];
      if (points === undefined) {
        continue;
      }
      const [, y1, , y2] = points.split(',').map((part) => Number(part.trim()));
      expect(y1, `${name} y1`).toBeGreaterThanOrEqual(0);
      expect(y1, `${name} y1`).toBeLessThanOrEqual(1);
      expect(y2, `${name} y2`).toBeGreaterThanOrEqual(0);
      expect(y2, `${name} y2`).toBeLessThanOrEqual(1);
    }
  });
});

describe('reduced motion', () => {
  it('reports false when matchMedia is unavailable', () => {
    // SSR, workers and the node test environment. Defaulting to "motion is
    // fine" is the right failure mode for a query that only removes animation.
    expect(prefersReducedMotion()).toBe(false);
  });

  it('reports the user preference when matchMedia is present', () => {
    stubMatchMedia([]);
    expect(prefersReducedMotion()).toBe(false);

    stubMatchMedia([REDUCED_MOTION_QUERY]);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('collapses every JS-sequenced duration when the preference is set', () => {
    stubMatchMedia([REDUCED_MOTION_QUERY]);
    for (const name of DURATION_ORDER) {
      expect(durationMs(name)).toBe(REDUCED_MOTION_DURATION_MS);
    }
  });

  it('never collapses to zero', () => {
    // At 0ms browsers may skip transitionend/animationend entirely, and any
    // app logic sequenced on those events hangs forever.
    expect(REDUCED_MOTION_DURATION_MS).toBeGreaterThan(0);
  });

  it('passes the scale through untouched otherwise', () => {
    stubMatchMedia([]);
    for (const name of DURATION_ORDER as readonly DurationName[]) {
      expect(durationMs(name)).toBe(DURATIONS_MS[name]);
    }
  });
});
