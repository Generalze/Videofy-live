/** @author masterzee001 */
/**
 * Every running programme's measurements, kept apart by run.
 *
 * PARTITIONED BY RUN, NOT BY PROGRAMME. A channel can air the same programme
 * twice, and the second airing's latencies are not evidence about the first.
 * Keying on programmeId would silently merge them; keying on the transport
 * session would split one broadcast in half the first time a stream dropped
 * and reconnected. The run is the only identity that means "this broadcast".
 *
 * BOUNDED, because a service that keeps a recorder per run forever is a memory
 * leak with a schedule. Runs are dropped oldest-first past a ceiling, and a
 * finished run is released as soon as its session closes.
 */

import { RoutePerformanceRecorder, type RoutePerformance } from '@videofy-live/programme-quality';

/** How many concurrent runs this process will hold measurements for. */
export const MAX_TRACKED_RUNS = 64;

function directionKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage.toLowerCase()}->${targetLanguage.toLowerCase()}`;
}

export class ProgrammePerformanceRegistry {
  /** runId -> direction -> recorder. Insertion order is the eviction order. */
  private readonly runs = new Map<string, Map<string, RoutePerformanceRecorder>>();

  constructor(private readonly maxRuns: number = MAX_TRACKED_RUNS) {}

  /**
   * The recorder for one direction of one run, created on first use.
   *
   * Directions are separate because a route IS a direction: `en->yo` and
   * `yo->en` are different models with different failure modes, and one
   * average would describe neither.
   */
  for(runId: string, sourceLanguage: string, targetLanguage: string): RoutePerformanceRecorder {
    let directions = this.runs.get(runId);
    if (directions === undefined) {
      directions = new Map();
      this.runs.set(runId, directions);
      this.evictOldest();
    }
    const key = directionKey(sourceLanguage, targetLanguage);
    let recorder = directions.get(key);
    if (recorder === undefined) {
      recorder = new RoutePerformanceRecorder(sourceLanguage, targetLanguage);
      directions.set(key, recorder);
    }
    return recorder;
  }

  /**
   * What one run is doing, or an empty list.
   *
   * An empty list means nothing has been measured for that run -- which is a
   * true and useful answer, and must never be dressed up as a healthy one by
   * whatever renders it.
   */
  snapshot(runId: string): readonly RoutePerformance[] {
    const directions = this.runs.get(runId);
    if (directions === undefined) return [];
    return [...directions.values()].map((recorder) => recorder.snapshot());
  }

  /** Does this process hold measurements for that run at all? */
  tracks(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** The broadcast is over; its counters go with it. */
  release(runId: string): void {
    this.runs.delete(runId);
  }

  private evictOldest(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next();
      if (oldest.done === true) return;
      this.runs.delete(oldest.value);
    }
  }
}
