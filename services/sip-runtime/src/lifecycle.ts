/** @author masterzee001 */
/**
 * The process's own lifecycle, stated rather than assumed.
 *
 *     STARTING  ->  READY  ->  DRAINING  ->  STOPPED
 *
 * Every transition is forward. There is no path back from DRAINING, because a
 * process that has begun refusing calls and has been told to resume has no way
 * to know which of its callers already went elsewhere.
 *
 * The reason this is a class rather than a `let state` and some `if`s: SIGTERM
 * on a container arrives while calls are in progress, and the difference
 * between a clean drain and a killed process is audible. A caller mid-sentence
 * hears the line die. So shutdown is ORDERED and BOUNDED:
 *
 *   1. stop accepting new calls        nothing new enters the drain
 *   2. end active calls, bounded       the seam is told, before the sockets go
 *   3. close RTP sockets               nothing can arrive for a dead call
 *   4. close the SIP socket            signalling stops last of the transports
 *   5. close the remote connection     the gateway learns we are going
 *   6. release timers                  or the event loop never empties
 *   7. exit
 *
 * The order is not decorative. Closing sockets before ending calls would mean
 * the seam is told about a hangup it can no longer receive audio for; releasing
 * timers first would stop the pump that is draining the last frames.
 *
 * And the whole thing is bounded. A drain that waits forever for one wedged
 * call is a container that gets SIGKILLed at the orchestrator's deadline, which
 * is exactly the un-clean shutdown the drain existed to avoid.
 */
export type RuntimeState = 'starting' | 'ready' | 'draining' | 'stopped';

const ORDER: readonly RuntimeState[] = ['starting', 'ready', 'draining', 'stopped'];

export interface ShutdownStep {
  readonly name: string;
  run(): void | Promise<void>;
}

export interface RuntimeLifecycleDeps {
  readonly steps: readonly ShutdownStep[];
  /** The whole drain, not each step. Exceeding it is reported, never hidden. */
  readonly deadlineMs: number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface ShutdownReport {
  readonly completed: readonly string[];
  readonly failed: readonly { name: string; message: string }[];
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export class RuntimeLifecycle {
  private current: RuntimeState = 'starting';
  private shutdownRun: Promise<ShutdownReport> | null = null;
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeLifecycleDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
  }

  get state(): RuntimeState {
    return this.current;
  }

  /** True only in READY. Everything else refuses, including STARTING. */
  get acceptsCalls(): boolean {
    return this.current === 'ready';
  }

  ready(): void {
    this.transition('ready');
  }

  private transition(next: RuntimeState): void {
    if (ORDER.indexOf(next) <= ORDER.indexOf(this.current)) {
      throw new Error(`Cannot move from ${this.current} to ${next}.`);
    }
    this.current = next;
    this.log('runtime state', { state: next });
  }

  /**
   * Drain and stop. Idempotent: a second SIGTERM joins the first shutdown
   * rather than starting a competing one, because two concurrent teardowns
   * closing the same sockets is how a clean shutdown becomes a crash.
   */
  shutdown(reason: string): Promise<ShutdownReport> {
    if (this.shutdownRun !== null) return this.shutdownRun;
    this.shutdownRun = this.run(reason);
    return this.shutdownRun;
  }

  private async run(reason: string): Promise<ShutdownReport> {
    const startedAt = this.now();
    this.transition('draining');
    this.log('draining', { reason });

    const completed: string[] = [];
    const failed: { name: string; message: string }[] = [];
    let timedOut = false;

    const setTimer = this.deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    const clearTimer = this.deps.clearTimer ?? ((handle) => clearTimeout(handle as never));

    let expire: (() => void) | null = null;
    const deadline = new Promise<'deadline'>((resolve) => {
      expire = () => resolve('deadline');
    });
    const handle = setTimer(() => expire?.(), this.deps.deadlineMs);

    const sequence = (async () => {
      for (const step of this.deps.steps) {
        try {
          await step.run();
          completed.push(step.name);
        } catch (error) {
          // A failing step must not abort the remaining ones. Half a teardown
          // leaves sockets bound and the next start fails on EADDRINUSE, which
          // is a much worse thing to debug than the original fault.
          const message = error instanceof Error ? error.message : 'unknown';
          failed.push({ name: step.name, message });
          this.log('shutdown step failed', { step: step.name, message });
        }
      }
      return 'done' as const;
    })();

    const outcome = await Promise.race([sequence, deadline]);
    clearTimer(handle);
    if (outcome === 'deadline') {
      timedOut = true;
      // Named, not swallowed. A drain that silently exceeded its deadline is
      // one nobody tunes, and the orchestrator will eventually SIGKILL it.
      this.log('shutdown exceeded its deadline', {
        deadlineMs: this.deps.deadlineMs,
        completed: [...completed],
        pending: this.deps.steps.map((step) => step.name).filter((n) => !completed.includes(n)),
      });
    }

    this.current = 'stopped';
    const report: ShutdownReport = {
      completed,
      failed,
      timedOut,
      durationMs: this.now() - startedAt,
    };
    this.log('runtime state', { state: 'stopped', ...report });
    return report;
  }
}
