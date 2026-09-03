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
  await rm(directory, { recursive: true, force: true });
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
