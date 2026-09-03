/** @author masterzee001 */
/**
 * Can anybody get ahead of the safety delay?
 *
 * The manifest listing only published segments is necessary and nowhere near
 * sufficient. Segment names are sequential; anybody can add one. So every test
 * here attacks the boundary rather than reading the brochure: guess the next
 * name, ask for another run's media, ask after the output has stopped, ask for
 * a programme time that has not happened yet.
 *
 * The property being defended: for a protected broadcast, nothing belonging to
 * the unpublished future reaches the audience through any route.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeEgressAuthority, initSegmentId, renderHlsManifest } from '../programme-egress.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const OTHER = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_2' };
const DELAY_MS = 45_000;

/**
 * 1500 ms granularity, chosen so the ruling's scenario lands exactly: 430
 * segments reach a 645 000 ms live edge, and a 45 s delay puts the cursor on
 * 600 000 ms rather than near it.
 */
const SEGMENT_MS = 1500;

function segment(runId: string, startMs: number, durationMs = SEGMENT_MS): ProgrammeMediaSegment {
  return {
    runId,
    segmentId: `${runId}_seg_${startMs}`,
    startProgrammeTimeMs: startMs,
    endProgrammeTimeMs: startMs + durationMs,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/private/spool/${runId}/${startMs}.m4s`,
    bytes: 100_000,
  };
}

/** A protected broadcast: 645 s produced, 45 s delay, cursor at 600 s. */
function protectedRun(): {
  readonly egress: ProgrammeEgressAuthority;
  readonly timelines: ProgrammeTimelineRegistry;
  readonly media: ProgrammeMediaStore;
} {
  const timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
    metadata: true,
    media: true,
  });
  const timeline = timelines.open(RUN);
  const media = new ProgrammeMediaStore();
  for (let ms = 0; ms < 645_000; ms += SEGMENT_MS) {
    media.accept(segment('run_1', ms));
    timeline.append({
      programmeTimeMs: ms,
      kind: 'media',
      reference: `run_1_seg_${ms}`,
      durationMs: SEGMENT_MS,
    });
  }
  timelines.buffer('run_1')?.advance();

  const egress = new ProgrammeEgressAuthority(timelines, media);
  egress.noteInitSegment('run_1', '/private/spool/run_1/init.mp4');
  return { egress, timelines, media };
}

describe('the manifest publishes only what the cursor has released', () => {
  it('stops at the cursor, not at the encoder’s live edge', () => {
    const { egress } = protectedRun();
    const manifest = egress.manifest('run_1');

    expect(manifest.available).toBe(true);
    if (!manifest.available) throw new Error('unreachable');
    expect(manifest.publicOutputTimeMs).toBe(600_000);
    // 400 segments reach 600 000; the encoder has produced 430.
    expect(manifest.segments).toHaveLength(400);
    expect(manifest.segments.some((s) => s.segmentId === 'run_1_seg_600000')).toBe(false);
  });

  it('never exposes a filesystem path to a client', () => {
    const { egress } = protectedRun();
    const manifest = egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');

    const rendered = renderHlsManifest(manifest, (id) => `/programmes/run_1/media/${id}`);
    // The spool is private. Its shape is nobody's business, and leaking it
    // would tie the Programme contract to today's storage.
    expect(rendered).not.toContain('/private/spool');
    expect(rendered).not.toContain('.m4s');
    expect(rendered).toContain('/programmes/run_1/media/run_1_seg_0');
  });

  it('keeps the playlist open while the programme is still running', () => {
    const { egress } = protectedRun();
    const manifest = egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');
    const rendered = renderHlsManifest(manifest, (id) => `/m/${id}`);
    // ENDLIST here would stop a player at the current edge forever.
    expect(rendered).not.toContain('#EXT-X-ENDLIST');
  });
});

describe('guessing does not get you the future', () => {
  it('refuses the very next segment, which exists on disk', () => {
    const { egress } = protectedRun();
    // The obvious attack: the manifest ends at 598 500, so ask for the next.
    const attempt = egress.authorizeSegment('run_1', 'run_1_seg_600000');

    expect(attempt.allowed).toBe(false);
    if (attempt.allowed) throw new Error('unreachable');
    // Named distinctly, because somebody reaching for the future is the one
    // worth alerting on.
    expect(attempt.refusal).toBe('not-yet-public');
  });

  it('refuses a segment far in the unpublished future', () => {
    const { egress } = protectedRun();
    expect(egress.authorizeSegment('run_1', 'run_1_seg_643500').allowed).toBe(false);
  });

  it('allows a segment the cursor has genuinely published', () => {
    const { egress } = protectedRun();
    const allowed = egress.authorizeSegment('run_1', 'run_1_seg_0');
    expect(allowed.allowed).toBe(true);
    if (!allowed.allowed) throw new Error('unreachable');
    expect(allowed.storageReference).toContain('/private/spool/run_1/0.m4s');
  });

  it('refuses a segment that never existed', () => {
    const { egress } = protectedRun();
    const attempt = egress.authorizeSegment('run_1', 'run_1_seg_999999999');
    if (attempt.allowed) throw new Error('unreachable');
    expect(attempt.refusal).toBe('unknown-segment');
  });

  it('serves the init segment, which carries configuration and no programme', () => {
    const { egress } = protectedRun();
    // Withholding it would make the first published fragment undecodable.
    expect(egress.authorizeSegment('run_1', initSegmentId('run_1')).allowed).toBe(true);
  });
});

describe('one broadcast cannot reach into another', () => {
  it('refuses another run’s segment id', () => {
    const { egress, timelines, media } = protectedRun();
    timelines.open(OTHER);
    media.accept(segment('run_2', 0));

    // Correctly formed, real, and belonging to somebody else.
    const attempt = egress.authorizeSegment('run_1', 'run_2_seg_0');
    expect(attempt.allowed).toBe(false);
  });

  it('refuses a run this service is not carrying', () => {
    const { egress } = protectedRun();
    const manifest = egress.manifest('run_absent');
    expect(manifest.available).toBe(false);
    if (manifest.available) throw new Error('unreachable');
    expect(manifest.refusal).toBe('unknown-run');
  });
});

describe('a stopped output serves nothing at all', () => {
  it('refuses the manifest when the buffer has failed', () => {
    const { egress, timelines } = protectedRun();
    timelines.buffer('run_1')?.fail('the timeline could not be persisted');

    const manifest = egress.manifest('run_1');
    expect(manifest.available).toBe(false);
    if (manifest.available) throw new Error('unreachable');
    // Continuing to serve the last good manifest is how an audience keeps
    // watching a broadcast that has been withdrawn.
    expect(manifest.refusal).toBe('output-stopped');
  });

  it('refuses segments that were public a moment ago', () => {
    const { egress, timelines } = protectedRun();
    expect(egress.authorizeSegment('run_1', 'run_1_seg_0').allowed).toBe(true);

    timelines.buffer('run_1')?.fail('storage lost');

    // Authorisation is asked at FETCH, so a manifest fetched before the fault
    // does not entitle anybody afterwards.
    const attempt = egress.authorizeSegment('run_1', 'run_1_seg_0');
    expect(attempt.allowed).toBe(false);
    if (attempt.allowed) throw new Error('unreachable');
    expect(attempt.refusal).toBe('output-stopped');
  });
});

describe('an unprotected broadcast still goes through the same boundary', () => {
  it('publishes to the live edge when no delay is configured', () => {
    const timelines = new ProgrammeTimelineRegistry(32, 0);
    const timeline = timelines.open(RUN);
    const media = new ProgrammeMediaStore();
    for (let ms = 0; ms < 5 * SEGMENT_MS; ms += SEGMENT_MS) {
      media.accept(segment('run_1', ms));
      timeline.append({ programmeTimeMs: ms, kind: 'media', reference: `run_1_seg_${ms}`, durationMs: SEGMENT_MS });
    }
    timelines.buffer('run_1')?.advance();

    const egress = new ProgrammeEgressAuthority(timelines, media);
    const manifest = egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');
    // One egress, one code path: true live is a cursor at the live edge.
    expect(manifest.segments).toHaveLength(5);
  });
});
