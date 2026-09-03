/** @author masterzee001 */
/**
 * What a protected broadcast does when the storage under it misbehaves.
 *
 * Every case here has the same shape: something the code could paper over, and
 * a reason papering over it is worse than stopping. A safety delay is a promise
 * about what an audience has and has not received, and the moment the record of
 * that becomes unreliable the promise cannot be kept -- so the correct answer
 * is nearly always to fail where somebody can see it, rather than to carry on
 * with a plausible guess.
 *
 * THE ONE RULE THAT IS NEVER BENT: protected output never jumps toward the live
 * edge to make up for material it no longer has. Skipping forward is how an
 * audience receives the very seconds the delay exists to withhold, and it is
 * the tempting repair in almost every failure below.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JournalTimelineStore } from '../journal-timeline-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import type { ProgrammeMediaSegment, ProgrammeTimelineEvent } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 45_000;

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'videofy-failure-'));
}

function event(sequence: number): ProgrammeTimelineEvent {
  return {
    runId: 'run_1',
    sequence,
    programmeTimeMs: sequence * 1000,
    kind: 'caption',
    reference: `seg_${sequence}`,
    durationMs: 1000,
    attributes: {},
  };
}

function segment(startMs: number): ProgrammeMediaSegment {
  return {
    runId: 'run_1',
    segmentId: `run_1.g0.${startMs}`,
    startProgrammeTimeMs: startMs,
    endProgrammeTimeMs: startMs + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/run_1/${startMs}.m4s`,
    bytes: 1000,
  };
}

describe('a journal that did not read back whole', () => {
  it('keeps everything before a torn final record', async () => {
    const where = directory();
    const store = new JournalTimelineStore({ directory: where });
    for (let i = 1; i <= 5; i += 1) await store.append(event(i));
    await store.flush('run_1');

    // A process killed mid-write. The fragment is the last thing on disk.
    const path = join(where, 'run_1.journal');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"runId":"run_1","seq`);

    const loaded = await store.load('run_1');
    expect(loaded?.events).toHaveLength(5);
    /*
     * Everything before the fragment is exactly what the audience already
     * received. Refusing the whole journal over one truncated line would turn
     * a recoverable restart into a lost programme.
     */
    expect(loaded?.intact).toBe(true);
  });

  it('reports a hole in the middle rather than quietly closing over it', async () => {
    const where = directory();
    const store = new JournalTimelineStore({ directory: where });
    for (let i = 1; i <= 5; i += 1) await store.append(event(i));
    await store.flush('run_1');

    const path = join(where, 'run_1.journal');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[2] = '{"runId":"run_1","corrupt';
    writeFileSync(path, lines.join('\n'));

    const loaded = await store.load('run_1');
    /*
     * The readable records after the break prove this is not a torn tail. The
     * broadcast is missing a piece somebody may already have been sent, and
     * replaying it would give the audience a different programme from the one
     * that aired. Both cases used to be dropped silently and identically.
     */
    expect(loaded?.intact).toBe(false);
    expect(loaded?.events.length).toBe(4);
  });

  it('stops a broadcast recovered over a gap, rather than resuming across it', async () => {
    const where = directory();
    const store = new JournalTimelineStore({ directory: where });
    for (let i = 1; i <= 5; i += 1) await store.append(event(i));
    await store.flush('run_1');
    const path = join(where, 'run_1.journal');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = 'not json at all';
    writeFileSync(path, lines.join('\n'));

    const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, store, {
      metadata: true,
      media: true,
    });
    expect(await registry.recover(RUN)).toBe(true);
    /*
     * Failing costs the rest of the programme. Guessing costs the promise the
     * delay was made under: a broadcast that cannot tell what its audience
     * received will either replay material they have had or skip material they
     * have not.
     */
    expect(registry.status('run_1')?.state).toBe('failed');
    expect(registry.status('run_1')?.detail).toContain('gap');
  });

  it('replays from the start when the cursor is gone, never from the edge', async () => {
    const where = directory();
    const store = new JournalTimelineStore({ directory: where });
    for (let i = 1; i <= 5; i += 1) await store.append(event(i));
    await store.flush('run_1');
    // The cursor file never landed. Nothing is known about what was released.
    const loaded = await store.load('run_1');
    expect(loaded?.releasedThroughMs).toBe(-1);
  });
});

describe('a spool that stops accepting writes', () => {
  function refusingStore(reason: string): JournalTimelineStore {
    return new JournalTimelineStore({
      directory: directory(),
      io: {
        appendFile: async () => {
          throw Object.assign(new Error(reason), { code: reason });
        },
        writeFile: async () => {
          throw Object.assign(new Error(reason), { code: reason });
        },
        readFile: async () => {
          throw new Error('nothing to read');
        },
        mkdir: async () => undefined,
        rm: async () => undefined,
      },
    });
  }

  it('refuses the append rather than reporting a write that did not happen', async () => {
    for (const reason of ['ENOSPC', 'EACCES', 'EIO']) {
      const store = refusingStore(reason);
      expect(await store.append(event(1))).toBe(false);
    }
  });

  it('fails the broadcast closed when the spool stops accepting the timeline', async () => {
    const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, refusingStore('ENOSPC'), {
      metadata: true,
      media: true,
    });
    const timeline = registry.open(RUN);
    timeline.append({ programmeTimeMs: 0, kind: 'caption', reference: 'c1', durationMs: 1000 });
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));

    /*
     * A safety delay whose record is not being kept is a delay that will not
     * survive the next restart, and the audience was promised one that would.
     */
    expect(registry.status('run_1')?.state).toBe('failed');
  });

  it('reports itself unhealthy rather than merely quiet', async () => {
    const store = refusingStore('EACCES');
    await store.append(event(1));
    const health = await store.health();
    expect(health.writable).toBe(false);
    expect(health.reason).not.toBeNull();
  });
});

describe('media the store must not accept', () => {
  it('refuses a segment that does not begin on a keyframe', () => {
    const media = new ProgrammeMediaStore();
    /*
     * A viewer released from the buffer, or reconnecting, starts at a
     * boundary. A boundary that cannot be decoded on its own produces a
     * delayed broadcast that will not play -- discovered by an audience
     * rather than by us.
     */
    expect(media.accept({ ...segment(0), keyframeAligned: false })).toBe(false);
    expect(media.accept(segment(0))).toBe(true);
  });

  it('will not offer a manifest with no initialisation object', () => {
    const timelines = new ProgrammeTimelineRegistry(32, 0, undefined, undefined, {
      metadata: true,
      media: true,
    });
    const timeline = timelines.open(RUN);
    const media = new ProgrammeMediaStore();
    const egress = new ProgrammeEgressAuthority(timelines, media);
    media.accept(segment(0));
    timeline.append({
      programmeTimeMs: 0,
      kind: 'media',
      reference: 'run_1.g0.0',
      durationMs: 2000,
    });
    timelines.buffer('run_1')?.advance();

    // Nothing has told the egress where the init object is, so asking for it
    // is a refusal rather than a path that happens to be wrong.
    expect(egress.authorizeSegment('run_1', 'run_1.init.0').allowed).toBe(false);
  });
});

describe('retention running out under a protected broadcast', () => {
  it('stops output rather than skipping the audience forward', async () => {
    const timelines = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, undefined, {
      metadata: true,
      media: true,
    });
    const timeline = timelines.open(RUN);
    const media = new ProgrammeMediaStore();
    const egress = new ProgrammeEgressAuthority(timelines, media);
    egress.noteInitSegment('run_1', '/spool/run_1/init.0.mp4');

    // Three minutes produced, then everything the audience still needs is
    // discarded: the retention window has been outrun.
    for (let ms = 0; ms < 180_000; ms += 2000) {
      media.accept(segment(ms));
      timeline.append({
        programmeTimeMs: ms,
        kind: 'media',
        reference: `run_1.g0.${ms}`,
        durationMs: 2000,
      });
    }
    timelines.buffer('run_1')?.advance();
    const before = egress.manifest('run_1');
    expect(before.available).toBe(true);

    /*
     * THE RETENTION WINDOW OUTRUN. Pruning for a delay far shorter than the one
     * actually being held discards material the audience has not reached --
     * which is what happens when a deployment is sized for one delay and
     * configured for another.
     */
    await media.prune('run_1', 180_000, 0);
    const after = egress.manifest('run_1');

    /*
     * THE TEMPTING REPAIR, AND THE ONE THAT IS NEVER RIGHT. Serving what
     * remains would move the audience forward to material the delay was
     * withholding -- the exact seconds a protected broadcast exists to keep
     * back. Refusing is the only answer.
     */
    expect(after.available).toBe(false);
    if (after.available) throw new Error('unreachable');
    expect(after.refusal).toBe('output-stopped');
  });
});

describe('two broadcasts at once', () => {
  it('keeps their journals from interleaving', async () => {
    const where = directory();
    const store = new JournalTimelineStore({ directory: where });
    for (let i = 1; i <= 20; i += 1) {
      void store.append({ ...event(i), runId: 'run_1' });
      void store.append({ ...event(i), runId: 'run_2' });
    }
    await store.flush('run_1');
    await store.flush('run_2');

    const one = await store.load('run_1');
    const two = await store.load('run_2');
    // A run's journal is its own account. One broadcast's events appearing in
    // another's would replay somebody else's programme.
    expect(one?.events.every((e) => e.runId === 'run_1')).toBe(true);
    expect(two?.events.every((e) => e.runId === 'run_2')).toBe(true);
    expect(one?.events).toHaveLength(20);
    expect(two?.events).toHaveLength(20);
  });

  it('keeps fifty same-tick appends in the order the programme happened', async () => {
    const store = new JournalTimelineStore({ directory: directory() });
    for (let i = 1; i <= 50; i += 1) void store.append(event(i));
    await store.flush('run_1');

    const loaded = await store.load('run_1');
    /*
     * Callers do not await `append` -- a live broadcast cannot wait on a disk
     * -- so without per-run serialisation these race and the journal ends up
     * in an order the programme never happened in.
     */
    expect(loaded?.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
  });
});
