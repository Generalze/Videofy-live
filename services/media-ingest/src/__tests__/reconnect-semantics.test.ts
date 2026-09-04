/** @author masterzee001 */
/**
 * Coming back, on either side, without becoming a different broadcast.
 *
 * TWO DIFFERENT RECONNECTS, and they fail in opposite directions.
 *
 * A VIEWER who returns must resume where the audience is, not at the live
 * edge. Jumping them to live hands them the forty-five seconds the safety
 * delay exists to withhold -- the bypass is a dropped connection, which is not
 * an attack anybody has to mount.
 *
 * A SOURCE that returns must not begin a second broadcast. The transport is
 * new; the programme is not. A run that restarted on every network hiccup
 * would reset the cursor, orphan its timeline, and replay adverts that had
 * already been shown.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;
const SEGMENT_MS = 1500;

function segment(startMs: number): ProgrammeMediaSegment {
  return {
    runId: 'run_1',
    segmentId: `run_1_seg_${startMs}`,
    startProgrammeTimeMs: startMs,
    endProgrammeTimeMs: startMs + SEGMENT_MS,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/private/spool/run_1/${startMs}.m4s`,
    bytes: 100_000,
  };
}

function rig(policy?: { readonly onLoss: 'fail-closed' | 'continue-unbuffered' }): {
  readonly timelines: ProgrammeTimelineRegistry;
  readonly media: ProgrammeMediaStore;
  readonly egress: ProgrammeEgressAuthority;
  readonly produce: (throughMs: number) => void;
} {
  const timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, policy, undefined, {
    metadata: true,
    media: true,
  });
  timelines.open(RUN);
  const media = new ProgrammeMediaStore();
  const egress = new ProgrammeEgressAuthority(timelines, media);
  egress.noteInitSegment('run_1', '/private/spool/run_1/init.mp4');

  let producedTo = 0;
  const produce = (throughMs: number): void => {
    const timeline = timelines.timeline('run_1');
    for (let ms = producedTo; ms < throughMs; ms += SEGMENT_MS) {
      media.accept(segment(ms));
      timeline?.append({
        programmeTimeMs: ms,
        kind: 'media',
        reference: `run_1_seg_${ms}`,
        durationMs: SEGMENT_MS,
      });
    }
    producedTo = Math.max(producedTo, throughMs);
    timelines.buffer('run_1')?.advance();
  };
  return { timelines, media, egress, produce };
}

describe('a viewer who reconnects resumes where the audience is', () => {
  it('is given the public position, not the live edge', () => {
    const { egress, produce } = rig();
    produce(180_000);

    // The viewer had been watching; their connection dropped; they return.
    const onReturn = egress.manifest('run_1');
    expect(onReturn.available).toBe(true);
    if (!onReturn.available) throw new Error('unreachable');

    // Live is 180 000. The audience is at 135 000 and that is where they
    // rejoin -- a dropped connection is not a way past the safety delay.
    expect(onReturn.publicOutputTimeMs).toBe(135_000);
    const last = onReturn.segments[onReturn.segments.length - 1];
    expect(last?.segmentId).toBe(`run_1_seg_${135_000 - SEGMENT_MS}`);
  });

  it('cannot reach the live edge by asking for it directly', () => {
    const { egress, produce } = rig();
    produce(180_000);
    // The obvious move on reconnect: ask for the newest thing that exists.
    const attempt = egress.authorizeSegment('run_1', `run_1_seg_${178_500}`);
    expect(attempt.allowed).toBe(false);
  });

  it('resumes at a decodable boundary, with the init segment available', () => {
    const { egress, produce } = rig();
    produce(180_000);
    const manifest = egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');

    // A returning viewer needs initialisation before any fragment decodes.
    expect(egress.authorizeSegment('run_1', manifest.initSegmentId).allowed).toBe(true);
    // And every segment offered begins on a keyframe by construction.
    for (const entry of manifest.segments.slice(-3)) {
      expect(egress.authorizeSegment('run_1', entry.segmentId).allowed).toBe(true);
    }
  });

  it('sees the same public position while the buffer is still filling', () => {
    const { egress, produce, timelines } = rig();
    produce(20_000);

    // Not yet protected, and the manifest still tells the truth about where
    // the audience is rather than pretending the delay is achieved.
    expect(timelines.status('run_1')?.state).toBe('filling');
    const manifest = egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');
    expect(manifest.publicOutputTimeMs).toBe(0);
  });

  it('resumes at the public position while the buffer is DEGRADED', () => {
    /*
     * Degraded is only reachable under a deployment that has chosen to keep
     * going at reduced depth rather than stop. The cursor still governs -- the
     * audience is less delayed, not undelayed -- which is the trade that
     * policy names.
     */
    const { egress, produce, timelines } = rig({ onLoss: 'continue-unbuffered' });
    produce(180_000);
    /*
     * Degraded is not failed. The programme reached its target, fell back, and
     * is still going out -- so a viewer returning gets what is public, which
     * is less than the promise but is genuinely theirs. Refusing here would
     * take a recoverable broadcast off the air.
     */
    timelines.buffer('run_1')?.fail('the encoder fell behind');
    expect(timelines.status('run_1')?.state).toBe('degraded');

    const manifest = egress.manifest('run_1');
    expect(manifest.available).toBe(true);
    if (!manifest.available) throw new Error('unreachable');
    expect(manifest.publicOutputTimeMs).toBeLessThanOrEqual(180_000);
    // And still not the live edge, degraded or not.
    expect(egress.authorizeSegment('run_1', `run_1_seg_${178_500}`).allowed).toBe(false);
  });

  it('keeps serving the tail while the broadcast is DRAINING', () => {
    const { egress, produce, timelines } = rig();
    produce(180_000);
    timelines.buffer('run_1')?.drain();
    expect(timelines.status('run_1')?.state).toBe('draining');

    const manifest = egress.manifest('run_1');
    expect(manifest.available).toBe(true);
    if (!manifest.available) throw new Error('unreachable');
    /*
     * The studio has stopped and the audience has not finished. A viewer who
     * reconnects during the drain is owed the rest of it -- refusing would
     * cut off the last forty-five seconds of every protected programme, which
     * were produced, paid for and promised.
     */
    expect(manifest.segments.length).toBeGreaterThan(0);
  });

  it('is refused entirely once output has stopped', () => {
    const { egress, produce, timelines } = rig();
    produce(180_000);
    timelines.buffer('run_1')?.fail('storage lost');

    // Reconnecting into a withdrawn broadcast must not succeed just because
    // the client has a manifest from before.
    expect(egress.manifest('run_1').available).toBe(false);
  });
});

describe('a source that reconnects does not begin a second broadcast', () => {
  it('keeps the same timeline, cursor and buffer target', () => {
    const { timelines, produce } = rig();
    produce(180_000);

    const before = {
      cursor: timelines.status('run_1')?.cursor.publicOutputTimeMs,
      target: timelines.status('run_1')?.configuredDelayMs,
      events: timelines.timeline('run_1')?.length,
    };

    // The contribution drops and returns: same run, new transport session.
    timelines.open(RUN);

    expect(timelines.status('run_1')?.cursor.publicOutputTimeMs).toBe(before.cursor);
    expect(timelines.status('run_1')?.configuredDelayMs).toBe(before.target);
    expect(timelines.timeline('run_1')?.length).toBe(before.events);
  });

  it('continues the timeline sequence rather than restarting it', () => {
    const { timelines, produce } = rig();
    produce(30_000);
    const lastBefore = timelines.timeline('run_1')?.all().slice(-1)[0]?.sequence ?? 0;

    timelines.open(RUN);
    const next = timelines.timeline('run_1')?.append({
      programmeTimeMs: 30_000,
      kind: 'media',
      reference: 'after_reconnect',
      durationMs: SEGMENT_MS,
    });

    // A sequence that restarted would reorder the broadcast on replay.
    expect(next?.sequence).toBe(lastBefore + 1);
  });

  it('does not replay an advert that was already committed', () => {
    const { timelines, produce } = rig();
    produce(60_000);
    timelines.timeline('run_1')?.append({
      programmeTimeMs: 10_000,
      kind: 'advertisement',
      reference: 'decision_1',
      durationMs: 30_000,
    });

    timelines.open(RUN);

    const adverts = timelines
      .timeline('run_1')
      ?.all()
      .filter((event) => event.kind === 'advertisement');
    // A second impression because the network hiccupped would be billed to an
    // advertiser who did not buy it.
    expect(adverts).toHaveLength(1);
  });

  it('does not rewind the audience when the source returns', () => {
    const { timelines, egress, produce } = rig();
    produce(180_000);
    const cursorBefore = egress.manifest('run_1');
    if (!cursorBefore.available) throw new Error('unreachable');

    timelines.open(RUN);
    produce(200_000);

    const after = egress.manifest('run_1');
    if (!after.available) throw new Error('unreachable');
    // Forward only. Nobody re-watches because a cable was replugged.
    expect(after.publicOutputTimeMs).toBeGreaterThanOrEqual(cursorBefore.publicOutputTimeMs);
  });

  it('starts a genuinely new broadcast under a new run identity', () => {
    const { timelines, produce } = rig();
    produce(60_000);

    // A second airing is a different run, and shares nothing.
    timelines.open({ ...RUN, runId: 'run_2' });
    expect(timelines.timeline('run_2')?.length).toBe(0);
    expect(timelines.timeline('run_1')?.length).toBeGreaterThan(0);
  });
});
