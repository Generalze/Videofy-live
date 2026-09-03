/** @author masterzee001 */
/**
 * The original programme's audio and video, held until the cursor needs it.
 *
 * This is the half of the safety buffer that was missing. Captions and
 * translated audio are produced by this service and could always be held; the
 * original media is forwarded live from the broadcaster's tracks, so until
 * something terminates it and holds it, a protective delay could only ever be
 * applied to half a broadcast.
 *
 * WHAT THIS OWNS is which segments exist, where they sit in programme time,
 * and when they may be discarded. What it deliberately does not own is
 * PRODUCING them: an encoder writes independently decodable segments to a
 * spool and tells this store about them. That boundary is why keyframes,
 * jitter, packet loss and codec timing are not this file's problem.
 *
 * ISOLATION IS BY RUN. Two airings of one channel keep separate media, and a
 * viewer of one can never be served the other's -- which is a tenancy
 * question, not a tidiness one.
 */

import {
  mediaThroughCursor,
  retentionWindowMs,
  segmentsToDiscard,
  type MediaAvailability,
  type ProgrammeMediaSegment,
} from '@videofy-live/programme-timeline';

export interface MediaSegmentSink {
  /** Remove a segment's bytes. Failure is reported, never thrown at a broadcast. */
  discard(storageReference: string): Promise<boolean>;
}

/** A sink for deployments that keep nothing: development, and tests. */
export const NO_SEGMENT_SINK: MediaSegmentSink = {
  async discard() {
    return true;
  },
};

export class ProgrammeMediaStore {
  private readonly runs = new Map<string, ProgrammeMediaSegment[]>();
  private discarded = 0;

  constructor(
    private readonly sink: MediaSegmentSink = NO_SEGMENT_SINK,
    private readonly onProblem?: (message: string, detail: Record<string, unknown>) => void,
  ) {}

  /**
   * An encoder finished a segment.
   *
   * A segment that does not begin on a keyframe is REFUSED. A viewer released
   * from the buffer, or reconnecting, starts at a boundary, and a boundary
   * that cannot be decoded on its own produces a delayed broadcast that will
   * not play -- which would be discovered by an audience rather than by us.
   */
  accept(segment: ProgrammeMediaSegment): boolean {
    if (!segment.keyframeAligned) {
      this.onProblem?.('media segment refused: it does not begin on a keyframe', {
        runId: segment.runId,
        segmentId: segment.segmentId,
      });
      return false;
    }
    if (segment.endProgrammeTimeMs <= segment.startProgrammeTimeMs) {
      this.onProblem?.('media segment refused: it occupies no programme time', {
        runId: segment.runId,
        segmentId: segment.segmentId,
      });
      return false;
    }
    const held = this.runs.get(segment.runId) ?? [];
    /*
     * A SEGMENT ID IS ACCEPTED ONCE. Recovery rebuilds this index from the
     * journal, and a recovery that ran twice -- a retried start, a supervisor
     * that called it again -- would otherwise hold every segment twice, double
     * every retention calculation and offer each fragment to a player twice.
     * Idempotent is the only safe shape for an index rebuild.
     */
    if (held.some((existing) => existing.segmentId === segment.segmentId)) return true;
    held.push(segment);
    this.runs.set(segment.runId, held);
    return true;
  }

  /**
   * What a viewer at this cursor may be served, for this run only.
   *
   * `earliestNeededMs` is the oldest programme time still owed to anybody:
   * usually the cursor itself, but behind it for a viewer catching up after a
   * reconnect. If the store no longer reaches that far back this refuses,
   * rather than serving what it has and jumping the audience forward.
   */
  throughCursor(
    runId: string,
    publicOutputTimeMs: number,
    earliestNeededMs: number,
  ): MediaAvailability {
    return mediaThroughCursor(this.runs.get(runId) ?? [], publicOutputTimeMs, earliestNeededMs);
  }

  /**
   * Release what the cursor has left far enough behind.
   *
   * Bounded by the retention window for the configured delay, so a longer
   * delay automatically keeps more rather than silently outrunning its store.
   */
  async prune(runId: string, publicOutputTimeMs: number, configuredDelayMs: number): Promise<number> {
    const held = this.runs.get(runId);
    if (held === undefined) return 0;
    const stale = segmentsToDiscard(held, publicOutputTimeMs, configuredDelayMs);
    if (stale.length === 0) return 0;

    const gone = new Set<string>();
    for (const segment of stale) {
      const removed = await this.sink.discard(segment.storageReference);
      if (removed) gone.add(segment.segmentId);
      else {
        this.onProblem?.('media segment could not be discarded; the spool will grow', {
          runId,
          segmentId: segment.segmentId,
        });
      }
    }
    this.runs.set(
      runId,
      held.filter((segment) => !gone.has(segment.segmentId)),
    );
    this.discarded += gone.size;
    return gone.size;
  }

  /** How far back this run's media currently reaches. Null when it holds none. */
  earliestHeldMs(runId: string): number | null {
    const held = this.runs.get(runId);
    if (held === undefined || held.length === 0) return null;
    return Math.min(...held.map((segment) => segment.startProgrammeTimeMs));
  }

  /** How much programme time is held, against what the delay requires. */
  coverage(runId: string, configuredDelayMs: number): {
    readonly heldMs: number;
    readonly requiredMs: number;
    readonly sufficient: boolean;
  } {
    const held = this.runs.get(runId) ?? [];
    const requiredMs = retentionWindowMs(configuredDelayMs);
    if (held.length === 0) return { heldMs: 0, requiredMs, sufficient: false };
    const earliest = Math.min(...held.map((s) => s.startProgrammeTimeMs));
    const latest = Math.max(...held.map((s) => s.endProgrammeTimeMs));
    const heldMs = latest - earliest;
    return { heldMs, requiredMs, sufficient: heldMs >= configuredDelayMs };
  }

  segmentCount(runId: string): number {
    return this.runs.get(runId)?.length ?? 0;
  }

  /** The broadcast is over; its media goes with it. */
  async release(runId: string): Promise<void> {
    for (const segment of this.runs.get(runId) ?? []) {
      await this.sink.discard(segment.storageReference);
    }
    this.runs.delete(runId);
  }
}
