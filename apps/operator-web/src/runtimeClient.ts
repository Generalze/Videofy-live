/** @author masterzee001 */
/**
 * What the running broadcast is measurably doing, read from the service.
 *
 * The console has been describing configuration and calling it quality. This
 * is the other half: samples taken as work completed, and the depth the safety
 * buffer is really holding. The two are kept apart all the way to the screen,
 * because a route that is perfectly configured and performing terribly must be
 * able to say both things at once.
 *
 * EVERY ABSENCE IS A DIFFERENT ABSENCE, and this module refuses to flatten
 * them. No run id means the console does not know which broadcast to ask
 * about. A 404 means this service is not running that broadcast -- another
 * process may be. A failed request means nobody knows anything. None of those
 * is "everything is fine", and a single `null` would let the page render them
 * all as an empty table.
 */

export interface StagePerformanceView {
  readonly stage: string;
  readonly samples: number;
  readonly successes: number;
  readonly errors: number;
  readonly timeouts: number;
  readonly reconnects: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly lastSampleAtMs: number | null;
}

export interface RoutePerformanceView {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly stt: StagePerformanceView;
  readonly translation: StagePerformanceView;
  readonly tts: StagePerformanceView;
  readonly endToEnd: StagePerformanceView;
}

export interface SafetyBufferView {
  readonly state: string;
  readonly configuredDelayMs: number;
  readonly protected: boolean;
  readonly detail: string;
  readonly cursor: {
    readonly programmeTimeMs: number;
    readonly publicOutputTimeMs: number;
    readonly bufferDepthMs: number;
  };
}

export interface ProgrammeRuntime {
  readonly runId: string;
  readonly safetyBuffer: SafetyBufferView | null;
  readonly durability: { readonly durable: boolean; readonly reason: string | null };
  readonly routes: readonly RoutePerformanceView[];
  readonly measuredAtMs: number;
}

export type ProgrammeRuntimeResult =
  | { readonly kind: 'runtime'; readonly runtime: ProgrammeRuntime }
  /** No broadcast is identified, so there is nothing to ask about. */
  | { readonly kind: 'no-run' }
  /** The service answered, and it is not running that broadcast. */
  | { readonly kind: 'not-here' }
  /** Nobody could be asked. The reason belongs on screen, not in a log. */
  | { readonly kind: 'unreachable'; readonly reason: string };

export async function fetchProgrammeRuntime(
  ingestUrl: string,
  runId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ProgrammeRuntimeResult> {
  if (runId === null || runId.trim() === '') return { kind: 'no-run' };
  try {
    const response = await fetchImpl(
      `${ingestUrl.replace(/\/+$/u, '')}/programmes/${encodeURIComponent(runId)}/runtime`,
      { cache: 'no-store' },
    );
    if (response.status === 404) return { kind: 'not-here' };
    if (!response.ok) return { kind: 'unreachable', reason: `the media service answered ${response.status}` };
    return { kind: 'runtime', runtime: (await response.json()) as ProgrammeRuntime };
  } catch (error) {
    return {
      kind: 'unreachable',
      reason: error instanceof Error ? error.message : 'the media service could not be reached',
    };
  }
}

/**
 * The sentence a console may print about a stage, and never a kinder one.
 *
 * A stage with no samples says so. It does not say "0 ms", which reads as
 * instantaneous, and it does not say "Good", which is a judgement nobody has
 * made. This is the whole reason the measurement is null rather than zero.
 */
export function stageWords(stage: StagePerformanceView): string {
  if (stage.samples === 0) return 'No samples yet';
  const p50 = stage.p50Ms === null ? '—' : `${stage.p50Ms} ms`;
  const p95 = stage.p95Ms === null ? '—' : `${stage.p95Ms} ms`;
  return `p50 ${p50} · p95 ${p95} · ${stage.samples} samples`;
}

/**
 * What the safety buffer is really doing, in words.
 *
 * Never "On-air delay: 45 s" because somebody chose 45 in a dropdown. The
 * configured target and the actual depth are both named, and the difference
 * between them is the point.
 */
export function bufferWords(buffer: SafetyBufferView | null): string {
  if (buffer === null) return 'No safety buffer is running for this broadcast.';
  const depth = Math.round(buffer.cursor.bufferDepthMs / 100) / 10;
  const target = Math.round(buffer.configuredDelayMs / 100) / 10;
  if (buffer.configuredDelayMs === 0) return 'No delay configured. The programme goes out live.';
  return buffer.protected
    ? `Holding ${depth} s against a ${target} s target.`
    : `${depth} s held of a ${target} s target — NOT protected.`;
}
