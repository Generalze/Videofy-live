/** @author masterzee001 */
/**
 * The lifecycle machine, driven directly.
 *
 * These assert TRANSITIONS, not their consequences. Three pins in this
 * adapter's history passed by accident because they counted array lengths
 * instead of checking the property they claimed to protect, and a state
 * machine is exactly the place where that mistake is invisible: a call that
 * skipped release and a call that completed it both end with one entry in
 * `closes`. So the path itself is the assertion here.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptsMediaIn,
  CallLifecycle,
  deliversMediaIn,
  guardedLogger,
  invokeBounded,
  mayTransition,
  type LifecycleState,
  type LifecycleSteps,
  type LifecycleTimers,
  type TerminationIntent,
} from '../lifecycle.js';

const ALL_STATES: readonly LifecycleState[] = [
  'active',
  'draining',
  'aborting',
  'terminating',
  'closed',
];

/** Every edge the design allows. Everything else must be refused. */
const PERMITTED: ReadonlyArray<readonly [LifecycleState, LifecycleState]> = [
  ['active', 'draining'],
  ['active', 'aborting'],
  ['draining', 'aborting'],
  ['draining', 'terminating'],
  ['aborting', 'terminating'],
  ['terminating', 'closed'],
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Timers that never fire on their own: the test decides when a deadline expires. */
function manualTimers(): {
  timers: LifecycleTimers;
  outstanding: () => number;
  fireAll: () => void;
} {
  const pending = new Map<number, () => void>();
  let nextId = 0;
  const timers: LifecycleTimers = {
    setTimer(handler) {
      nextId += 1;
      pending.set(nextId, handler);
      return nextId;
    },
    clearTimer(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    outstanding: () => pending.size,
    fireAll: () => {
      for (const [id, handler] of [...pending]) {
        pending.delete(id);
        handler();
      }
    },
  };
}

function recordingSteps(overrides: Partial<LifecycleSteps> = {}): {
  steps: LifecycleSteps;
  calls: string[];
  notified: TerminationIntent[];
} {
  const calls: string[] = [];
  const notified: TerminationIntent[] = [];
  const steps: LifecycleSteps = {
    async drain(intent) {
      calls.push('drain');
      await overrides.drain?.(intent);
    },
    discard(intent) {
      calls.push('discard');
      overrides.discard?.(intent);
    },
    release(intent) {
      calls.push('release');
      overrides.release?.(intent);
    },
    async notify(intent) {
      calls.push('notify');
      notified.push(intent);
      await overrides.notify?.(intent);
    },
  };
  return { steps, calls, notified };
}

/** Where the machine went, as a plain path. */
const pathOf = (lifecycle: CallLifecycle): LifecycleState[] =>
  lifecycle.transitions.map((transition) => transition.to);

describe('the transition table', () => {
  it('permits exactly the moves the design allows, checked over every pair', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const allowed = PERMITTED.some(([f, t]) => f === from && t === to);
        // Compared as objects so a failure names the pair rather than
        // reporting "expected false to be true" for one of twenty-five.
        expect({ from, to, permitted: mayTransition(from, to) }).toEqual({
          from,
          to,
          permitted: allowed,
        });
      }
    }
  });

  it('refuses the four moves that would each be a distinct defect', () => {
    // De-escalation: an abort that could become a bye again would hand the
    // engine the buffered speech of a call declared untrustworthy.
    expect(mayTransition('aborting', 'draining')).toBe(false);
    // CLOSED is a sink; a call cannot come back to life.
    expect(mayTransition('closed', 'active')).toBe(false);
    // No skipping release: CLOSED must be reached THROUGH termination.
    expect(mayTransition('active', 'closed')).toBe(false);
    expect(mayTransition('draining', 'closed')).toBe(false);
    // Every teardown records its delivery policy before anything is released.
    expect(mayTransition('active', 'terminating')).toBe(false);
  });

  it('separates admitting media from delivering it', () => {
    // Two different questions, and reading one for the other is how a
    // graceful hangup came to drop the last words of every call.
    expect(ALL_STATES.filter(acceptsMediaIn)).toEqual(['active']);
    expect(ALL_STATES.filter(deliversMediaIn)).toEqual(['active', 'draining']);
  });
});

describe('the paths a call may take', () => {
  it('a graceful close walks ACTIVE, DRAINING, TERMINATING, CLOSED', async () => {
    const { steps, calls } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('caller hung up', 'graceful');

    expect(pathOf(lifecycle)).toEqual(['draining', 'terminating', 'closed']);
    expect(calls).toEqual(['drain', 'discard', 'release', 'notify']);
    expect(lifecycle.refusedTransitions).toBe(0);
    expect(lifecycle.isClosed).toBe(true);
  });

  it('an abort walks ACTIVE, ABORTING, TERMINATING, CLOSED and never drains', async () => {
    const { steps, calls } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('refused', 'abort');

    expect(pathOf(lifecycle)).toEqual(['aborting', 'terminating', 'closed']);
    // The drain is not merely empty — it is never invited to run.
    expect(calls).toEqual(['discard', 'release', 'notify']);
    expect(lifecycle.refusedTransitions).toBe(0);
  });

  it('release always precedes CLOSED, and CLOSED is never reported before it', async () => {
    const seen: Array<{ state: LifecycleState; released: boolean }> = [];
    let released = false;
    const { steps } = recordingSteps({
      release: () => {
        released = true;
      },
    });
    const lifecycle = new CallLifecycle({
      steps,
      onTransition: (transition) => seen.push({ state: transition.to, released }),
    });
    await lifecycle.requestClose('bye', 'graceful');

    // Whatever else happened, nothing was still unreleased at CLOSED.
    expect(seen.find((entry) => entry.state === 'closed')).toEqual({
      state: 'closed',
      released: true,
    });
    expect(seen.find((entry) => entry.state === 'terminating')).toEqual({
      state: 'terminating',
      released: false,
    });
  });
});

describe('escalation', () => {
  it('an abort raised mid-drain escalates the machine and keeps its own reason', async () => {
    let lifecycle!: CallLifecycle;
    const { steps, notified } = recordingSteps({
      drain: () => {
        void lifecycle.requestClose('compromised: media policy refusal', 'abort');
      },
    });
    lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('bye', 'graceful');

    // The escalation is a real edge the machine took, in order.
    expect(lifecycle.transitions).toEqual([
      { from: 'active', to: 'draining' },
      { from: 'draining', to: 'aborting' },
      { from: 'aborting', to: 'terminating' },
      { from: 'terminating', to: 'closed' },
    ]);
    // Strength decides, not arrival order. A security abort filed under the
    // "bye" it overtook is a security event nobody will ever find.
    expect(lifecycle.terminationIntent).toEqual({
      mode: 'abort',
      reason: 'compromised: media policy refusal',
    });
    expect(notified).toEqual([
      { mode: 'abort', reason: 'compromised: media policy refusal' },
    ]);
    expect(lifecycle.refusedTransitions).toBe(0);
  });

  it('a second graceful close does not overwrite the first cause', async () => {
    const { steps, notified } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    const first = lifecycle.requestClose('caller hung up', 'graceful');
    const second = lifecycle.requestClose('rtp socket closed', 'graceful');
    await Promise.all([first, second]);

    // The second is usually a consequence of the first, so the first is the
    // one that explains the call.
    expect(notified).toEqual([{ mode: 'graceful', reason: 'caller hung up' }]);
  });

  it('a graceful close behind an abort cannot soften it', async () => {
    const { steps, calls, notified } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    const abort = lifecycle.requestClose('compromised', 'abort');
    const polite = lifecycle.requestClose('bye', 'graceful');
    await Promise.all([abort, polite]);

    expect(pathOf(lifecycle)).toEqual(['aborting', 'terminating', 'closed']);
    expect(calls).not.toContain('drain');
    expect(notified).toEqual([{ mode: 'abort', reason: 'compromised' }]);
  });

  it('an abort arriving after release upgrades the reason but moves nothing backwards', async () => {
    let lifecycle!: CallLifecycle;
    const { steps } = recordingSteps({
      notify: () => {
        void lifecycle.requestClose('discovered during teardown', 'abort');
      },
    });
    lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('bye', 'graceful');

    // No terminating -> aborting edge exists, so none was taken.
    expect(pathOf(lifecycle)).toEqual(['draining', 'terminating', 'closed']);
    expect(lifecycle.refusedTransitions).toBe(0);
    // The truth about why the call ended is still recorded.
    expect(lifecycle.terminationIntent).toEqual({
      mode: 'abort',
      reason: 'discovered during teardown',
    });
  });

  it('a drain that never answers is escalated at the grace period and still closes', async () => {
    const clock = manualTimers();
    const { steps } = recordingSteps({
      // The shape of a hanging application callback: it simply never answers.
      drain: () => new Promise<void>(() => {}),
    });
    const lifecycle = new CallLifecycle({ steps, timers: clock.timers, gracePeriodMs: 50 });
    const closing = lifecycle.requestClose('bye', 'graceful');
    expect(lifecycle.state).toBe('draining');
    clock.fireAll();
    await closing;

    expect(pathOf(lifecycle)).toEqual(['draining', 'aborting', 'terminating', 'closed']);
    // Escalated rather than abandoned, so whatever the drain did not deliver
    // reaches the discard step and is counted there.
    expect(lifecycle.isClosed).toBe(true);
    // No deadline timer outlived the call it was protecting.
    expect(clock.outstanding()).toBe(0);
  });
});

describe('nothing an application does can stop the machine', () => {
  it('a step that throws or rejects still reaches CLOSED, with every later step run', async () => {
    const { steps, calls } = recordingSteps({
      drain: () => Promise.reject(new Error('drain exploded')),
      discard: () => {
        throw new Error('discard exploded');
      },
      release: () => {
        throw new Error('release exploded');
      },
      notify: () => Promise.reject(new Error('seam exploded')),
    });
    const lifecycle = new CallLifecycle({ steps });

    await expect(lifecycle.requestClose('bye', 'graceful')).resolves.toBeUndefined();
    expect(calls).toEqual(['drain', 'discard', 'release', 'notify']);
    // A rejected drain is a drain that did not finish, so it escalates.
    expect(pathOf(lifecycle)).toEqual(['draining', 'aborting', 'terminating', 'closed']);
  });

  it('a throwing log sink is contained rather than becoming control flow', async () => {
    const { steps } = recordingSteps({ drain: () => Promise.reject(new Error('boom')) });
    const lifecycle = new CallLifecycle({
      steps,
      // Every escalation and every failed step logs; all of it throws.
      log: () => {
        throw new Error('log sink down');
      },
    });
    await expect(lifecycle.requestClose('bye', 'graceful')).resolves.toBeUndefined();
    expect(lifecycle.isClosed).toBe(true);
  });

  it('a throwing transition observer is a spectator, not a brake', async () => {
    const { steps } = recordingSteps();
    const lifecycle = new CallLifecycle({
      steps,
      onTransition: () => {
        throw new Error('observer exploded');
      },
    });
    await expect(lifecycle.requestClose('bye', 'graceful')).resolves.toBeUndefined();
    expect(pathOf(lifecycle)).toEqual(['draining', 'terminating', 'closed']);
  });
});

describe('joining, re-entering and repeating', () => {
  it('three callers in one tick share one lifecycle and the strongest reason', async () => {
    const { steps, calls, notified } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    const a = lifecycle.requestClose('caller hung up', 'graceful');
    const b = lifecycle.requestClose('rtp socket error', 'abort');
    const c = lifecycle.requestClose('supervisor asked', 'graceful');
    await Promise.all([a, b, c]);

    expect(calls.filter((name) => name === 'release')).toHaveLength(1);
    expect(calls.filter((name) => name === 'notify')).toHaveLength(1);
    expect(notified).toEqual([{ mode: 'abort', reason: 'rtp socket error' }]);
    expect(pathOf(lifecycle)).toEqual(['draining', 'aborting', 'terminating', 'closed']);
  });

  it('a close re-entered from a step returns as a signal instead of waiting on itself', async () => {
    let lifecycle!: CallLifecycle;
    let stateWhenTheSignalReturned: LifecycleState | null = null;
    const { steps } = recordingSteps({
      drain: async () => {
        await lifecycle.requestClose('the seam hung up too', 'graceful');
        // If this had joined the teardown it would still be waiting; teardown
        // cannot finish while it is inside this very step.
        stateWhenTheSignalReturned = lifecycle.state;
      },
    });
    lifecycle = new CallLifecycle({ steps });

    const outcome = await Promise.race([
      lifecycle.requestClose('bye', 'graceful').then(() => 'settled'),
      sleep(250).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    expect(stateWhenTheSignalReturned).toBe('draining');
    expect(lifecycle.reentrantSignals).toBe(1);
    expect(lifecycle.isClosed).toBe(true);
  });

  it('is idempotent: closing a closed call changes nothing', async () => {
    const { steps, calls } = recordingSteps();
    const lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('bye', 'graceful');
    const pathAfterFirst = pathOf(lifecycle);

    await expect(lifecycle.requestClose('again', 'abort')).resolves.toBeUndefined();
    expect(calls).toEqual(['drain', 'discard', 'release', 'notify']);
    expect(pathOf(lifecycle)).toEqual(pathAfterFirst);
    // A finished call does not get a new reason for having finished.
    expect(lifecycle.terminationIntent).toEqual({ mode: 'graceful', reason: 'bye' });
  });

  it('one call being torn down cannot make another call believe it is closing', async () => {
    const other = new CallLifecycle(recordingSteps());
    let observedInsideOther: LifecycleState | null = null;
    let lifecycle!: CallLifecycle;
    const { steps } = recordingSteps({
      drain: async () => {
        // A close for a DIFFERENT call, raised from inside this one's
        // teardown, is an ordinary caller and must actually wait for it.
        await other.requestClose('the other end went away', 'graceful');
        observedInsideOther = other.state;
      },
    });
    lifecycle = new CallLifecycle({ steps });
    await lifecycle.requestClose('bye', 'graceful');

    expect(observedInsideOther).toBe('closed');
    expect(other.reentrantSignals).toBe(0);
    expect(other.terminationIntent).toEqual({
      mode: 'graceful',
      reason: 'the other end went away',
    });
  });
});

describe('bounded invocation', () => {
  it('reports ok, rejection and non-answer as three verdicts rather than exceptions', async () => {
    const clock = manualTimers();
    await expect(invokeBounded(() => {}, 1000, clock.timers)).resolves.toBe('ok');
    await expect(
      invokeBounded(() => Promise.reject(new Error('no')), 1000, clock.timers),
    ).resolves.toBe('rejected');
    await expect(
      invokeBounded(
        () => {
          throw new Error('synchronously no');
        },
        1000,
        clock.timers,
      ),
    ).resolves.toBe('rejected');

    const hanging = invokeBounded(() => new Promise<void>(() => {}), 1000, clock.timers);
    clock.fireAll();
    await expect(hanging).resolves.toBe('timed-out');
    expect(clock.outstanding()).toBe(0);
  });

  it('work abandoned at the deadline never becomes an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const clock = manualTimers();
      // A callback that answers late, and answers badly.
      const outcome = invokeBounded(
        () => sleep(20).then(() => Promise.reject(new Error('late and angry'))),
        1000,
        clock.timers,
      );
      clock.fireAll();
      await expect(outcome).resolves.toBe('timed-out');
      await sleep(60);
      // A promise we stopped waiting for must not take the process down.
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the guarded logger', () => {
  it('passes lines through, survives a throwing sink, and tolerates no sink', () => {
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const good = guardedLogger((line, detail) => lines.push([line, detail]));
    good('a line', { detail: 1 });
    expect(lines).toEqual([['a line', { detail: 1 }]]);

    const bad = guardedLogger(() => {
      throw new Error('log sink down');
    });
    expect(() => bad('a line', { detail: 1 })).not.toThrow();
    expect(() => guardedLogger(undefined)('a line')).not.toThrow();
  });
});
