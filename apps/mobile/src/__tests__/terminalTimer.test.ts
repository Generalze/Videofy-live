/** @author masterzee001 */
/**
 * T1 — the clocks that must stop when the call does.
 *
 * A call runs two timers. The screen's own stops on the terminal state. The
 * system's belongs to the self-managed Telecom connection, which an ANSWERED
 * call deliberately keeps alive -- IncomingCallService only ends it when the
 * reason is not "answered" -- so it is closed later, by `reportCallEnded`.
 *
 * That chain runs across three files and no single one of them shows it, which
 * is why it is written down here: terminal state -> the screen leaves ->
 * App.tsx ends the Telecom connection. Breaking any link leaves the system
 * counting behind a screen that has already said the call is over.
 *
 * Evidence for T1 alone. Nothing here is evidence about video, ringing,
 * notifications, or the hangup paint (T2), each of which is tested separately.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_DIRECT_STATES } from '../call/directCallApi';
import { callTickIntervalMs, callTickWanted, startCallTick } from '../call/callTimer';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/gu, '\n');

const screen = read('../screens/CallScreen.tsx');
// The root component sits OUTSIDE src/, which is where the wiring lives.
const app = read('../../App.tsx');

describe('every terminal state the server can send is terminal here', () => {
  it.each(['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended'])(
    '%s ends the call',
    (state) => {
      expect(TERMINAL_DIRECT_STATES.has(state)).toBe(true);
    },
  );

  it('holds nothing else, so a live call is never mistaken for a dead one', () => {
    for (const live of ['calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting']) {
      expect(TERMINAL_DIRECT_STATES.has(live)).toBe(false);
    }
  });
});

describe("the screen's own timer stops", () => {
  /*
   * MEASURED, NOT MATCHED. Until 20 Sep this whole section asserted the SOURCE
   * TEXT of two lines in CallScreen.tsx, and a mutant that deleted the tick
   * effect's `return () => clearInterval(timer)` -- leaking the interval so the
   * clock ran on after the call ended, the exact property this file exists to
   * protect -- left both asserted strings byte-identical and the suite green.
   *
   * The condition and the interval now live in ../call/callTimer.ts as ordinary
   * functions, and these call them.
   */
  it('refuses to tick at all once the server has ended the call', () => {
    expect(
      callTickWanted({ terminal: true, connectedAtMs: 1_000, ringExpiresAtMs: 2_000 }),
    ).toBe(false);
    expect(callTickWanted({ terminal: true, connectedAtMs: 1_000, ringExpiresAtMs: null })).toBe(false);
    expect(callTickWanted({ terminal: true, connectedAtMs: null, ringExpiresAtMs: null })).toBe(false);
  });

  it('ticks for a duration to advance OR a ring deadline to draw', () => {
    // Widened 20 Sep: it used to need an origin, which left the outgoing ring
    // arc frozen for the whole of the ring -- the one phase it exists for.
    expect(callTickWanted({ terminal: false, connectedAtMs: 1_000, ringExpiresAtMs: null })).toBe(true);
    expect(callTickWanted({ terminal: false, connectedAtMs: null, ringExpiresAtMs: 2_000 })).toBe(true);
    expect(callTickWanted({ terminal: false, connectedAtMs: null, ringExpiresAtMs: null })).toBe(false);
    // Faster while there is an arc: a second-by-second arc steps, and a stepping
    // arc reads as a rendering fault rather than a measurement.
    expect(callTickIntervalMs(null)).toBe(250);
    expect(callTickIntervalMs(1_000)).toBe(1_000);
  });

  it('CANCELS the interval it started, which is the whole point', () => {
    const cancelled: unknown[] = [];
    const handle = Symbol('interval');
    const ticks: number[] = [];
    const stop = startCallTick({
      ticking: true,
      intervalMs: 1_000,
      onTick: (nowMs) => ticks.push(nowMs),
      now: () => 4_242,
      schedule: () => handle,
      cancel: (given) => cancelled.push(given),
    });
    // Once immediately: the screen may have been still before the reason to
    // tick appeared, and the first painted figure must not be stale.
    expect(ticks).toEqual([4_242]);
    expect(stop).toBeTypeOf('function');
    stop?.();
    expect(cancelled).toEqual([handle]);
  });

  it('starts nothing at all when there is nothing to advance', () => {
    let scheduled = 0;
    const stop = startCallTick({
      ticking: false,
      intervalMs: 1_000,
      onTick: () => undefined,
      schedule: () => {
        scheduled += 1;
        return null;
      },
      cancel: () => undefined,
    });
    expect(stop).toBeUndefined();
    expect(scheduled).toBe(0);
  });

  it('is armed by the screen from those two functions and nothing else', () => {
    // The one assertion here that is about the FILE rather than the outcome:
    // the effect has to be the call, or the measurements above prove nothing
    // about the screen. Everything it could get wrong is measured above.
    expect(screen).toContain('const ticking = callTickWanted({ terminal, connectedAtMs, ringExpiresAtMs });');
    expect(screen).toContain('startCallTick({ ticking, intervalMs: tickIntervalMs, onTick: setNowMs })');
  });

  it('derives terminal from the server state, not the timer, roster or socket', () => {
    expect(screen).toContain(
      'const terminal = serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);',
    );
  });
});

describe("the system's timer stops too, through the whole chain", () => {
  it('a terminal state leaves the call screen without anyone tapping', () => {
    expect(screen).toContain('if (!terminal) return undefined;');
    expect(screen).toContain('const timer = setTimeout(() => onLeave(), 2500);');
  });

  it('leaving ends the Telecom connection', () => {
    // Without this the connection outlives the call: the OS keeps counting,
    // and the native module warns an un-ended one blocks every later call.
    expect(app).toContain('videofyCall.reportCallEnded(activeCall.callId);');
  });

  it('declining ends it as well, since that call was never answered', () => {
    expect(app).toContain('videofyCall.reportCallEnded(ringing.callId);');
  });
});
