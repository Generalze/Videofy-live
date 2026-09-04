/** @author masterzee001 */
/**
 * Original programme audio and video, addressed by programme time.
 *
 * WHY SEGMENTS AND NOT PACKETS. A safety delay implemented by holding RTP and
 * forwarding it later has to be right about keyframes, sequence numbers,
 * retransmission, jitter, RTCP and codec timing, and has to stay right across
 * a reconnect and a process restart. Independently decodable segments make
 * almost all of that somebody else's solved problem: a segment begins on a
 * keyframe, carries its own timing, and can be handed to a player that has
 * never seen the ones before it.
 *
 * That is also what makes the delay expressible at all. "The audience is at
 * programme time 600 000" becomes "serve segments whose end is at or before
 * 600 000", which is a filter over a list rather than a scheduler over a
 * socket -- and a viewer who reconnects simply asks again.
 *
 * PROGRAMME TIME, NOT WALL-CLOCK TIME. A segment knows where it sits in the
 * broadcast. Two viewers on different delays are at different instants and the
 * same programme position, and must receive the same media.
 *
 * THE TIMELINE REFERENCES MEDIA; IT DOES NOT CONTAIN IT. A timeline event
 * carries a segment id. The bytes live in a store with its own retention,
 * because a broadcast's structure is small and worth keeping while its video
 * is enormous and worth keeping only as long as the cursor still needs it.
 */

/** One independently decodable stretch of the original programme. */
export interface ProgrammeMediaSegment {
  readonly runId: string;
  readonly segmentId: string;
  /** Where this segment begins in the broadcast. */
  readonly startProgrammeTimeMs: number;
  /** Where it ends. Exclusive: the next segment begins here. */
  readonly endProgrammeTimeMs: number;
  /**
   * Does it start on a keyframe?
   *
   * A viewer joining, reconnecting, or being released from a buffer starts at
   * a segment boundary, and a boundary that is not a keyframe cannot be
   * decoded without the segments before it. A store that accepted these
   * silently would produce a delayed broadcast that will not play.
   */
  readonly keyframeAligned: boolean;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  /** Where the bytes are. Opaque: a path, an object key, a URL. */
  readonly storageReference: string;
  readonly bytes: number;
  /**
   * Which initialisation object decodes this segment.
   *
   * A restarted encoder can legitimately produce different codec
   * configuration, and every fragment already inside the retention window was
   * written against the previous one. Carrying the generation is what lets a
   * manifest offer BOTH -- the old init for the old fragments, the new one for
   * the new -- instead of replacing an object that material still in the
   * window depends on.
   *
   * Optional so a store that has never restarted an encoder need not think
   * about it; absent means the first generation.
   */
  readonly initGeneration?: number;
}

export function segmentDurationMs(segment: ProgrammeMediaSegment): number {
  return Math.max(0, segment.endProgrammeTimeMs - segment.startProgrammeTimeMs);
}

/**
 * The longest safety delay this product offers.
 *
 * The delay grades stop at ninety seconds, so nothing beyond that ever needs
 * servicing from the store.
 */
export const MAX_SUPPORTED_DELAY_MS = 90_000;

/**
 * How much margin is retained beyond the delay itself.
 *
 * Retaining exactly the delay means the oldest segment a viewer needs is the
 * one being deleted, and any hesitation -- a slow read, a reconnecting client,
 * a recovery replaying from slightly behind the cursor -- lands on a gap. The
 * margin is what makes the difference between a tight system and a fragile one.
 */
export const RETENTION_MARGIN_MS = 30_000;

/**
 * How far back a store must keep media for a given configured delay.
 *
 * Derived rather than fixed, so raising a delay grade cannot silently outrun
 * the retention that serves it.
 */
export function retentionWindowMs(configuredDelayMs: number): number {
  const delay = Math.min(Math.max(0, configuredDelayMs), MAX_SUPPORTED_DELAY_MS);
  return delay + RETENTION_MARGIN_MS;
}

export type MediaAvailability =
  | { readonly available: true; readonly segments: readonly ProgrammeMediaSegment[] }
  /**
   * The cursor needs media the store no longer has.
   *
   * A visible, terminal condition. Skipping forward to what IS held would
   * silently jump the audience toward live -- exactly the downgrade a safety
   * buffer exists to prevent -- so this is reported instead.
   */
  | { readonly available: false; readonly reason: string; readonly missingFromMs: number };

/**
 * What a viewer at this cursor position may be served.
 *
 * Segments that have fully passed the cursor, in programme order. A segment
 * still in progress at the cursor is withheld: releasing it would give the
 * audience material from beyond the delay they were promised.
 */
export function mediaThroughCursor(
  segments: readonly ProgrammeMediaSegment[],
  publicOutputTimeMs: number,
  earliestNeededMs: number,
): MediaAvailability {
  const ordered = [...segments].sort(
    (a, b) => a.startProgrammeTimeMs - b.startProgrammeTimeMs,
  );
  const due = ordered.filter((segment) => segment.endProgrammeTimeMs <= publicOutputTimeMs);

  /*
   * THE HOLE THAT MATTERS is at the front. If the oldest segment the store
   * still holds begins after the point the audience has reached, the material
   * between has been discarded and cannot be served. Continuing would jump
   * them forward without telling anybody.
   */
  const oldest = ordered[0];
  if (oldest !== undefined && oldest.startProgrammeTimeMs > earliestNeededMs) {
    return {
      available: false,
      reason:
        'Media retention has been exhausted: the audience needs programme time the store no longer holds.',
      missingFromMs: earliestNeededMs,
    };
  }

  return { available: true, segments: due };
}

/**
 * Segments that may be discarded at this cursor position.
 *
 * Everything that ends before the retention window opens. Bounded by the
 * window rather than by a count, because what matters is how far behind the
 * audience is, not how many files that happened to take.
 */
export function segmentsToDiscard(
  segments: readonly ProgrammeMediaSegment[],
  publicOutputTimeMs: number,
  configuredDelayMs: number,
): readonly ProgrammeMediaSegment[] {
  const keepFromMs = publicOutputTimeMs - retentionWindowMs(configuredDelayMs);
  if (keepFromMs <= 0) return [];
  return segments.filter((segment) => segment.endProgrammeTimeMs <= keepFromMs);
}
