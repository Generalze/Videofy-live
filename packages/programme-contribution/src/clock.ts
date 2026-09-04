/** @author masterzee001 */
/**
 * ONE CLOCK FOR THE WHOLE CONTRIBUTION.
 *
 * A programme's audio and video must advance together or the broadcast is
 * broken in the way that is hardest to notice and hardest to fix: not an
 * error, not a dropout, just lips that stop matching words some minutes in.
 *
 * The way that happens is banal. Two callbacks arrive, each samples the wall
 * clock, and each derives its own position from its own reading. They agree
 * for a while. Then a garbage collection lands between them, or the two sinks
 * deliver at different rates, and the two positions separate -- permanently,
 * because nothing downstream ever compares them.
 *
 * So there is exactly one clock here, established when the contribution
 * begins, and BOTH media derive their position from it. Neither ever samples
 * time for itself.
 *
 * IT IS MONOTONIC. `Date.now()` steps backwards when a host syncs its time,
 * and a programme clock that goes backwards produces segments that overlap
 * ones already published. The default source is the process's monotonic timer,
 * which is what that timer is for.
 */

/** A source of monotonically increasing milliseconds. Injected so tests drive it. */
export type MonotonicSource = () => number;

/** The default: a timer that cannot step backwards when the host syncs its clock. */
export const processMonotonic: MonotonicSource = () => {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1_000_000;
};

/**
 * Where a contribution has reached, relative to the moment it began.
 *
 * Run-relative rather than absolute on purpose: the number that matters is how
 * far into THIS broadcast a frame belongs, and an absolute timestamp would
 * carry the host's idea of the date into a programme's timeline.
 */
export class ContributionClock {
  private origin: number | null = null;
  private frozenAt: number | null = null;

  constructor(private readonly source: MonotonicSource = processMonotonic) {}

  /**
   * Begin, or resume after a reconnect.
   *
   * A RECONNECT DOES NOT RESTART THE BROADCAST. The transport is new and the
   * programme is not, so the clock is re-anchored so that its next reading
   * continues from where it stopped -- not from zero. Restarting would place
   * the returning contribution on top of material already published, and every
   * caption and advert positioned against those moments would point at the
   * wrong thing.
   */
  start(): void {
    const now = this.source();
    const resumeFrom = this.frozenAt ?? 0;
    this.origin = now - resumeFrom;
    this.frozenAt = null;
  }

  /** The contribution has stopped. Its position is held for a resume. */
  stop(): void {
    if (this.origin === null) return;
    this.frozenAt = this.source() - this.origin;
    this.origin = null;
  }

  get running(): boolean {
    return this.origin !== null;
  }

  /**
   * How far into the broadcast we are, in milliseconds.
   *
   * Zero before it starts, and held at the last position while stopped, so a
   * reading taken during a reconnect never jumps forward across the gap.
   */
  elapsedMs(): number {
    if (this.origin === null) return this.frozenAt ?? 0;
    return this.source() - this.origin;
  }
}

/**
 * How many whole frames should have been produced by now.
 *
 * The pacing rule for raw video: FFmpeg reading `rawvideo` derives every
 * timestamp from the frame COUNT and the declared rate, so the only way to
 * keep video honest is to hand it exactly as many frames as the clock says
 * have elapsed. A frame short is a frame of drift that never comes back.
 */
export function framesDueBy(elapsedMs: number, frameRate: number): number {
  if (frameRate <= 0) return 0;
  return Math.floor((elapsedMs * frameRate) / 1000);
}

/**
 * How many whole audio samples should have been produced by now.
 *
 * The same rule, from the same clock. Audio and video positions are two
 * readings of one number, which is what makes them stay together.
 */
export function samplesDueBy(elapsedMs: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return Math.floor((elapsedMs * sampleRate) / 1000);
}
