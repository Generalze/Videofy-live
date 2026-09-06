/** @author masterzee001 */
/**
 * The last check between an authorisation and some bytes.
 *
 * WHY THIS SUITE IS NOT HTTP. The archive now diagnoses a tampered reference
 * when it opens -- which is the better place to find one -- so a request made
 * through the door never reaches the delivery adapter with a bad reference in
 * hand. That is the right behaviour and it would leave the last line of defence
 * completely untested, so it is tested here directly, as the thing it is: a
 * function given a logical object and a claim about where it lives.
 *
 * THE PROPERTY, stated once:
 *
 *     asked for run A / segment X
 *         ->  serves exactly run A / segment X's canonical archived object
 *         ->  or serves nothing
 *
 * Not "something inside the archive". Not "something inside run A". Every
 * fragment of a recording sits in one directory, so a reference edited to name
 * the NEXT fragment stays inside the run, is a real file written by this very
 * archive, and can be exactly the recorded length. The only thing wrong with it
 * is that it is not what was asked for.
 */
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import {
  FilesystemReplayArchive,
  replayInitialisationPath,
  replayRunDirectory,
  replaySegmentPath,
} from '@videofy-live/programme-replay/filesystem';
import {
  FilesystemReplayDelivery,
  type ReplayMediaLocator,
  type ReplayObjectOpening,
} from '../programme-replay-delivery.js';

const STARTED = 1_700_000_000_000;

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.length = 0;
});

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

interface Archive {
  readonly root: string;
  readonly spool: string;
  readonly delivery: FilesystemReplayDelivery;
  /** What the archive actually recorded for one fragment. */
  segment(runId: string, index: number): { reference: string; bytes: number; segmentId: string };
  initialisation(runId: string, generation: number): { reference: string; bytes: number };
}

/**
 * Two finished recordings, each with an init object and two fragments of
 * DIFFERENT lengths, plus a pair of equal length for the size-blind case.
 */
async function archived(): Promise<Archive> {
  const root = scratch('videofy-delivery-');
  const spool = scratch('videofy-delivery-spool-');
  const { archive } = await FilesystemReplayArchive.open(root, () => STARTED);

  const held = new Map<string, { reference: string; bytes: number; segmentId: string }>();
  const inits = new Map<string, { reference: string; bytes: number }>();

  for (const runId of ['run_1', 'run_2']) {
    const identity: ProgrammeRunIdentity = { channelId: 'ch_1', programmeId: 'prog_1', runId };
    await archive.begin({
      identity,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });

    const initSource = join(spool, `${runId}.init.mp4`);
    writeFileSync(initSource, Buffer.from(`INIT-${runId}-`.padEnd(96, '#')));
    await archive.retainInitialisation(runId, {
      runId,
      generation: 0,
      storageReference: initSource,
      bytes: statSync(initSource).size,
    });

    for (let index = 0; index < 3; index += 1) {
      const source = join(spool, `${runId}.seg${index}.m4s`);
      // Fragments 0 and 1 are the SAME length on purpose: a size check cannot
      // tell them apart, so only identity can.
      const width = index === 2 ? 200 : 160;
      writeFileSync(source, Buffer.from(`SECRET-${runId}-SEGMENT-${index}-`.padEnd(width, '.')));
      const segmentId = `${runId}.g0.${String(index).padStart(5, '0')}`;
      await archive.retainSegment(runId, {
        runId,
        segmentId,
        startProgrammeTimeMs: index * 2000,
        endProgrammeTimeMs: index * 2000 + 2000,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: source,
        bytes: statSync(source).size,
      });
    }
    const finalised = await archive.finalise(runId);
    if (!finalised.ok) throw new Error(`could not finalise ${runId}: ${finalised.failure.detail}`);

    const record = await archive.describe(runId);
    if (record === null) throw new Error('unreachable');
    for (const kept of record.segments) {
      held.set(kept.segmentId, {
        reference: kept.storageReference,
        bytes: kept.bytes,
        segmentId: kept.segmentId,
      });
    }
    const init = record.initialisations[0];
    if (init === undefined) throw new Error('unreachable');
    inits.set(runId, { reference: init.storageReference, bytes: init.bytes });
  }

  return {
    root,
    spool,
    delivery: new FilesystemReplayDelivery(root),
    segment: (runId, index) => {
      const entry = held.get(`${runId}.g0.${String(index).padStart(5, '0')}`);
      if (entry === undefined) throw new Error('unreachable');
      return entry;
    },
    initialisation: (runId) => {
      const entry = inits.get(runId);
      if (entry === undefined) throw new Error('unreachable');
      return entry;
    },
  };
}

function segmentLocator(
  runId: string,
  segmentId: string,
  reference: string,
  expectedBytes: number,
): ReplayMediaLocator {
  return { kind: 'segment', runId, segmentId, reference, expectedBytes };
}

async function bodyOf(opening: ReplayObjectOpening): Promise<string> {
  if (!opening.ok) throw new Error('unreachable');
  const chunks: Buffer[] = [];
  for await (const chunk of opening.object.stream(null)) chunks.push(Buffer.from(chunk));
  await opening.object.close();
  return Buffer.concat(chunks).toString('utf8');
}

/* ============================================================ the happy path */

describe('the object that was asked for', () => {
  it('serves a fragment from its canonical archive object', async () => {
    const archive = await archived();
    const wanted = archive.segment('run_1', 0);
    const opening = await archive.delivery.open(
      segmentLocator('run_1', wanted.segmentId, wanted.reference, wanted.bytes),
    );

    expect(opening.ok).toBe(true);
    expect(await bodyOf(opening)).toContain('SECRET-run_1-SEGMENT-0-');
  });

  it('serves initialisation material from its canonical archive object', async () => {
    const archive = await archived();
    const wanted = archive.initialisation('run_1', 0);
    const opening = await archive.delivery.open({
      kind: 'initialisation',
      runId: 'run_1',
      generation: 0,
      reference: wanted.reference,
      expectedBytes: wanted.bytes,
    });

    expect(opening.ok).toBe(true);
    expect(await bodyOf(opening)).toContain('INIT-run_1-');
  });

  it('records references that already ARE the canonical paths', async () => {
    // The archive and delivery derive the same path from the same helper, so
    // an untampered recording satisfies the check by construction.
    const archive = await archived();
    const wanted = archive.segment('run_1', 1);
    expect(wanted.reference).toBe(replaySegmentPath(archive.root, 'run_1', wanted.segmentId));
    expect(archive.initialisation('run_1', 0).reference).toBe(
      replayInitialisationPath(archive.root, 'run_1', 0),
    );
  });
});

/* ================================================ substitution within one run */

describe('one fragment is not another fragment', () => {
  it('refuses a reference naming a different fragment of the same recording', async () => {
    /*
     * THE CASE RUN-SCOPING LETS THROUGH. Same run, same directory, real file,
     * written by this archive -- and not the material that was authorised.
     */
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const other = archive.segment('run_1', 2);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, other.reference, other.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses it when both fragments are exactly the same length', async () => {
    // Fragments 0 and 1 were written to the same width on purpose: a size
    // check cannot tell them apart, so only identity can.
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const twin = archive.segment('run_1', 1);
    expect(asked.bytes).toBe(twin.bytes);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, twin.reference, asked.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a fragment request pointed at its own initialisation object', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const init = archive.initialisation('run_1', 0);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, init.reference, init.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses an initialisation request pointed at a fragment', async () => {
    const archive = await archived();
    const fragment = archive.segment('run_1', 0);

    const opening = await archive.delivery.open({
      kind: 'initialisation',
      runId: 'run_1',
      generation: 0,
      reference: fragment.reference,
      expectedBytes: fragment.bytes,
    });
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a reference naming the run state file', async () => {
    // A real file, inside the run's own directory, and not media at all.
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const state = join(replayRunDirectory(archive.root, 'run_1'), 'state.json');

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, state, statSync(state).size),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a generation that is not the one asked for', async () => {
    const archive = await archived();
    const init = archive.initialisation('run_1', 0);

    const opening = await archive.delivery.open({
      kind: 'initialisation',
      runId: 'run_1',
      generation: 1,
      reference: init.reference,
      expectedBytes: init.bytes,
    });
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });
});

/* ==================================================== substitution across runs */

describe('one recording is not another recording', () => {
  it('refuses a reference naming another run fragment', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const stolen = archive.segment('run_2', 0);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, stolen.reference, stolen.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a reference naming another run initialisation object', async () => {
    const archive = await archived();
    const stolen = archive.initialisation('run_2', 0);

    const opening = await archive.delivery.open({
      kind: 'initialisation',
      runId: 'run_1',
      generation: 0,
      reference: stolen.reference,
      expectedBytes: stolen.bytes,
    });
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a reference escaping the archive entirely', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const secret = join(archive.spool, 'secrets.env');
    writeFileSync(secret, Buffer.from('DATABASE_PASSWORD=hunter2'));

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, secret, statSync(secret).size),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
    expect(JSON.stringify(opening)).not.toContain('hunter2');
  });

  it('leaves the other recording servable', async () => {
    const archive = await archived();
    const wanted = archive.segment('run_2', 0);
    const opening = await archive.delivery.open(
      segmentLocator('run_2', wanted.segmentId, wanted.reference, wanted.bytes),
    );
    expect(opening.ok).toBe(true);
    expect(await bodyOf(opening)).toContain('SECRET-run_2-SEGMENT-0-');
  });
});

/* ================================================ links standing in the way */

describe('a link at the right name is still the wrong object', () => {
  it('refuses when the canonical leaf resolves somewhere else', async () => {
    /*
     * The reference IS the canonical path, so nothing about the string is
     * wrong. Only resolving the leaf shows that it is a link pointing at the
     * neighbouring fragment -- which is why the leaf is compared as an exact
     * resolved path rather than as a prefix.
     */
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const other = archive.segment('run_1', 2);
    const canonical = replaySegmentPath(archive.root, 'run_1', asked.segmentId);

    rmSync(canonical);
    try {
      symlinkSync(other.reference, canonical);
    } catch {
      // Unprivileged Windows processes cannot create a file symlink. The
      // directory-redirect case below covers the same rule.
      return;
    }

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, canonical, other.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses when the whole media folder has been redirected', async () => {
    /*
     * A junction where `media` should be. Every path under it still starts
     * with this run's directory, so a prefix test passes; the material comes
     * from somewhere else entirely.
     */
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const folder = join(replayRunDirectory(archive.root, 'run_1'), 'media');
    const elsewhere = join(replayRunDirectory(archive.root, 'run_2'), 'media');

    await rename(folder, `${folder}-moved`);
    try {
      symlinkSync(elsewhere, folder, 'junction');
    } catch {
      return;
    }

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, asked.reference, asked.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });
});

/* ============================================================ ordinary faults */

describe('material that is simply not right', () => {
  it('reports an object that has gone', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    rmSync(asked.reference);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, asked.reference, asked.bytes),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('not-found');
  });

  it('reports an object of the wrong length', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);

    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, asked.reference, asked.bytes + 1),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('byte-mismatch');
  });

  it('names no filesystem path in anything it reports', async () => {
    const archive = await archived();
    const asked = archive.segment('run_1', 0);
    const stolen = archive.segment('run_2', 0);
    const opening = await archive.delivery.open(
      segmentLocator('run_1', asked.segmentId, stolen.reference, stolen.bytes),
    );

    const reported = JSON.stringify(opening);
    expect(reported).not.toContain(archive.root);
    expect(reported).not.toContain(archive.spool);
    expect(reported).not.toContain('.bin');
  });
});
