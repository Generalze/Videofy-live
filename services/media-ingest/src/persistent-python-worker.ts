import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_MAX_QUEUE_LENGTH = 200;
const DEFAULT_COLD_START_TIMEOUT_MS = 300_000;
const STDERR_TAIL_LIMIT = 8_192;

export type PythonWorkerErrorKind =
  | 'spawn-failed'
  | 'worker-exited'
  | 'timeout'
  | 'python-error'
  | 'queue-overflow'
  | 'disposed';

export interface PythonWorkerErrorDetails {
  errorType?: string | null;
  stderr?: string;
  code?: string | null;
  signal?: string | null;
  exitCode?: number | null;
}

export class PythonWorkerError extends Error {
  readonly kind: PythonWorkerErrorKind;
  readonly errorType: string | null;
  readonly stderr: string;
  readonly code: string | null;
  readonly signal: string | null;
  readonly exitCode: number | null;

  constructor(message: string, kind: PythonWorkerErrorKind, details: PythonWorkerErrorDetails = {}) {
    super(message);
    this.name = 'PythonWorkerError';
    this.kind = kind;
    this.errorType = details.errorType ?? null;
    this.stderr = details.stderr ?? '';
    this.code = details.code ?? null;
    this.signal = details.signal ?? null;
    this.exitCode = details.exitCode ?? null;
  }
}

export interface WorkerStdinLike {
  write(chunk: string): unknown;
  end(): void;
}

export interface WorkerStreamLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

export interface WorkerChildProcessLike {
  stdin: WorkerStdinLike | null;
  stdout: WorkerStreamLike | null;
  stderr: WorkerStreamLike | null;
  pid?: number | undefined;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(): unknown;
}

export type WorkerSpawn = (command: string, args: readonly string[]) => WorkerChildProcessLike;

export interface PythonWorkerConfig {
  command: string;
  args: readonly string[];
  maxConcurrency: number;
  maxQueueLength?: number;
  label?: string;
  killOnTimeout?: boolean;
  spawn?: WorkerSpawn;
  /**
   * Minimum timeout applied while the worker has not yet completed a request
   * after a (re)spawn: the first request pays interpreter start-up plus model
   * load, which routinely exceeds steady-state per-request budgets.
   */
  coldStartTimeoutMs?: number;
}

export interface PythonWorkerRequestOptions {
  timeoutMs: number;
}

export interface PythonWorkerLike {
  request(payload: unknown, options: PythonWorkerRequestOptions): Promise<unknown>;
  dispose(): void;
}

export type PythonWorkerFactory = (config: PythonWorkerConfig) => PythonWorkerLike;

export const createPersistentPythonWorker: PythonWorkerFactory = (config) =>
  new PersistentPythonWorker(config);

interface PendingRequest {
  id: number;
  payload: unknown;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: PythonWorkerError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

const defaultSpawn: WorkerSpawn = (command, args) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
};

/**
 * Manages one long-lived `python -c <loop script>` process. The python side reads
 * one JSON request per line from stdin and writes one JSON response per line to
 * stdout ({"id", "ok", "result"} or {"id", "ok": false, "error", "errorType"}).
 * Requests beyond maxConcurrency queue in FIFO order; the worker is spawned
 * lazily on first use and respawned on the next request after a crash.
 */
export class PersistentPythonWorker implements PythonWorkerLike {
  private child: WorkerChildProcessLike | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private readonly inFlight = new Map<number, PendingRequest>();
  private readonly queue: PendingRequest[] = [];
  private stdoutBuffer = '';
  private stderrTail = '';
  private disposed = false;
  private readonly label: string;
  private readonly maxConcurrency: number;
  private readonly maxQueueLength: number;
  private readonly killOnTimeout: boolean;
  private readonly spawnWorker: WorkerSpawn;
  private readonly coldStartTimeoutMs: number;
  private warmed = false;

  constructor(private readonly config: PythonWorkerConfig) {
    this.label = config.label ?? 'python';
    this.maxConcurrency = Math.max(1, config.maxConcurrency);
    this.maxQueueLength = config.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this.killOnTimeout = config.killOnTimeout ?? true;
    this.spawnWorker = config.spawn ?? defaultSpawn;
    this.coldStartTimeoutMs = config.coldStartTimeoutMs ?? DEFAULT_COLD_START_TIMEOUT_MS;
  }

  request(payload: unknown, options: PythonWorkerRequestOptions): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(
        new PythonWorkerError(`${this.label} worker has been disposed.`, 'disposed'),
      );
    }
    if (this.queue.length >= this.maxQueueLength) {
      return Promise.reject(
        new PythonWorkerError(
          `${this.label} worker queue is full (${this.queue.length} requests pending).`,
          'queue-overflow',
        ),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({
        id: this.nextRequestId++,
        payload,
        timeoutMs: options.timeoutMs,
        resolve,
        reject,
        timer: null,
        settled: false,
      });
      this.flush();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAllRequests(
      new PythonWorkerError(`${this.label} worker has been disposed.`, 'disposed'),
    );
    this.discardChild(true);
  }

  private flush(): void {
    while (!this.disposed && this.queue.length > 0 && this.inFlight.size < this.maxConcurrency) {
      const child = this.ensureChild();
      if (!child) return;
      const pending = this.queue.shift();
      if (!pending) return;
      this.inFlight.set(pending.id, pending);
      if (!Number.isFinite(pending.timeoutMs) || pending.timeoutMs <= 0) {
        pending.timeoutMs = this.coldStartTimeoutMs || DEFAULT_COLD_START_TIMEOUT_MS;
      }
      if (!this.warmed) {
        pending.timeoutMs = Math.max(pending.timeoutMs, this.coldStartTimeoutMs);
      }
      pending.timer = setTimeout(() => this.handleTimeout(pending), pending.timeoutMs);
      try {
        child.stdin?.write(`${JSON.stringify({ id: pending.id, payload: pending.payload })}\n`);
      } catch (error) {
        this.handleWorkerFailure(
          new PythonWorkerError(
            `${this.label} worker stdin write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'worker-exited',
            { stderr: this.stderrTail },
          ),
        );
        return;
      }
    }
  }

  private ensureChild(): WorkerChildProcessLike | null {
    if (this.child) return this.child;
    let child: WorkerChildProcessLike;
    try {
      child = this.spawnWorker(this.config.command, this.config.args);
    } catch (error) {
      const err = error as { code?: unknown; message?: unknown };
      this.failAllRequests(
        new PythonWorkerError(
          `Failed to spawn ${this.label} worker: ${
            typeof err.message === 'string' ? err.message : 'unknown spawn error'
          }`,
          'spawn-failed',
          { code: typeof err.code === 'string' ? err.code : null },
        ),
      );
      return null;
    }
    this.generation += 1;
    const generation = this.generation;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    child.stdout?.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.handleStdout(String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.on('error', (error) => {
      if (generation !== this.generation) return;
      this.handleChildError(error);
    });
    child.on('exit', (code, signal) => {
      if (generation !== this.generation) return;
      this.handleChildExit(code, signal);
    });
    this.child = child;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleResponseLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleResponseLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // Non-protocol stdout noise (library prints); ignore.
    }
    if (typeof raw !== 'object' || raw === null) return;
    const response = raw as Record<string, unknown>;
    const id = response['id'];
    if (typeof id !== 'number') return; // Python reply to a malformed request line.
    const pending = this.inFlight.get(id);
    if (!pending) return;
    this.inFlight.delete(id);
    this.clearTimer(pending);
    pending.settled = true;
    if (response['ok'] === true) {
      this.warmed = true;
      pending.resolve(response['result']);
    } else {
      pending.reject(
        new PythonWorkerError(
          typeof response['error'] === 'string' && response['error']
            ? response['error']
            : `${this.label} worker reported an unknown error.`,
          'python-error',
          {
            errorType: typeof response['errorType'] === 'string' ? response['errorType'] : null,
            stderr: this.stderrTail,
          },
        ),
      );
    }
    this.flush();
  }

  private handleTimeout(pending: PendingRequest): void {
    if (pending.settled) return;
    this.inFlight.delete(pending.id);
    pending.settled = true;
    pending.timer = null;
    pending.reject(
      new PythonWorkerError(
        `${this.label} worker request timed out after ${pending.timeoutMs} ms.`,
        'timeout',
        { stderr: this.stderrTail },
      ),
    );
    if (this.killOnTimeout) {
      // The python loop is serial and may be wedged; restart it so queued
      // requests get a fresh process.
      this.handleWorkerFailure(
        new PythonWorkerError(
          `${this.label} worker was restarted after a request timeout.`,
          'worker-exited',
          { stderr: this.stderrTail, signal: 'SIGTERM' },
        ),
      );
    } else {
      this.flush();
    }
  }

  private handleWorkerFailure(error: PythonWorkerError): void {
    this.discardChild(false);
    this.failInFlight(error);
    this.flush();
  }

  private handleChildExit(code: number | null, signal: string | null): void {
    this.child = null;
    this.generation += 1;
    const stderrSummary = firstMeaningfulLine(this.stderrTail);
    this.failInFlight(
      new PythonWorkerError(
        `${this.label} worker exited unexpectedly (code ${code ?? 'null'}, signal ${
          signal ?? 'null'
        }).${stderrSummary ? ` ${stderrSummary}` : ''}`,
        'worker-exited',
        { stderr: this.stderrTail, signal, exitCode: code },
      ),
    );
    this.flush();
  }

  private handleChildError(error: Error): void {
    this.child = null;
    this.generation += 1;
    const code = (error as { code?: unknown }).code;
    // Spawn failures (e.g. ENOENT) are deterministic; fail queued requests too
    // instead of retrying the same broken executable for each of them.
    this.failAllRequests(
      new PythonWorkerError(
        `Failed to start ${this.label} worker: ${error.message}`,
        'spawn-failed',
        { code: typeof code === 'string' ? code : null, stderr: this.stderrTail },
      ),
    );
  }

  private discardChild(endStdin: boolean): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.generation += 1;
    // A respawned worker pays the model load again on its first request.
    this.warmed = false;
    if (endStdin) {
      try {
        child.stdin?.end();
      } catch {
        // Ignore shutdown races.
      }
    }
    try {
      // On Windows a venv python.exe is a shim that spawns the real interpreter
      // as a grandchild; child.kill() only reaches the shim and orphans the
      // model-holding process. Kill the whole tree.
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill();
      }
    } catch {
      // Ignore shutdown races.
    }
  }

  private failInFlight(error: PythonWorkerError): void {
    const pending = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const request of pending) this.settleReject(request, error);
  }

  private failAllRequests(error: PythonWorkerError): void {
    this.failInFlight(error);
    for (const request of this.queue.splice(0)) this.settleReject(request, error);
  }

  private settleReject(request: PendingRequest, error: PythonWorkerError): void {
    if (request.settled) return;
    request.settled = true;
    this.clearTimer(request);
    request.reject(error);
  }

  private clearTimer(request: PendingRequest): void {
    if (request.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
  }
}

function firstMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? '';
}

/**
 * Python-side request loop shared by every persistent worker script. Worker
 * scripts append their own model setup, define `handle(payload)`, then call
 * `run_worker_loop(handle)`. Malformed request lines produce an error response
 * (id null) without stopping the loop; stdin EOF exits the loop cleanly.
 */
export const PYTHON_WORKER_LOOP = String.raw`
import json
import sys

def run_worker_loop(handle):
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("worker request must be a JSON object")
            request_id = request.get("id")
            payload = request.get("payload")
            result = handle(payload if isinstance(payload, dict) else {})
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc) or exc.__class__.__name__,
                "errorType": exc.__class__.__name__,
            }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
`;
