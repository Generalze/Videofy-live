/** @author masterzee001 */
/**
 * A restart brings back the promise. It has to bring back the material too.
 *
 * The journal survives, so a recovered broadcast knows precisely what it
 * published and how far behind its audience is. The media store is held in
 * memory and came back empty -- so the manifest was well formed, listed
 * nothing, reported a correct cursor, and served an audience silence for the
 * rest of the programme behind an entirely green console. "The safety buffer
 * survives a restart" was half true: the promise survived and the material did
 * not.
 *
 * AND THE TWO ABSENCES ARE DIFFERENT. A segment missing because the packager
 * has not closed it yet arrives on the next poll. A segment the timeline
 * already REFERENCES and that is not on the volume was published to somebody
 * and is gone. Both are ENOENT at the system call; only one of them is a fault.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generationOf,
  recoverProgrammeMedia,
  requiredMediaFromMs,
  segmentFileName,
} from '../programme-media-recovery.js';
import { ProgrammeMediaStore } from '../programme-media-store.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { JournalTimelineStore } from '../journal-timeline-store.js';
import { ProgrammeEgressAuthority } from '../programme-egress.js';
import { retentionWindowMs, type ProgrammeTimelineEvent } from '@videofy-live/programme-timeline';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };
const DELAY_MS = 20_000;
const SEGMENT_MS = 2_000;

function mediaEvent(index: number): ProgrammeTimelineEvent {
  return {
    runId: 'run_1',
    sequence: index + 1,
    programmeTimeMs: index * SEGMENT_MS,
    kind: 'media',
    reference: `run_1.g0.${String(index).padStart(5, '0')}`,
    durationMs: SEGMENT_MS,
    attributes: {},
  };
}

/** A spool holding real bytes for the segments a timeline names. */
function spoolWith(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'videofy-recover-'));
  mkdirSync(join(root, 'run_1'), { recursive: true });
  writeFileSync(join(root, 'run_1', 'init.0.mp4'), Buffer.from('INIT'));
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(root, 'run_1', `seg_g0_${String(i).padStart(5, '0')}.m4s`),
      Buffer.from(`SEGMENT-${i}`.padEnd(64, '.')),
    );
  }
  return root;
}

describe('the id a file is named by', () => {
  it('maps a segment id to the file the packager wrote', () => {
    // Two spellings of one convention is how a recovery quietly finds nothing.
    expect(segmentFileName('run_1.g0.00007')).toBe('seg_g0_00007.m4s');
    expect(segmentFileName('run_1.g2.00113')).toBe('seg_g2_00113.m4s');
    expect(generationOf('run_1.g2.00113')).toBe(2);
  });

  it('refuses an id it cannot map rather than guessing a path', () => {
    expect(segmentFileName('not-a-segment')).toBeNull();
  });
});

describe('putting the retained media back', () => {
  it('restores every segment the timeline references', async () => {
    const root = spoolWith(5);
    const media = new ProgrammeMediaStore();
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1, 2, 3, 4].map(mediaEvent),
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    expect(outcome.restored).toBe(5);
    expect(outcome.missing).toEqual([]);
    expect(media.segmentCount('run_1')).toBe(5);
  });

  it('restores them at the programme times the timeline recorded', async () => {
    const root = spoolWith(3);
    const media = new ProgrammeMediaStore();
    await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1, 2].map(mediaEvent),
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    // Not renumbered from zero: a recovered segment belongs where it was
    // broadcast, or every caption and advert around it points at the wrong
    // moment.
    const held = media.throughCursor('run_1', 6_000, 0);
    expect(held.available).toBe(true);
    if (!held.available) throw new Error('unreachable');
    expect(held.segments.map((s) => s.startProgrammeTimeMs)).toEqual([0, 2000, 4000]);
  });

  it('reports the init generations the restored window still needs', async () => {
    const root = spoolWith(2);
    const media = new ProgrammeMediaStore();
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1].map(mediaEvent),
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    // A fragment whose init is not registered is a fragment nothing can
    // decode, so recovery has to say which ones matter.
    expect(outcome.generations).toEqual([0]);
  });

  it('leaves orphans on the spool rather than resurrecting them', async () => {
    const root = spoolWith(5);
    const media = new ProgrammeMediaStore();
    // The write ordering deliberately fails towards orphans: media made
    // durable and never referenced. They are not part of the broadcast.
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1].map(mediaEvent),
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    expect(outcome.restored).toBe(2);
    expect(media.segmentCount('run_1')).toBe(2);
  });
});

describe('media the broadcast published and can no longer serve', () => {
  it('names a referenced segment that is not on the volume', async () => {
    const root = spoolWith(4);
    rmSync(join(root, 'run_1', 'seg_g0_00002.m4s'));
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1, 2, 3].map(mediaEvent),
      media: new ProgrammeMediaStore(),
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    /*
     * The distinction that matters. Absent because the packager is still
     * closing it is a moment old; absent when the timeline already references
     * it means it was published to somebody and is gone.
     */
    expect(outcome.missing).toEqual(['run_1.g0.00002']);
  });

  it('treats a present but empty file as missing', async () => {
    const root = spoolWith(3);
    writeFileSync(join(root, 'run_1', 'seg_g0_00001.m4s'), Buffer.alloc(0));
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [0, 1, 2].map(mediaEvent),
      media: new ProgrammeMediaStore(),
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    // Zero length is what a truncated write leaves behind, and offering it
    // hands a player something it cannot decode.
    expect(outcome.missing).toEqual(['run_1.g0.00001']);
  });
});

describe('what a recovered run does about it', () => {
  /*
   * Thirty segments is sixty seconds of programme against a twenty-second
   * delay, so the cursor has genuinely released material. Six segments would
   * have been entirely inside the delay -- an empty manifest would then be
   * correct, and the test would have proved nothing about recovery.
   */
  const SEGMENTS = 30;

  async function recoveredRun(options: { readonly removeIndex?: number }) {
    const root = spoolWith(SEGMENTS);
    if (options.removeIndex !== undefined) {
      rmSync(join(root, 'run_1', `seg_g0_${String(options.removeIndex).padStart(5, '0')}.m4s`));
    }
    const directory = mkdtempSync(join(tmpdir(), 'videofy-journal-'));
    const store = new JournalTimelineStore({ directory });
    const all = Array.from({ length: SEGMENTS }, (_unused, index) => mediaEvent(index));
    for (const event of all) await store.append(event);
    await store.flush('run_1');

    const media = new ProgrammeMediaStore();
    const registry = new ProgrammeTimelineRegistry(32, DELAY_MS, undefined, store, {
      metadata: true,
      media: true,
    });
    const egress = new ProgrammeEgressAuthority(registry, media);
    registry.onRecovered(async (runId, events) => {
      const outcome = await recoverProgrammeMedia({
        runId,
        directory: join(root, 'run_1'),
        events,
        media,
        publicOutputTimeMs: Math.max(0, registry.status(runId)?.cursor.publicOutputTimeMs ?? 0),
        configuredDelayMs: DELAY_MS,
      });
      for (const generation of outcome.generations) {
        egress.noteInitSegment(runId, join(root, 'run_1', 'init.0.mp4'), generation);
      }
      return { missing: outcome.missing };
    });
    await registry.recover(RUN);
    return { registry, media, egress };
  }

  it('can serve the recovered window again', async () => {
    const { registry, media, egress } = await recoveredRun({});
    registry.buffer('run_1')?.advance();
    expect(media.segmentCount('run_1')).toBe(SEGMENTS);

    const manifest = egress.manifest('run_1');
    expect(manifest.available).toBe(true);
    if (!manifest.available) throw new Error('unreachable');
    /*
     * The half that was missing. Before recovery restored the media this
     * manifest was well formed, listed nothing, and reported a correct cursor
     * -- an audience served silence behind an entirely green console.
     */
    expect(manifest.segments.length).toBeGreaterThan(0);
  });

  it('stops the broadcast when published media did not come back', async () => {
    const { registry } = await recoveredRun({ removeIndex: 2 });
    /*
     * Continuing would offer a window with a hole in it, and a viewer who
     * reconnected into that hole would simply stall with nothing to blame.
     */
    expect(registry.status('run_1')?.state).toBe('failed');
    expect(registry.status('run_1')?.detail).toContain('retained media is missing');
  });
});

describe('history the retention policy was entitled to delete', () => {
  /*
   * THE BOUNDARY THIS TYPE EXISTS FOR. A six-hour programme's journal
   * remembers hour one; the spool is required to hold minutes. A recovery that
   * demanded every reference ever written would fail on the first restart of
   * any long broadcast -- for material that was correctly deleted hours
   * earlier, by the very policy that is supposed to keep the disk from
   * filling.
   */
  it('does not miss material older than the window the run still owes', async () => {
    const root = spoolWith(0);
    // Two hours of programme in the journal, nothing on the spool.
    const events = Array.from({ length: 60 }, (_unused, index) => mediaEvent(index));
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events,
      media: new ProgrammeMediaStore(),
      // The audience is far past all of it.
      publicOutputTimeMs: 10_000_000,
      configuredDelayMs: DELAY_MS,
    });
    expect(outcome.missing).toEqual([]);
    expect(outcome.expired).toBe(60);
  });

  it('draws the boundary with the same function retention prunes by', async () => {
    /*
     * Two independent definitions of one boundary would disagree the first
     * time either was tuned, and the disagreement would present as a broadcast
     * that fails to recover for no visible reason.
     */
    const cursor = 600_000;
    expect(requiredMediaFromMs(cursor, DELAY_MS)).toBe(
      cursor - retentionWindowMs(DELAY_MS),
    );
  });

  it('still requires everything inside the window, published or not', async () => {
    const root = spoolWith(0);
    const cursor = 600_000;
    const from = requiredMediaFromMs(cursor, DELAY_MS);
    // One segment just inside the window, and one after the cursor: material
    // the audience has not reached yet but will in seconds.
    const inside: ProgrammeTimelineEvent = { ...mediaEvent(0), programmeTimeMs: from + 1_000 };
    const future: ProgrammeTimelineEvent = {
      ...mediaEvent(1),
      programmeTimeMs: cursor + 10_000,
    };
    const outcome = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events: [inside, future],
      media: new ProgrammeMediaStore(),
      publicOutputTimeMs: cursor,
      configuredDelayMs: DELAY_MS,
    });
    /*
     * A restart that recovered only what was already public would restore the
     * current manifest and then run out of programme the moment the cursor
     * advanced.
     */
    expect(outcome.missing).toHaveLength(2);
    expect(outcome.expired).toBe(0);
  });
});

describe('recovery can be run twice', () => {
  it('rebuilds an index rather than adding a broadcast', async () => {
    const root = spoolWith(4);
    const media = new ProgrammeMediaStore();
    const events = [0, 1, 2, 3].map(mediaEvent);
    const once = await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events,
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    await recoverProgrammeMedia({
      runId: 'run_1',
      directory: join(root, 'run_1'),
      events,
      media,
      publicOutputTimeMs: 0,
      configuredDelayMs: DELAY_MS,
    });
    // A retried start would otherwise hold every segment twice, double every
    // retention calculation and offer each fragment to a player twice.
    expect(once.restored).toBe(4);
    expect(media.segmentCount('run_1')).toBe(4);
  });
});

describe('the corruption cases, each answered differently', () => {
  const recover = (root: string, count: number, publicOutputTimeMs = count * SEGMENT_MS) =>
    recoverProgrammeMedia({
      runId: RUN.runId,
      directory: join(root, 'run_1'),
      events: Array.from({ length: count }, (_, index) => mediaEvent(index)),
      media: new ProgrammeMediaStore(),
      publicOutputTimeMs,
      configuredDelayMs: DELAY_MS,
    });

  it('FAILS WHEN A REQUIRED INITIALISATION OBJECT IS GONE', async () => {
    /*
     * Every fragment of a generation decodes only with that generation's init.
     * A window whose fragments all came back and whose init did not is not a
     * recovered window; it is a set of files no player can open -- and
     * recovery used to report it as entirely restored.
     */
    const root = spoolWith(4);
    rmSync(join(root, 'run_1', 'init.0.mp4'));
    const outcome = await recover(root, 4);
    expect(outcome.restored).toBe(4);
    expect(outcome.missingInits).toEqual([0]);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails on an initialisation object truncated to nothing', async () => {
    // What a power loss mid-write leaves. Present, and useless.
    const root = spoolWith(4);
    writeFileSync(join(root, 'run_1', 'init.0.mp4'), Buffer.alloc(0));
    const outcome = await recover(root, 4);
    expect(outcome.missingInits).toEqual([0]);
    rmSync(root, { recursive: true, force: true });
  });

  it('is content when the init is present and has bytes', async () => {
    const root = spoolWith(4);
    expect((await recover(root, 4)).missingInits).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('NEVER IMPORTS A SEGMENT BELONGING TO ANOTHER RUN', async () => {
    /*
     * Structural rather than checked: recovery only ever looks inside the
     * directory of the run it was asked about, and the file name it derives
     * carries no path. A neighbouring broadcast's material on the same volume
     * is invisible to it, which is the property that matters when two runs
     * share a spool root.
     */
    const root = spoolWith(2);
    mkdirSync(join(root, 'run_2'), { recursive: true });
    writeFileSync(join(root, 'run_2', 'seg_g0_00007.m4s'), Buffer.from('SOMEBODY ELSE'));
    const media = new ProgrammeMediaStore();
    await recoverProgrammeMedia({
      runId: RUN.runId,
      directory: join(root, 'run_1'),
      events: [mediaEvent(0), mediaEvent(1)],
      media,
      publicOutputTimeMs: 2 * SEGMENT_MS,
      configuredDelayMs: DELAY_MS,
    });
    const restored = media.retainedSegmentIds(RUN.runId);
    expect(restored).toHaveLength(2);
    for (const segmentId of restored) expect(segmentId.startsWith('run_1.')).toBe(true);
    // And nothing was attributed to the other run at all.
    expect(media.retainedSegmentIds('run_2')).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores an orphan the timeline never committed', async () => {
    /*
     * The safe failure direction: media is made durable before its reference
     * is appended, so a process that died between the two leaves bytes nothing
     * points at. Those are not part of the broadcast and must not be
     * resurrected into it.
     */
    const root = spoolWith(2);
    writeFileSync(join(root, 'run_1', 'seg_g0_09999.m4s'), Buffer.from('ORPHAN'));
    const outcome = await recover(root, 2);
    expect(outcome.restored).toBe(2);
    expect(outcome.missing).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
