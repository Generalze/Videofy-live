/** @author masterzee001 */
/**
 * THE THREE TREATMENTS, AND THE ARC THAT IS A MEASUREMENT.
 *
 * `directCallPhase` deliberately re-uses the timer row's own condition rather
 * than forming a second opinion about whether a call is up. Two answers to "is
 * this connected" is exactly how the screen came to read Connected for a call
 * the server had put back to `connecting` (see callDisplay.ts), and a phase
 * that decided independently would reintroduce that disagreement one layer
 * further out.
 *
 * `ringProgress` is the outgoing arc. It is drawn from the server's own
 * `expiresAtMs` -- the deadline at which the gateway itself ends the call as
 * no_answer -- so the arc really is the share of the ring that has gone. It
 * answers null wherever there is nothing to measure, and the screen then draws
 * the static motif instead of an empty gauge.
 */
import { describe, expect, it } from 'vitest';
import { callEyebrow, directCallPhase, endedSummaryLine } from '../call/callDisplay';
import {
  formatSpokenElapsed,
  monotonicRingProgress,
  observeRingWindow,
  ringProgress,
} from '../call/callTimer';

describe('which treatment a direct call is in', () => {
  it('is placing while the call has not connected', () => {
    expect(
      directCallPhase({ serverState: 'ringing', elapsedMs: null, connectedRowShown: false }),
    ).toBe('placing');
  });

  it('is live once there is an origin AND a live state to describe', () => {
    expect(
      directCallPhase({ serverState: 'connected', elapsedMs: 4000, connectedRowShown: true }),
    ).toBe('live');
  });

  it('is NOT live on a historic origin the server has stopped standing behind', () => {
    // `connectedRow` answers show:false for a terminal state even though
    // `connectedAtMs` still exists. The phase has to follow it, or the screen
    // would draw a running call around a call that is over.
    expect(
      directCallPhase({ serverState: 'ended', elapsedMs: 291_000, connectedRowShown: false }),
    ).toBe('ended');
  });

  it('FOLLOWS the connected row rather than forming a second opinion', () => {
    /*
     * The contract, pinned at the boundary. Today the only reason
     * `connectedRow` hides itself on a non-terminal state is one this phase
     * would also reach on its own -- so dropping `connectedRowShown` from the
     * condition would pass every other test in this file, which is exactly
     * what a mutation run found. The parameter is not decoration: the moment
     * the row grows a second reason to hide, a phase that had quietly stopped
     * consulting it would draw a live call around one the row is refusing to
     * describe, which is the September disagreement all over again.
     */
    expect(
      directCallPhase({ serverState: 'connecting', elapsedMs: 4000, connectedRowShown: false }),
    ).toBe('placing');
  });

  it('is ended for every terminal state, answered or not', () => {
    for (const state of ['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended']) {
      expect(directCallPhase({ serverState: state, elapsedMs: null, connectedRowShown: false })).toBe(
        'ended',
      );
    }
  });
});

describe('the eyebrow names the moment, and says nothing during the call', () => {
  it('reads Calling at the end that placed the call', () => {
    expect(callEyebrow('ringing', 'caller', 'placing')).toBe('Calling…');
  });

  it('reads Connecting at the end that answered it', () => {
    expect(callEyebrow('answered', 'callee', 'placing')).toBe('Connecting');
  });

  it('is absent on a live call, where the timer already says everything', () => {
    expect(callEyebrow('connected', 'caller', 'live')).toBeNull();
  });

  it('reads Call ended once the call is over, at either end', () => {
    expect(callEyebrow('declined', 'caller', 'ended')).toBe('Call ended');
    expect(callEyebrow('ended', 'callee', 'ended')).toBe('Call ended');
  });
});

describe('the ended screen states a length, not a clock face', () => {
  it('reads minutes and seconds in words', () => {
    expect(formatSpokenElapsed(291_000)).toBe('4 min 51 s');
  });

  it('keeps the seconds, and the hours when there are any', () => {
    expect(formatSpokenElapsed(3_723_000)).toBe('1 hr 2 min 3 s');
    expect(formatSpokenElapsed(7_000)).toBe('7 s');
    expect(formatSpokenElapsed(0)).toBe('0 s');
    expect(formatSpokenElapsed(120_000)).toBe('2 min');
  });

  it('says the call was translated only where that was PROVEN', () => {
    expect(endedSummaryLine(291_000, 'translated', 'translated')).toBe('4 min 51 s · translated');
    expect(endedSummaryLine(291_000, 'normal', 'unproven')).toBe('4 min 51 s · original voices');
  });

  it('will not certify a translated call the phone measured as untranslated', () => {
    /*
     * THE WORST DEFECT OF THE FIRST CUT. The line derived "· translated" from
     * the configured MODE alone, while the screen above it had spent four
     * minutes saying "This server cannot translate" from the gateway's own
     * `translation-engine-unavailable`. The contradiction was measured and
     * thrown away; three elements then agreed on the false half and nothing
     * dissented.
     */
    expect(endedSummaryLine(291_000, 'translated', 'not-translated')).toBe('4 min 51 s · not translated');
  });

  it('has a weaker word for a call that only ever produced translated TEXT', () => {
    /*
     * A caption proves the engine ran and its output reached the handset. It is
     * not proof that anybody heard a translation, and for a day it was enough
     * to print the bare word "translated" on a call in which every translated
     * frame was turned away -- the 19 Sep production failure, certified.
     */
    expect(endedSummaryLine(291_000, 'translated', 'text-only')).toBe(
      '4 min 51 s · translated text only',
    );
  });

  it('says so when it worked and then stopped', () => {
    expect(endedSummaryLine(291_000, 'translated', 'interrupted')).toBe(
      '4 min 51 s · translation stopped partway',
    );
  });

  it('claims NOTHING about a translated call in which nothing was measured', () => {
    // Configured translated, nothing played, nothing captioned, no fault
    // reported. The duration is a fact; "· translated" would not be.
    expect(endedSummaryLine(291_000, 'translated', 'unproven')).toBe('4 min 51 s');
  });

  it('states the duration alone when the server never named a mode', () => {
    expect(endedSummaryLine(291_000, null, 'unproven')).toBe('4 min 51 s');
    expect(endedSummaryLine(291_000, null, 'translated')).toBe('4 min 51 s');
  });

  it('states NOTHING for a call that never connected', () => {
    // A declined call has no duration. "0 s · translated" would describe a
    // conversation that did not happen.
    expect(endedSummaryLine(null, 'translated', 'translated')).toBeNull();
  });
});

describe('the outgoing arc is a share of the server ring window', () => {
  const EXPIRES = 1_700_000_045_000;
  const WINDOW = 45_000;
  /** Server time == phone time, so the arithmetic is readable. */
  const OFFSET = 0;

  it('captures the window once, from the first deadline it is told about', () => {
    const first = observeRingWindow(null, EXPIRES, OFFSET, EXPIRES - WINDOW);
    expect(first).toBe(WINDOW);
    // A later wire never moves it, for the same reason the clock offset is
    // measured once: a resume ack carries a state that transitioned long ago.
    expect(observeRingWindow(first, EXPIRES, OFFSET, EXPIRES - 10_000)).toBe(WINDOW);
  });

  it('captures nothing from a wire that carried no deadline', () => {
    expect(observeRingWindow(null, null, OFFSET, EXPIRES)).toBeNull();
    expect(observeRingWindow(null, EXPIRES, OFFSET, EXPIRES + 1)).toBeNull();
  });

  it('is empty at the start of the ring and full at its deadline', () => {
    const at = (localNowMs: number) =>
      ringProgress({ expiresAtMs: EXPIRES, windowMs: WINDOW, offsetMs: OFFSET, localNowMs });
    expect(at(EXPIRES - WINDOW)).toBe(0);
    expect(at(EXPIRES - WINDOW / 2)).toBeCloseTo(0.5, 5);
    expect(at(EXPIRES)).toBe(1);
  });

  it('never draws a second lap past the deadline', () => {
    expect(
      ringProgress({ expiresAtMs: EXPIRES, windowMs: WINDOW, offsetMs: OFFSET, localNowMs: EXPIRES + 30_000 }),
    ).toBe(1);
  });

  it('computes a smaller share when the server moves the deadline', () => {
    /*
     * Answering extends the window by the answer grace (direct-call-lifecycle's
     * `answering`). The denominator is the first window this screen saw, so a
     * deadline pushed forward computes as less of the ring gone. That is the
     * arithmetic; what the SCREEN may draw from it is the next test.
     */
    const extended = EXPIRES + 15_000;
    const before = ringProgress({ expiresAtMs: EXPIRES, windowMs: WINDOW, offsetMs: OFFSET, localNowMs: EXPIRES - 5_000 });
    const after = ringProgress({ expiresAtMs: extended, windowMs: WINDOW, offsetMs: OFFSET, localNowMs: EXPIRES - 5_000 });
    expect(before).toBeCloseTo(0.888, 2);
    expect(after).toBeCloseTo(0.555, 2);
    expect(after).toBeLessThan(before as number);
  });

  it('NEVER GROWS on screen: an extension holds the arc, it does not refill it', () => {
    /*
     * The documented Answer grace, step by step: a 30 s window captured at
     * t=0; at t=24 s a fifth of the arc is left; the server pushes
     * `expiresAtMs` 30 s out. The raw share drops to zero, so the arc snapped
     * from a fifth back to FULL in one frame and then sat motionless for six
     * seconds -- which reads as a ring that restarted, and then as a display
     * that has stopped measuring. The high-water mark holds it where it was
     * until the drain catches up.
     */
    const window = 30_000;
    const deadline = 1_700_000_030_000;
    const at = (expiresAtMs: number, localNowMs: number) =>
      ringProgress({ expiresAtMs, windowMs: window, offsetMs: OFFSET, localNowMs });
    const t24 = at(deadline, deadline - 6_000);
    expect(t24).toBeCloseTo(0.8, 5);
    let seen = monotonicRingProgress(null, t24);
    expect(seen).toBeCloseTo(0.8, 5);
    // The extension lands. The raw figure collapses; the arc does not move.
    const extended = deadline + 30_000;
    const jump = at(extended, deadline - 6_000);
    expect(jump).toBe(0);
    seen = monotonicRingProgress(seen, jump);
    expect(seen).toBeCloseTo(0.8, 5);
    // Six seconds of the extension spent: still held, never grown.
    seen = monotonicRingProgress(seen, at(extended, deadline));
    expect(seen).toBeCloseTo(0.8, 5);
    // And it drains again once the new deadline is closer than the old one was.
    const later = monotonicRingProgress(seen, at(extended, extended - 3_000));
    expect(later).toBeCloseTo(0.9, 5);
    // Nothing to measure stays nothing to measure: no stale arc is kept.
    expect(monotonicRingProgress(seen, null)).toBeNull();
  });

  it('is EMPTY, not part-filled, when the new deadline is past the whole window', () => {
    /*
     * Answering extends the deadline by the answer grace, which can push the
     * remaining time BEYOND the window this screen captured -- 45 s captured,
     * 60 s of grace granted at t=40 s. The elapsed share is then negative, and
     * an absolute value taken on it (a mutation run's survivor) would fill a
     * third of the arc at the exact moment the call was rescued from timing
     * out. There is no such thing as less than none of the ring gone.
     */
    const generous = EXPIRES + 20_000;
    expect(
      ringProgress({
        expiresAtMs: generous,
        windowMs: WINDOW,
        offsetMs: OFFSET,
        localNowMs: EXPIRES - WINDOW,
      }),
    ).toBe(0);
  });

  it('measures against the SERVER clock, not the handset one', () => {
    // The phone is two minutes fast. Read on the phone's own clock the ring
    // would already be over; corrected by the measured offset it is halfway.
    const offset = 120_000;
    expect(
      ringProgress({
        expiresAtMs: EXPIRES,
        windowMs: WINDOW,
        offsetMs: offset,
        localNowMs: EXPIRES - WINDOW / 2 + offset,
      }),
    ).toBeCloseTo(0.5, 5);
  });

  it('draws no arc at all when there is nothing to measure', () => {
    const none = { offsetMs: OFFSET, localNowMs: EXPIRES };
    expect(ringProgress({ ...none, expiresAtMs: null, windowMs: WINDOW })).toBeNull();
    expect(ringProgress({ ...none, expiresAtMs: EXPIRES, windowMs: null })).toBeNull();
    // 0 is the normaliser's "the wire carried none", never a 1970 deadline.
    expect(ringProgress({ ...none, expiresAtMs: 0, windowMs: WINDOW })).toBeNull();
  });
});
