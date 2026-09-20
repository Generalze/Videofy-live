/** @author masterzee001 */
/**
 * THE RING MOTIF, AS ARITHMETIC -- so the one thing it asserts can be proven.
 *
 * The board draws a dashed ring behind the avatar with a teal arc over it. The
 * dashed ring is TEXTURE: it says nothing and is always the same. The arc is a
 * MEASUREMENT, and three separate mistakes were found in the first version of
 * it, all of them invisible to a test suite because the numbers lived inside
 * JSX:
 *
 *   IT FILLED, AND FILLING MEANT THE OPPOSITE OF WHAT IT LOOKED LIKE. The
 *   figure behind it is the share of the server's ring window that has GONE
 *   (../call/callTimer.ts `ringProgress`), so a full arc under the word
 *   "Calling…" meant the call was one second from being abandoned. Every
 *   viewer reads a filling arc as progress towards something. So the arc now
 *   DRAINS: `remaining` is the share of the ring window LEFT, full when the
 *   ring starts and empty at the deadline. The measurement is unchanged; only
 *   the encoding is inverted, here, where it can be read.
 *
 *   A NULL MEASUREMENT DREW A QUARTER-ARC. With no deadline on the wire the
 *   component substituted a hand-drawn 0.25 in the same colour and weight as a
 *   measured arc. An unmeasured thing drawn in the language of a measured one
 *   is the same lie as a status line over silence. `remaining: null` now
 *   yields NO arc at all -- the dashed ring alone.
 *
 *   THE ARC ERASED THE MOTIF. Both circles were drawn at the same radius with
 *   the arc one point wider, so the arc painted over the dashed texture as it
 *   swept. They are concentric now, with the arc inside the dashes.
 */

export interface RingArc {
  /** Radius of the arc's own circle, inside the dashed ring. */
  readonly radius: number;
  readonly circumference: number;
  /** `strokeDasharray`: the drawn run, then the gap that finishes the circle. */
  readonly dash: string;
  /** The bright node at the head of the arc, in the SVG's own coordinates. */
  readonly head: { readonly cx: number; readonly cy: number };
}

export interface RingGeometry {
  readonly centre: number;
  /** The dashed ring: texture, never a value. */
  readonly radius: number;
  /** Null when nothing was measured. There is then nothing to draw. */
  readonly arc: RingArc | null;
}

/** Between none and all of it; a share computed from two clocks can land outside. */
function share(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * @param remaining the share of the ring window still LEFT, or null when no
 * deadline was measured. 1 is the start of the ring, 0 its deadline.
 */
export function ringGeometry(input: {
  readonly size: number;
  readonly stroke: number;
  readonly remaining: number | null;
}): RingGeometry {
  const centre = input.size / 2;
  const radius = (input.size - input.stroke) / 2;
  if (input.remaining === null) {
    return { centre, radius, arc: null };
  }
  const left = share(input.remaining);
  // Inside the dashes by more than both stroke widths, so a sweeping arc can
  // never sit on top of the texture it is supposed to travel within.
  const arcRadius = Math.max(1, radius - (input.stroke + 5));
  const circumference = 2 * Math.PI * arcRadius;
  const drawn = circumference * left;
  // 12 o'clock is -90deg and the arc is drawn clockwise from there, so its head
  // is `left` of a turn round -- and travels BACK towards the top as it drains.
  const headAngle = (left * 360 - 90) * (Math.PI / 180);
  return {
    centre,
    radius,
    arc: {
      radius: arcRadius,
      circumference,
      dash: `${drawn} ${Math.max(0, circumference - drawn)}`,
      head: {
        cx: centre + arcRadius * Math.cos(headAngle),
        cy: centre + arcRadius * Math.sin(headAngle),
      },
    },
  };
}
