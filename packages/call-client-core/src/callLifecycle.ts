// P6.4-W7 — mobile suspend/resume lifecycle observation.
//
// A phone put in a pocket takes this page through visibilitychange, sometimes
// freeze/resume (Page Lifecycle), sometimes pagehide/pageshow (back/forward
// cache), and possibly a radio drop — and every browser exposes a different
// subset of those signals. This module OBSERVES only: it subscribes to
// whatever the platform actually provides, classifies the noise into one
// small typed stream, and leaves every recovery decision to the orchestrator.
// It never touches the socket, the peers, or any audio path — in particular
// it must not duplicate the resume-token rejoin that already runs on socket
// 'connect' (handleSocketReconnect), and it has no opinion about autoplay.
//
// Classification contract:
//   - Resume-from-suspend is explicit: pageshow with persisted=true, the Page
//     Lifecycle 'resume' event, or visibilitychange->visible after an
//     observed hidden interval. 'resumed' fires at most once per interval,
//     from whichever of those signals lands first; a trailing
//     visibilitychange->visible is plain 'visible'.
//   - Network loss is NOT a suspend. 'online'/'offline' are their own kinds
//     and never open or close a hidden interval: a radio handover mid-call
//     must not read as the phone having slept, nor the reverse.
//
// Diagnostics carry event names, causes and durations only — never call,
// participant, account or device identity.

export type CallLifecycleEventKind =
  | 'suspended'
  | 'resumed'
  | 'hidden'
  | 'visible'
  | 'online'
  | 'offline';

export interface CallLifecycleEvent {
  kind: CallLifecycleEventKind;
  /**
   * Time from the start of the observed hidden interval to this event.
   * Present only when a resume classification closes an interval this
   * observer saw open; a restore with no observed start has nothing to
   * measure and omits the field rather than guessing.
   */
  hiddenDurationMs?: number;
  /** The platform signal that produced this classification (an event name). */
  cause: string;
}

/** NO PII: diagnostic names, event names and durations only. */
export type CallLifecycleDiagnostic = (
  name: string,
  detail?: Record<string, string | number>,
) => void;

/** The subset of an EventTarget this module needs, so node tests can fake it. */
export interface LifecycleTargetLike {
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface LifecycleDocumentLike extends LifecycleTargetLike {
  /** 'visible' | 'hidden' where supported; anything else is unclassifiable. */
  visibilityState?: string;
}

export interface CallLifecycleObserverOptions {
  onEvent: (event: CallLifecycleEvent) => void;
  onDiagnostic?: CallLifecycleDiagnostic;
  /** Injected for deterministic duration measurement in tests. */
  now?: () => number;
  /** Injected targets for node tests; default to the real document/window. */
  documentLike?: LifecycleDocumentLike | null;
  windowLike?: LifecycleTargetLike | null;
}

const DOCUMENT_EVENTS = ['visibilitychange', 'freeze', 'resume'] as const;
const WINDOW_EVENTS = ['pagehide', 'pageshow', 'online', 'offline'] as const;

function defaultDocument(): LifecycleDocumentLike | null {
  return typeof document === 'undefined' ? null : document;
}

function defaultWindow(): LifecycleTargetLike | null {
  return typeof window === 'undefined' ? null : window;
}

/**
 * Feature-detected attach: a missing target, a missing addEventListener or a
 * throwing one all yield null instead of an error. The returned detach is
 * best-effort for the same reason; callers must keep their own disposed guard
 * so an undetachable target still goes quiet.
 */
function attachListener(
  target: LifecycleTargetLike | null,
  type: string,
  listener: (event: unknown) => void,
): (() => void) | null {
  if (!target || typeof target.addEventListener !== 'function') return null;
  try {
    target.addEventListener(type, listener);
  } catch {
    return null;
  }
  return () => {
    try {
      target.removeEventListener?.(type, listener);
    } catch {
      // Best-effort; the disposed guard silences an undetachable target.
    }
  };
}

/** pageshow/pagehide carry `persisted`; anything else reads as false. */
function isPersisted(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { persisted?: unknown }).persisted === true
  );
}

export class CallLifecycleObserver {
  private readonly onEvent: (event: CallLifecycleEvent) => void;
  private readonly onDiagnostic: CallLifecycleDiagnostic | undefined;
  private readonly now: () => number;
  private readonly documentLike: LifecycleDocumentLike | null;
  /**
   * When the current hidden interval opened, or null when no interval is
   * open. Doubles as the once-per-interval latch: emitting 'resumed' closes
   * the interval, so later resume signals for the same interval degrade to
   * 'visible' instead of repeating the classification.
   */
  private hiddenAtMs: number | null = null;
  private disposed = false;
  private readonly detachers: (() => void)[] = [];

  constructor(options: CallLifecycleObserverOptions) {
    this.onEvent = options.onEvent;
    this.onDiagnostic = options.onDiagnostic;
    this.now = options.now ?? (() => Date.now());
    this.documentLike =
      options.documentLike === undefined ? defaultDocument() : options.documentLike;
    const windowLike = options.windowLike === undefined ? defaultWindow() : options.windowLike;

    const handlers: Record<
      (typeof DOCUMENT_EVENTS)[number] | (typeof WINDOW_EVENTS)[number],
      (event: unknown) => void
    > = {
      visibilitychange: () => this.handleVisibilityChange(),
      freeze: () => this.handleFreeze(),
      resume: () => this.handleResumeSignal(),
      pagehide: (event) => this.handlePageHide(event),
      pageshow: (event) => this.handlePageShow(event),
      online: () => this.emit({ kind: 'online', cause: 'online' }),
      offline: () => this.emit({ kind: 'offline', cause: 'offline' }),
    };
    for (const type of DOCUMENT_EVENTS) this.subscribe(this.documentLike, type, handlers[type]);
    for (const type of WINDOW_EVENTS) this.subscribe(windowLike, type, handlers[type]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const detach of this.detachers.splice(0)) detach();
  }

  private subscribe(
    target: LifecycleTargetLike | null,
    type: string,
    handler: (event: unknown) => void,
  ): void {
    const guarded = (event: unknown): void => {
      if (this.disposed) return;
      handler(event);
    };
    const detach = attachListener(target, type, guarded);
    if (detach === null) {
      this.onDiagnostic?.('lifecycle-subscribe-skipped', { event: type });
      return;
    }
    this.detachers.push(detach);
  }

  private handleVisibilityChange(): void {
    const state = this.documentLike?.visibilityState;
    if (state === 'hidden') {
      this.openHiddenInterval();
      this.emit({ kind: 'hidden', cause: 'visibilitychange' });
      return;
    }
    if (state !== 'visible') return; // Unknown state: nothing to classify.
    if (this.hiddenAtMs !== null) {
      // Visible after an observed hidden interval IS resume-from-suspend.
      this.emit(this.closeHiddenInterval('visibilitychange'));
      return;
    }
    this.emit({ kind: 'visible', cause: 'visibilitychange' });
  }

  /** Page Lifecycle: the page is frozen (CPU suspended, timers stopped). */
  private handleFreeze(): void {
    this.openHiddenInterval();
    this.emit({ kind: 'suspended', cause: 'freeze' });
  }

  /** Page Lifecycle: the page thawed after a freeze. */
  private handleResumeSignal(): void {
    this.emit(this.closeHiddenInterval('resume'));
  }

  private handlePageHide(event: unknown): void {
    // persisted=true: the page may enter the back/forward cache — a genuine
    // suspension a later pageshow can end. Without it the page is being
    // unloaded, which is departure, not suspension; diagnostic only.
    this.openHiddenInterval();
    if (isPersisted(event)) {
      this.emit({ kind: 'suspended', cause: 'pagehide-persisted' });
      return;
    }
    this.onDiagnostic?.('lifecycle-pagehide-unload');
  }

  private handlePageShow(event: unknown): void {
    if (isPersisted(event)) {
      this.emit(this.closeHiddenInterval('pageshow-persisted'));
      return;
    }
    // Initial navigation, not a restore.
    this.onDiagnostic?.('lifecycle-pageshow-initial');
  }

  private openHiddenInterval(): void {
    if (this.hiddenAtMs === null) this.hiddenAtMs = this.now();
  }

  /** Builds the one 'resumed' this interval gets, measuring where possible. */
  private closeHiddenInterval(cause: string): CallLifecycleEvent {
    const hiddenAt = this.hiddenAtMs;
    this.hiddenAtMs = null;
    if (hiddenAt === null) return { kind: 'resumed', cause };
    return { kind: 'resumed', cause, hiddenDurationMs: Math.max(0, this.now() - hiddenAt) };
  }

  private emit(event: CallLifecycleEvent): void {
    if (this.disposed) return;
    const detail: Record<string, string | number> = { kind: event.kind, cause: event.cause };
    if (event.hiddenDurationMs !== undefined) detail['hiddenDurationMs'] = event.hiddenDurationMs;
    this.onDiagnostic?.('lifecycle-event', detail);
    this.onEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Wake lock
// ---------------------------------------------------------------------------

export interface WakeLockSentinelLike {
  /** True once the platform has let the lock go (it does so on every hide). */
  released?: boolean;
  release(): Promise<void> | void;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockNavigatorLike {
  wakeLock?: WakeLockApiLike;
}

export interface CallWakeLockOptions {
  /** Injected for node tests; defaults to the real navigator. */
  navigatorLike?: WakeLockNavigatorLike | null;
  /** Auto-reacquire listens here; null disables reacquisition only. */
  documentLike?: LifecycleDocumentLike | null;
  onDiagnostic?: CallLifecycleDiagnostic;
}

function defaultNavigator(): WakeLockNavigatorLike | null {
  return typeof navigator === 'undefined' ? null : navigator;
}

/**
 * Screen wake lock as a PURE ENHANCEMENT.
 *
 * Every method resolves harmlessly when navigator.wakeLock is missing,
 * refused, or lost — NOTHING may depend on this class for correctness. Users
 * will lock their phones anyway, so the suspend/resume observation above is
 * the path that has to survive; holding the screen awake merely makes
 * suspension less frequent while the call is front-most.
 *
 * The platform drops the lock on every hide. Between request() and release()
 * this class re-requests it on visibilitychange->visible; a refusal at any
 * point costs nothing but the lock itself.
 */
export class CallWakeLock {
  private readonly navigatorLike: WakeLockNavigatorLike | null;
  private readonly documentLike: LifecycleDocumentLike | null;
  private readonly onDiagnostic: CallLifecycleDiagnostic | undefined;
  private readonly detachers: (() => void)[] = [];
  /** The caller's intent; the sentinel is merely how well it is being met. */
  private wantHeld = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private requesting = false;

  constructor(options: CallWakeLockOptions = {}) {
    this.navigatorLike =
      options.navigatorLike === undefined ? defaultNavigator() : options.navigatorLike;
    this.documentLike =
      options.documentLike === undefined ? defaultDocument() : options.documentLike;
    this.onDiagnostic = options.onDiagnostic;
    const detach = attachListener(this.documentLike, 'visibilitychange', () =>
      this.handleVisibilityChange(),
    );
    if (detach !== null) this.detachers.push(detach);
  }

  async request(): Promise<void> {
    this.wantHeld = true;
    await this.acquire('request');
  }

  /** Idempotent; resolves whether or not anything was actually held. */
  async release(): Promise<void> {
    this.wantHeld = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel === null) return;
    try {
      await sentinel.release();
    } catch {
      // Releasing an already-released sentinel throws on some platforms; the
      // outcome is the released state either way.
    }
  }

  dispose(): void {
    void this.release();
    for (const detach of this.detachers.splice(0)) detach();
  }

  private handleVisibilityChange(): void {
    if (this.documentLike?.visibilityState !== 'visible') return;
    if (!this.wantHeld) return;
    void this.acquire('visibilitychange');
  }

  private async acquire(cause: string): Promise<void> {
    const api = this.navigatorLike?.wakeLock;
    if (!api || typeof api.request !== 'function') {
      this.onDiagnostic?.('wake-lock-unsupported', { cause });
      return;
    }
    if (this.requesting) return;
    if (this.sentinel !== null && this.sentinel.released !== true) return; // Still held.
    this.requesting = true;
    try {
      const sentinel = await api.request('screen');
      if (!this.wantHeld) {
        // release() overtook the in-flight request; hold nothing nobody wants.
        try {
          await sentinel.release();
        } catch {
          // Already gone is the desired state.
        }
        return;
      }
      this.sentinel = sentinel;
      this.onDiagnostic?.('wake-lock-acquired', { cause });
    } catch {
      // Refusal (battery saver, permissions policy) costs only the lock.
      this.onDiagnostic?.('wake-lock-request-rejected', { cause });
    } finally {
      this.requesting = false;
    }
  }
}
