/** @author masterzee001 */
/**
 * What the archive believes, versus what it has actually written down.
 *
 * THE DEFECT THIS SUITE HUNTS is a ghost: an archive that has updated the
 * record in its own memory and then failed to persist it, so that everything
 * it says afterwards is a promise the disk never made. It is invisible while a
 * process lives -- describe answers, finalise works, byte totals add up -- and
 * it is discovered exactly once, by the restart that reads the truth back.
 *
 * The rule under test, stated once:
 *
 *     THE CACHED RECORD NEVER ADVANCES BEYOND THE LAST STATE MADE DURABLE.
 *
 * Every mutating operation is driven into failure at the moment its metadata
 * write happens, with everything before it having succeeded -- including, for
 * retention, a media object that is already published and flushed. Each test
 * then asks the same three questions: what does the archive say now, what is on
 * the disk, and do they still agree after a restart.
 *
 * HOW THE FAILURE IS INJECTED. `state.json` is replaced by a DIRECTORY of the
 * same name. Publishing a state file renames a temporary over that name, which
 * a directory refuses, while the temporary directory beside it still accepts
 * writes -- so media copies keep succeeding and only the metadata commit fails.
 * Measured on this platform rather than assumed: the rename fails EPERM on
 * Windows and EISDIR elsewhere, and neither code is special-cased.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import { FilesystemReplayArchive, type CorruptReplayRun } from './filesystem.js';
import type { ReplayInitialisation } from './media.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RUN: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_a' };

let root: string;
let spool: string;
let archive: FilesystemReplayArchive;
let corrupt: readonly CorruptReplayRun[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'videofy-atomicity-'));
  spool = mkdtempSync(join(tmpdir(), 'videofy-atomicity-spool-'));
  ({ archive, corrupt } = await FilesystemReplayArchive.open(root, () => STARTED));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(spool, { recursive: true, force: true });
});

function runDirectory(runId = RUN.runId): string {
  return join(root, 'runs', createHash('sha256').update(runId, 'utf8').digest('hex'));
}

function statePath(runId = RUN.runId): string {
  return join(runDirectory(runId), 'state.json');
}

function listing(folder: string, runId = RUN.runId): readonly string[] {
  try {
    return readdirSync(join(runDirectory(runId), folder));
  } catch {
    return [];
  }
}

/**
 * Make every metadata commit fail, and hand back the undo.
 *
 * The saved bytes are restored on release, which is what a crash would have
 * left: the last state that was genuinely made durable, and nothing after it.
 */
function breakStateWrites(runId = RUN.runId): () => void {
  const path = statePath(runId);
  const saved = existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
  if (saved !== null) rmSync(path);
  mkdirSync(path, { recursive: true });
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (saved !== null) writeFileSync(path, saved);
  };
}

async function restart(): Promise<void> {
  ({ archive, corrupt } = await FilesystemReplayArchive.open(root, () => STARTED));
}

function sourceFile(name: string, body: string): string {
  const path = join(spool, name);
  writeFileSync(path, Buffer.from(body));
  return path;
}

function segment(index: number, overrides: Partial<ProgrammeMediaSegment> = {}): ProgrammeMediaSegment {
  const name = `seg_${String(index).padStart(5, '0')}.m4s`;
  const path = sourceFile(name, `SEGMENT-${name}`.padEnd(128, '.'));
  return {
    runId: RUN.runId,
    segmentId: `${RUN.runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: index * 2000,
    endProgrammeTimeMs: index * 2000 + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: path,
    bytes: statSync(path).size,
    ...overrides,
  };
}

function initialisation(generation = 0): ReplayInitialisation {
  const path = sourceFile(`init.${generation}.mp4`, `INIT-${generation}`.padEnd(48, '#'));
  return { runId: RUN.runId, generation, storageReference: path, bytes: statSync(path).size };
}

async function keep(): Promise<void> {
  const begun = await archive.begin({
    identity: RUN,
    retention: { policy: 'keep' },
    visibility: 'private',
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
}

async function expiring(): Promise<void> {
  const begun = await archive.begin({
    identity: RUN,
    retention: { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
    visibility: 'private',
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
}

/* ==================================================================== begin */

describe('a begin that could not be written down never happened', () => {
  it('refuses, exposes no recording, and leaves none after a restart', async () => {
    // The run's directories are made before the first record is written, so a
    // failure here leaves folders and nothing that was ever true.
    mkdirSync(runDirectory(), { recursive: true });
    const release = breakStateWrites();

    const begun = await archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'private',
      startedAtMs: STARTED,
    });

    expect(begun.ok).toBe(false);
    if (begun.ok) throw new Error('unreachable');
    expect(begun.failure.reason).toBe('archive-unavailable');
    expect(await archive.describe(RUN.runId)).toBeNull();

    release();
    await restart();
    expect(await archive.describe(RUN.runId)).toBeNull();
    // An interrupted begin is not damage: nothing was ever claimed.
    expect(corrupt).toEqual([]);
  });

  it('lets the run be begun properly afterwards', async () => {
    mkdirSync(runDirectory(), { recursive: true });
    const release = breakStateWrites();
    await archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'private',
      startedAtMs: STARTED,
    });
    release();

    await restart();
    await keep();
    expect((await archive.describe(RUN.runId))?.status).toBe('recording');
  });
});

/* ======================================================== retain: the ghost */

describe('a retention that could not be written down did not happen', () => {
  it('publishes the object, fails the commit, and exposes no segment', async () => {
    /*
     * THE EXACT GHOST WINDOW. The bytes are in the archive and flushed; the
     * record naming them is not. An archive that had already updated its own
     * memory would answer `describe` with a segment the disk has never heard
     * of -- and would finalise a recording around it.
     */
    await keep();
    await archive.retainSegment(RUN.runId, segment(0));
    const before = await archive.describe(RUN.runId);
    const release = breakStateWrites();

    const ghost = await archive.retainSegment(RUN.runId, segment(1));
    expect(ghost.ok).toBe(false);
    if (ghost.ok) throw new Error('unreachable');
    expect(ghost.failure.reason).toBe('archive-unavailable');

    const after = await archive.describe(RUN.runId);
    expect(after?.segments).toHaveLength(1);
    expect(after?.bytes).toBe(before?.bytes);
    expect(after?.segments.map((s) => s.segmentId)).toEqual(
      before?.segments.map((s) => s.segmentId),
    );
    // The object really was published: that is what makes this the hard case.
    expect(listing('media')).toHaveLength(2);
    release();
  });

  it('cannot finalise around a segment the disk never recorded', async () => {
    await keep();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));
    const release = breakStateWrites();
    await archive.retainSegment(RUN.runId, segment(1));
    release();

    const finalised = await archive.finalise(RUN.runId);
    expect(finalised.ok).toBe(true);
    if (!finalised.ok) throw new Error('unreachable');
    // One segment, not two: the ghost is nowhere in the published recording.
    expect(finalised.value.segments).toHaveLength(1);
  });

  it('sweeps the orphan on restart and leaves the byte total alone', async () => {
    await keep();
    await archive.retainSegment(RUN.runId, segment(0));
    const before = await archive.describe(RUN.runId);
    const release = breakStateWrites();
    await archive.retainSegment(RUN.runId, segment(1));
    release();

    await restart();
    const after = await archive.describe(RUN.runId);
    expect(after?.segments).toHaveLength(1);
    expect(after?.bytes).toBe(before?.bytes);
    // The published-but-unnamed object was an orphan, and is gone.
    expect(listing('media')).toHaveLength(1);
    expect(corrupt).toEqual([]);
  });

  it('accepts the same segment cleanly on a later attempt', async () => {
    await keep();
    const later = segment(1);
    const release = breakStateWrites();
    await archive.retainSegment(RUN.runId, later);
    release();

    const retried = await archive.retainSegment(RUN.runId, later);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('unreachable');
    expect(retried.value.stored).toBe(true);
    expect(retried.value.segmentCount).toBe(1);
    expect(retried.value.bytes).toBe(later.bytes);
    expect((await archive.describe(RUN.runId))?.segments).toHaveLength(1);
  });

  it('does the same for initialisation material', async () => {
    await keep();
    const init = initialisation(0);
    const release = breakStateWrites();

    const ghost = await archive.retainInitialisation(RUN.runId, init);
    expect(ghost.ok).toBe(false);
    if (ghost.ok) throw new Error('unreachable');
    expect(ghost.failure.reason).toBe('archive-unavailable');
    expect((await archive.describe(RUN.runId))?.initialisations).toEqual([]);
    expect((await archive.describe(RUN.runId))?.bytes).toBe(0);

    release();
    await restart();
    expect((await archive.describe(RUN.runId))?.initialisations).toEqual([]);
    expect(listing('init')).toEqual([]);

    const retried = await archive.retainInitialisation(RUN.runId, init);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('unreachable');
    expect(retried.value.initialisationCount).toBe(1);
  });
});

/* ============================================================== finalisation */

describe('a finalisation that could not be written down did not happen', () => {
  it('leaves the run recording, never processing, never available', async () => {
    await keep();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));
    const release = breakStateWrites();

    const finalised = await archive.finalise(RUN.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('archive-unavailable');

    const held = await archive.describe(RUN.runId);
    expect(held?.status).toBe('recording');
    expect(held?.status).not.toBe('processing');
    expect(held?.status).not.toBe('available');
    expect(held?.history.map((h) => h.status)).toEqual(['recording']);
    expect(held?.finalisedAtMs).toBeNull();
    release();
  });

  it('still reads as recording after a restart, and finalises cleanly on retry', async () => {
    await keep();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));
    const release = breakStateWrites();
    await archive.finalise(RUN.runId);
    release();

    await restart();
    expect((await archive.describe(RUN.runId))?.status).toBe('recording');

    const retried = await archive.finalise(RUN.runId);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('unreachable');
    // Exactly one pass through processing, with nothing left over from the
    // attempt that died.
    expect(retried.value.history.map((h) => h.status)).toEqual([
      'recording',
      'processing',
      'available',
    ]);
  });
});

/* ===================================================================== fail */

describe('a failure that could not be written down did not happen', () => {
  it('leaves the previous durable state, and the restart agrees', async () => {
    await keep();
    await archive.retainSegment(RUN.runId, segment(0));
    const release = breakStateWrites();

    const failed = await archive.fail(RUN.runId, 'media-origin-failed', 'the encoder died');
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('unreachable');
    expect(failed.failure.reason).toBe('archive-unavailable');

    const held = await archive.describe(RUN.runId);
    expect(held?.status).toBe('recording');
    expect(held?.failure).toBeNull();

    release();
    await restart();
    const durable = await archive.describe(RUN.runId);
    expect(durable?.status).toBe('recording');
    expect(durable?.failure).toBeNull();
  });
});

/* ========================================================== expire and delete */

describe('a release that could not be written down did not happen', () => {
  it('leaves an expiring replay available, with its media still reachable', async () => {
    await expiring();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));
    await archive.finalise(RUN.runId);
    const before = await archive.describe(RUN.runId);
    const release = breakStateWrites();

    const expired = await archive.expire(RUN.runId, STARTED + THIRTY_DAYS_MS);
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error('unreachable');
    expect(expired.failure.reason).toBe('archive-unavailable');

    const held = await archive.describe(RUN.runId);
    expect(held?.status).toBe('available');
    expect(held?.segments).toHaveLength(1);
    expect(held?.bytes).toBe(before?.bytes);
    // THE PHYSICAL CLEANUP MUST NOT HAVE RUN. Bytes are released only after
    // the record that releases them is durable, or a crash between the two
    // leaves a recording pointing at media somebody has already deleted.
    expect(statSync(held?.segments[0]?.storageReference ?? '').size).toBe(
      held?.segments[0]?.bytes,
    );
    expect(listing('media')).toHaveLength(1);

    release();
    await restart();
    const durable = await archive.describe(RUN.runId);
    expect(durable?.status).toBe('available');
    expect(durable?.segments).toHaveLength(1);
  });

  it('leaves a deleted replay exactly as it was, media included', async () => {
    await keep();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));
    const before = await archive.describe(RUN.runId);
    const release = breakStateWrites();

    const deleted = await archive.delete(RUN.runId);
    expect(deleted.ok).toBe(false);
    if (deleted.ok) throw new Error('unreachable');
    expect(deleted.failure.reason).toBe('archive-unavailable');

    const held = await archive.describe(RUN.runId);
    expect(held?.status).toBe('recording');
    expect(held?.segments).toHaveLength(1);
    expect(held?.bytes).toBe(before?.bytes);
    expect(listing('media')).toHaveLength(1);
    expect(listing('init')).toHaveLength(1);

    release();
    await restart();
    const durable = await archive.describe(RUN.runId);
    expect(durable?.status).toBe('recording');
    expect(durable?.segments).toHaveLength(1);
    expect(durable?.bytes).toBe(before?.bytes);
  });

  it('still lets the delete succeed once the archive is writable again', async () => {
    await keep();
    await archive.retainSegment(RUN.runId, segment(0));
    const release = breakStateWrites();
    await archive.delete(RUN.runId);
    release();

    const deleted = await archive.delete(RUN.runId);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error('unreachable');
    expect(deleted.value.status).toBe('deleted');
    expect(deleted.value.segments).toEqual([]);
    expect(listing('media')).toEqual([]);
  });
});

/* ============================================================ the whole rule */

describe('the cache never runs ahead of the disk', () => {
  it('agrees with a freshly opened archive after every kind of failed write', async () => {
    /*
     * The rule stated once, over every mutating operation in turn: whatever
     * the archive says after a failed commit is exactly what a new process
     * reading the same directory would say.
     */
    await keep();
    await archive.retainInitialisation(RUN.runId, initialisation(0));
    await archive.retainSegment(RUN.runId, segment(0));

    const release = breakStateWrites();
    await archive.retainSegment(RUN.runId, segment(1));
    await archive.retainInitialisation(RUN.runId, initialisation(1));
    await archive.fail(RUN.runId, 'media-origin-failed', 'nope');
    await archive.finalise(RUN.runId);
    await archive.delete(RUN.runId);
    const cached = await archive.describe(RUN.runId);
    release();

    await restart();
    const durable = await archive.describe(RUN.runId);

    expect(cached?.status).toBe(durable?.status);
    expect(cached?.bytes).toBe(durable?.bytes);
    expect(cached?.segments.map((s) => s.segmentId)).toEqual(
      durable?.segments.map((s) => s.segmentId),
    );
    expect(cached?.initialisations.map((i) => i.generation)).toEqual(
      durable?.initialisations.map((i) => i.generation),
    );
    expect(cached?.history.map((h) => h.status)).toEqual(durable?.history.map((h) => h.status));
    expect(cached?.failure).toEqual(durable?.failure ?? null);
    expect(corrupt).toEqual([]);
  });
});
