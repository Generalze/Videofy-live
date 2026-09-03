/** @author masterzee001 */
/**
 * A broadcast that outlives the process running it.
 *
 * A safety buffer held only in memory is a promise with a footnote: restart
 * the service mid-programme and the timeline is gone, the cursor resets, and
 * an audience forty seconds into a protected broadcast either jumps to live or
 * stops. Neither is what the operator was told could happen.
 *
 * These use the real journal against a real temporary directory, because the
 * failure being guarded is a filesystem one and a fake filesystem cannot have
 * it. Only the injected io double is substituted, and only for the tests that
 * are specifically about a disk going away.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JournalTimelineStore } from '../journal-timeline-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import type { ProgrammeTimelineEvent } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

function event(over: Partial<ProgrammeTimelineEvent> = {}): ProgrammeTimelineEvent {
  return {
    runId: 'run_1',
    sequence: 1,
    programmeTimeMs: 0,
    kind: 'media',
    durationMs: 1000,
    reference: 'seg_0',
    attributes: {},
    ...over,
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'videofy-timeline-'));
});

afterEach(async () => {
  // Retried: on Windows a delete can lose a race with a write that is still
  // settling, and a flaky teardown teaches people to re-run rather than look.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
});

describe('a broadcast survives the process that was running it', () => {
  it('replays exactly what was written, in order', async () => {
    const store = new JournalTimelineStore({ directory });
    for (let i = 0; i < 5; i += 1) {
      await store.append(event({ sequence: i + 1, programmeTimeMs: i * 1000, reference: `seg_${i}` }));
    }
    await store.saveCursor('run_1', 2_000);

    // A different process, a fresh registry, the same spool.
    const registry = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    expect(await registry.recover(RUN)).toBe(true);

    const timeline = registry.timeline('run_1');
    expect(timeline?.length).toBe(5);
    expect(timeline?.all().map((e) => e.reference)).toEqual([
      'seg_0', 'seg_1', 'seg_2', 'seg_3', 'seg_4',
    ]);
  });

  it('puts the audience back where they were, not at the beginning', async () => {
    const store = new JournalTimelineStore({ directory });
    for (let i = 0; i < 60; i += 1) {
      await store.append(event({ sequence: i + 1, programmeTimeMs: i * 1000, reference: `seg_${i}` }));
    }
    await store.saveCursor('run_1', 40_000);

    const registry = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    await registry.recover(RUN);

    const status = registry.status('run_1');
    // Forty seconds in, still forty seconds in. A restart that replayed from
    // zero would give them a programme they have already heard.
    expect(status?.cursor.publicOutputTimeMs).toBe(40_000);
    expect(status?.cursor.bufferDepthMs).toBe(20_000);
  });

  it('never rewinds an audience, even if a stale cursor says to', async () => {
    const store = new JournalTimelineStore({ directory });
    // Enough broadcast for a thirty-second cursor to be a real position: the
    // cursor is clamped to what has actually been authored.
    for (let i = 0; i < 60; i += 1) {
      await store.append(event({ sequence: i + 1, programmeTimeMs: i * 1000, reference: `seg_${i}` }));
    }
    await store.saveCursor('run_1', 30_000);
    const registry = new ProgrammeTimelineRegistry(32, 0, undefined, store);
    await registry.recover(RUN);

    const buffer = registry.buffer('run_1');
    buffer?.restoreReleasedThrough(5_000);
    // Backwards is never a legitimate move: they have heard what they heard.
    expect(registry.status('run_1')?.cursor.publicOutputTimeMs).toBe(30_000);
  });

  it('refuses to continue a broadcast it cannot account for', async () => {
    const store = new JournalTimelineStore({ directory });
    const registry = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    // Nothing was ever written for this run.
    expect(await registry.recover(RUN)).toBe(false);
    expect(registry.tracks('run_1')).toBe(false);
  });
});

describe('a torn write is not a lost programme', () => {
  it('keeps every complete record and drops a truncated final line', async () => {
    const store = new JournalTimelineStore({ directory });
    await store.append(event({ sequence: 1, reference: 'seg_0' }));
    await store.append(event({ sequence: 2, programmeTimeMs: 1000, reference: 'seg_1' }));

    // A process killed mid-write leaves a fragment behind.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(directory, 'run_1.journal'), '{"runId":"run_1","sequ', 'utf8');

    const loaded = await store.load('run_1');
    // Everything before the fragment is intact and is exactly what the
    // audience already received. Refusing the whole journal over one torn line
    // would turn a recoverable restart into a lost broadcast.
    expect(loaded?.events.map((e) => e.reference)).toEqual(['seg_0', 'seg_1']);
  });

  it('replays from the start when the cursor is missing', async () => {
    const store = new JournalTimelineStore({ directory });
    await store.append(event());
    const loaded = await store.load('run_1');
    // Nothing is known about what they received, so nothing is assumed.
    expect(loaded?.releasedThroughMs).toBe(-1);
  });
});

describe('durability is claimed only where it is true', () => {
  it('reports a writable spool by writing to it, not by looking at it', async () => {
    const store = new JournalTimelineStore({ directory });
    expect(await store.health()).toEqual({ writable: true, reason: null });
  });

  it('reports a disk that has gone away', async () => {
    const store = new JournalTimelineStore({
      directory,
      io: {
        appendFile: async () => { throw new Error('ENOSPC: no space left on device'); },
        writeFile: async () => { throw new Error('ENOSPC: no space left on device'); },
        readFile: async () => { throw new Error('ENOENT'); },
        mkdir: async () => undefined,
        rm: async () => undefined,
      } as never,
    });

    const health = await store.health();
    expect(health.writable).toBe(false);
    expect(health.reason).toContain('ENOSPC');
  });

  it('tells a caller a write failed rather than throwing into a live broadcast', async () => {
    const store = new JournalTimelineStore({
      directory,
      io: {
        appendFile: async () => { throw new Error('EROFS: read-only file system'); },
        writeFile: async () => undefined,
        readFile: async () => { throw new Error('ENOENT'); },
        mkdir: async () => undefined,
        rm: async () => undefined,
      } as never,
    });

    // False, not an exception: the caller's correct response is to stop
    // promising a safety delay, not to crash a programme that is on air.
    expect(await store.append(event())).toBe(false);
  });

  it('says a deployment without a store cannot keep a promise across a restart', async () => {
    const registry = new ProgrammeTimelineRegistry();
    expect(await registry.durable()).toEqual({
      durable: false,
      reason: 'no durable timeline store is configured',
    });
  });

  it('says a deployment with a working spool can', async () => {
    const registry = new ProgrammeTimelineRegistry(
      32, 0, undefined, new JournalTimelineStore({ directory }),
    );
    expect(await registry.durable()).toEqual({ durable: true, reason: null });
  });
});

describe('what is written is metadata', () => {
  it('puts no media, transcript or vocabulary on disk', async () => {
    const store = new JournalTimelineStore({ directory });
    await store.append(
      event({ kind: 'caption', reference: 'seg_0', attributes: { language: 'en', final: true } }),
    );
    const raw = await readFile(join(directory, 'run_1.journal'), 'utf8');
    // References and positions only. A broadcast's structure is small and
    // worth keeping; its content belongs in the spool under other rules.
    expect(raw).toContain('seg_0');
    expect(raw).toContain('caption');
    expect(raw.length).toBeLessThan(400);
  });

  it('will not let a run id become a path into somebody else’s broadcast', async () => {
    const store = new JournalTimelineStore({ directory });
    expect(await store.append(event({ runId: '../escape' }))).toBe(false);
    expect(await store.load('../escape')).toBeNull();
  });
});

/*
 * The seam I very nearly left open.
 *
 * The store was written, recovery was written, both were tested, and nothing
 * called `append` during a broadcast -- so recovery would have read an empty
 * journal and every test above would still have passed. That is the eighth
 * instance of this exact shape in this repository, and the only difference is
 * that this one was caught before it shipped.
 */
describe('a running broadcast actually writes to the spool', () => {
  it('persists every event as the timeline is written', async () => {
    const store = new JournalTimelineStore({ directory });
    const registry = new ProgrammeTimelineRegistry(32, 0, undefined, store);
    const timeline = registry.open(RUN);

    timeline.append({ programmeTimeMs: 0, kind: 'media', reference: 'seg_0', durationMs: 1000 });
    timeline.append({ programmeTimeMs: 1000, kind: 'caption', reference: 'seg_1' });
    // The sink is fire-and-forget; let it land.
    await store.flush('run_1');

    const loaded = await store.load('run_1');
    expect(loaded?.events.map((e) => e.reference)).toEqual(['seg_0', 'seg_1']);
  });

  it('survives a restart end to end, through the registry', async () => {
    const store = new JournalTimelineStore({ directory });
    const first = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    const timeline = first.open(RUN);
    for (let i = 0; i < 30; i += 1) {
      timeline.append({ programmeTimeMs: i * 1000, kind: 'media', reference: `s${i}`, durationMs: 1000 });
    }
    first.buffer('run_1')?.advance();
    await store.saveCursor('run_1', 20_000);
    await store.flush('run_1');

    // The process dies. A new one comes up against the same spool.
    const second = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    expect(await second.recover(RUN)).toBe(true);
    expect(second.timeline('run_1')?.length).toBe(30);
    expect(second.status('run_1')?.cursor.publicOutputTimeMs).toBe(20_000);
  });

  it('fails the buffer closed when the spool stops accepting writes', async () => {
    const store = new JournalTimelineStore({
      directory,
      io: {
        appendFile: async () => { throw new Error('ENOSPC'); },
        writeFile: async () => undefined,
        readFile: async () => { throw new Error('ENOENT'); },
        mkdir: async () => undefined,
        rm: async () => undefined,
      } as never,
    });
    const registry = new ProgrammeTimelineRegistry(32, 10_000, undefined, store);
    const timeline = registry.open(RUN);
    timeline.append({ programmeTimeMs: 0, kind: 'media', reference: 'seg_0', durationMs: 1000 });
    await store.flush('run_1');

    /*
     * A safety delay whose record is not being kept will not survive the next
     * restart, and the audience was promised one that would. So the buffer
     * stops rather than continuing to imply a protection it can no longer
     * guarantee.
     */
    const status = registry.status('run_1');
    expect(status?.state).toBe('failed');
    expect(status?.protected).toBe(false);
    expect(status?.detail).toContain('could not be persisted');
  });
});

describe('the journal is append-ORDERED, not merely append-only', () => {
  it('keeps the order the programme happened in, across many events', async () => {
    /*
     * This caught a real race. `append` is not awaited by its callers, so two
     * events written in the same tick reached the file in whichever order the
     * disk finished them -- intermittently. A journal out of order replays as
     * a different broadcast from the one that aired, and the failure appeared
     * roughly one run in three, which is the worst frequency there is.
     */
    const store = new JournalTimelineStore({ directory });
    const registry = new ProgrammeTimelineRegistry(32, 0, undefined, store);
    const timeline = registry.open(RUN);

    const expected: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const reference = `seg_${i}`;
      expected.push(reference);
      // Written in one tick, exactly as a busy programme writes them.
      timeline.append({ programmeTimeMs: i * 20, kind: 'media', reference, durationMs: 20 });
    }
    await store.flush('run_1');

    const loaded = await store.load('run_1');
    expect(loaded?.events.map((e) => e.reference)).toEqual(expected);
  });

  it('keeps two runs from interleaving into each other', async () => {
    const store = new JournalTimelineStore({ directory });
    const registry = new ProgrammeTimelineRegistry(32, 0, undefined, store);
    const one = registry.open(RUN);
    const two = registry.open({ ...RUN, runId: 'run_2' });

    for (let i = 0; i < 20; i += 1) {
      one.append({ programmeTimeMs: i, kind: 'media', reference: `a_${i}`, durationMs: 1 });
      two.append({ programmeTimeMs: i, kind: 'media', reference: `b_${i}`, durationMs: 1 });
    }
    await store.flush('run_1');
    await store.flush('run_2');

    const first = await store.load('run_1');
    const second = await store.load('run_2');
    expect(first?.events.every((e) => e.reference.startsWith('a_'))).toBe(true);
    expect(second?.events.every((e) => e.reference.startsWith('b_'))).toBe(true);
    expect(first?.events).toHaveLength(20);
    expect(second?.events).toHaveLength(20);
  });
});
