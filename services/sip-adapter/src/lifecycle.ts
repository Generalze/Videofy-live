/** @author masterzee001 */
/**
 * The call lifecycle: one coordinator, one direction of travel.
 *
 * Teardown used to be seven mechanisms describing the same event from seven
 * angles — a `closed` boolean, a shared `closing` promise, a pump chain, a
 * drain flag, nested try/catch layers, abort handling and per-callback guards.
 * Every one of them was individually defensible and the defects were never
 * inside any single one; they were in the PAIRS. Two mechanisms disagreeing
 * about whether the call was closed is how extracted frames vanished with no
 * counter moving, how a security abort was recorded as an ordinary "bye", and
 * how a close re-entered from a callback waited on itself forever.
 *
 * So there is exactly one authority, and it answers three questions
 * SEPARATELY, because they have separate answers and conflating them into one
 * boolean is what made the old path unfixable:
 *
 *   acceptingMedia   may NEW media enter?             only while ACTIVE
 *   deliveringMedia  may ADMITTED media still leave?  ACTIVE and DRAINING
 *   state            where teardown actually is       the machine below
 *
 * Everyone else — a BYE handler, an RTP socket error, a media-policy refusal,
 * an application callback — SIGNALS INTENT to this object. Nobody else tears
 * anything down, and nothing outside this file decides what a close means.
 *
 * Nothing here knows what a codec, a packet or a participant is. It is a
 * lifecycle, and the call supplies the four steps it drives.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LifecycleState = 'active' | 'draining' | 'aborting' | 'terminating' | 'closed';

/**
 * GRACEFUL owes the listener the words already spoken. ABORT does not: the
 * call is being destroyed because it is invalid, refused or compromised, and
 * its buffered speech is the one thing we least want to trust on the way out.
 */
export type TerminationMode = 'graceful' | 'abort';

export interface TerminationIntent {
  readonly mode: TerminationMode;
  readonly reason: string;
}

export interface LifecycleTransition {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
}

/**
 * The whole machine, in one table:
 *
 *   ACTIVE ──▶ DRAINING ──▶ TERMINATING ──▶ CLOSED
 *        ╰──▶ ABORTING ──▶ ╯      ▲
 *              ▲                  │
 *              ╰── escalation ────╯ (DRAINING ▶ ABORTING, never the reverse)
 *
 * Two properties are deliberate. Teardown never skips a MODE state, so the
 * delivery policy for this hangup is always recorded somewhere before any
 * resource is released. And there is no edge that moves backwards: a call
 * cannot become live again, an abort cannot be de-escalated into a bye, and
 * CLOSED is a sink. Anything absent from this table is refused rather than
 * tolerated — a lifecycle that quietly accepts an impossible move is one that
 * eventually reports CLOSED for a call still holding a socket.
 */
export const PERMITTED_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  active: ['draining', 'aborting'],
  draining: ['aborting', 'terminating'],
  aborting: ['terminating'],
  terminating: ['closed'],
  closed: [],
};

export function mayTransition(from: LifecycleState, to: LifecycleState): boolean {
  return PERMITTED_TRANSITIONS[from].includes(to);
}

/** New media is admitted only while the call is genuinely live. */
export function acceptsMediaIn(state: LifecycleState): boolean {
  return state === 'active';
}

/**
 * Whether media ALREADY ADMITTED may still be delivered. This is not the same
 * question as whether new media is accepted, and reading one for the other is
 * how a graceful hangup came to drop the last words of every call.
 */
export function deliversMediaIn(state: LifecycleState): boolean {
  return state === 'active' || state === 'draining';
}

// --- bounded waiting -------------------------------------------------------

export type TimerHandle = unknown;

/**
 * Injectable so a test can bound a callback without spending real time, and
 * so a suite can prove no timer outlives the call.
 */
export interface LifecycleTimers {
  setTimer(handler: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export const SYSTEM_TIMERS: LifecycleTimers = {
  setTimer(handler, delayMs) {
    const handle = setTimeout(handler, delayMs);
    // A deadline is a safety net, never a reason for a process to stay alive.
    handle.unref?.();
    return handle;
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type CallbackOutcome = 'ok' | 'rejected' | 'timed-out';

/**
 * Call application code with a deadline, and come back with a verdict rather
 * than an exception.
 *
 * Three failures are the same failure to a teardown: the callback threw, it
 * rejected, or it never answered at all. A hanging callback is the dangerous
 * one — it is indistinguishable from a slow one until the deadline expires,
 * and without a deadline it is indistinguishable from a slow one forever.
 *
 * The abandoned work keeps its own rejection handler. A promise we stopped
 * waiting for that later rejects would otherwise take the process down for a
 * callback whose answer we had already decided we did not need.
 */
export async function invokeBounded(
  invoke: () => Promise<void> | void,
  deadlineMs: number,
  timers: LifecycleTimers,
): Promise<CallbackOutcome> {
  let work: Promise<CallbackOutcome>;
  try {
    work = Promise.resolve(invoke()).then(
      (): CallbackOutcome => 'ok',
      (): CallbackOutcome => 'rejected',
    );
  } catch {
    // A synchronous throw is a rejection that never became a promise.
    return 'rejected';
  }
  if (!(deadlineMs > 0)) return 'timed-out';

  let handle: TimerHandle = null;
  try {
    const expiry = new Promise<CallbackOutcome>((resolve) => {
      handle = timers.setTimer(() => resolve('timed-out'), deadlineMs);
    });
    return await Promise.race([work, expiry]);
  } finally {
    if (handle !== null) timers.clearTimer(handle);
  }
}

// --- logging ---------------------------------------------------------------

export type LogSink = (line: string, detail?: Record<string, unknown>) => void;

/**
 * Logging is diagnostics, never control flow. A log sink is application code
 * like any other, and a throwing one used to be enough to make a call
 * permanently unclosable — the teardown rejected before it released the
 * session, and every later close adopted that rejected promise. It also has
 * to be safe inside a UDP handler, which documents itself as never throwing.
 */
export function guardedLogger(log: LogSink | undefined): LogSink {
  if (log === undefined) return () => {};
  return (line, detail) => {
    try {
      log(line, detail);
    } catch {
      // Deliberately empty. There is nowhere safe to report a broken
      // reporter, and any attempt to would be the same failure again.
    }
  };
}

// --- the coordinator -------------------------------------------------------

/**
 * The four things a call must do to die. The lifecycle decides WHEN and in
 * what order; the call decides what each one means.
 */
export interface LifecycleSteps {
  /**
   * Deliver media already admitted and still deliverable. Bounded by the
   * lifecycle, and expected to stop by itself the moment delivery is no
   * longer permitted.
   */
  drain(intent: TerminationIntent): Promise<void>;
  /**
   * Release media extracted from a buffer but never delivered, COUNTING every
   * frame. Frames that leave a buffer are owned by someone until they are
   * delivered or explicitly accounted for; silence here is how two 20 ms
   * frames once vanished with `lost: 0` and `evicted: 0`.
   */
  discard(intent: TerminationIntent): void;
  /**
   * Release everything the call owns — sockets, timers, queues, mappings,
   * session state. Written so it cannot throw and cannot await application
   * code, because CLOSED is only true once this has genuinely run.
   */
  release(intent: TerminationIntent): void;
  /** Tell the application. Bounded by the lifecycle, and never trusted by it. */
  notify(intent: TerminationIntent): Promise<void>;
}

export interface CallLifecycleDeps {
  steps: LifecycleSteps;
  timers?: LifecycleTimers;
  /** How long a graceful drain may run before it is escalated to an abort. */
  gracePeriodMs?: number;
  /** How long the application may be told about the ending before we stop waiting. */
  terminationDeadlineMs?: number;
  log?: LogSink;
  onTransition?: (transition: LifecycleTransition, intent: TerminationIntent | null) => void;
}

/**
 * A window during which this call's teardown may be waiting on the stack you
 * are standing on.
 *
 * A close raised from INSIDE work this call owns — an application callback
 * that hangs up while it is being handed a frame, or while being told the
 * call is ending — must become a SIGNAL, not another wait. Awaiting the
 * teardown that is at that moment awaiting you is a deadlock with nothing
 * left to break it, and it was reached in practice through exactly one cycle:
 * teardown, pump chain, pushAudio, the shared close promise, teardown.
 *
 * Keyed by the lifecycle INSTANCE rather than by a flag, for two reasons. A
 * boolean would be true of every concurrent call in the process while only
 * one of them is the one we are inside, so an unrelated caller's close would
 * return immediately and tell it the call was closed when teardown had barely
 * started. And it keeps one call's teardown from changing what another call's
 * close means, which is a property this adapter has to hold per call.
 *
 * The `live` flag is the other half, and the reason a plain instance was not
 * enough. AsyncLocalStorage propagates into EVERY async continuation of the
 * work it wraps — the application's continuations included — and it never
 * stops. A seam handed a frame could schedule a timer, keep a queue, or park
 * a retry, and each of those inherited this call's context permanently; a
 * close raised from one of them minutes later was read as re-entrant and
 * returned at once, telling an unrelated caller the call was closed while it
 * still held a socket, a buffer and a session. That is the same lie the
 * lifecycle exists to prevent, arriving through the mechanism meant to
 * prevent it.
 *
 * So the context is not "which call is this" but "is that call's teardown
 * still waiting on this work". It is armed when the work starts and
 * disarmed the moment the work SETTLES — which is exactly when teardown stops
 * being able to be blocked by it. Exiting the context around seam calls
 * instead was tried and is wrong in the other direction: it answers NO to a
 * seam that hangs up synchronously inside `pushAudio`, which is the one case
 * where the answer is unambiguously yes.
 */
interface OwnedScope {
  readonly lifecycle: CallLifecycle;
  live: boolean;
}

const TEARDOWN_CONTEXT = new AsyncLocalStorage<OwnedScope>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

export class CallLifecycle {
  private readonly steps: LifecycleSteps;
  private readonly timers: LifecycleTimers;
  private readonly gracePeriodMs: number;
  private readonly terminationDeadlineMs: number;
  private readonly log: LogSink;
  private readonly onTransition:
    | ((transition: LifecycleTransition, intent: TerminationIntent | null) => void)
    | undefined;

  private currentState: LifecycleState = 'active';
  private intent: TerminationIntent | null = null;
  /** The one in-flight teardown. Every joiner awaits this, nobody re-runs it. */
  private settled: Promise<void> | null = null;
  private readonly transitionLog: LifecycleTransition[] = [];
  private refusedTransitionCount = 0;
  private reentrantSignalCount = 0;

  constructor(deps: CallLifecycleDeps) {
    this.steps = deps.steps;
    this.timers = deps.timers ?? SYSTEM_TIMERS;
    this.gracePeriodMs = deps.gracePeriodMs ?? 2000;
    this.terminationDeadlineMs = deps.terminationDeadlineMs ?? 3000;
    this.log = guardedLogger(deps.log);
    this.onTransition = deps.onTransition;
  }

  get state(): LifecycleState {
    return this.currentState;
  }

  get acceptingMedia(): boolean {
    return acceptsMediaIn(this.currentState);
  }

  get deliveringMedia(): boolean {
    return deliversMediaIn(this.currentState);
  }

  /** True only once resources are genuinely released — not once teardown began. */
  get isClosed(): boolean {
    return this.currentState === 'closed';
  }

  get terminationIntent(): TerminationIntent | null {
    return this.intent;
  }

  /** Every move the machine actually made, for tests that assert the path itself. */
  get transitions(): readonly LifecycleTransition[] {
    return this.transitionLog;
  }

  get refusedTransitions(): number {
    return this.refusedTransitionCount;
  }

  /** Closes raised from inside this call's own work, taken as signals. */
  get reentrantSignals(): number {
    return this.reentrantSignalCount;
  }

  /**
   * Signal that this call should end. Everyone calls this — the first caller
   * happens to drive the teardown, but no caller can tell whether it did, and
   * none of them owns the outcome.
   */
  requestClose(reason: string, mode: TerminationMode): Promise<void> {
    // Idempotent: a BYE and a socket close arriving after the call is already
    // finished are both correct and neither reopens anything.
    if (this.currentState === 'closed') return Promise.resolve();

    this.recordIntent(reason, mode);
    const scope = TEARDOWN_CONTEXT.getStore();
    const reentrant = scope !== undefined && scope.lifecycle === this && scope.live;
    if (reentrant) {
      this.reentrantSignalCount += 1;
      this.log('sip call close re-entered from work this call owns; taken as a signal', {
        state: this.currentState,
        mode,
      });
    }

    const teardown = this.ensureDriving();
    // A caller that teardown may itself be waiting for cannot also wait for
    // teardown. Its intent is recorded and the lifecycle is running, which is
    // the whole of what it asked for; handing it the teardown promise here is
    // exactly the cycle that used to leave a call unsettled forever.
    return reentrant ? Promise.resolve() : teardown;
  }

  /**
   * Run work that teardown may end up waiting for — a delivery task, a step,
   * anything that calls application code on this call's behalf — inside this
   * call's own context, so that a close raised from within it is recognised.
   */
  runOwnedWork<T>(work: () => T): T {
    const scope: OwnedScope = { lifecycle: this, live: true };
    const result = TEARDOWN_CONTEXT.run(scope, work);
    // The window closes when the work SETTLES, not when it returns. Up to
    // that moment teardown can be blocked on it and a close from within it
    // must be a signal; after it, the same context may still be riding around
    // inside something the application kept, and it must no longer mean
    // anything at all.
    if (isPromiseLike(result)) {
      void Promise.resolve(result).then(
        () => {
          scope.live = false;
        },
        () => {
          scope.live = false;
        },
      );
    } else {
      scope.live = false;
    }
    return result;
  }

  /**
   * Armed before anything can await, so two closes in one tick cannot both
   * become drivers and every later caller joins the one that exists.
   *
   * The promise is created and stored BEFORE `drive` executes a single line,
   * which is not a nicety: `drive` invokes the first teardown step
   * synchronously, and a close raised from inside that step would otherwise
   * look around, find no teardown running, and start a second one — which
   * would do the same again, forever.
   */
  private ensureDriving(): Promise<void> {
    const running = this.settled;
    if (running !== null) return running;
    let announce: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      announce = resolve;
    });
    this.settled = settled;
    const scope: OwnedScope = { lifecycle: this, live: true };
    // `drive` is written not to reject; settling on both outcomes means a
    // mistake in it still cannot leave every closer waiting forever.
    TEARDOWN_CONTEXT.run(scope, () => {
      const finish = (): void => {
        // Teardown is over, so nothing can be waiting on it any more — and
        // any context the application carried out of a teardown step stops
        // being able to speak for this call.
        scope.live = false;
        announce();
      };
      void this.drive().then(finish, finish);
    });
    return settled;
  }

  /**
   * Strength decides, not arrival order. An abort is raised because the call
   * is invalid, refused or compromised; letting an earlier "bye" keep the
   * reason files a security event as an ordinary hangup, and letting it keep
   * the MODE hands the engine the buffered speech of a call we just declared
   * untrustworthy. Between two of equal strength the first cause wins, because
   * the second is usually a consequence of the first.
   */
  private recordIntent(reason: string, mode: TerminationMode): void {
    const previous = this.intent;
    if (previous === null) {
      this.intent = { mode, reason };
      return;
    }
    if (previous.mode === 'abort' || mode === 'graceful') return;
    this.intent = { mode, reason };
    // An abort behind an in-flight graceful close escalates it. The drain
    // stops at its next frame boundary because delivery is no longer
    // permitted, and everything it had not delivered is discarded and counted.
    if (this.currentState === 'draining') this.transition('aborting');
  }

  private transition(to: LifecycleState): boolean {
    const from = this.currentState;
    if (!mayTransition(from, to)) {
      // Refused rather than applied. A forbidden move means two parts of the
      // system disagree about where teardown is, which is precisely the defect
      // class this file exists to remove; applying it would hide the
      // disagreement behind a plausible-looking state.
      this.refusedTransitionCount += 1;
      this.log('sip call lifecycle refused a forbidden transition', { from, to });
      return false;
    }
    this.currentState = to;
    const transition: LifecycleTransition = { from, to };
    this.transitionLog.push(transition);
    if (this.onTransition !== undefined) {
      try {
        this.onTransition(transition, this.intent);
      } catch {
        // An observer is a spectator. It does not get to stop the machine.
      }
    }
    return true;
  }

  private currentIntent(): TerminationIntent {
    return this.intent ?? { mode: 'graceful', reason: 'unspecified' };
  }

  /**
   * The teardown itself. It runs exactly once, it always reaches CLOSED, and
   * every step that touches application code is bounded — a step that throws,
   * rejects or never answers costs one deadline, never the call.
   */
  private async drive(): Promise<void> {
    const opening = this.currentIntent();
    this.transition(opening.mode === 'graceful' ? 'draining' : 'aborting');

    if (this.currentState === 'draining') {
      const outcome = await invokeBounded(
        () => this.steps.drain(this.currentIntent()),
        this.gracePeriodMs,
        this.timers,
      );
      if (outcome !== 'ok') {
        // The drain refused or stopped answering, so the grace is over. It is
        // escalated rather than merely abandoned, so that whatever it did not
        // deliver is discarded and COUNTED instead of leaving with the
        // teardown. The abandoned drain sees delivery withdrawn at its next
        // frame; at most the one push already in flight can still land.
        this.log('sip call graceful drain did not finish within its grace period', {
          outcome,
          gracePeriodMs: this.gracePeriodMs,
        });
        this.transition('aborting');
      }
    }

    // Everything extracted and not delivered is released here — after an
    // abort, after a drain that ran out of grace, and after a drain that
    // simply had nothing left. One place, so nothing can fall between two.
    this.runOwnStep('discard', () => this.steps.discard(this.currentIntent()));

    this.transition('terminating');
    // Resources first, application second. No callback may stand between a
    // call and the release of what it holds.
    this.runOwnStep('release', () => this.steps.release(this.currentIntent()));

    // Read as late as possible: an abort that arrived during the drain should
    // reach the application as an abort, not as the bye it overtook.
    await invokeBounded(
      () => this.steps.notify(this.currentIntent()),
      this.terminationDeadlineMs,
      this.timers,
    );

    this.transition('closed');
  }

  /**
   * Our own steps are written so they cannot fail. The guard is a backstop
   * that keeps a mistake in one of them from stranding a call short of CLOSED
   * — not a licence for them to throw.
   */
  private runOwnStep(name: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      this.log(`sip call teardown step failed: ${name}`, {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
