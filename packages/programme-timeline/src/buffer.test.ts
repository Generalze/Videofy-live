/** @author masterzee001 */
/**
 * The buffer, and the four numbers it must never confuse.
 *
 * Most of these tests are about a sentence a console might print. "On-air
 * delay: 45 s" is true only when the buffer is actually holding forty-five
 * seconds, and the failure mode this file guards is printing it because
 * somebody selected forty-five in a dropdown.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeTimeline } from './index.js';
import { METADATA_PLANE_ONLY, ProgrammeOutputBuffer } from './buffer.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

/** Author `seconds` of programme media, one second at a time. */
function authorSeconds(timeline: ProgrammeTimeline, seconds: number, fromMs = 0): void {
  for (let i = 0; i < seconds; i += 1) {
    timeline.append({
      programmeTimeMs: fromMs + i * 1000,
      kind: 'media',
      reference: `seg_${(fromMs + i * 1000) / 1000}`,
      durationMs: 1000,
    });
  }
}

/**
 * A buffer whose every delivery plane is governed by the cursor.
 *
 * These tests are about buffer MECHANICS -- depth, release, states -- so they
 * declare full governance. Whether a real deployment has it is a separate
 * question with its own tests at the bottom of this file.
 */
const ALL_PLANES = { metadata: true, media: true } as const;

function bufferFor(
  timeline: ProgrammeTimeline,
  delayMs: number,
  policy?: { onLoss: 'fail-closed' | 'continue-unbuffered' },
): ProgrammeOutputBuffer {
  return new ProgrammeOutputBuffer(
    timeline,
    delayMs,
    policy ?? { onLoss: 'fail-closed' },
    ALL_PLANES,
  );
}

describe('a configured delay is not a delay that exists', () => {
  it('is filling, and not protected, before the depth is reached', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 45_000);
    authorSeconds(timeline, 12);
    buffer.advance();

    const status = buffer.status();
    expect(status.state).toBe('filling');
    // The specific lie: configured 45, holding 12, and saying 45.
    expect(status.configuredDelayMs).toBe(45_000);
    expect(status.cursor.bufferDepthMs).toBe(12_000);
    expect(status.protected).toBe(false);
    expect(status.detail).toContain('Not yet protected');
  });

  it('becomes protected only once the depth reaches the target', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);
    authorSeconds(timeline, 10);
    buffer.advance();

    const status = buffer.status();
    expect(status.state).toBe('active');
    expect(status.protected).toBe(true);
    expect(status.cursor.bufferDepthMs).toBe(10_000);
  });

  it('holds exactly the configured depth once running', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);
    authorSeconds(timeline, 30);
    buffer.advance();

    const { cursor } = buffer.status();
    expect(cursor.programmeTimeMs).toBe(30_000);
    // The audience is ten seconds behind the live edge, by construction.
    expect(cursor.publicOutputTimeMs).toBe(20_000);
    expect(cursor.bufferDepthMs).toBe(10_000);
  });
});

describe('what the audience receives, and when', () => {
  it('releases only what has aged past the delay', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 5_000);
    authorSeconds(timeline, 8);

    const released = buffer.advance();
    /*
     * Eight seconds authored, five held back, so the audience sits at
     * programme position 3. They have received everything that STARTS at or
     * before that, which includes the segment beginning exactly there -- an
     * event at the cursor plays rather than being perpetually one millisecond
     * away.
     */
    expect(released.map((e) => e.reference)).toEqual(['seg_0', 'seg_1', 'seg_2', 'seg_3']);
  });

  it('releases each event exactly once', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 2_000);
    authorSeconds(timeline, 5);

    const first = buffer.advance().map((e) => e.reference);
    authorSeconds(timeline, 3, 5_000);
    const second = buffer.advance().map((e) => e.reference);

    expect(first).toEqual(['seg_0', 'seg_1', 'seg_2', 'seg_3']);
    // No repeats: a viewer must never be shown the same moment twice.
    expect(second.every((ref) => !first.includes(ref))).toBe(true);
  });

  it('keeps an advert in the order it was placed against the programme', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 3_000);
    authorSeconds(timeline, 10);
    timeline.append({
      programmeTimeMs: 4_000,
      kind: 'advertisement',
      reference: 'decision_1',
      durationMs: 30_000,
    });

    const released = buffer.advance();
    const kinds = released.map((e) => `${e.kind}@${e.programmeTimeMs}`);
    // The advert sits between the segments it was placed between, and travels
    // with them through the delay. This is the whole reason it is an event.
    expect(kinds).toContain('advertisement@4000');
    expect(kinds.indexOf('advertisement@4000')).toBeGreaterThan(kinds.indexOf('media@3000'));
    expect(kinds.indexOf('advertisement@4000')).toBeLessThan(kinds.indexOf('media@5000'));
  });
});

describe('the cursor never goes backwards', () => {
  it('does not rewind the audience when the delay is increased', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 2_000);
    authorSeconds(timeline, 20);
    buffer.advance();
    const before = buffer.status().cursor.publicOutputTimeMs;

    buffer.configure(15_000);
    buffer.advance();

    // The live edge runs away until the new depth is reached; the audience
    // does not un-see what it has already been shown.
    expect(buffer.status().cursor.publicOutputTimeMs).toBe(before);
  });

  it('does not skip the audience forward when the delay is reduced', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);
    authorSeconds(timeline, 30);
    buffer.advance();

    buffer.configure(2_000);
    const released = buffer.advance();
    // They advance through the gap, receiving every moment in it, rather than
    // jumping over eight seconds of programme. seg_20 was already theirs; the
    // next one they had not seen is the one that must arrive now.
    expect(released.map((e) => e.reference)).toContain('seg_21');
    expect(released.map((e) => e.reference)).toContain('seg_28');
  });
});

describe('losing the buffer is not a quiet downgrade', () => {
  it('stops the public output by default rather than reverting to live', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);
    authorSeconds(timeline, 20);
    buffer.advance();
    expect(buffer.status().protected).toBe(true);

    buffer.fail('spool storage unavailable');
    authorSeconds(timeline, 10, 20_000);

    const status = buffer.status();
    expect(status.state).toBe('failed');
    expect(status.protected).toBe(false);
    // And nothing further reaches the audience: an audience promised a delay
    // must not silently start receiving true live.
    expect(buffer.advance()).toEqual([]);
    expect(status.detail).toContain('spool storage unavailable');
  });

  it('can be told to continue unbuffered, which is a different mode', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000, { onLoss: 'continue-unbuffered' });
    authorSeconds(timeline, 20);
    buffer.advance();
    buffer.fail('spool storage unavailable');

    // Still not protected, but still broadcasting, because somebody chose it.
    expect(buffer.status().protected).toBe(false);
    expect(buffer.status().state).toBe('degraded');
  });

  it('tells filling and degraded apart, because they promise different things', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);

    authorSeconds(timeline, 4);
    buffer.advance();
    // Never protected yet: nothing has been promised.
    expect(buffer.status().state).toBe('filling');

    authorSeconds(timeline, 16, 4_000);
    buffer.advance();
    expect(buffer.status().state).toBe('active');

    // Now it falls behind after having been protected, which an operator must
    // be told about in different words.
    buffer.configure(30_000);
    buffer.advance();
    expect(buffer.status().state).toBe('degraded');
    expect(buffer.status().detail).toContain('Not protected');
  });
});

describe('no delay configured is an honest state, not a broken one', () => {
  it('is inactive and says the programme goes out live', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 0);
    authorSeconds(timeline, 5);
    const released = buffer.advance();

    expect(buffer.status().state).toBe('inactive');
    expect(buffer.status().protected).toBe(false);
    expect(buffer.status().detail).toContain('goes out live');
    // Everything reaches the audience immediately, which is what live means.
    expect(released).toHaveLength(5);
  });
});

/*
 * The plane that is not governed.
 *
 * A programme reaches its audience over two paths. Captions, translated audio
 * and advertising are emitted by this service and can be held. Original audio
 * and video are forwarded live from the broadcaster's tracks to each listener,
 * with nowhere to hold them.
 *
 * Delaying one and not the other is worse than delaying neither: the audience
 * hears the speaker now and reads the caption in forty-five seconds, and an
 * operator has been told the programme is protected.
 */
describe('a protective delay requires every plane, or none', () => {
  it('refuses protection when original media is not held to the cursor', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = new ProgrammeOutputBuffer(timeline, 45_000, undefined, METADATA_PLANE_ONLY);

    const status = buffer.status();
    expect(status.state).toBe('failed');
    expect(status.protected).toBe(false);
    expect(status.detail).toContain('not held to the output cursor');
  });

  it('refuses it on a later configure too, not only at construction', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = new ProgrammeOutputBuffer(timeline, 0, undefined, METADATA_PLANE_ONLY);
    expect(buffer.status().state).toBe('inactive');

    buffer.configure(45_000);
    expect(buffer.status().protected).toBe(false);
    expect(buffer.status().state).toBe('failed');
  });

  it('still allows going live, which is a legitimate way to broadcast', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = new ProgrammeOutputBuffer(timeline, 45_000, undefined, METADATA_PLANE_ONLY);
    // Removing the delay must never be unreachable because protection was once
    // impossible: unbuffered is a real mode, not a punishment.
    buffer.configure(0);
    expect(buffer.status().state).toBe('inactive');
    expect(buffer.status().detail).toContain('goes out live');
  });

  it('protects normally once every plane is governed', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = bufferFor(timeline, 10_000);
    authorSeconds(timeline, 10);
    buffer.advance();
    expect(buffer.status().protected).toBe(true);
  });
});
