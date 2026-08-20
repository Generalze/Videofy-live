/** @author masterzee001 */
/**
 * SIGTERM arrives while people are talking.
 *
 * The difference between a clean drain and a killed process is audible: a
 * caller mid-sentence hears the line die. So these tests are about ORDER and
 * BOUNDS, which are the two properties that make a drain worth having.
 */
import { describe, expect, it } from 'vitest';
import { RuntimeLifecycle, type ShutdownStep } from '../lifecycle.js';

function stepsRecording(order: string[], overrides: Record<string, () => Promise<void> | void> = {}) {
  return ['stop-accepting', 'end-calls', 'close-transports', 'close-remote', 'release-timers'].map(
    (name): ShutdownStep => ({
      name,
      run: async () => {
        order.push(name);
        await overrides[name]?.();
      },
    }),
  );
}

describe('states move forward only', () => {
  it('starts in STARTING and refuses calls until READY', () => {
    const lifecycle = new RuntimeLifecycle({ steps: [], deadlineMs: 1_000 });
    expect(lifecycle.state).toBe('starting');
    // A process that accepted a call before it had finished binding would be
    // answering with sockets that do not exist yet.
    expect(lifecycle.acceptsCalls).toBe(false);
    lifecycle.ready();
    expect(lifecycle.acceptsCalls).toBe(true);
  });

  it('PIN: there is no way back from DRAINING', async () => {
    const lifecycle = new RuntimeLifecycle({ steps: [], deadlineMs: 1_000 });
    lifecycle.ready();
    await lifecycle.shutdown('SIGTERM');
    expect(lifecycle.state).toBe('stopped');
    expect(lifecycle.acceptsCalls).toBe(false);
    // A process that has begun refusing calls has no way to know which of its
    // callers already went elsewhere.
    expect(() => lifecycle.ready()).toThrow();
  });
});

describe('shutdown', () => {
  it('PIN: runs the steps in order', async () => {
    const order: string[] = [];
    const lifecycle = new RuntimeLifecycle({ steps: stepsRecording(order), deadlineMs: 1_000 });
    lifecycle.ready();
    const report = await lifecycle.shutdown('SIGTERM');

    // Not decorative. Closing transports before ending calls would tell the
    // seam about a hangup it can no longer receive the last audio for;
    // releasing timers first would stop the pump that is draining it.
    expect(order).toEqual([
      'stop-accepting',
      'end-calls',
      'close-transports',
      'close-remote',
      'release-timers',
    ]);
    expect(report.failed).toEqual([]);
    expect(report.timedOut).toBe(false);
  });

  it('PIN: a second signal joins the first drain rather than racing it', async () => {
    const order: string[] = [];
    const lifecycle = new RuntimeLifecycle({ steps: stepsRecording(order), deadlineMs: 1_000 });
    lifecycle.ready();
    // Two concurrent teardowns closing the same sockets is how a clean
    // shutdown becomes a crash.
    const [first, second] = await Promise.all([
      lifecycle.shutdown('SIGTERM'),
      lifecycle.shutdown('SIGINT'),
    ]);
    expect(order).toHaveLength(5);
    expect(second).toBe(first);
  });

  it('PIN: a failing step does not abort the rest', async () => {
    const order: string[] = [];
    const lifecycle = new RuntimeLifecycle({
      steps: stepsRecording(order, {
        'end-calls': () => {
          throw new Error('a call would not end');
        },
      }),
      deadlineMs: 1_000,
    });
    lifecycle.ready();
    const report = await lifecycle.shutdown('SIGTERM');

    // Half a teardown leaves sockets bound, and the next start fails on
    // EADDRINUSE -- much worse to debug than the original fault.
    expect(order).toHaveLength(5);
    expect(report.failed).toEqual([{ name: 'end-calls', message: 'a call would not end' }]);
    expect(report.completed).not.toContain('end-calls');
    expect(report.completed).toContain('release-timers');
    expect(lifecycle.state).toBe('stopped');
  });

  it('PIN: the drain is bounded, and says so when it overruns', async () => {
    let release: (() => void) | null = null;
    const order: string[] = [];
    const lifecycle = new RuntimeLifecycle({
      steps: stepsRecording(order, {
        'end-calls': () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      }),
      deadlineMs: 30,
    });
    lifecycle.ready();
    const report = await lifecycle.shutdown('SIGTERM');

    // A drain that waits forever for one wedged call is a container the
    // orchestrator SIGKILLs -- exactly the un-clean shutdown it existed to
    // avoid. Named rather than swallowed, because a silent overrun is one
    // nobody tunes.
    expect(report.timedOut).toBe(true);
    expect(report.completed).toEqual(['stop-accepting']);
    expect(lifecycle.state).toBe('stopped');
    release?.();
  });

  it('reports how long it took, so a deadline can be tuned from evidence', async () => {
    let clock = 1_000;
    const lifecycle = new RuntimeLifecycle({
      steps: [{ name: 'one', run: () => void (clock += 250) }],
      deadlineMs: 5_000,
      now: () => clock,
    });
    lifecycle.ready();
    expect((await lifecycle.shutdown('SIGTERM')).durationMs).toBe(250);
  });
});
