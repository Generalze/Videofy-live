/** @author masterzee001 */
/**
 * THE ARC AROUND AN OUTGOING CALL, and the three things it got wrong while it
 * lived inside JSX where nothing could read it.
 *
 * It filled towards a deadline that ENDS the call, so a nearly full arc under
 * "Calling…" meant the call was about to be abandoned. It drew a quarter-arc,
 * in the colour and weight of a measurement, whenever there was nothing to
 * measure. And it was drawn at the same radius as the dashed ring, so it
 * painted the board's motif away as it swept.
 */
import { describe, expect, it } from 'vitest';
import { ringGeometry } from '../call/callRingGeometry';

const SIZE = 188;
const STROKE = 2;
const at = (remaining: number | null) => ringGeometry({ size: SIZE, stroke: STROKE, remaining });

/** The drawn run of a dash pattern, which is the length of the arc. */
const drawn = (dash: string): number => Number(dash.split(' ')[0]);

describe('the arc is absent unless something was measured', () => {
  it('draws NO arc without a deadline -- not a quarter of one', () => {
    const geometry = at(null);
    expect(geometry.arc).toBeNull();
    // The dashed ring is texture and is always there; it asserts nothing.
    expect(geometry.radius).toBeCloseTo((SIZE - STROKE) / 2, 6);
  });
});

describe('the arc DRAINS: it is time left, so it reads as time left', () => {
  it('is a whole circle at the start of the ring window', () => {
    const arc = at(1)?.arc;
    expect(arc).not.toBeNull();
    expect(drawn(arc!.dash)).toBeCloseTo(arc!.circumference, 6);
  });

  it('is empty at the deadline', () => {
    const arc = at(0)!.arc!;
    expect(drawn(arc.dash)).toBeCloseTo(0, 6);
  });

  it('shrinks as the ring goes on', () => {
    const early = drawn(at(0.9)!.arc!.dash);
    const late = drawn(at(0.1)!.arc!.dash);
    expect(late).toBeLessThan(early);
  });

  it('puts its head back at the top as it empties, and at the top when full', () => {
    const centre = SIZE / 2;
    const full = at(1)!.arc!;
    const empty = at(0)!.arc!;
    // 12 o'clock: the same x, and above the centre in SVG coordinates.
    expect(full.head.cx).toBeCloseTo(centre, 6);
    expect(full.head.cy).toBeCloseTo(centre - full.radius, 6);
    expect(empty.head.cx).toBeCloseTo(centre, 6);
    expect(empty.head.cy).toBeCloseTo(centre - empty.radius, 6);
    // A quarter left is three o'clock, a quarter of the way round clockwise.
    const quarter = at(0.25)!.arc!;
    expect(quarter.head.cx).toBeCloseTo(centre + quarter.radius, 6);
    expect(quarter.head.cy).toBeCloseTo(centre, 6);
  });
});

describe('the arc never paints over the motif it travels in', () => {
  it('is drawn inside the dashed ring, clear of both stroke widths', () => {
    const geometry = at(0.5);
    expect(geometry.arc!.radius).toBeLessThan(geometry.radius - STROKE);
  });
});

describe('a share computed from two clocks is not trusted', () => {
  it('never draws more than a lap, or less than none', () => {
    const over = at(1.4)!.arc!;
    expect(drawn(over.dash)).toBeCloseTo(over.circumference, 6);
    const under = at(-0.3)!.arc!;
    expect(drawn(under.dash)).toBeCloseTo(0, 6);
    const broken = at(Number.NaN)!.arc!;
    expect(drawn(broken.dash)).toBeCloseTo(0, 6);
  });

  it('completes the circle with the gap, so no second lap is drawn', () => {
    const arc = at(0.4)!.arc!;
    const [run, gap] = arc.dash.split(' ').map(Number);
    expect((run ?? 0) + (gap ?? 0)).toBeCloseTo(arc.circumference, 6);
  });
});
