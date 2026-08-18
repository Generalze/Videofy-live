import { describe, expect, it } from 'vitest';
import {
  CallLifecycleObserver,
  CallWakeLock,
  type CallLifecycleEvent,
  type LifecycleDocumentLike,
  type LifecycleTargetLike,
  type WakeLockSentinelLike,
} from './callLifecycle';

class FakeTarget implements LifecycleTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((existing) => existing !== listener),
    );
  }
  dispatch(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  listenerCount(): number {
    let total = 0;
    for (const registered of this.listeners.values()) total += registered.length;
    return total;
  }

  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
}

class FakeDocument extends FakeTarget implements LifecycleDocumentLike {
  visibilityState = 'visible';
}

/** A target that can attach but never detach — dispose must still silence it. */
class StickyTarget implements LifecycleTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.attached.push({ type, listener });
  }
  dispatch(type: string, event?: unknown): void {
    for (const entry of [...this.attached]) {
      if (entry.type === type) entry.listener(event);
    }
  }

  private readonly attached: { type: string; listener: (event: unknown) => void }[] = [];
}

interface DiagnosticRecord {
  name: string;
  detail: Record<string, string | number> | undefined;
}

function observerHarness() {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const events: CallLifecycleEvent[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  let nowMs = 0;
  const observer = new CallLifecycleObserver({
    documentLike: doc,
    windowLike: win,
    onEvent: (event) => events.push(event),
    onDiagnostic: (name, detail) => diagnostics.push({ name, detail }),
    now: () => nowMs,
  });
  const setNow = (ms: number): void => {
    nowMs = ms;
  };
  const hide = (atMs: number): void => {
    setNow(atMs);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
  };
  const show = (atMs: number): void => {
    setNow(atMs);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
  };
  return { observer, doc, win, events, diagnostics, setNow, hide, show };
}

function kinds(events: readonly CallLifecycleEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('CallLifecycleObserver feature detection', () => {
  it('constructs, stays silent and disposes when both targets are missing', () => {
    const events: CallLifecycleEvent[] = [];
    const observer = new CallLifecycleObserver({
      documentLike: null,
      windowLike: null,
      onEvent: (event) => events.push(event),
    });
    observer.dispose();
    expect(events).toEqual([]);
  });

  it('skips targets without addEventListener, one diagnostic per event', () => {
    const skipped: string[] = [];
    const observer = new CallLifecycleObserver({
      documentLike: {},
      windowLike: {},
      onEvent: () => undefined,
      onDiagnostic: (name, detail) => {
        if (name === 'lifecycle-subscribe-skipped') skipped.push(String(detail?.['event']));
      },
    });
    expect(skipped.sort()).toEqual(
      ['freeze', 'offline', 'online', 'pagehide', 'pageshow', 'resume', 'visibilitychange'].sort(),
    );
    observer.dispose();
  });

  it('contains a throwing addEventListener instead of failing construction', () => {
    const skipped: string[] = [];
    const hostile: LifecycleTargetLike = {
      addEventListener: () => {
        throw new Error('not here');
      },
    };
    const observer = new CallLifecycleObserver({
      documentLike: hostile,
      windowLike: hostile,
      onEvent: () => undefined,
      onDiagnostic: (name) => {
        if (name === 'lifecycle-subscribe-skipped') skipped.push(name);
      },
    });
    expect(skipped).toHaveLength(7);
    observer.dispose();
  });

  it('a target without removeEventListener still goes quiet after dispose', () => {
    const doc = new StickyTarget() as StickyTarget & LifecycleDocumentLike;
    doc.visibilityState = 'hidden';
    const events: CallLifecycleEvent[] = [];
    const observer = new CallLifecycleObserver({
      documentLike: doc,
      windowLike: null,
      onEvent: (event) => events.push(event),
    });
    doc.dispatch('visibilitychange');
    expect(kinds(events)).toEqual(['hidden']);
    observer.dispose();
    doc.dispatch('visibilitychange');
    expect(kinds(events)).toEqual(['hidden']);
  });
});

describe('suspend classification', () => {
  it('freeze is suspended, and the resume event closes it with a measured duration', () => {
    const h = observerHarness();
    h.setNow(2_000);
    h.doc.dispatch('freeze');
    h.setNow(9_500);
    h.doc.dispatch('resume');
    expect(h.events).toStrictEqual([
      { kind: 'suspended', cause: 'freeze' },
      { kind: 'resumed', cause: 'resume', hiddenDurationMs: 7_500 },
    ]);
  });

  it('pagehide with persisted=true is suspended; the pageshow restore measures from it', () => {
    const h = observerHarness();
    h.setNow(100);
    h.win.dispatch('pagehide', { persisted: true });
    h.setNow(700);
    h.win.dispatch('pageshow', { persisted: true });
    expect(h.events).toStrictEqual([
      { kind: 'suspended', cause: 'pagehide-persisted' },
      { kind: 'resumed', cause: 'pageshow-persisted', hiddenDurationMs: 600 },
    ]);
  });

  it('pagehide without persisted is unload, not suspension', () => {
    const h = observerHarness();
    h.win.dispatch('pagehide', { persisted: false });
    h.win.dispatch('pagehide', undefined);
    expect(h.events).toEqual([]);
    expect(h.diagnostics.filter((d) => d.name === 'lifecycle-pagehide-unload')).toHaveLength(2);
  });

  it('pageshow with persisted=true resumes even with no observed start, without a guessed duration', () => {
    const h = observerHarness();
    h.win.dispatch('pageshow', { persisted: true });
    expect(h.events).toStrictEqual([{ kind: 'resumed', cause: 'pageshow-persisted' }]);
  });

  it('pageshow without persisted is initial load, not a resume', () => {
    const h = observerHarness();
    h.win.dispatch('pageshow', { persisted: false });
    h.win.dispatch('pageshow', undefined);
    expect(h.events).toEqual([]);
    expect(h.diagnostics.filter((d) => d.name === 'lifecycle-pageshow-initial')).toHaveLength(2);
  });

  it('visibilitychange to visible after a hidden interval is resumed, not merely visible', () => {
    const h = observerHarness();
    h.hide(1_000);
    h.show(61_500);
    expect(h.events).toStrictEqual([
      { kind: 'hidden', cause: 'visibilitychange' },
      { kind: 'resumed', cause: 'visibilitychange', hiddenDurationMs: 60_500 },
    ]);
  });

  it('visible with no open interval is plain visible', () => {
    const h = observerHarness();
    h.show(5_000);
    expect(h.events).toStrictEqual([{ kind: 'visible', cause: 'visibilitychange' }]);
  });

  it('resumed fires once per interval; the trailing visible is just visible', () => {
    const h = observerHarness();
    h.hide(0);
    h.doc.dispatch('freeze');
    h.setNow(5_000);
    h.doc.dispatch('resume');
    h.show(6_000);
    expect(h.events).toStrictEqual([
      { kind: 'hidden', cause: 'visibilitychange' },
      { kind: 'suspended', cause: 'freeze' },
      { kind: 'resumed', cause: 'resume', hiddenDurationMs: 5_000 },
      { kind: 'visible', cause: 'visibilitychange' },
    ]);
  });

  it('freeze after hidden measures from the hidden start, not the freeze', () => {
    const h = observerHarness();
    h.hide(1_000);
    h.setNow(3_000);
    h.doc.dispatch('freeze');
    h.setNow(10_000);
    h.doc.dispatch('resume');
    const resumed = h.events.find((event) => event.kind === 'resumed');
    expect(resumed?.hiddenDurationMs).toBe(9_000);
  });
});

describe('network signals are not suspend signals', () => {
  it('offline is offline, never suspended', () => {
    const h = observerHarness();
    h.win.dispatch('offline');
    expect(h.events).toStrictEqual([{ kind: 'offline', cause: 'offline' }]);
  });

  it('online is online, never resumed', () => {
    const h = observerHarness();
    h.win.dispatch('online');
    expect(h.events).toStrictEqual([{ kind: 'online', cause: 'online' }]);
  });

  it('network events neither open nor close a hidden interval', () => {
    const h = observerHarness();
    h.hide(0);
    h.win.dispatch('online');
    h.show(500);
    expect(h.events).toStrictEqual([
      { kind: 'hidden', cause: 'visibilitychange' },
      { kind: 'online', cause: 'online' },
      { kind: 'resumed', cause: 'visibilitychange', hiddenDurationMs: 500 },
    ]);
  });
});

describe('dispose', () => {
  it('detaches every listener and silences the stream', () => {
    const h = observerHarness();
    expect(h.doc.listenerCount() + h.win.listenerCount()).toBe(7);
    h.observer.dispose();
    expect(h.doc.listenerCount()).toBe(0);
    expect(h.win.listenerCount()).toBe(0);
    h.hide(0);
    h.doc.dispatch('freeze');
    h.win.dispatch('pageshow', { persisted: true });
    h.win.dispatch('offline');
    expect(h.events).toEqual([]);
    h.observer.dispose(); // Second dispose is a no-op, not an error.
  });
});

describe('diagnostics', () => {
  it('carries only names, kinds, causes and durations', () => {
    const h = observerHarness();
    h.hide(0);
    h.show(250);
    h.win.dispatch('offline');
    h.win.dispatch('pageshow', { persisted: false });
    expect(h.diagnostics.length).toBeGreaterThan(0);
    for (const { detail } of h.diagnostics) {
      for (const [key, value] of Object.entries(detail ?? {})) {
        expect(['kind', 'cause', 'hiddenDurationMs', 'event']).toContain(key);
        expect(['string', 'number']).toContain(typeof value);
      }
    }
  });
});

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCount = 0;
  release(): Promise<void> {
    this.releaseCount += 1;
    this.released = true;
    return Promise.resolve();
  }
}

class FakeWakeLockApi {
  readonly requestedTypes: string[] = [];
  readonly sentinels: FakeSentinel[] = [];
  rejectNext = false;
  deferNext = false;

  request(type: 'screen'): Promise<WakeLockSentinelLike> {
    this.requestedTypes.push(type);
    if (this.rejectNext) {
      this.rejectNext = false;
      return Promise.reject(new Error('NotAllowedError'));
    }
    if (this.deferNext) {
      this.deferNext = false;
      return new Promise((resolveRequest) => {
        this.deferred = resolveRequest;
      });
    }
    const sentinel = new FakeSentinel();
    this.sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  }

  resolveDeferred(): FakeSentinel {
    const sentinel = new FakeSentinel();
    this.sentinels.push(sentinel);
    this.deferred?.(sentinel);
    this.deferred = null;
    return sentinel;
  }

  private deferred: ((sentinel: FakeSentinel) => void) | null = null;
}

function wakeLockHarness() {
  const api = new FakeWakeLockApi();
  const doc = new FakeDocument();
  const diagnostics: string[] = [];
  const lock = new CallWakeLock({
    navigatorLike: { wakeLock: api },
    documentLike: doc,
    onDiagnostic: (name) => diagnostics.push(name),
  });
  return { api, doc, lock, diagnostics };
}

const flushAsync = (): Promise<void> => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

describe('CallWakeLock', () => {
  it('every method resolves harmlessly when wake lock is unsupported', async () => {
    const diagnostics: string[] = [];
    const lock = new CallWakeLock({
      navigatorLike: {},
      documentLike: null,
      onDiagnostic: (name) => diagnostics.push(name),
    });
    await lock.request();
    await lock.release();
    lock.dispose();
    expect(diagnostics).toContain('wake-lock-unsupported');

    const bare = new CallWakeLock({ navigatorLike: null, documentLike: null });
    await bare.request();
    await bare.release();
    bare.dispose();
  });

  it('request acquires a screen wake lock when supported', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    expect(h.api.requestedTypes).toEqual(['screen']);
    expect(h.diagnostics).toContain('wake-lock-acquired');
  });

  it('request while already held does not stack sentinels', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    await h.lock.request();
    expect(h.api.requestedTypes).toHaveLength(1);
  });

  it('auto-reacquires on visibilitychange to visible while held', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    h.api.sentinels[0]!.released = true; // The platform dropped it on hide.
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await flushAsync();
    expect(h.api.requestedTypes).toHaveLength(2);
  });

  it('does not reacquire while hidden', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    h.api.sentinels[0]!.released = true;
    h.doc.visibilityState = 'hidden';
    h.doc.dispatch('visibilitychange');
    await flushAsync();
    expect(h.api.requestedTypes).toHaveLength(1);
  });

  it('does not reacquire after release', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    await h.lock.release();
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await flushAsync();
    expect(h.api.requestedTypes).toHaveLength(1);
  });

  it('release is idempotent', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    await h.lock.release();
    await h.lock.release();
    expect(h.api.sentinels[0]!.releaseCount).toBe(1);
  });

  it('a refused request stays harmless and a later visible retries', async () => {
    const h = wakeLockHarness();
    h.api.rejectNext = true;
    await h.lock.request();
    expect(h.diagnostics).toContain('wake-lock-request-rejected');
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await flushAsync();
    expect(h.api.requestedTypes).toHaveLength(2);
    expect(h.diagnostics).toContain('wake-lock-acquired');
  });

  it('release overtaking an in-flight request lets the late sentinel go', async () => {
    const h = wakeLockHarness();
    h.api.deferNext = true;
    const pending = h.lock.request();
    await h.lock.release();
    const sentinel = h.api.resolveDeferred();
    await pending;
    expect(sentinel.releaseCount).toBe(1);
    h.doc.visibilityState = 'visible';
    h.doc.dispatch('visibilitychange');
    await flushAsync();
    expect(h.api.requestedTypes).toHaveLength(1); // Nothing wants it anymore.
  });

  it('dispose releases the lock and detaches the visibility listener', async () => {
    const h = wakeLockHarness();
    await h.lock.request();
    h.lock.dispose();
    await flushAsync();
    expect(h.api.sentinels[0]!.releaseCount).toBe(1);
    expect(h.doc.listenerCount()).toBe(0);
  });
});
