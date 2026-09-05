/** @author masterzee001 */
/**
 * Does the archive actually own the bytes, and does it still own them tomorrow?
 *
 * The conformance suite already proves this implementation keeps the same
 * promises as every other. What is left is everything that only means anything
 * once there is a disk: that retention COPIES rather than remembers a path,
 * that a recording survives the process, that a crash cannot leave metadata
 * pointing at media nobody wrote, and that damage is reported rather than
 * quietly worked around.
 *
 * THE CENTRAL TEST is the one that deletes the live spool. Everything else in
 * this file exists to make that one trustworthy.
 */
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import {
  FilesystemReplayArchive,
  REPLAY_ARCHIVE_SCHEMA_VERSION,
  type CorruptReplayRun,
} from './filesystem-archive.js';
import type { ReplayInitialisation } from './media.js';

const STARTED = 1_700_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_A: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_a' };
const RUN_B: ProgrammeRunIdentity = { channelId: 'main', programmeId: 'news', runId: 'run_b' };

function keyOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let root: string;
let spool: string;
let archive: FilesystemReplayArchive;
let corrupt: readonly CorruptReplayRun[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'videofy-fs-archive-'));
  spool = mkdtempSync(join(tmpdir(), 'videofy-fs-spool-'));
  ({ archive, corrupt } = await FilesystemReplayArchive.open(root, () => STARTED));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(spool, { recursive: true, force: true });
});

/** Reopen the same archive root: everything a restart does, and nothing else. */
async function restart(now: () => number = () => STARTED): Promise<void> {
  ({ archive, corrupt } = await FilesystemReplayArchive.open(root, now));
}

function sourceFile(name: string, body: string): string {
  const path = join(spool, name);
  writeFileSync(path, Buffer.from(body));
  return path;
}

function segment(index: number, overrides: Partial<ProgrammeMediaSegment> = {}): ProgrammeMediaSegment {
  const runId = overrides.runId ?? RUN_A.runId;
  const name = `${runId}.g0.${String(index).padStart(5, '0')}.m4s`;
  const path = sourceFile(name, `SEGMENT-${name}`.padEnd(128, '.'));
  return {
    runId,
    segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
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
  return {
    runId: RUN_A.runId,
    generation,
    storageReference: path,
    bytes: statSync(path).size,
  };
}

async function keep(identity = RUN_A): Promise<void> {
  const begun = await archive.begin({
    identity,
    retention: { policy: 'keep' },
    visibility: 'private',
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);
}

function runDirectory(runId = RUN_A.runId): string {
  return join(root, 'runs', keyOf(runId));
}

function listing(folder: string, runId = RUN_A.runId): readonly string[] {
  try {
    return readdirSync(join(runDirectory(runId), folder));
  } catch {
    return [];
  }
}

function persisted(runId = RUN_A.runId): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDirectory(runId), 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/* ================================================================ ownership */

describe('a successful retention means the archive owns the bytes', () => {
  it('copies the initialisation material into its own root', async () => {
    await keep();
    const init = initialisation(0);
    const kept = await archive.retainInitialisation(RUN_A.runId, init);
    expect(kept.ok).toBe(true);

    const held = await archive.describe(RUN_A.runId);
    const reference = held?.initialisations[0]?.storageReference ?? '';
    expect(reference.startsWith(root)).toBe(true);
    expect(reference).not.toBe(init.storageReference);
    expect(readFileSync(reference)).toEqual(readFileSync(init.storageReference));
  });

  it('copies the segment into its own root', async () => {
    await keep();
    const only = segment(0);
    await archive.retainSegment(RUN_A.runId, only);

    const held = await archive.describe(RUN_A.runId);
    const reference = held?.segments[0]?.storageReference ?? '';
    expect(reference.startsWith(root)).toBe(true);
    expect(reference).not.toBe(only.storageReference);
    expect(readFileSync(reference)).toEqual(readFileSync(only.storageReference));
    expect(listing('media')).toHaveLength(1);
  });

  it('keeps the whole recording after the live spool is destroyed', async () => {
    /*
     * THE POINT OF THE WHOLE WAVE. The spool prunes as the audience advances
     * and is released when the broadcast ends. An archive that stored the
     * spool's path would be an archive of dead links, and would find out weeks
     * later, from a viewer.
     */
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.retainSegment(RUN_A.runId, segment(1));

    rmSync(spool, { recursive: true, force: true });

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(true);
    if (!finalised.ok) throw new Error('unreachable');
    expect(finalised.value.status).toBe('available');
    for (const held of finalised.value.segments) {
      expect(statSync(held.storageReference).size).toBe(held.bytes);
    }
  });

  it('survives the spool being destroyed AND the process restarting', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    rmSync(spool, { recursive: true, force: true });

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('available');
    expect(held?.segments).toHaveLength(1);
    expect(statSync(held?.segments[0]?.storageReference ?? '').size).toBe(
      held?.segments[0]?.bytes,
    );
  });

  it('refuses when the source is already gone', async () => {
    await keep();
    const only = segment(0);
    rmSync(only.storageReference);

    const kept = await archive.retainSegment(RUN_A.runId, only);
    expect(kept.ok).toBe(false);
    if (kept.ok) throw new Error('unreachable');
    expect(kept.failure.reason).toBe('source-media-unavailable');
    // Not archive-unavailable: the store was fine, the material was not.
    expect(kept.failure.reason).not.toBe('archive-unavailable');
    expect((await archive.describe(RUN_A.runId))?.segments).toEqual([]);
    expect(listing('media')).toEqual([]);
  });

  it('refuses material whose size is not what was declared', async () => {
    /*
     * The producer's metadata is authoritative for what a fragment IS. A copy
     * of a different length is not a smaller segment; it is one that was still
     * being written, or truncated, or a different file altogether. Recording
     * whatever arrived would make the archive's byte totals a fiction.
     */
    await keep();
    const only = segment(0);
    const kept = await archive.retainSegment(RUN_A.runId, { ...only, bytes: only.bytes + 10 });

    expect(kept.ok).toBe(false);
    if (kept.ok) throw new Error('unreachable');
    expect(kept.failure.reason).toBe('source-media-unavailable');
    expect(kept.failure.detail).toContain('yielded');
    expect((await archive.describe(RUN_A.runId))?.segments).toEqual([]);
  });

  it('leaves no partial copy behind when it refuses', async () => {
    await keep();
    const only = segment(0);
    await archive.retainSegment(RUN_A.runId, { ...only, bytes: only.bytes + 10 });

    expect(listing('tmp')).toEqual([]);
    expect(listing('media')).toEqual([]);
    expect(persisted()['segments']).toEqual([]);
  });

  it('records the byte count the producer declared, exactly', async () => {
    await keep();
    const init = initialisation(0);
    const first = segment(0);
    await archive.retainInitialisation(RUN_A.runId, init);
    await archive.retainSegment(RUN_A.runId, first);

    const held = await archive.describe(RUN_A.runId);
    expect(held?.bytes).toBe(init.bytes + first.bytes);
    expect(held?.segments[0]?.bytes).toBe(first.bytes);
    expect(statSync(held?.segments[0]?.storageReference ?? '').size).toBe(first.bytes);
  });
});

/* ================================================================== restart */

describe('a recording outlives the process that made it', () => {
  it('restores a run that was still recording, and carries on', async () => {
    // A restart is not an ending. Nothing here finalises anything on the way in.
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('recording');
    expect(held?.segments).toHaveLength(1);

    const later = await archive.retainSegment(RUN_A.runId, segment(1));
    expect(later.ok).toBe(true);
    expect((await archive.describe(RUN_A.runId))?.segments).toHaveLength(2);
  });

  it('restores identity, retention, visibility and byte totals', async () => {
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
      visibility: 'unlisted',
      startedAtMs: STARTED,
    });
    const init = initialisation(0);
    const first = segment(0);
    await archive.retainInitialisation(RUN_A.runId, init);
    await archive.retainSegment(RUN_A.runId, first);

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.identity).toEqual(RUN_A);
    expect(held?.retention).toEqual({ policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS });
    expect(held?.expiresAtMs).toBe(STARTED + THIRTY_DAYS_MS);
    expect(held?.visibility).toBe('unlisted');
    expect(held?.bytes).toBe(init.bytes + first.bytes);
    expect(held?.startedAtMs).toBe(STARTED);
  });

  it('restores an available recording, with its history intact', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('available');
    expect(held?.finalisedAtMs).toBe(STARTED);
    expect(held?.history.map((h) => h.status)).toEqual(['recording', 'processing', 'available']);
  });

  it('restores a failed recording, with its reason', async () => {
    await keep();
    await archive.fail(RUN_A.runId, 'media-origin-failed', 'the encoder died mid-programme');

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('failed');
    expect(held?.failure?.reason).toBe('media-origin-failed');
    expect(held?.failure?.detail).toContain('the encoder died');
    expect(held?.failure?.liveImpact).toBe('none');
  });

  it('restores an expired recording, still holding nothing', async () => {
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'expire', expiresAtMs: STARTED + THIRTY_DAYS_MS },
      visibility: 'private',
      startedAtMs: STARTED,
    });
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);
    await archive.expire(RUN_A.runId, STARTED + THIRTY_DAYS_MS);

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('expired');
    expect(held?.segments).toEqual([]);
    expect(held?.bytes).toBe(0);
  });

  it('restores a deleted recording, and does not bring its media back', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.delete(RUN_A.runId);

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('deleted');
    expect(held?.segments).toEqual([]);
    // The physical cleanup happened, or was resumed by the reopen.
    expect(listing('media')).toEqual([]);
    expect(listing('init')).toEqual([]);
  });

  it('remembers that a run was configured to keep nothing', async () => {
    await archive.begin({
      identity: RUN_A,
      retention: { policy: 'none' },
      visibility: 'private',
      startedAtMs: STARTED,
    });

    await restart();
    expect(await archive.describe(RUN_A.runId)).toBeNull();

    const offered = await archive.retainSegment(RUN_A.runId, segment(0));
    expect(offered.ok).toBe(false);
    if (offered.ok) throw new Error('unreachable');
    // Not `unknown-replay`: the operator chose this, and those call for
    // opposite responses from whatever is watching.
    expect(offered.failure.reason).toBe('policy-forbids-replay');

    const init = await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    expect(init.ok).toBe(false);
    if (init.ok) throw new Error('unreachable');
    expect(init.failure.reason).toBe('policy-forbids-replay');
  });

  it('keeps generation associations across a restart', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainInitialisation(RUN_A.runId, initialisation(1));
    await archive.retainSegment(RUN_A.runId, segment(0, { initGeneration: 0 }));
    await archive.retainSegment(
      RUN_A.runId,
      segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
    );

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.initialisations.map((i) => i.generation).sort()).toEqual([0, 1]);
    expect(held?.segments.map((s) => s.initGeneration)).toEqual([0, 1]);

    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(true);
  });

  it('still refuses to publish a recording missing a generation, after a restart', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(
      RUN_A.runId,
      segment(1, { initGeneration: 1, segmentId: 'run_a.g1.00000' }),
    );

    await restart();
    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
    if (finalised.ok) throw new Error('unreachable');
    expect(finalised.failure.reason).toBe('initialisation-missing');
    expect((await archive.describe(RUN_A.runId))?.status).toBe('failed');
  });
});

/* ================================================ duplicates across restart */

describe('a retry after a restart is still just a retry', () => {
  it('absorbs the exact same segment without a second object or second bytes', async () => {
    await keep();
    const only = segment(0);
    const first = await archive.retainSegment(RUN_A.runId, only);
    if (!first.ok) throw new Error('unreachable');

    await restart();
    const again = await archive.retainSegment(RUN_A.runId, only);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.value.stored).toBe(false);
    expect(again.value.segmentCount).toBe(1);
    expect(again.value.bytes).toBe(first.value.bytes);
    expect(listing('media')).toHaveLength(1);
    expect((await archive.describe(RUN_A.runId))?.bytes).toBe(first.value.bytes);
  });

  it('absorbs the exact same initialisation the same way', async () => {
    await keep();
    const init = initialisation(0);
    await archive.retainInitialisation(RUN_A.runId, init);

    await restart();
    const again = await archive.retainInitialisation(RUN_A.runId, init);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.value.stored).toBe(false);
    expect(again.value.initialisationCount).toBe(1);
    expect(listing('init')).toHaveLength(1);
  });

  it('still calls a changed segment a conflict after a restart', async () => {
    /*
     * The comparison is against what was OFFERED, which is why the offered
     * reference is persisted alongside the archive's own. Comparing against
     * the archive path would make every ordinary retry look like a conflict.
     */
    await keep();
    const original = segment(0);
    await archive.retainSegment(RUN_A.runId, original);

    await restart();
    const conflicting = await archive.retainSegment(RUN_A.runId, {
      ...original,
      storageReference: sourceFile('rival.m4s', 'RIVAL'.padEnd(128, '~')),
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('segment-conflict');
    expect(listing('media')).toHaveLength(1);
  });

  it('still calls a changed initialisation a conflict after a restart', async () => {
    await keep();
    const original = initialisation(3);
    await archive.retainInitialisation(RUN_A.runId, original);

    await restart();
    const conflicting = await archive.retainInitialisation(RUN_A.runId, {
      ...original,
      storageReference: sourceFile('rival-init.mp4', 'RIVAL'.padEnd(48, '#')),
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.reason).toBe('initialisation-conflict');
    expect(listing('init')).toHaveLength(1);
  });
});

/* =========================================================== crash windows */

describe('what a crash may and may not leave behind', () => {
  it('never lets metadata name media that was not published first', async () => {
    // The ordering rule, read straight off the disk: everything the state
    // references exists, and is the size the state says.
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.retainSegment(RUN_A.runId, segment(1));

    const state = persisted();
    const entries = [
      ...(state['segments'] as { archiveReference: string; offered: { bytes: number } }[]),
      ...(state['initialisations'] as { archiveReference: string; offered: { bytes: number } }[]),
    ];
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(statSync(entry.archiveReference).size).toBe(entry.offered.bytes);
    }
  });

  it('sweeps a copy that died before it was published', async () => {
    // A temporary file is a copy that never finished and can never become
    // anything else.
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    writeFileSync(join(runDirectory(), 'tmp', 'abandoned.part'), Buffer.from('HALF'));
    expect(listing('tmp')).toHaveLength(1);

    await restart();
    expect(listing('tmp')).toEqual([]);
    expect((await archive.describe(RUN_A.runId))?.segments).toHaveLength(1);
  });

  it('treats a published object nothing references as a safe orphan', async () => {
    /*
     * The other side of the ordering rule: an object made durable just before
     * the process died, whose metadata never landed. The record is the
     * authority, so the object is swept -- and never mistaken for media.
     */
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    writeFileSync(join(runDirectory(), 'media', `${'0'.repeat(64)}.bin`), Buffer.from('ORPHAN'));
    expect(listing('media')).toHaveLength(2);

    await restart();
    expect(listing('media')).toHaveLength(1);
    const held = await archive.describe(RUN_A.runId);
    expect(held?.segments).toHaveLength(1);
    expect(held?.status).toBe('recording');
  });

  it('resumes a physical cleanup that a crash interrupted', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.delete(RUN_A.runId);

    // As if the process had died between the state being written and the files
    // being removed.
    writeFileSync(join(runDirectory(), 'media', `${'1'.repeat(64)}.bin`), Buffer.from('LEFTOVER'));

    await restart();
    expect(listing('media')).toEqual([]);
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('deleted');
    expect(held?.segments).toEqual([]);
  });

  it('does not resurrect a deleted recording because files were left behind', async () => {
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.delete(RUN_A.runId);
    writeFileSync(join(runDirectory(), 'media', `${'2'.repeat(64)}.bin`), Buffer.from('GARBAGE'));

    await restart();
    const held = await archive.describe(RUN_A.runId);
    expect(held?.status).toBe('deleted');
    expect(held?.status).not.toBe('available');
    const finalised = await archive.finalise(RUN_A.runId);
    expect(finalised.ok).toBe(false);
  });

  it('does not append a second processing when finalisation is retried', async () => {
    // Nothing intermediate is ever persisted, so a finalisation that died
    // leaves the run exactly as it was and the retry reads correctly.
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));

    await restart();
    await archive.finalise(RUN_A.runId);
    await restart();

    const held = await archive.describe(RUN_A.runId);
    expect(held?.history.map((h) => h.status)).toEqual(['recording', 'processing', 'available']);
    const again = await archive.finalise(RUN_A.runId);
    expect(again.ok).toBe(false);
    expect((await archive.describe(RUN_A.runId))?.history).toHaveLength(3);
  });
});

/* ============================================================== corruption */

describe('damage is reported, never worked around', () => {
  it('refuses a run whose state will not parse', async () => {
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    writeFileSync(join(runDirectory(), 'state.json'), '{ this is not json');

    await restart();
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.runKey).toBe(keyOf(RUN_A.runId));
    expect(corrupt[0]?.reason).toContain('could not be read');
    expect(await archive.describe(RUN_A.runId)).toBeNull();

    const offered = await archive.retainSegment(RUN_A.runId, segment(1));
    expect(offered.ok).toBe(false);
    if (offered.ok) throw new Error('unreachable');
    expect(offered.failure.reason).toBe('archive-unavailable');
  });

  it('refuses a run written by a schema this build does not know', async () => {
    await keep();
    const state = persisted();
    state['schemaVersion'] = REPLAY_ARCHIVE_SCHEMA_VERSION + 99;
    writeFileSync(join(runDirectory(), 'state.json'), JSON.stringify(state));

    await restart();
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.reason).toContain('unsupported schemaVersion');
    // The run id survives even a refusal, because it was still readable.
    expect(corrupt[0]?.runId).toBe(RUN_A.runId);
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });

  it('refuses a run whose media has gone missing underneath it', async () => {
    await keep();
    await archive.retainInitialisation(RUN_A.runId, initialisation(0));
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.finalise(RUN_A.runId);

    const held = await archive.describe(RUN_A.runId);
    rmSync(held?.segments[0]?.storageReference ?? '');

    await restart();
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.reason).toContain('not intact');
    // Never silently available with a fragment nobody has.
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });

  it('refuses a run whose media is the wrong size', async () => {
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    const held = await archive.describe(RUN_A.runId);
    truncateSync(held?.segments[0]?.storageReference ?? '', 4);

    await restart();
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.reason).toContain('bytes');
    expect(await archive.describe(RUN_A.runId)).toBeNull();
  });

  it('does not let one damaged run poison another', async () => {
    await keep(RUN_A);
    await keep(RUN_B);
    await archive.retainSegment(RUN_A.runId, segment(0));
    await archive.retainSegment(
      RUN_B.runId,
      segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' }),
    );
    writeFileSync(join(runDirectory(RUN_A.runId), 'state.json'), 'broken');

    await restart();
    expect(corrupt).toHaveLength(1);
    expect(await archive.describe(RUN_A.runId)).toBeNull();

    // The healthy broadcast is entirely unaffected.
    const healthy = await archive.describe(RUN_B.runId);
    expect(healthy?.status).toBe('recording');
    expect(healthy?.segments).toHaveLength(1);
    const more = await archive.retainSegment(
      RUN_B.runId,
      segment(1, { runId: RUN_B.runId, segmentId: 'run_b.g0.00001' }),
    );
    expect(more.ok).toBe(true);
  });

  it('does not sweep the files of a run it could not read', async () => {
    // Sweeping against metadata that cannot be trusted would turn a
    // diagnosable problem into a destroyed recording.
    await keep();
    await archive.retainSegment(RUN_A.runId, segment(0));
    expect(listing('media')).toHaveLength(1);
    writeFileSync(join(runDirectory(), 'state.json'), 'broken');

    await restart();
    expect(listing('media')).toHaveLength(1);
  });
});

/* ============================================================= concurrency */

describe('two callers, one archive', () => {
  it('turns simultaneous identical segment offers into one object', async () => {
    await keep();
    const only = segment(0);
    const [first, second] = await Promise.all([
      archive.retainSegment(RUN_A.runId, only),
      archive.retainSegment(RUN_A.runId, only),
    ]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect([first.value.stored, second.value.stored].sort()).toEqual([false, true]);
    expect(listing('media')).toHaveLength(1);
    const held = await archive.describe(RUN_A.runId);
    expect(held?.segments).toHaveLength(1);
    expect(held?.bytes).toBe(only.bytes);
  });

  it('turns simultaneous identical initialisation offers into one object', async () => {
    await keep();
    const init = initialisation(0);
    const [first, second] = await Promise.all([
      archive.retainInitialisation(RUN_A.runId, init),
      archive.retainInitialisation(RUN_A.runId, init),
    ]);

    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect([first.value.stored, second.value.stored].sort()).toEqual([false, true]);
    expect(listing('init')).toHaveLength(1);
    expect((await archive.describe(RUN_A.runId))?.initialisations).toHaveLength(1);
  });

  it('keeps one run in order without holding another one up', async () => {
    /*
     * One chain per run, never one for the archive. A single global lock would
     * let one slow copy stall the recording of every other programme on the
     * box, which on a busy host is every broadcast waiting for the unluckiest.
     */
    await keep(RUN_A);
    await keep(RUN_B);

    const finished: string[] = [];
    const slow = Array.from({ length: 12 }, (_, index) =>
      archive
        .retainSegment(RUN_A.runId, segment(index))
        .then(() => finished.push(`a${index}`)),
    );
    const quick = archive
      .retainSegment(RUN_B.runId, segment(0, { runId: RUN_B.runId, segmentId: 'run_b.g0.00000' }))
      .then(() => finished.push('b'));

    await Promise.all([...slow, quick]);

    // Run B did not have to wait for all twelve of run A's copies.
    expect(finished.indexOf('b')).toBeLessThan(finished.indexOf('a11'));
    // And run A kept its own order.
    const held = await archive.describe(RUN_A.runId);
    expect(held?.segments.map((s) => s.startProgrammeTimeMs)).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 2000),
    );
  });
});
