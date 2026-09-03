/** @author masterzee001 */
/**
 * What the running programme is ACTUALLY doing, measured.
 *
 * This is the second of three separate claims that were previously sharing one
 * word. Readiness says a route CAN operate: approved, engine configured,
 * provider present. This says how it is behaving right now, from samples taken
 * as work completed. They answer different questions and one is never evidence
 * for the other -- a perfectly configured route with a dying provider is ready
 * and performing terribly, and the console must be able to say both.
 *
 * THE RULE THAT SHAPES EVERY TYPE HERE: a latency that was never measured is
 * `null`, never `0`. Zero is a measurement, and a very good one; showing it
 * for a stage nobody has exercised would report a flawless pipeline that has
 * not run. Every consumer is therefore forced by the compiler to decide what
 * "no samples yet" looks like on screen.
 */

import type { PipelineStage } from './index.js';

/** One completed unit of work, or one way it failed. */
export type StageOutcome = 'success' | 'error' | 'timeout';

export interface StagePerformance {
  readonly stage: PipelineStage;
  /** How many latency samples the percentiles below are drawn from. */
  readonly samples: number;
  readonly successes: number;
  readonly errors: number;
  readonly timeouts: number;
  /** Transport restarts under this stage: a provider dropping and returning. */
  readonly reconnects: number;
  /** Null until something has actually been measured. */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /**
   * Null until there are enough samples for a 99th percentile to mean
   * anything. With twenty samples it is just the slowest one wearing a
   * statistical name.
   */
  readonly p99Ms: number | null;
  /** Epoch ms of the most recent sample, so a console can say "4 s ago". */
  readonly lastSampleAtMs: number | null;
}

/** Below this, a p99 is a single outlier with a label. */
export const P99_MINIMUM_SAMPLES = 100;

/**
 * The retained sample window.
 *
 * Bounded because a programme runs for hours and nobody needs the tail of a
 * broadcast's first minute to describe its current behaviour. Recent enough to
 * be current, long enough that one slow sentence does not swing p95.
 */
export const PERFORMANCE_WINDOW_SAMPLES = 512;

export function emptyStagePerformance(stage: PipelineStage): StagePerformance {
  return {
    stage,
    samples: 0,
    successes: 0,
    errors: 0,
    timeouts: 0,
    reconnects: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    lastSampleAtMs: null,
  };
}

/**
 * The percentile of a sorted sample set, by nearest rank.
 *
 * Nearest-rank rather than interpolation on purpose: an interpolated p95
 * reports a latency that no request actually experienced, and the question
 * being asked here is "how slow was it for the unlucky ones", which wants a
 * real observation.
 */
function percentile(sortedAscending: readonly number[], fraction: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? null;
}

/**
 * Collects samples for one stage of one route.
 *
 * Deliberately tiny and synchronous: it sits on the hot path of a live
 * programme, and a measurement that slows the thing it measures is worse than
 * no measurement.
 */
export class StagePerformanceRecorder {
  private readonly latencies: number[] = [];
  private successes = 0;
  private errors = 0;
  private timeouts = 0;
  private reconnects = 0;
  private lastSampleAtMs: number | null = null;

  constructor(
    private readonly stage: PipelineStage,
    private readonly windowSamples: number = PERFORMANCE_WINDOW_SAMPLES,
  ) {}

  /**
   * Record one completed attempt.
   *
   * A failure still carries a latency -- how long it took to fail is a real
   * and useful number -- but a timeout does not enter the percentiles: it
   * measures the deadline, not the provider, and would drag p95 toward
   * whatever the timeout happens to be set to.
   */
  record(outcome: StageOutcome, latencyMs: number, atMs: number): void {
    if (outcome === 'success') this.successes += 1;
    else if (outcome === 'error') this.errors += 1;
    else this.timeouts += 1;

    this.lastSampleAtMs = atMs;
    if (outcome === 'timeout') return;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;

    this.latencies.push(latencyMs);
    if (this.latencies.length > this.windowSamples) this.latencies.shift();
  }

  /** A provider's transport came back. Counted, never treated as a latency. */
  noteReconnect(atMs: number): void {
    this.reconnects += 1;
    this.lastSampleAtMs = atMs;
  }

  snapshot(): StagePerformance {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      stage: this.stage,
      samples: sorted.length,
      successes: this.successes,
      errors: this.errors,
      timeouts: this.timeouts,
      reconnects: this.reconnects,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: sorted.length >= P99_MINIMUM_SAMPLES ? percentile(sorted, 0.99) : null,
      lastSampleAtMs: this.lastSampleAtMs,
    };
  }
}

export interface RoutePerformance {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly stt: StagePerformance;
  readonly translation: StagePerformance;
  readonly tts: StagePerformance;
  /**
   * Speech in, translated speech out, measured end to end.
   *
   * Not the sum of the three stages: they overlap, they queue, and a listener
   * experiences the whole path rather than its parts. Null until a complete
   * utterance has made the journey.
   */
  readonly endToEnd: StagePerformance;
}

/**
 * Every stage of one direction, recorded together.
 *
 * Keyed by direction because that is what a route IS: `en->yo` and `yo->en`
 * are different models with different failure modes, and averaging them would
 * describe neither.
 */
export class RoutePerformanceRecorder {
  private readonly stt = new StagePerformanceRecorder('stt');
  private readonly translation = new StagePerformanceRecorder('translation');
  private readonly tts = new StagePerformanceRecorder('tts');
  // Reuses the stage shape; 'tts' is its nearest label and nothing reads it.
  private readonly endToEnd = new StagePerformanceRecorder('tts');

  constructor(
    private readonly sourceLanguage: string,
    private readonly targetLanguage: string,
  ) {}

  for(stage: PipelineStage): StagePerformanceRecorder {
    if (stage === 'stt') return this.stt;
    if (stage === 'translation') return this.translation;
    return this.tts;
  }

  recordEndToEnd(outcome: StageOutcome, latencyMs: number, atMs: number): void {
    this.endToEnd.record(outcome, latencyMs, atMs);
  }

  snapshot(): RoutePerformance {
    return {
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      stt: this.stt.snapshot(),
      translation: this.translation.snapshot(),
      tts: this.tts.snapshot(),
      endToEnd: this.endToEnd.snapshot(),
    };
  }
}
