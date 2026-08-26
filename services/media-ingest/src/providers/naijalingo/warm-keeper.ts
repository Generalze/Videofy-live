/** @author masterzee001 */
/**
 * Keeping scale-to-zero capacity awake for as long as somebody is using it.
 *
 * THE PROBLEM, measured rather than assumed. 9jaLingo runs on inference
 * capacity that scales to zero: `GET /v1/health` on an idle endpoint returns
 * `engine_ready: false`, `current_copy_count: 0`, and synthesis is refused with
 * a 503 saying capacity is starting and to retry in about five minutes.
 *
 * On a live call that is the worst possible timing. The fallback chain does its
 * job -- a general vendor answers -- but a general vendor is precisely what a
 * Yoruba listener should not be hearing, so the specialist is missing at the
 * one moment it was added for.
 *
 * WHAT THIS CAN AND CANNOT FIX. It cannot make a cold start fast; only the
 * vendor can. What it can do is stop a deployment going cold WHILE IT IS IN
 * USE, which is the case that matters: the first Nigerian-language sentence
 * after a long quiet period may still fall back, but the second call of the
 * afternoon will not, and a call that runs past the idle threshold will not go
 * cold underneath itself.
 *
 * IDLE MEANS STOP, and that is deliberate. Pinging an endpoint forever is
 * paying to keep somebody else's GPU warm for nobody, so the keeper falls
 * silent once demand does. A deployment that would rather always be warm can
 * say so with `alwaysOn` -- an explicit choice with an obvious cost, not a
 * default that quietly runs up a bill.
 */

export interface WarmKeeperOptions {
  /** Fire one warm-up. Must not throw, and nothing waits on it. */
  readonly warm: () => void;
  /** How often to ping while warm-keeping is active. */
  readonly intervalMs: number;
  /** Stop this long after the last real use. Ignored when `alwaysOn`. */
  readonly idleAfterMs: number;
  /**
   * Keep pinging whether or not anybody is using it.
   *
   * Off by default. Always-warm has a real cost and a deployment should choose
   * it, rather than discover it.
   */
  readonly alwaysOn?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly setIntervalImpl?: typeof setInterval | undefined;
  readonly clearIntervalImpl?: typeof clearInterval | undefined;
}

export interface WarmKeeper {
  /** Called when the specialist was actually asked for something. */
  noteUsed(): void;
  /** Stop all timers. Safe to call twice. */
  stop(): void;
  /** For tests and logs: is a timer currently running? */
  readonly active: boolean;
}

export function createWarmKeeper(options: WarmKeeperOptions): WarmKeeper {
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastUsedAt = 0;

  const stop = (): void => {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  };

  const tick = (): void => {
    if (options.alwaysOn !== true && now() - lastUsedAt > options.idleAfterMs) {
      // Demand has stopped. So does the spending.
      stop();
      return;
    }
    options.warm();
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = setIntervalFn(tick, options.intervalMs);
    /*
     * A keep-alive must never be the reason a process refuses to exit. `unref`
     * is missing from the DOM timer typing that some builds resolve, so it is
     * probed rather than assumed.
     */
    const handle = timer as unknown as { unref?: () => void };
    handle.unref?.();
  };

  if (options.alwaysOn === true) start();

  return {
    noteUsed(): void {
      lastUsedAt = now();
      start();
    },
    stop,
    get active(): boolean {
      return timer !== null;
    },
  };
}
