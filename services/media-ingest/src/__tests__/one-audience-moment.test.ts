/** @author masterzee001 */
/**
 * ONE AUDIENCE MOMENT.
 *
 * The property this whole architecture exists for, stated once and asserted
 * directly:
 *
 *   live programme time   645 000 ms   (00:10:45)
 *   configured delay       45 000 ms
 *   public output cursor  600 000 ms   (00:10:00)
 *
 * At that instant a viewer must receive the original video, the original
 * audio, the caption and the translated audio that all belong to programme
 * time 600 000 -- and nothing from the forty-five seconds after it.
 *
 * Before this, two of those four followed the cursor and two were live. That
 * is not a partially finished feature; it is a broadcast in which the speaker
 * and their subtitle are three-quarters of a minute apart.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeOutputPump } from '../programme-output-pump.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;
const LIVE_MS = 645_000;
const CURSOR_MS = 600_000;

function mediaSegment(startMs: number, durationMs = 2000, runId = 'run_1'): ProgrammeMediaSegment {
  return {
    runId,
    segmentId: `${runId}_media_${startMs}`,
    startProgrammeTimeMs: startMs,
    endProgrammeTimeMs: startMs + durationMs,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/${runId}/${startMs}.m4s`,
    bytes: 120_000,
  };
}

/** A whole broadcast: media segments, captions and translated audio. */
function broadcast(): {
  readonly registry: ProgrammeTimelineRegistry;
  readonly media: ProgrammeMediaStore;
  readonly pump: ProgrammeOutputPump;
  readonly emitted: string[];
} {
  const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    // Declared because the media store below genuinely holds the media plane.
    media: true,
  });
  const timeline = registry.open(RUN);
  const buffer = registry.buffer('run_1');
  if (buffer === null) throw new Error('no buffer');
  const media = new ProgrammeMediaStore();
  const emitted: string[] = [];
  const pump = new ProgrammeOutputPump(buffer);

  for (let ms = 0; ms < LIVE_MS; ms += 2000) media.accept(mediaSegment(ms));
  for (let second = 0; second * 1000 < LIVE_MS; second += 1) {
    const at = second * 1000;
    for (const [kind, tag] of [
      ['caption', 'cap'],
      ['generated-audio', 'aud'],
    ] as const) {
      const reference = `${tag}_${second}`;
      timeline.append({ programmeTimeMs: at, kind, reference, durationMs: 1000 });
      pump.hold(reference, { kind, emit: () => emitted.push(reference) });
    }
  }
  return { registry, media, pump, emitted };
}

describe('every plane arrives at the same programme moment', () => {
  it('serves original media, captions and translated audio for 00:10:00', () => {
    const { registry, media, pump, emitted } = broadcast();
    pump.tick();

    const cursor = registry.status('run_1')?.cursor.publicOutputTimeMs;
    expect(cursor).toBe(CURSOR_MS);

    const served = media.throughCursor('run_1', CURSOR_MS, 0);
    expect(served.available).toBe(true);
    if (!served.available) throw new Error('unreachable');
    const lastMedia = served.segments[served.segments.length - 1];

    // Original video and audio, ending exactly at the cursor.
    expect(lastMedia?.hasVideo).toBe(true);
    expect(lastMedia?.hasAudio).toBe(true);
    expect(lastMedia?.endProgrammeTimeMs).toBe(CURSOR_MS);

    // The caption and the translated audio for the same instant.
    expect(emitted).toContain('cap_600');
    expect(emitted).toContain('aud_600');
  });

  it('withholds every plane beyond the delay', () => {
    const { media, pump, emitted } = broadcast();
    pump.tick();

    const served = media.throughCursor('run_1', CURSOR_MS, 0);
    if (!served.available) throw new Error('unreachable');

    // Nothing from the forty-five seconds the audience has not reached, on
    // any plane. A single one leaking is the split timeline all over again.
    expect(served.segments.some((s) => s.startProgrammeTimeMs >= CURSOR_MS)).toBe(false);
    expect(emitted).not.toContain('cap_601');
    expect(emitted).not.toContain('aud_644');
  });

  it('keeps original audio and video together, because they are one segment', () => {
    const { media } = broadcast();
    const served = media.throughCursor('run_1', CURSOR_MS, 0);
    if (!served.available) throw new Error('unreachable');
    // They cannot drift apart: there is no separate audio path to drift.
    expect(served.segments.every((s) => s.hasAudio && s.hasVideo)).toBe(true);
  });

  it('fails without the media plane, which is the join under test', () => {
    /*
     * Remove the delayed-media half and the buffer refuses to protect at all.
     * This is the regression that would otherwise let the two-path broadcast
     * come back quietly.
     */
    const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
      metadata: true,
      media: false,
    });
    registry.open(RUN);
    const status = registry.status('run_1');
    expect(status?.protected).toBe(false);
    expect(status?.state).toBe('failed');
  });
});

describe('media that cannot be decoded never enters the store', () => {
  it('refuses a segment that does not begin on a keyframe', () => {
    const problems: string[] = [];
    const media = new ProgrammeMediaStore(undefined, (message) => problems.push(message));
    const broken = { ...mediaSegment(0), keyframeAligned: false };

    expect(media.accept(broken)).toBe(false);
    expect(media.segmentCount('run_1')).toBe(0);
    // A viewer released from the buffer starts at a boundary. One that cannot
    // be decoded alone produces a delayed broadcast that will not play, and it
    // would be an audience that discovered it.
    expect(problems.join(' ')).toContain('keyframe');
  });

  it('refuses a segment that occupies no programme time', () => {
    const media = new ProgrammeMediaStore();
    expect(media.accept({ ...mediaSegment(0), endProgrammeTimeMs: 0 })).toBe(false);
  });
});

describe('two broadcasts never see each other', () => {
  it('serves each run only its own media', () => {
    const media = new ProgrammeMediaStore();
    media.accept(mediaSegment(0, 2000, 'run_1'));
    media.accept(mediaSegment(0, 2000, 'run_2'));

    const first = media.throughCursor('run_1', 10_000, 0);
    if (!first.available) throw new Error('unreachable');
    // A tenancy question, not a tidiness one.
    expect(first.segments.every((s) => s.runId === 'run_1')).toBe(true);
    expect(media.segmentCount('run_2')).toBe(1);
  });
});

describe('retention is bounded, and exhaustion is visible', () => {
  it('discards only what the cursor has left well behind', async () => {
    const media = new ProgrammeMediaStore();
    for (let ms = 0; ms < 400_000; ms += 2000) media.accept(mediaSegment(ms));
    const before = media.segmentCount('run_1');

    await media.prune('run_1', 300_000, DELAY_MS);

    expect(media.segmentCount('run_1')).toBeLessThan(before);
    // What the audience is about to be served is still there.
    const served = media.throughCursor('run_1', 300_000, 300_000 - DELAY_MS);
    expect(served.available).toBe(true);
  });

  it('refuses rather than jumping the audience forward when media is gone', () => {
    const media = new ProgrammeMediaStore();
    // The store begins well after the point the audience is still owed.
    for (let ms = 300_000; ms < 400_000; ms += 2000) media.accept(mediaSegment(ms));

    const served = media.throughCursor('run_1', 400_000, 100_000);
    expect(served.available).toBe(false);
    if (served.available) throw new Error('unreachable');
    expect(served.reason).toContain('retention has been exhausted');
  });

  it('reports whether it holds enough to serve the configured delay', () => {
    const media = new ProgrammeMediaStore();
    for (let ms = 0; ms < 10_000; ms += 2000) media.accept(mediaSegment(ms));
    // Ten seconds held against a forty-five second promise.
    expect(media.coverage('run_1', DELAY_MS).sufficient).toBe(false);

    for (let ms = 10_000; ms < 60_000; ms += 2000) media.accept(mediaSegment(ms));
    expect(media.coverage('run_1', DELAY_MS).sufficient).toBe(true);
  });
});
