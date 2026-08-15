/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  BASE_VIEWPORT_TIER,
  BREAKPOINT_ORDER,
  BREAKPOINTS,
  isAtLeast,
  mediaQueryBetween,
  mediaQueryDown,
  mediaQueryUp,
  resolveViewportTier,
  type BreakpointName,
} from '../breakpoints.js';

describe('breakpoint scale', () => {
  it('declares the order exhaustively and without repeats', () => {
    // BREAKPOINT_ORDER is hand-written so the ordering is a contract rather
    // than an accident of object key insertion. That only holds if it stays
    // in step with BREAKPOINTS.
    expect([...BREAKPOINT_ORDER].sort()).toEqual(Object.keys(BREAKPOINTS).sort());
    expect(new Set(BREAKPOINT_ORDER).size).toBe(BREAKPOINT_ORDER.length);
  });

  it('ascends strictly', () => {
    const widths = BREAKPOINT_ORDER.map((name) => BREAKPOINTS[name]);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1] as number);
    }
  });

  it('uses whole pixels inside a plausible viewport range', () => {
    for (const name of BREAKPOINT_ORDER) {
      const width = BREAKPOINTS[name];
      expect(Number.isInteger(width)).toBe(true);
      // A fractional or absurd threshold means a typo, and a typo in a
      // breakpoint produces a layout that only breaks on someone else's
      // machine.
      expect(width).toBeGreaterThanOrEqual(320);
      expect(width).toBeLessThanOrEqual(2560);
    }
  });
});

describe('media query construction', () => {
  it('builds min-width queries from the scale', () => {
    expect(mediaQueryUp('md')).toBe('(min-width: 768px)');
  });

  it('leaves no gap between a tier and the tier below it', () => {
    // The whole point of the 0.02px epsilon: browsers report fractional
    // viewport widths under zoom and on scaled displays, so `max-width: 767px`
    // beside `min-width: 768px` leaves 767.5px matching neither rule.
    for (let i = 1; i < BREAKPOINT_ORDER.length; i += 1) {
      const upper = BREAKPOINT_ORDER[i] as BreakpointName;
      const downQuery = mediaQueryDown(upper);
      const ceiling = Number(/max-width: ([\d.]+)px/.exec(downQuery)?.[1]);

      expect(ceiling).toBeLessThan(BREAKPOINTS[upper]);
      // Under 0.05px of daylight: small enough that no real device width can
      // fall through, large enough that no engine rounds it away.
      expect(BREAKPOINTS[upper] - ceiling).toBeLessThan(0.05);
    }
  });

  it('builds half-open bands that tile without overlapping', () => {
    expect(mediaQueryBetween('md', 'lg')).toBe('(min-width: 768px) and (max-width: 1023.98px)');
  });
});

describe('resolveViewportTier', () => {
  it('treats a breakpoint width as belonging to the tier it opens', () => {
    // Must agree with `min-width`, which is inclusive. Off-by-one here means
    // JS and CSS disagree about the layout at exactly 768px.
    expect(resolveViewportTier(BREAKPOINTS.md)).toBe('md');
    expect(resolveViewportTier(BREAKPOINTS.md - 1)).toBe('sm');
  });

  it('falls back to the implicit base tier below the first breakpoint', () => {
    expect(resolveViewportTier(0)).toBe(BASE_VIEWPORT_TIER);
    expect(resolveViewportTier(BREAKPOINTS.sm - 1)).toBe(BASE_VIEWPORT_TIER);
  });

  it('assigns every width to exactly one tier', () => {
    // Sweep the whole plausible axis: any width that resolves to a tier it is
    // not actually wide enough for, or fails to resolve to the widest tier it
    // qualifies for, is an overlap or a hole in the scale.
    for (let width = 0; width <= 2600; width += 1) {
      const tier = resolveViewportTier(width);
      const qualifying = BREAKPOINT_ORDER.filter((name) => isAtLeast(width, name));
      const expected = qualifying.at(-1) ?? BASE_VIEWPORT_TIER;
      expect(tier).toBe(expected);
    }
  });
});
