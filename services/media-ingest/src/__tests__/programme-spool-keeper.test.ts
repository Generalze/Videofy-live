/** @author masterzee001 */
/**
 * Watching the volume while a broadcast is being held on it.
 *
 * A spool that was fit at startup is not fit for ever: the broadcast that
 * starts on a healthy disk is the one filling it. So capacity is asked again
 * while the run is live, and the answer arrives with enough warning to act on
 * -- ENOSPC discovered mid-broadcast is a problem with nothing left to do
 * about it.
 *
 * AND THE ONE FORBIDDEN REMEDY. Shortening the delay would reliably free
 * space and would move an audience closer to live than they were told. When
 * the volume cannot hold the promise, the promise fails.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileName } from '@videofy-live/programme-contribution';
import { ProgrammeSpoolKeeper } from '../programme-spool-keeper.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { FileSegmentSink } from '../programme-spool-retention.js';
import { requiredSpoolBytes, PROGRAMME_SPOOL_MARGIN } from '../programme-spool-readiness.js';

const DELAY_MS = 45_000;
const CAPACITY = {
  bytesPerSecond: 3_500_000 / 8,
  maxDelayMs: DELAY_MS,
  concurrentRuns: 1,
  marginFactor: PROGRAMME_SPOOL_MARGIN,
};
const REQUIRED = requiredSpoolBytes(CAPACITY);

let root: string;
let run: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spool-keeper-'));
  run = join(root, 'run-1');
  await mkdir(run, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A run whose cursor sits far enough ahead that early media has expired. */
function timelines(publicOutputTimeMs: number) {
  return {
    trackedRuns: () => ['run-1'],
    status: (runId: string) =>
      runId === 'run-1'
        ? ({
            configuredDelayMs: DELAY_MS,
            cursor: { publicOutputTimeMs },
          } as never)
        : null,
  };
}

async function storeWithSegments(count: number, startMs = 0): Promise<ProgrammeMediaStore> {
  const media = new ProgrammeMediaStore(new FileSegmentSink({ spoolRoot: root }));
  for (let index = 0; index < count; index += 1) {
    const fileName = `seg_g0_${String(index).padStart(5, '0')}.m4s`;
    await writeFile(join(run, fileName), 'x'.repeat(1000));
    media.accept({
      runId: 'run-1',
      segmentId: `run-1.g0.${String(index).padStart(5, '0')}`,
      startProgrammeTimeMs: startMs + index * 2000,
      endProgrammeTimeMs: startMs + (index + 1) * 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: join(run, fileName),
      bytes: 1000,
      initGeneration: 0,
    });
  }
  return media;
}

describe('retention is finally called by something', () => {
  it('REMOVES THE BYTES OF SEGMENTS THE WINDOW HAS RELEASED', async () => {
    /*
     * The end-to-end version of the two unwired halves: nothing called prune,
     * and prune deleted nothing. This asserts on the filesystem, because an
     * index that shrank while the volume grew is exactly what happened.
     */
    const media = await storeWithSegments(20);
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      /*
       * The retained window is the delay plus its margin, 75 s here, and the
       * run holds 40 s of media. A cursor at 100 s puts the first half of it
       * outside the window and leaves the rest inside -- which is the case
       * that matters: retention must trim, not empty.
       */
      timelines: timelines(100_000),
      capacity: CAPACITY,
      freeBytes: async () => REQUIRED * 10,
    });
    await keeper.sweep();
    const { readdir } = await import('node:fs/promises');
    const left = await readdir(run);
    expect(left.length).toBeLessThan(20);
    expect(left.length).toBeGreaterThan(0);
    expect(media.retainedSegmentIds('run-1').length).toBe(left.length);
  });

  it('keeps everything while the cursor is still inside the window', async () => {
    const media = await storeWithSegments(5);
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(4000),
      capacity: CAPACITY,
      freeBytes: async () => REQUIRED * 10,
    });
    await keeper.sweep();
    expect(media.retainedSegmentIds('run-1').length).toBe(5);
  });

  it('retires an initialisation object only after its last fragment expires', async () => {
    const media = await storeWithSegments(20);
    await writeFile(join(run, initFileName(0)), 'init');
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(100_000),
      capacity: CAPACITY,
      freeBytes: async () => REQUIRED * 10,
    });
    await keeper.sweep();
    const { readdir } = await import('node:fs/promises');
    // Generation 0 fragments are still retained, so its init stays.
    expect(await readdir(run)).toContain(initFileName(0));
  });
});

describe('capacity, while the broadcast is running', () => {
  const keeperWith = async (freeBytes: number | null, now?: () => number) => {
    const media = await storeWithSegments(3);
    return new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(2000),
      capacity: CAPACITY,
      freeBytes: async () => freeBytes,
      ...(now === undefined ? {} : { now }),
    });
  };

  it('is content with room to spare', async () => {
    const keeper = await keeperWith(REQUIRED * 10);
    expect((await keeper.sweep()).state).toBe('ok');
  });

  it('FAILS PROTECTION WHEN THE VOLUME CANNOT HOLD THE WINDOW', async () => {
    const keeper = await keeperWith(Math.floor(REQUIRED / 2));
    const pressure = await keeper.sweep();
    expect(pressure.state).toBe('failed');
    // Both numbers, in megabytes, so an operator can compare them with df.
    expect(pressure.detail).toMatch(/needs/u);
  });

  it('degrades when it can hold the window and nothing more', async () => {
    const keeper = await keeperWith(Math.floor(REQUIRED * 1.2));
    expect((await keeper.sweep()).state).toBe('degraded');
  });

  it('treats unreadable free space as degraded, never as fine', async () => {
    /*
     * Not knowing is not the same as being well. A volume whose free space
     * cannot be read is one no safety buffer can be promised on.
     */
    const keeper = await keeperWith(null);
    const pressure = await keeper.sweep();
    expect(pressure.state).toBe('degraded');
    expect(pressure.detail).toMatch(/cannot be read/u);
  });

  it('PREDICTS EXHAUSTION RATHER THAN WAITING FOR ENOSPC', async () => {
    /*
     * Two samples, a falling volume, and a horizon computed from the rate.
     * Waiting for the write to fail means finding out in the middle of a
     * broadcast, when there is nothing left to do about it.
     */
    let clock = 0;
    let free = REQUIRED * 8;
    const media = await storeWithSegments(3);
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(2000),
      capacity: CAPACITY,
      now: () => clock,
      freeBytes: async () => free,
    });

    expect((await keeper.sweep()).state).toBe('ok');
    // A minute later, a large part of the headroom is gone.
    clock += 60_000;
    free = REQUIRED * 2;
    const pressure = await keeper.sweep();

    expect(pressure.state).toBe('degraded');
    expect(pressure.secondsToExhaustion).not.toBeNull();
    // Still comfortably above the requirement at this instant: the warning
    // comes from the trend, not from the level.
    expect(pressure.availableBytes).toBeGreaterThan(pressure.requiredBytes);
    expect(pressure.detail).toMatch(/at the current rate/u);
  });

  it('does not invent a horizon from a steady volume', async () => {
    let clock = 0;
    const media = await storeWithSegments(3);
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(2000),
      capacity: CAPACITY,
      now: () => clock,
      freeBytes: async () => REQUIRED * 8,
    });
    await keeper.sweep();
    clock += 60_000;
    const pressure = await keeper.sweep();
    // Nothing is being consumed, so there is no exhaustion to project.
    expect(pressure.secondsToExhaustion).toBeNull();
    expect(pressure.state).toBe('ok');
  });

  it('reports a refused write as degraded', async () => {
    const keeper = await keeperWith(REQUIRED * 10);
    keeper.noteWriteFailure();
    const pressure = await keeper.sweep();
    expect(pressure.writeFailures).toBe(1);
    expect(pressure.state).toBe('degraded');
    // Counted per sample, so one bad moment does not degrade a run for ever.
    expect((await keeper.sweep()).state).toBe('ok');
  });
});

describe('orphans wait for recovery', () => {
  it('sweeps nothing until the run has been reconstructed', async () => {
    const media = await storeWithSegments(1);
    const keeper = new ProgrammeSpoolKeeper({
      spoolRoot: root,
      media,
      timelines: timelines(2000),
      capacity: CAPACITY,
      freeBytes: async () => REQUIRED * 10,
      // Old enough that the grace period would not save it.
      now: () => Date.now() + 86_400_000,
    });
    await writeFile(join(run, 'seg_g0_09999.m4s'), 'orphan');
    await keeper.sweep();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(run)).toContain('seg_g0_09999.m4s');

    keeper.noteRecovered('run-1');
    await keeper.sweep();
    expect(await readdir(run)).not.toContain('seg_g0_09999.m4s');
  });
});
