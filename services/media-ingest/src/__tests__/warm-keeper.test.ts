/**
 * Keeping scale-to-zero capacity awake, and knowing when to stop.
 *
 * Two failures matter here and they pull in opposite directions: going cold
 * while somebody is still using the service, and pinging an idle endpoint
 * forever because nothing told the timer to stop. Most of these tests are about
 * the second one, because it costs money quietly and no error is ever raised.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWarmKeeper } from '../providers/naijalingo/warm-keeper.js';

/** A hand-cranked clock and timer, so nothing here waits on real time. */
function harness(options: { idleAfterMs?: number; alwaysOn?: boolean } = {}) {
  let clock = 1_000_000;
  let scheduled: (() => void) | null = null;
  const warmed: number[] = [];

  const keeper = createWarmKeeper({
    warm: () => warmed.push(clock),
    intervalMs: 60_000,
    idleAfterMs: options.idleAfterMs ?? 300_000,
    alwaysOn: options.alwaysOn,
    now: () => clock,
    setIntervalImpl: ((callback: () => void) => {
      scheduled = callback;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {
      scheduled = null;
    }) as unknown as typeof clearInterval,
  });

  return {
    keeper,
    warmed,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => scheduled?.(),
    get running() {
      return scheduled !== null;
    },
  };
}

describe('while it is being used', () => {
  it('does not run before anything has used it', () => {
    const h = harness();
    expect(h.running).toBe(false);
    expect(h.warmed).toHaveLength(0);
  });

  it('starts keeping warm once used', () => {
    const h = harness();
    h.keeper.noteUsed();
    expect(h.running).toBe(true);
  });

  it('warms on each tick while use is recent', () => {
    const h = harness();
    h.keeper.noteUsed();

    h.advance(60_000);
    h.tick();
    h.advance(60_000);
    h.tick();

    expect(h.warmed).toHaveLength(2);
  });

  /*
   * The case this exists for: a call that runs longer than the idle threshold
   * must not go cold underneath itself, because continued use keeps pushing
   * the deadline out.
   */
  it('keeps going through a long session of continued use', () => {
    const h = harness({ idleAfterMs: 300_000 });
    h.keeper.noteUsed();

    for (let minute = 0; minute < 20; minute += 1) {
      h.advance(60_000);
      h.keeper.noteUsed();
      h.tick();
    }

    expect(h.running).toBe(true);
    expect(h.warmed.length).toBeGreaterThan(15);
  });

  it('starts again after it has stopped', () => {
    const h = harness({ idleAfterMs: 100_000 });
    h.keeper.noteUsed();
    h.advance(200_000);
    h.tick();
    expect(h.running).toBe(false);

    h.keeper.noteUsed();
    expect(h.running).toBe(true);
  });
});

describe('when demand stops', () => {
  /*
   * THE ONE THAT COSTS MONEY IF IT IS WRONG. An endpoint pinged forever is paid
   * for forever, and nothing raises an error to say so -- the bill is the only
   * signal.
   */
  it('stops once nothing has used it for the idle window', () => {
    const h = harness({ idleAfterMs: 300_000 });
    h.keeper.noteUsed();

    h.advance(400_000);
    h.tick();

    expect(h.running).toBe(false);
  });

  it('does not warm on the tick that discovers it is idle', () => {
    const h = harness({ idleAfterMs: 300_000 });
    h.keeper.noteUsed();

    h.advance(400_000);
    h.tick();

    expect(h.warmed).toHaveLength(0);
  });

  it('stops on request and stays stopped', () => {
    const h = harness();
    h.keeper.noteUsed();
    h.keeper.stop();
    expect(h.running).toBe(false);
    // Twice must be safe: shutdown paths call it without checking.
    expect(() => h.keeper.stop()).not.toThrow();
  });
});

describe('always on', () => {
  /*
   * An explicit choice with an obvious cost. It must be genuinely explicit --
   * a deployment that did not ask for this must never end up running it.
   */
  it('runs from the start without any use', () => {
    const h = harness({ alwaysOn: true });
    expect(h.running).toBe(true);
  });

  it('keeps warming long past the idle window', () => {
    const h = harness({ alwaysOn: true, idleAfterMs: 1000 });
    h.advance(999_999);
    h.tick();

    expect(h.running).toBe(true);
    expect(h.warmed).toHaveLength(1);
  });

  it('is off unless asked for', () => {
    expect(harness().running).toBe(false);
    expect(harness({ alwaysOn: false }).running).toBe(false);
  });
});

describe('not holding the process open', () => {
  /* A keep-alive must never be the reason a service refuses to exit. */
  it('unrefs its timer', () => {
    const unref = vi.fn();
    const keeper = createWarmKeeper({
      warm: () => undefined,
      intervalMs: 1000,
      idleAfterMs: 1000,
      setIntervalImpl: (() =>
        ({ unref }) as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    keeper.noteUsed();
    expect(unref).toHaveBeenCalled();
  });

  /* Some builds resolve DOM timer typings, where `unref` does not exist. */
  it('survives a timer with no unref', () => {
    const keeper = createWarmKeeper({
      warm: () => undefined,
      intervalMs: 1000,
      idleAfterMs: 1000,
      setIntervalImpl: (() => ({}) as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(() => keeper.noteUsed()).not.toThrow();
  });
});
