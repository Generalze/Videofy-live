/** @author masterzee001 */
/**
 * One timeline and one output buffer per broadcast, held by run.
 *
 * The same partition rule as the performance registry, for the same reason: a
 * channel can air the same programme twice, and the second airing's timeline
 * is not a continuation of the first. Keying on the programme would splice two
 * broadcasts together; keying on the transport session would start a new
 * broadcast every time a stream reconnected.
 *
 * A RECONNECT MUST NOT BEGIN A SECOND BROADCAST. `open` returns the existing
 * timeline when one is already held for that run, so a dropped stream that
 * comes back keeps writing to the account it was already writing to, and the
 * audience's cursor does not reset to the beginning of a broadcast they are
 * already halfway through.
 */

import {
  ProgrammeOutputBuffer,
  ProgrammeTimeline,
  type BufferPolicy,
  type BufferStatus,
} from '@videofy-live/programme-timeline';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';

/** How many concurrent broadcasts this process holds an account for. */
export const MAX_TRACKED_TIMELINES = 32;

interface TrackedRun {
  readonly identity: ProgrammeRunIdentity;
  readonly timeline: ProgrammeTimeline;
  readonly buffer: ProgrammeOutputBuffer;
}

export class ProgrammeTimelineRegistry {
  private readonly runs = new Map<string, TrackedRun>();

  constructor(
    private readonly maxRuns: number = MAX_TRACKED_TIMELINES,
    private readonly defaultDelayMs = 0,
    private readonly policy?: BufferPolicy,
  ) {}

  /**
   * The timeline for this run, resumed if it already exists.
   *
   * Resumed rather than replaced: the identity is what says whether this is
   * the same broadcast, and a stream that dropped and returned is the same
   * broadcast by definition.
   */
  open(identity: ProgrammeRunIdentity): ProgrammeTimeline {
    const existing = this.runs.get(identity.runId);
    if (existing !== undefined) return existing.timeline;

    const timeline = new ProgrammeTimeline(identity);
    const buffer =
      this.policy === undefined
        ? new ProgrammeOutputBuffer(timeline, this.defaultDelayMs)
        : new ProgrammeOutputBuffer(timeline, this.defaultDelayMs, this.policy);
    this.runs.set(identity.runId, { identity, timeline, buffer });
    this.evictOldest();
    return timeline;
  }

  timeline(runId: string): ProgrammeTimeline | null {
    return this.runs.get(runId)?.timeline ?? null;
  }

  buffer(runId: string): ProgrammeOutputBuffer | null {
    return this.runs.get(runId)?.buffer ?? null;
  }

  /**
   * What the buffer for this run is doing, or null when nothing is tracked.
   *
   * Null rather than an idle-looking status: a console must be able to tell
   * "this process is not running that broadcast" from "that broadcast is
   * holding no delay", which look identical if both answer with zeroes.
   */
  status(runId: string): BufferStatus | null {
    return this.runs.get(runId)?.buffer.status() ?? null;
  }

  tracks(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** The broadcast is over. Its account and its cursor go with it. */
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
