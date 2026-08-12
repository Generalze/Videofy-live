import { describe, expect, it } from 'vitest';
import {
  PersistentPythonWorker,
  PythonWorkerError,
  type PythonWorkerConfig,
  type WorkerChildProcessLike,
} from '../persistent-python-worker.js';

class FakeChildProcess implements WorkerChildProcessLike {
  readonly writtenLines: string[] = [];
  stdinEnded = false;
  killed = false;
  private readonly stdoutListeners: Array<(chunk: unknown) => void> = [];
  private readonly stderrListeners: Array<(chunk: unknown) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly stdinErrorListeners: Array<(error: Error) => void> = [];

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writtenLines.push(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
    on: (event: 'error', listener: (error: Error) => void): void => {
      if (event === 'error') this.stdinErrorListeners.push(listener);
    },
  };

  emitStdinError(error: Error & { code?: string }): void {
    for (const listener of this.stdinErrorListeners) listener(error);
  }

  readonly stdout = {
    on: (event: 'data', listener: (chunk: unknown) => void): void => {
      if (event === 'data') this.stdoutListeners.push(listener);
    },
  };

  readonly stderr = {
    on: (event: 'data', listener: (chunk: unknown) => void): void => {
      if (event === 'data') this.stderrListeners.push(listener);
    },
  };

  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error' | 'exit', listener: unknown): void {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
  }

  kill(): void {
    this.killed = true;
  }

  emitStdout(chunk: string): void {
    for (const listener of this.stdoutListeners) listener(chunk);
  }

  emitStderr(chunk: string): void {
    for (const listener of this.stderrListeners) listener(chunk);
  }

  emitError(error: Error & { code?: string }): void {
    for (const listener of this.errorListeners) listener(error);
  }

  emitExit(code: number | null, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener(code, signal);
  }

  respond(response: Record<string, unknown>): void {
    this.emitStdout(`${JSON.stringify(response)}\n`);
  }

  parsedRequests(): Array<{ id: number; payload: unknown }> {
    return this.writtenLines.map((line) => JSON.parse(line) as { id: number; payload: unknown });
  }
}

function harness(overrides: Partial<PythonWorkerConfig> = {}) {
  const children: FakeChildProcess[] = [];
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  const worker = new PersistentPythonWorker({
    command: 'python',
    args: ['-c', 'loop-script', 'extra-arg'],
    maxConcurrency: 1,
    // Unit tests exercise steady-state timeouts unless a test opts in.
    coldStartTimeoutMs: 0,
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      const child = new FakeChildProcess();
      children.push(child);
      return child;
    },
    ...overrides,
  });
  return { worker, children, spawnCalls };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('PersistentPythonWorker', () => {
  it('spawns the worker once and reuses it across sequential requests', async () => {
    const { worker, children, spawnCalls } = harness();

    for (let index = 0; index < 3; index += 1) {
      const pending = worker.request({ value: index }, { timeoutMs: 1_000 });
      await flushMicrotasks();
      const child = children[0]!;
      const request = child.parsedRequests().at(-1)!;
      child.respond({ id: request.id, ok: true, result: { echoed: index } });
      await expect(pending).resolves.toEqual({ echoed: index });
    }

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ command: 'python' });
    expect(spawnCalls[0]?.args).toEqual(['-c', 'loop-script', 'extra-arg']);
  });

  it('spawns lazily: no process until the first request', async () => {
    const { spawnCalls } = harness();
    expect(spawnCalls).toHaveLength(0);
  });

  it('queues requests beyond maxConcurrency and dispatches them FIFO', async () => {
    const { worker, children } = harness({ maxConcurrency: 1 });

    const first = worker.request({ order: 1 }, { timeoutMs: 1_000 });
    const second = worker.request({ order: 2 }, { timeoutMs: 1_000 });
    const third = worker.request({ order: 3 }, { timeoutMs: 1_000 });
    await flushMicrotasks();

    const child = children[0]!;
    expect(child.parsedRequests().map((request) => request.payload)).toEqual([{ order: 1 }]);

    child.respond({ id: child.parsedRequests()[0]!.id, ok: true, result: 'one' });
    await expect(first).resolves.toBe('one');
    expect(child.parsedRequests().map((request) => request.payload)).toEqual([
      { order: 1 },
      { order: 2 },
    ]);

    child.respond({ id: child.parsedRequests()[1]!.id, ok: true, result: 'two' });
    await expect(second).resolves.toBe('two');
    child.respond({ id: child.parsedRequests()[2]!.id, ok: true, result: 'three' });
    await expect(third).resolves.toBe('three');
  });

  it('rejects with queue-overflow once the pending queue is full', async () => {
    const { worker } = harness({ maxConcurrency: 1, maxQueueLength: 2 });

    const accepted = [
      worker.request({ n: 1 }, { timeoutMs: 1_000 }),
      worker.request({ n: 2 }, { timeoutMs: 1_000 }),
      worker.request({ n: 3 }, { timeoutMs: 1_000 }),
    ];
    const overflow = worker.request({ n: 4 }, { timeoutMs: 1_000 });

    await expect(overflow).rejects.toMatchObject({
      name: 'PythonWorkerError',
      kind: 'queue-overflow',
    });
    for (const pending of accepted) pending.catch(() => undefined);
  });

  it('extends the first request with the cold-start grace and reverts once warmed', async () => {
    const { worker, children } = harness({ coldStartTimeoutMs: 5_000 });

    const first = worker.request({ warm: true }, { timeoutMs: 20 });
    await flushMicrotasks();
    const child = children[0]!;
    // Well past the steady-state timeout: the cold-start grace keeps it alive.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const request = child.parsedRequests()[0]!;
    child.respond({ id: request.id, ok: true, result: 'warmed' });
    await expect(first).resolves.toBe('warmed');

    // Once warmed, the caller's steady-state timeout applies again.
    const second = worker.request({ fast: true }, { timeoutMs: 20 });
    await expect(second).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects a request that times out and restarts the worker for queued work', async () => {
    const { worker, children, spawnCalls } = harness();

    const timedOut = worker.request({ slow: true }, { timeoutMs: 20 });
    const queued = worker.request({ next: true }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    await expect(timedOut).rejects.toMatchObject({ kind: 'timeout' });
    const timeoutError = (await timedOut.catch((error: unknown) => error)) as PythonWorkerError;
    expect(timeoutError.message).toContain('timed out after 20 ms');
    expect(children[0]!.killed).toBe(true);

    // The queued request is dispatched to a freshly spawned worker.
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(2);
    const replacement = children[1]!;
    const request = replacement.parsedRequests()[0]!;
    expect(request.payload).toEqual({ next: true });
    replacement.respond({ id: request.id, ok: true, result: 'recovered' });
    await expect(queued).resolves.toBe('recovered');
  });

  it('rejects in-flight requests when the worker crashes and respawns on the next request', async () => {
    const { worker, children, spawnCalls } = harness();

    const doomed = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    children[0]!.emitStderr('Traceback (most recent call last):\nRuntimeError: model exploded\n');
    children[0]!.emitExit(1);

    await expect(doomed).rejects.toMatchObject({
      kind: 'worker-exited',
      stderr: expect.stringContaining('model exploded'),
    });

    const retried = worker.request({ n: 2 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(2);
    const replacement = children[1]!;
    const request = replacement.parsedRequests()[0]!;
    replacement.respond({ id: request.id, ok: true, result: 'ok-again' });
    await expect(retried).resolves.toBe('ok-again');
  });

  it('routes an async stdin EPIPE into worker failure instead of crashing the process', async () => {
    const { worker, children, spawnCalls } = harness();

    const doomed = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    const queued = worker.request({ n: 2 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    expect(children).toHaveLength(1);

    // The write itself succeeded; the EPIPE arrives asynchronously afterwards.
    const epipe = new Error('write EPIPE') as Error & { code: string };
    epipe.code = 'EPIPE';
    children[0]!.emitStdinError(epipe);

    await expect(doomed).rejects.toMatchObject({
      name: 'PythonWorkerError',
      kind: 'worker-exited',
      code: 'EPIPE',
      message: expect.stringContaining('stdin stream failed: write EPIPE'),
    });

    // Queued work is redispatched to a fresh worker; the old one is discarded.
    await flushMicrotasks();
    expect(children[0]!.killed).toBe(true);
    expect(spawnCalls).toHaveLength(2);
    const replacement = children[1]!;
    const request = replacement.parsedRequests()[0]!;
    expect(request.payload).toEqual({ n: 2 });
    replacement.respond({ id: request.id, ok: true, result: 'recovered' });
    await expect(queued).resolves.toBe('recovered');
  });

  it('rejects pending and queued requests with the spawn error code when spawn fails', async () => {
    const { worker, children } = harness();

    const first = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    const second = worker.request({ n: 2 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    const spawnError = new Error('spawn python ENOENT') as Error & { code: string };
    spawnError.code = 'ENOENT';
    children[0]!.emitError(spawnError);

    await expect(first).rejects.toMatchObject({ kind: 'spawn-failed', code: 'ENOENT' });
    await expect(second).rejects.toMatchObject({ kind: 'spawn-failed', code: 'ENOENT' });
  });

  it('surfaces python-side errors with message and errorType', async () => {
    const { worker, children } = harness();

    const failing = worker.request({ bad: true }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    const child = children[0]!;
    const request = child.parsedRequests()[0]!;
    child.respond({
      id: request.id,
      ok: false,
      error: 'Unsupported language pair: en->xx',
      errorType: 'RuntimeError',
    });

    await expect(failing).rejects.toMatchObject({
      kind: 'python-error',
      message: 'Unsupported language pair: en->xx',
      errorType: 'RuntimeError',
    });
  });

  it('ignores non-protocol stdout noise and reassembles responses split across chunks', async () => {
    const { worker, children } = harness();

    const pending = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    const child = children[0]!;
    const request = child.parsedRequests()[0]!;
    child.emitStdout('library progress noise\n{"id": null, "ok": false, "error": "bad line"}\n');
    const response = JSON.stringify({ id: request.id, ok: true, result: 'chunked' });
    child.emitStdout(response.slice(0, 10));
    child.emitStdout(`${response.slice(10)}\n`);

    await expect(pending).resolves.toBe('chunked');
  });

  it('matches out-of-order responses to their requests by id', async () => {
    const { worker, children } = harness({ maxConcurrency: 2 });

    const first = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    const second = worker.request({ n: 2 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    const child = children[0]!;
    const requests = child.parsedRequests();
    expect(requests).toHaveLength(2);

    child.respond({ id: requests[1]!.id, ok: true, result: 'second' });
    child.respond({ id: requests[0]!.id, ok: true, result: 'first' });

    await expect(second).resolves.toBe('second');
    await expect(first).resolves.toBe('first');
  });

  it('dispose rejects outstanding requests, ends stdin and refuses new work', async () => {
    const { worker, children } = harness();

    const pending = worker.request({ n: 1 }, { timeoutMs: 1_000 });
    await flushMicrotasks();
    worker.dispose();

    await expect(pending).rejects.toMatchObject({ kind: 'disposed' });
    expect(children[0]!.stdinEnded).toBe(true);
    expect(children[0]!.killed).toBe(true);
    await expect(worker.request({ n: 2 }, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: 'disposed',
    });
  });
});
