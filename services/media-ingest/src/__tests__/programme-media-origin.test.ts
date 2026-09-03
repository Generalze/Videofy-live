/** @author masterzee001 */
/**
 * Does a running programme actually produce protected media?
 *
 * The encoder and the store were both correct and never spoke. The assertions
 * here are about the speaking: that a segment reaches the store only once the
 * packager has finished writing it, that its place in the broadcast comes from
 * the media rather than a clock, and that a dead encoder is a failed broadcast
 * rather than a quiet one.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProgrammeMediaOrigin,
  parsePlaylist,
  type OriginProcess,
  type OriginSpawner,
} from '../programme-media-origin.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { ProgrammeEgressAuthority, initSegmentId } from '../programme-egress.js';
import type { MediaOriginOptions, OriginRunResult } from '../media-origin-worker.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;

/** An encoder that never exits unless a test says so. */
function fakeSpawner(): OriginSpawner & {
  readonly started: MediaOriginOptions[];
  exit: (result: OriginRunResult) => void;
  stopped: () => boolean;
} {
  const started: MediaOriginOptions[] = [];
  let resolveExit: ((result: OriginRunResult) => void) | null = null;
  let wasStopped = false;
  const exited = new Promise<OriginRunResult>((resolve) => {
    resolveExit = resolve;
  });
  const process: OriginProcess = {
    exited,
    stop: () => {
      wasStopped = true;
    },
  };
  return {
    started,
    start(options) {
      started.push(options);
      return process;
    },
    exit: (result) => resolveExit?.(result),
    stopped: () => wasStopped,
  };
}

function playlistOf(...durations: readonly number[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MAP:URI="init.mp4"'];
  durations.forEach((duration, index) => {
    lines.push(`#EXTINF:${duration.toFixed(6)},`);
    lines.push(`seg_${String(index).padStart(5, '0')}.m4s`);
  });
  return `${lines.join('\n')}\n`;
}

interface Rig {
  readonly origin: ProgrammeMediaOrigin;
  readonly media: ProgrammeMediaStore;
  readonly timelines: ProgrammeTimelineRegistry;
  readonly egress: ProgrammeEgressAuthority;
  readonly spawner: ReturnType<typeof fakeSpawner>;
  /** What the packager's playlist currently says. */
  setPlaylist: (playlist: string | null) => void;
}

function rig(delayMs = DELAY_MS): Rig {
  const spoolRoot = mkdtempSync(join(tmpdir(), 'videofy-origin-'));
  const timelines = new ProgrammeTimelineRegistry(32, delayMs, undefined, undefined, {
    metadata: true,
    media: true,
  });
  timelines.open(RUN);
  const media = new ProgrammeMediaStore();
  const egress = new ProgrammeEgressAuthority(timelines, media);
  const spawner = fakeSpawner();

  let playlist: string | null = null;
  const origin = new ProgrammeMediaOrigin({
    media,
    timelines,
    egress,
    spoolRoot,
    spawner,
    // Long enough that no timer fires during a test; collection is driven
    // explicitly so the assertions are about the logic, not about waiting.
    pollMs: 3_600_000,
    readPlaylist: async () => playlist,
  });

  return {
    origin,
    media,
    timelines,
    egress,
    spawner,
    setPlaylist: (value) => {
      playlist = value;
    },
  };
}

describe('reading what the packager has finished', () => {
  it('takes each segment and the duration it actually has', () => {
    const entries = parsePlaylist(playlistOf(2, 1.96, 2.04));
    expect(entries.map((e) => e.fileName)).toEqual([
      'seg_00000.m4s',
      'seg_00001.m4s',
      'seg_00002.m4s',
    ]);
    // Not all two seconds: a forced keyframe lands on a frame boundary.
    expect(entries[1]?.durationSeconds).toBeCloseTo(1.96, 5);
  });

  it('ignores tags, comments and blank lines', () => {
    const entries = parsePlaylist('#EXTM3U\n\n#EXT-X-ENDLIST\n');
    expect(entries).toEqual([]);
  });
});

describe('a segment is finished when the playlist says so', () => {
  it('registers nothing while the playlist is absent', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    // The encoder is running and its first segment file exists on disk, being
    // written into. There is nothing to publish.
    expect(await live.origin.collect('run_1')).toBe(0);
  });

  it('registers a segment once the packager lists it', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2, 2));

    expect(await live.origin.collect('run_1')).toBe(2);
    const events = live.timelines
      .timeline('run_1')
      ?.all()
      .filter((event) => event.kind === 'media');
    expect(events).toHaveLength(2);
  });

  it('registers nothing twice when the playlist is read again', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2, 2));
    await live.origin.collect('run_1');

    live.setPlaylist(playlistOf(2, 2, 2));
    // A poll every second against a growing playlist must add one segment,
    // not re-add the whole broadcast.
    expect(await live.origin.collect('run_1')).toBe(1);
  });
});

describe('where a segment sits in the broadcast', () => {
  it('accumulates programme time from the durations the packager measured', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2, 1.96, 2.04));
    await live.origin.collect('run_1');

    const events = live.timelines
      .timeline('run_1')
      ?.all()
      .filter((event) => event.kind === 'media');
    // Not index * 2000: a wall clock or an assumed segment size drifts against
    // the encoder, and every caption placed against programme time drifts too.
    expect(events?.map((event) => event.programmeTimeMs)).toEqual([0, 2000, 3960]);
  });

  it('gives each segment an id derived from its run', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2));
    await live.origin.collect('run_1');

    const event = live.timelines
      .timeline('run_1')
      ?.all()
      .find((entry) => entry.kind === 'media');
    // Two broadcasts on one host must never mint the same segment id.
    expect(event?.reference).toBe('run_1.00000');
  });
});

describe('the init segment, without which nothing decodes', () => {
  it('is publishable before the first fragment is', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');

    // Registered at start, not after the first segment: a manifest that
    // offered fragments first would be one no player could use.
    expect(live.egress.authorizeSegment('run_1', initSegmentId('run_1')).allowed).toBe(true);
  });
});

describe('one producer per broadcast', () => {
  it('refuses to start a second encoder for a run already producing', async () => {
    const live = rig();
    expect(await live.origin.start('run_1', 'rtmp://source/live')).toBe(true);
    expect(await live.origin.start('run_1', 'rtmp://source/live')).toBe(false);
    // Two writers would produce two segment series with the same names and
    // different content: split brain, in the media plane.
    expect(live.spawner.started).toHaveLength(1);
  });

  it('runs the encoder into a directory of the run own', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    expect(live.spawner.started[0]?.outputDirectory).toContain('run_1');
    expect(live.spawner.started[0]?.input).toBe('rtmp://source/live');
  });
});

describe('the cursor still decides what is public', () => {
  it('holds produced media back until the delay has been served', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(...Array.from({ length: 10 }, () => 2)));
    await live.origin.collect('run_1');

    // Twenty seconds produced against a forty-five second delay: the producer
    // does not publish, it supplies. Nothing is public yet.
    const manifest = live.egress.manifest('run_1');
    expect(manifest.available).toBe(true);
    if (!manifest.available) throw new Error('unreachable');
    expect(manifest.segments).toHaveLength(0);
  });

  it('publishes what the delay has released and no more', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(...Array.from({ length: 60 }, () => 2)));
    await live.origin.collect('run_1');

    const manifest = live.egress.manifest('run_1');
    if (!manifest.available) throw new Error('unreachable');
    // 120 s produced, 45 s withheld: the audience is at 75 s.
    expect(manifest.publicOutputTimeMs).toBe(75_000);
    /*
     * Thirty-seven, not thirty-seven and a half. A segment is published whole
     * or not at all: the one running from 74 s to 76 s straddles the cursor,
     * and offering it would hand the audience a second of the future.
     */
    expect(manifest.segments).toHaveLength(37);
  });
});

describe('an encoder that stops', () => {
  it('fails the broadcast when it was not asked to stop', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.spawner.exit({ ok: false, exitCode: 1, stderr: 'Connection reset by peer' });
    await new Promise((done) => setImmediate(done));

    /*
     * Not a quiet stop. A frozen cursor with a healthy status is
     * indistinguishable from a broadcast that happens to be silent, and every
     * second of that is a second nobody knows is broken.
     */
    expect(live.timelines.status('run_1')?.state).toBe('failed');
  });

  it('does not fail the broadcast when the stop was deliberate', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2, 2));
    await live.origin.stop('run_1');
    live.spawner.exit({ ok: false, exitCode: 255, stderr: 'killed' });
    await new Promise((done) => setImmediate(done));

    expect(live.timelines.status('run_1')?.state).not.toBe('failed');
    expect(live.spawner.stopped()).toBe(true);
  });

  it('collects the segments completed between the last poll and the stop', async () => {
    const live = rig();
    await live.origin.start('run_1', 'rtmp://source/live');
    live.setPlaylist(playlistOf(2, 2, 2));
    // Never polled while running; the final read is what saves the tail of the
    // broadcast, which is as much a part of it as any other second.
    await live.origin.stop('run_1');

    const events = live.timelines
      .timeline('run_1')
      ?.all()
      .filter((event) => event.kind === 'media');
    expect(events).toHaveLength(3);
    expect(live.origin.produces('run_1')).toBe(false);
  });
});

/*
 * THE SEAM. Everything above would pass against a service that never built a
 * producer, which was the state of this repository until now.
 */
describe('the running service composes this producer', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('constructs one and gives it the same spool the egress serves from', () => {
    expect(source).toContain('new ProgrammeMediaOrigin({');
    expect(source).toContain('spoolRoot: programmeMediaSpool');
  });

  it('starts it only from a template the deployment owns', () => {
    // An operator-supplied input would be an instruction to read whatever that
    // address points at -- a local file, an internal host -- and broadcast it.
    expect(source).toContain("config.programmeMediaOriginInput.replace('{runId}', runId)");
    expect(source).not.toContain('req.body.input');
  });

  it('keeps the control route behind the operator guard', () => {
    expect(source).toContain("app.post('/programmes/:runId/media-origin', operatorOnly");
    expect(source).toContain("app.delete('/programmes/:runId/media-origin', operatorOnly");
  });

  it('does not claim the media plane is held merely because an encoder runs', () => {
    /*
     * THE ILLUSORY-PROTECTION DEFECT, asserted so it cannot come back.
     *
     * The gateway relays the broadcaster's tracks straight to each listener,
     * on a path this service's cursor has no part in. Producing segments does
     * not hold the original back. A composition that governed the media plane
     * on the strength of an encoder would let the console report PROTECTED
     * LIVE over an audience hearing the speaker immediately -- which is worse
     * than no protection, because somebody would rely on it.
     */
    expect(source).toContain("config.programmeMediaDelivery === 'delayed'");
    // Both conditions, and the honest fallback when either is missing.
    expect(source).toContain('config.programmeMediaOriginInput !== null &&');
    expect(source).toContain('METADATA_PLANE_ONLY');
  });
});
