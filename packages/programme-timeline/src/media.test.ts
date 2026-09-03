/** @author masterzee001 */
/**
 * Original media, addressed by the same programme clock as everything else.
 *
 * The property under test throughout: at public cursor 600 000, a viewer gets
 * the original audio and video belonging to programme time 600 000 — the same
 * instant their captions and translated audio describe. One audience moment.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SUPPORTED_DELAY_MS,
  RETENTION_MARGIN_MS,
  mediaThroughCursor,
  retentionWindowMs,
  segmentDurationMs,
  segmentsToDiscard,
  type ProgrammeMediaSegment,
} from './media.js';

/** Two-second segments, as a live encoder would produce them. */
function segments(count: number, fromMs = 0, durationMs = 2000): ProgrammeMediaSegment[] {
  return Array.from({ length: count }, (_, i) => {
    const start = fromMs + i * durationMs;
    return {
      runId: 'run_1',
      segmentId: `seg_${start}`,
      startProgrammeTimeMs: start,
      endProgrammeTimeMs: start + durationMs,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: `/spool/run_1/${start}.m4s`,
      bytes: 100_000,
    };
  });
}

describe('a viewer receives the media belonging to the cursor', () => {
  it('serves programme time 600 000 when the cursor is at 600 000', () => {
    // 645 s of broadcast, 45 s delay: the ruling's scenario, in media.
    const all = segments(323); // 646 s of two-second segments
    const served = mediaThroughCursor(all, 600_000, 0);

    expect(served.available).toBe(true);
    if (!served.available) throw new Error('unreachable');
    const last = served.segments[served.segments.length - 1];
    expect(last?.endProgrammeTimeMs).toBe(600_000);
    // Nothing from the forty-five seconds the audience has not reached.
    expect(served.segments.some((s) => s.startProgrammeTimeMs >= 600_000)).toBe(false);
  });

  it('withholds a segment still in progress at the cursor', () => {
    // Releasing it would hand over material from beyond the promised delay.
    const served = mediaThroughCursor(segments(10), 5_000, 0);
    if (!served.available) throw new Error('unreachable');
    expect(served.segments.map((s) => s.endProgrammeTimeMs)).toEqual([2_000, 4_000]);
  });

  it('serves in programme order however the store listed them', () => {
    const shuffled = [...segments(5)].reverse();
    const served = mediaThroughCursor(shuffled, 10_000, 0);
    if (!served.available) throw new Error('unreachable');
    expect(served.segments.map((s) => s.startProgrammeTimeMs)).toEqual([0, 2_000, 4_000, 6_000, 8_000]);
  });

  it('serves nothing at all before the first segment has completed', () => {
    const served = mediaThroughCursor(segments(5), 0, 0);
    if (!served.available) throw new Error('unreachable');
    expect(served.segments).toEqual([]);
  });
});

describe('exhausted retention is visible, never a silent jump to live', () => {
  it('refuses when the audience needs media the store has discarded', () => {
    /*
     * The store begins at programme time 300 000; the audience is still owed
     * from 100 000. Serving what IS held would move them forward two hundred
     * seconds without telling anybody — the exact downgrade a safety buffer
     * exists to prevent.
     */
    const held = segments(50, 300_000);
    const served = mediaThroughCursor(held, 400_000, 100_000);

    expect(served.available).toBe(false);
    if (served.available) throw new Error('unreachable');
    expect(served.reason).toContain('retention has been exhausted');
    expect(served.missingFromMs).toBe(100_000);
  });

  it('is satisfied when the store still reaches back far enough', () => {
    const held = segments(50, 100_000);
    expect(mediaThroughCursor(held, 150_000, 100_000).available).toBe(true);
  });
});

describe('retention is derived from the delay it has to serve', () => {
  it('keeps the delay plus a margin', () => {
    // Retaining exactly the delay puts the oldest segment a viewer needs and
    // the one being deleted in the same place.
    expect(retentionWindowMs(45_000)).toBe(45_000 + RETENTION_MARGIN_MS);
  });

  it('does not retain beyond the longest delay the product offers', () => {
    expect(retentionWindowMs(10_000_000)).toBe(MAX_SUPPORTED_DELAY_MS + RETENTION_MARGIN_MS);
  });

  it('grows when a longer delay is configured, so retention cannot be outrun', () => {
    expect(retentionWindowMs(90_000)).toBeGreaterThan(retentionWindowMs(30_000));
  });

  it('discards only what is older than that window', () => {
    const all = segments(200); // 400 s
    const discard = segmentsToDiscard(all, 300_000, 45_000);
    const keepFrom = 300_000 - retentionWindowMs(45_000);

    expect(discard.every((s) => s.endProgrammeTimeMs <= keepFrom)).toBe(true);
    // And the segment the audience is about to be served is never among them.
    expect(discard.some((s) => s.endProgrammeTimeMs === 300_000)).toBe(false);
  });

  it('discards nothing early in a broadcast', () => {
    expect(segmentsToDiscard(segments(10), 5_000, 45_000)).toEqual([]);
  });
});

describe('segments are the unit because they are independently decodable', () => {
  it('records whether a segment begins on a keyframe', () => {
    /*
     * A viewer joining, reconnecting, or being released from a buffer starts
     * at a boundary. A boundary that is not a keyframe cannot be decoded
     * without everything before it, so a delayed broadcast built from them
     * would simply not play.
     */
    const [first] = segments(1);
    expect(first?.keyframeAligned).toBe(true);
  });

  it('knows its own length', () => {
    const [first] = segments(1);
    expect(first === undefined ? 0 : segmentDurationMs(first)).toBe(2000);
  });
});
