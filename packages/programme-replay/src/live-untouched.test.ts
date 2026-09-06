/** @author masterzee001 */
/**
 * The live safety buffer is exactly where it was, and Replay did not move it.
 *
 * THE FAILURE THIS GUARDS AGAINST is the tempting one: noticing that the spool
 * already holds programme media and widening it until it holds the whole
 * broadcast. That would put every recording inside the live path, size a
 * replay by a constant that exists to protect a cursor, and make a recording
 * disappear the day somebody changed a delay grade.
 *
 * So the live retention rules are asserted here from the outside, by a package
 * that has every reason to want them changed and did not change them. Nothing
 * in this file edits anything: it reads the same functions the live path uses
 * and pins the answers.
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
} from '@videofy-live/programme-timeline';
import { InMemoryReplayArchive } from './memory-archive.js';
import { requiredInitGenerations } from './media.js';

const STARTED = 1_700_000_000_000;
const RUN = { channelId: 'main', programmeId: 'evening-news', runId: 'run_a' } as const;

function segments(count: number, fromMs = 0, durationMs = 2000): ProgrammeMediaSegment[] {
  return Array.from({ length: count }, (_, i) => {
    const start = fromMs + i * durationMs;
    return {
      runId: RUN.runId,
      segmentId: `${RUN.runId}.g0.${String(i).padStart(5, '0')}`,
      startProgrammeTimeMs: start,
      endProgrammeTimeMs: start + durationMs,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: `/spool/${RUN.runId}/${start}.m4s`,
      bytes: 100_000,
    };
  });
}

describe('the live retention window is what it always was', () => {
  it('is still the configured delay plus the margin', () => {
    expect(RETENTION_MARGIN_MS).toBe(30_000);
    expect(MAX_SUPPORTED_DELAY_MS).toBe(90_000);
    expect(retentionWindowMs(45_000)).toBe(75_000);
    expect(retentionWindowMs(MAX_SUPPORTED_DELAY_MS)).toBe(120_000);
  });

  it('still clamps a delay beyond the longest grade the product offers', () => {
    expect(retentionWindowMs(10 * MAX_SUPPORTED_DELAY_MS)).toBe(
      MAX_SUPPORTED_DELAY_MS + RETENTION_MARGIN_MS,
    );
  });

  it('still discards what the cursor has left behind the window', () => {
    const all = segments(200); // 400 s
    const stale = segmentsToDiscard(all, 300_000, 45_000);
    // Everything ending at or before 300 000 - 75 000.
    expect(stale.every((s) => s.endProgrammeTimeMs <= 225_000)).toBe(true);
    expect(stale).toHaveLength(112);
  });

  it('still serves the cursor and withholds what is beyond it', () => {
    const served = mediaThroughCursor(segments(50), 20_000, 0);
    expect(served.available).toBe(true);
    if (!served.available) throw new Error('unreachable');
    expect(served.segments).toHaveLength(10);
  });
});

describe('a replay does not disturb the live spool', () => {
  it('leaves the segments it retains exactly as it found them', async () => {
    // The live store and the replay describe the SAME bytes. A replay that
    // edited a segment would be editing what the live path is still serving.
    const original = segments(3);
    const copies = original.map((segment) => ({ ...segment }));

    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'private',
      startedAtMs: STARTED,
    });
    await archive.retainInitialisation(RUN.runId, {
      runId: RUN.runId,
      generation: 0,
      storageReference: `/spool/${RUN.runId}/init.0.mp4`,
      bytes: 1_000,
    });
    for (const segment of original) {
      await archive.retainSegment(RUN.runId, segment);
    }
    await archive.finalise(RUN.runId);

    expect(original).toEqual(copies);
  });

  it('changes nothing about what the live path would discard', async () => {
    const all = segments(200);
    const before = segmentsToDiscard(all, 300_000, 45_000).map((s) => s.segmentId);

    const archive = new InMemoryReplayArchive(() => STARTED);
    await archive.begin({
      identity: RUN,
      // A thirty-day replay: the longest retention there is, against a live
      // window of two minutes. The live answer must not budge.
      retention: { policy: 'expire', expiresAtMs: STARTED + 30 * 24 * 60 * 60 * 1000 },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    for (const segment of all) {
      await archive.retainSegment(RUN.runId, segment);
    }

    const after = segmentsToDiscard(all, 300_000, 45_000).map((s) => s.segmentId);
    expect(after).toEqual(before);
    expect(retentionWindowMs(45_000)).toBe(75_000);
  });

  it('reads the same segment shape the live path already produces', () => {
    // One encoder, one description of what it wrote. A second description of
    // the same bytes would be discovered by a viewer the first time the two
    // disagreed.
    const [first] = segments(1);
    if (first === undefined) throw new Error('unreachable');
    expect(segmentDurationMs(first)).toBe(2000);
    expect(requiredInitGenerations([first])).toEqual([0]);
  });
});
