/** @author masterzee001 */
/**
 * Letting go of material, physically.
 *
 * TWO HALVES OF ONE POLICY WERE BOTH UNWIRED. `prune` was written and tested
 * and called by nothing outside its own tests, and every deployment passed the
 * store a sink whose `discard` returns true without touching a file. So the
 * retained window never shrank on a real deployment: not in memory, and not a
 * byte on the volume. A long broadcast filled the disk behind a green console.
 *
 * The dangerous direction is the other one. A deletion that runs when it
 * should not destroys the retained window instead of trimming it, and the
 * audience finds out mid-reconnect.
 */
import { mkdtemp, mkdir, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFileName } from '@videofy-live/programme-contribution';
import {
  FileSegmentSink,
  sweepInitGenerations,
  sweepOrphans,
  initGenerationOfFile,
  ORPHAN_GRACE_MS,
} from '../programme-spool-retention.js';

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
const KEEPER = readFileSync(
  fileURLToPath(new URL('../programme-spool-keeper.ts', import.meta.url)),
  'utf8',
);

let root: string;
let run: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spool-retention-'));
  run = join(root, 'run-1');
  await mkdir(run, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const segment = async (name: string, bytes = 'x') => {
  const path = join(run, name);
  await writeFile(path, bytes);
  return path;
};

describe('the sink removes bytes, and only ours', () => {
  it('deletes the segment it is given', async () => {
    const path = await segment('seg_g0_00001.m4s');
    const sink = new FileSegmentSink({ spoolRoot: root });
    expect(await sink.discard(path)).toBe(true);
    expect(await readdir(run)).toEqual([]);
  });

  it('REFUSES A REFERENCE OUTSIDE THE SPOOL', async () => {
    /*
     * The reference comes from our own store, so this is unreachable while the
     * store behaves. The cost of the check being wrong is a spool that grows;
     * the cost of its absence, once, is somebody else's file.
     */
    const outside = join(root, 'not-the-spool.txt');
    await writeFile(outside, 'keep me');
    const sink = new FileSegmentSink({ spoolRoot: join(root, 'spool') });
    const problems: string[] = [];
    const guarded = new FileSegmentSink({
      spoolRoot: join(root, 'spool'),
      onProblem: (message) => problems.push(message),
    });
    expect(await sink.discard(outside)).toBe(false);
    expect(await guarded.discard(outside)).toBe(false);
    expect(problems[0]).toMatch(/outside the spool/u);
    // Still there.
    expect(await readdir(root)).toContain('not-the-spool.txt');
  });

  it('refuses a traversal that climbs out of the spool', async () => {
    const outside = join(root, 'escape.txt');
    await writeFile(outside, 'keep me');
    const sink = new FileSegmentSink({ spoolRoot: run });
    expect(await sink.discard(join(run, '..', 'escape.txt'))).toBe(false);
    expect(await readdir(root)).toContain('escape.txt');
  });

  it('treats an already-absent file as discarded', async () => {
    // Retention running twice, or after a crash mid-delete, must converge
    // rather than report a permanent failure nobody can clear.
    const sink = new FileSegmentSink({ spoolRoot: root });
    expect(await sink.discard(join(run, 'seg_g0_09999.m4s'))).toBe(true);
  });
});

describe('initialisation objects are reference-counted, not aged', () => {
  it('reads the init file name from the packager convention rather than a copy of it', () => {
    // Two spellings of one convention is how a sweep matches nothing -- or
    // matches the wrong thing.
    expect(initGenerationOfFile(initFileName(0))).toBe(0);
    expect(initGenerationOfFile(initFileName(12))).toBe(12);
    expect(initGenerationOfFile('seg_g0_00001.m4s')).toBeNull();
    expect(initGenerationOfFile('playlist.0.m3u8')).toBeNull();
  });

  it('KEEPS A GENERATION WHILE ONE RETAINED FRAGMENT STILL NEEDS IT', async () => {
    /*
     * The whole rule. Generation 0 is the oldest thing in the directory, and
     * age is exactly the wrong test: a fragment without its initialisation
     * object does not decode, so removing it destroys the retained window
     * rather than trimming it.
     */
    await writeFile(join(run, initFileName(0)), 'init0');
    await writeFile(join(run, initFileName(1)), 'init1');
    const result = await sweepInitGenerations({
      directory: run,
      retainedSegmentIds: ['run-1.g0.00042', 'run-1.g1.00001'],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([0, 1]);
  });

  it('removes a generation once its final fragment has expired', async () => {
    await writeFile(join(run, initFileName(0)), 'init0');
    await writeFile(join(run, initFileName(1)), 'init1');
    const result = await sweepInitGenerations({
      directory: run,
      // Nothing from generation 0 is retained any more.
      retainedSegmentIds: ['run-1.g1.00007'],
    });
    expect(result.removed).toEqual([0]);
    expect(result.kept).toEqual([1]);
    expect(await readdir(run)).toEqual([initFileName(1)]);
  });

  it('never touches a fragment', async () => {
    await segment('seg_g0_00001.m4s');
    await writeFile(join(run, initFileName(0)), 'init0');
    await sweepInitGenerations({ directory: run, retainedSegmentIds: [] });
    // The init went; the fragment is the segment sink's business, under the
    // retention window, and not age's.
    expect(await readdir(run)).toEqual(['seg_g0_00001.m4s']);
  });
});

describe('orphans', () => {
  const old = async (name: string) => {
    const path = await segment(name);
    const past = new Date(Date.now() - ORPHAN_GRACE_MS * 2);
    await utimes(path, past, past);
    return path;
  };

  it('REFUSES TO SWEEP A RUN RECOVERY HAS NOT RECONSTRUCTED', async () => {
    /*
     * The catastrophic version of this feature. After a restart NOTHING is in
     * memory, so "delete what is not referenced" would delete the entire
     * retained window of every recovered broadcast a moment before its
     * audience needed it.
     */
    await old('seg_g0_00001.m4s');
    const result = await sweepOrphans({
      directory: run,
      referencedFileNames: [],
      recovered: false,
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toMatch(/recovery/u);
    expect(await readdir(run)).toEqual(['seg_g0_00001.m4s']);
  });

  it('removes a committed-nowhere file once it is past the grace period', async () => {
    await old('seg_g0_00001.m4s');
    const result = await sweepOrphans({
      directory: run,
      referencedFileNames: [],
      recovered: true,
    });
    expect(result.removed).toEqual(['seg_g0_00001.m4s']);
  });

  it('leaves a file the timeline references exactly where it is', async () => {
    await old('seg_g0_00001.m4s');
    const result = await sweepOrphans({
      directory: run,
      referencedFileNames: ['seg_g0_00001.m4s'],
      recovered: true,
    });
    expect(result.removed).toEqual([]);
  });

  it('leaves a file that is too recent to judge', async () => {
    /*
     * A file being written right now and an abandoned one look identical from
     * outside. Deleting the first to tidy up after the second kills a live
     * broadcast.
     */
    await segment('seg_g0_00002.m4s');
    const result = await sweepOrphans({
      directory: run,
      referencedFileNames: [],
      recovered: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.tooRecent).toBe(1);
  });

  it('leaves initialisation objects and the encoder playlist alone', async () => {
    // Inits belong to the reference-counted sweep; the playlist belongs to the
    // running encoder, which rewrites it continuously.
    const past = new Date(Date.now() - ORPHAN_GRACE_MS * 2);
    for (const name of [initFileName(0), 'playlist.0.m3u8']) {
      await writeFile(join(run, name), 'x');
      await utimes(join(run, name), past, past);
    }
    const result = await sweepOrphans({
      directory: run,
      referencedFileNames: [],
      recovered: true,
    });
    expect(result.removed).toEqual([]);
  });

  it('works per run, so one broadcast cannot sweep another', async () => {
    const other = join(root, 'run-2');
    await mkdir(other);
    const past = new Date(Date.now() - ORPHAN_GRACE_MS * 2);
    await writeFile(join(other, 'seg_g0_00001.m4s'), 'x');
    await utimes(join(other, 'seg_g0_00001.m4s'), past, past);
    await sweepOrphans({ directory: run, referencedFileNames: [], recovered: true });
    // Untouched: the sweep is given one run's directory and never the root.
    expect(await readdir(other)).toEqual(['seg_g0_00001.m4s']);
  });
});

describe('the composition root runs retention', () => {
  it('gives the store a sink that actually deletes', () => {
    /*
     * The defect asserted against directly. `new ProgrammeMediaStore()` takes
     * the sink that keeps everything, so every deployment reported segments
     * discarded and removed no bytes.
     */
    expect(INDEX).toContain('new FileSegmentSink({');
    expect(INDEX).not.toContain('const programmeMedia = new ProgrammeMediaStore();');
  });

  it('constructs and starts the keeper that calls prune', () => {
    expect(INDEX).toContain('new ProgrammeSpoolKeeper({');
    expect(INDEX).toContain('programmeSpoolKeeper?.start();');
  });

  it('only permits orphan cleanup after a recovery has run', () => {
    expect(INDEX).toContain('programmeSpoolKeeper?.noteRecovered(runId);');
  });

  it('NEVER SHORTENS THE DELAY TO FREE SPACE', () => {
    /*
     * The one action that would reliably free disk, and the one that turns a
     * storage problem into a broadcast going out closer to live than the
     * people relying on it were told.
     */
    expect(KEEPER).not.toContain('configure(');
    expect(KEEPER).toContain('fail');
  });
});
