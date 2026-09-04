/** @author masterzee001 */
/**
 * A restarted service knowing which broadcasts it was already running.
 *
 * THE ENTRY POINT EXISTED AND NOTHING CALLED IT. `recover()` was written,
 * tested and exported. The media recovery beneath it was written, tested and
 * exported. `onRecovered` was registered. And no boot path invoked any of it,
 * so restarting media-ingest mid-broadcast produced a service that did not
 * know the run existed: 72 segments on the volume, a well-formed EMPTY
 * manifest, and every health signal green.
 *
 * IT COULD NOT HAVE BEEN JOINED AS IT STOOD, either. `recover()` needs a
 * ProgrammeRunIdentity -- channel, programme, run -- and the journal recorded
 * only events. Every unit test supplied that identity by hand, which is
 * exactly why they all passed while a real restart could not name a single
 * run. So the journal now writes down whose broadcast it is.
 */
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JournalTimelineStore } from '../journal-timeline-store.js';

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
const REGISTRY = readFileSync(
  fileURLToPath(new URL('../programme-timeline-registry.ts', import.meta.url)),
  'utf8',
);

const IDENTITY = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_boot_1' } as const;

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boot-recovery-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the journal remembers whose broadcast it is', () => {
  it('WRITES THE IDENTITY, NOT ONLY THE EVENTS', async () => {
    /*
     * Without this a recovered run cannot be placed on a channel, visibility
     * cannot be resolved, and no audience is admitted -- a broadcast that
     * survives a restart and that nobody may watch.
     */
    const store = new JournalTimelineStore({ directory });
    expect(await store.saveIdentity(IDENTITY)).toBe(true);
    expect(await readdir(directory)).toContain(`${IDENTITY.runId}.identity`);
  });

  it('lists what it holds, which load() alone cannot answer', async () => {
    // At boot nothing knows which runs to ask about. `load(runId)` needs the
    // very answer that is missing.
    const store = new JournalTimelineStore({ directory });
    await store.saveIdentity(IDENTITY);
    await store.saveIdentity({ ...IDENTITY, runId: 'run_boot_2' });
    const listed = await store.listRuns();
    expect(listed.map((run) => run.runId).sort()).toEqual(['run_boot_1', 'run_boot_2']);
    expect(listed[0]?.channelId).toBe('ch_1');
  });

  it('OMITS A RUN WHOSE IDENTITY IS UNREADABLE RATHER THAN GUESSING ONE', async () => {
    /*
     * Guessing a channel would admit an audience to somebody else's
     * programme. A run that cannot be placed is not recovered, and saying so
     * is the only safe answer.
     */
    const store = new JournalTimelineStore({ directory });
    await writeFile(join(directory, 'run_corrupt.identity'), 'not json at all');
    await writeFile(join(directory, 'run_mismatch.identity'), JSON.stringify({ runId: 'someone_else' }));
    expect(await store.listRuns()).toEqual([]);
  });

  it('ignores a journal with no identity beside it', async () => {
    // An existing journal written before identity was recorded. Not
    // recoverable, and not reported as a run.
    const store = new JournalTimelineStore({ directory });
    await writeFile(join(directory, 'run_legacy.journal'), '');
    expect(await store.listRuns()).toEqual([]);
  });
});

describe('the composition root actually recovers', () => {
  it('CALLS RECOVERY AT BOOT, which nothing did', () => {
    /*
     * The defect asserted against directly. Every piece below existed and was
     * green; the line that runs them did not.
     */
    expect(INDEX).toContain('await recoverRunsFromDisk();');
    expect(INDEX).toContain('await programmeTimelines.recover(identity)');
  });

  it('writes the identity when a run opens', () => {
    expect(REGISTRY).toContain('store?.saveIdentity?.(identity)');
  });

  it('DOES NOT RESURRECT A BROADCAST WHOSE MEDIA HAS EXPIRED', () => {
    /*
     * A finished run whose retention has passed has nothing left to serve, and
     * putting it back would offer an audience a programme that ended. The
     * spool is the honest test because it is what they would be served from.
     */
    const body = INDEX.slice(
      INDEX.indexOf('async function recoverRunsFromDisk'),
      INDEX.indexOf('await recoverRunsFromDisk();'),
    );
    expect(body).toContain("name.endsWith('.m4s')");
    expect(body).toContain('if (held === 0)');
  });

  it('counts what it declined, so an expired run reads differently from a broken one', () => {
    const body = INDEX.slice(
      INDEX.indexOf('async function recoverRunsFromDisk'),
      INDEX.indexOf('await recoverRunsFromDisk();'),
    );
    expect(body).toContain('declined');
    expect(INDEX).toContain("logger.info('Recovered broadcasts from the journal'");
  });
});

describe('a run comes back whole', () => {
  it('reloads identity, events and cursor together', async () => {
    /*
     * The three facts a recovered broadcast needs: who it belongs to, what it
     * aired, and how far the audience had reached. Any one missing and the run
     * is either unwatchable or wrong.
     */
    const store = new JournalTimelineStore({ directory });
    await store.saveIdentity(IDENTITY);
    await store.append({
      runId: IDENTITY.runId,
      sequence: 1,
      programmeTimeMs: 0,
      kind: 'media',
      reference: `${IDENTITY.runId}.g0.00000`,
      durationMs: 2000,
      attributes: {},
    });
    await store.saveCursor(IDENTITY.runId, 0);
    await store.flush(IDENTITY.runId);

    const listed = await store.listRuns();
    expect(listed).toHaveLength(1);
    const persisted = await store.load(IDENTITY.runId);
    expect(persisted?.events).toHaveLength(1);
    expect(persisted?.intact).toBe(true);
    expect(listed[0]).toEqual(IDENTITY);
  });

  it('survives the spool directory not existing yet', async () => {
    // listRuns is called at boot, before anything has necessarily been
    // written. It must answer, not throw.
    const store = new JournalTimelineStore({ directory: join(directory, 'not-created') });
    expect(await store.listRuns()).toEqual([]);
  });
});
