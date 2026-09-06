/** @author masterzee001 */
/**
 * History against the real archive, and a database that keeps falling over.
 *
 * TWO PROPERTIES, and the second is why this suite is adversarial:
 *
 *   HISTORY OUTLIVES ITS MEDIA. A programme that kept no recording, one whose
 *   recording expired, one whose recording was deleted and one whose files were
 *   physically removed all remain in the catalogue. Retention policy governs
 *   bytes; it does not get to edit the schedule.
 *
 *   A CATALOGUE OUTAGE IS NOT A BROADCAST PROBLEM. Every call below is made
 *   with the database refusing, throwing, or unreachable, and the assertions
 *   are about the broadcast and the archive being untouched. A history row that
 *   is late is a page that is briefly wrong; letting that reach a programme
 *   would trade something that matters for something that does not.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import {
  REPLAY_NOT_KEPT,
  airingRefused,
  judgeProjection,
  summariseReplay,
  type AiringOutcome,
  type ProgrammeAiringCatalogue,
  type ProgrammeAiringRecord,
  type ReplayDisposition,
} from '@videofy-live/programme-replay';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import { ProgrammeAiringReporter, type AiringReportProblem } from '../programme-airing-reporter.js';

const STARTED = 1_700_000_000_000;
const RUN: ProgrammeRunIdentity = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

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

/**
 * An in-memory catalogue that obeys the same rules as the durable one.
 *
 * The Postgres adapter has its own tests; what this suite is about is the
 * REPORTER -- when it calls, what it sends, and what it does when the answer is
 * no. Using the shared `judgeProjection` here keeps the two honest about the
 * same lifecycle rules.
 */
function catalogue(options: { failing?: boolean; throwing?: boolean } = {}): ProgrammeAiringCatalogue & {
  rows: Map<string, ProgrammeAiringRecord>;
  breaks: (broken: boolean) => void;
} {
  const rows = new Map<string, ProgrammeAiringRecord>();
  let failing = options.failing ?? false;
  const throwing = options.throwing ?? false;

  function guard<T>(): AiringOutcome<T> | null {
    if (throwing) throw new Error('the catalogue exploded');
    if (failing) return airingRefused('catalogue-unavailable', 'the catalogue is unreachable');
    return null;
  }

  return {
    rows,
    breaks: (broken) => {
      failing = broken;
    },
    async recordAiring(airing) {
      const refusal = guard<ProgrammeAiringRecord>();
      if (refusal !== null) return refusal;
      const held = rows.get(airing.identity.runId);
      if (held !== undefined) {
        if (
          held.identity.channelId !== airing.identity.channelId ||
          held.identity.programmeId !== airing.identity.programmeId
        ) {
          return airingRefused('identity-conflict', 'this run belongs to another channel');
        }
        return { ok: true, value: held };
      }
      const created: ProgrammeAiringRecord = {
        identity: airing.identity,
        startedAtMs: airing.startedAtMs,
        endedAtMs: null,
        replay: airing.replay ?? REPLAY_NOT_KEPT,
      };
      rows.set(airing.identity.runId, created);
      return { ok: true, value: created };
    },
    async projectReplay(runId, replay) {
      const refusal = guard<ProgrammeAiringRecord>();
      if (refusal !== null) return refusal;
      const held = rows.get(runId);
      if (held === undefined) return airingRefused('unknown-airing', 'no such airing');

      const judgement = judgeProjection(held.replay, replay);
      if (judgement.kind === 'conflict') {
        return airingRefused('disposition-conflict', judgement.detail);
      }
      if (judgement.kind === 'stale') return { ok: true, value: held };

      const updated = { ...held, replay };
      rows.set(runId, updated);
      return { ok: true, value: updated };
    },
    async finishAiring(runId, endedAtMs) {
      const refusal = guard<ProgrammeAiringRecord>();
      if (refusal !== null) return refusal;
      const held = rows.get(runId);
      if (held === undefined) return airingRefused('unknown-airing', 'no such airing');
      if (held.endedAtMs !== null) return { ok: true, value: held };
      const updated = { ...held, endedAtMs };
      rows.set(runId, updated);
      return { ok: true, value: updated };
    },
    async findByRunId(runId) {
      return rows.get(runId) ?? null;
    },
    async listByChannel(channelId) {
      return {
        airings: [...rows.values()].filter((row) => row.identity.channelId === channelId),
        next: null,
      };
    },
    async listByProgramme(programmeId) {
      return {
        airings: [...rows.values()].filter((row) => row.identity.programmeId === programmeId),
        next: null,
      };
    },
  };
}

interface Rig {
  readonly archive: FilesystemReplayArchive;
  readonly catalogue: ReturnType<typeof catalogue>;
  readonly reporter: ProgrammeAiringReporter;
  readonly problems: AiringReportProblem[];
  readonly root: string;
  readonly spool: string;
  reopen(): Promise<void>;
}

async function rig(options: { failing?: boolean; throwing?: boolean } = {}): Promise<Rig> {
  const root = scratch('videofy-airing-archive-');
  const spool = scratch('videofy-airing-spool-');
  const book = catalogue(options);
  const problems: AiringReportProblem[] = [];
  let opened = await FilesystemReplayArchive.open(root, () => STARTED);

  const held: Rig = {
    get archive() {
      return opened.archive;
    },
    catalogue: book,
    problems,
    root,
    spool,
    reporter: new ProgrammeAiringReporter({
      catalogue: book,
      archive: { describe: (runId: string) => held.archive.describe(runId) },
      onProblem: (problem) => problems.push(problem),
    }),
    reopen: async () => {
      opened = await FilesystemReplayArchive.open(root, () => STARTED);
    },
  };
  return held;
}

function source(spool: string, name: string, body: string): string {
  const path = join(spool, name);
  writeFileSync(path, Buffer.from(body));
  return path;
}

/** A finished, available recording in the archive. */
async function recorded(live: Rig): Promise<void> {
  const begun = await live.archive.begin({
    identity: RUN,
    retention: { policy: 'keep' },
    visibility: 'unlisted',
    startedAtMs: STARTED,
  });
  if (!begun.ok) throw new Error(`could not begin: ${begun.failure.detail}`);

  const init = source(live.spool, 'init.0.mp4', 'INIT'.padEnd(64, '#'));
  await live.archive.retainInitialisation(RUN.runId, {
    runId: RUN.runId,
    generation: 0,
    storageReference: init,
    bytes: statSync(init).size,
  });
  const media = source(live.spool, 'seg0.m4s', 'SEGMENT'.padEnd(160, '.'));
  await live.archive.retainSegment(RUN.runId, {
    runId: RUN.runId,
    segmentId: 'run_1.g0.00000',
    startProgrammeTimeMs: 0,
    endProgrammeTimeMs: 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: media,
    bytes: statSync(media).size,
  });
  const finalised = await live.archive.finalise(RUN.runId);
  if (!finalised.ok) throw new Error(`could not finalise: ${finalised.failure.detail}`);
}

function summary(record: ProgrammeAiringRecord | null): ReplayDisposition | null {
  return record?.replay ?? null;
}

/* ============================================================== association */

describe('a programme that went on air is written down', () => {
  it('associates the run with its channel and programme', async () => {
    const live = await rig();
    await live.reporter.airingBegan(RUN, STARTED);

    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held?.identity).toEqual(RUN);
    expect(held?.startedAtMs).toBe(STARTED);
    expect(held?.endedAtMs).toBeNull();
  });

  it('records a broadcast that will keep nothing', async () => {
    const live = await rig();
    await live.reporter.keepingNothing(RUN, STARTED);

    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held).not.toBeNull();
    expect(summary(held)).toEqual({ disposition: 'none' });
    // And there is genuinely no recording to describe.
    expect(await live.archive.describe(RUN.runId)).toBeNull();
  });

  it('follows the archive through a recording being made', async () => {
    const live = await rig();
    await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'unlisted',
      startedAtMs: STARTED,
    });
    const record = await live.archive.describe(RUN.runId);
    if (record === null) throw new Error('unreachable');
    await live.reporter.airingBegan(RUN, STARTED, summariseReplay(record));

    const held = await live.catalogue.findByRunId(RUN.runId);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('recording');
    expect(held.replay.summary.visibility).toBe('unlisted');
  });

  it('reaches available once the archive finalises', async () => {
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(RUN, STARTED, { disposition: 'replay', summary: {
      status: 'recording',
      retention: { policy: 'keep' },
      visibility: 'unlisted',
      finalisedAtMs: null,
      expiresAtMs: null,
      failure: null,
      bytes: 0,
      segmentCount: 0,
      initialisationCount: 0,
    } });
    await live.reporter.sync(RUN.runId);

    const held = await live.catalogue.findByRunId(RUN.runId);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('available');
    expect(held.replay.summary.segmentCount).toBe(1);
    expect(held.replay.summary.initialisationCount).toBe(1);
    expect(held.replay.summary.bytes).toBeGreaterThan(0);
  });
});

/* ========================================================= history survival */

describe('history outlives the media it describes', () => {
  it('keeps the airing when the recording expires', async () => {
    const live = await rig();
    const begun = await live.archive.begin({
      identity: RUN,
      retention: { policy: 'expire', expiresAtMs: STARTED + 1_000 },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    expect(begun.ok).toBe(true);
    const init = source(live.spool, 'init.0.mp4', 'INIT'.padEnd(64, '#'));
    await live.archive.retainInitialisation(RUN.runId, {
      runId: RUN.runId,
      generation: 0,
      storageReference: init,
      bytes: statSync(init).size,
    });
    const media = source(live.spool, 'seg0.m4s', 'SEGMENT'.padEnd(160, '.'));
    await live.archive.retainSegment(RUN.runId, {
      runId: RUN.runId,
      segmentId: 'run_1.g0.00000',
      startProgrammeTimeMs: 0,
      endProgrammeTimeMs: 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: media,
      bytes: statSync(media).size,
    });
    await live.archive.finalise(RUN.runId);
    await live.reporter.airingBegan(RUN, STARTED, summariseReplay(
      (await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('unreachable'); })(),
    ));

    await live.archive.expire(RUN.runId, STARTED + 1_000);
    await live.reporter.sync(RUN.runId);

    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held).not.toBeNull();
    expect(held?.identity).toEqual(RUN);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('expired');
  });

  it('keeps the airing when the recording is deleted', async () => {
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(
      RUN,
      STARTED,
      summariseReplay((await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('x'); })()),
    );

    await live.archive.delete(RUN.runId);
    await live.reporter.sync(RUN.runId);

    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held).not.toBeNull();
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('deleted');
  });

  it('keeps the airing when the archive files are physically removed', async () => {
    /*
     * THE PRODUCT INVARIANT. An operator clearing a volume, a retention sweep,
     * a restore that missed a directory -- none of it is allowed to erase the
     * fact that a programme was broadcast.
     */
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(
      RUN,
      STARTED,
      summariseReplay((await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('x'); })()),
    );

    rmSync(live.root, { recursive: true, force: true });
    await live.reopen();

    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held).not.toBeNull();
    expect(held?.identity).toEqual(RUN);
    expect(held?.startedAtMs).toBe(STARTED);
  });

  it('keeps the airing across an archive restart, and re-projects it', async () => {
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(RUN, STARTED, REPLAY_NOT_KEPT);

    // The airing was opened before anybody knew a recording would exist, so the
    // catalogue holds `none` and the archive holds a finished replay. They
    // disagree, and the catalogue says so rather than picking a winner.
    await live.reopen();
    await live.reporter.sync(RUN.runId);
    expect(live.problems.map((p) => p.reason)).toContain('disposition-conflict');
    expect(summary(await live.catalogue.findByRunId(RUN.runId))).toEqual({ disposition: 'none' });
  });
});

/* ========================================================== reconciliation */

describe('a stale row is repaired from the current snapshot alone', () => {
  it('catches up after an outage without replaying any transitions', async () => {
    const live = await rig();
    await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'unlisted',
      startedAtMs: STARTED,
    });
    await live.reporter.airingBegan(
      RUN,
      STARTED,
      summariseReplay((await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('x'); })()),
    );

    // The catalogue goes away for the whole of the interesting part.
    live.catalogue.breaks(true);
    const init = source(live.spool, 'init.0.mp4', 'INIT'.padEnd(64, '#'));
    await live.archive.retainInitialisation(RUN.runId, {
      runId: RUN.runId,
      generation: 0,
      storageReference: init,
      bytes: statSync(init).size,
    });
    const media = source(live.spool, 'seg0.m4s', 'SEGMENT'.padEnd(160, '.'));
    await live.archive.retainSegment(RUN.runId, {
      runId: RUN.runId,
      segmentId: 'run_1.g0.00000',
      startProgrammeTimeMs: 0,
      endProgrammeTimeMs: 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: media,
      bytes: statSync(media).size,
    });
    await live.archive.finalise(RUN.runId);
    await live.reporter.sync(RUN.runId);

    // Still stale, and the operator was told.
    const stale = await live.catalogue.findByRunId(RUN.runId);
    if (stale?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(stale.replay.summary.status).toBe('recording');
    expect(live.problems.map((p) => p.reason)).toContain('catalogue-unavailable');

    // One current snapshot repairs it. No journal, no replayed transitions.
    live.catalogue.breaks(false);
    await live.reporter.sync(RUN.runId);
    const repaired = await live.catalogue.findByRunId(RUN.runId);
    if (repaired?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(repaired.replay.summary.status).toBe('available');
    expect(repaired.replay.summary.segmentCount).toBe(1);
  });

  it('is safe to run over and over', async () => {
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(
      RUN,
      STARTED,
      summariseReplay((await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('x'); })()),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) await live.reporter.sync(RUN.runId);
    const held = await live.catalogue.findByRunId(RUN.runId);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('available');
    expect(live.catalogue.rows.size).toBe(1);
  });
});

/* ======================================================== failure isolation */

describe('a catalogue outage costs the broadcast nothing', () => {
  it('does not stop an airing being opened', async () => {
    const live = await rig({ failing: true });
    await live.reporter.airingBegan(RUN, STARTED);

    // The archive is entirely unaware.
    const begun = await live.archive.begin({
      identity: RUN,
      retention: { policy: 'keep' },
      visibility: 'public',
      startedAtMs: STARTED,
    });
    expect(begun.ok).toBe(true);
    expect(live.problems[0]?.operation).toBe('record');
  });

  it('does not stop a recording being made or finalised', async () => {
    const live = await rig({ failing: true });
    await live.reporter.airingBegan(RUN, STARTED);
    await recorded(live);
    await live.reporter.sync(RUN.runId);

    const record = await live.archive.describe(RUN.runId);
    expect(record?.status).toBe('available');
    expect(record?.segments).toHaveLength(1);
  });

  it('survives a catalogue that throws instead of refusing', async () => {
    const live = await rig({ throwing: true });
    await expect(live.reporter.airingBegan(RUN, STARTED)).resolves.toBeUndefined();
    await expect(live.reporter.sync(RUN.runId)).resolves.toBeUndefined();
    await expect(live.reporter.airingEnded(RUN.runId, STARTED + 1)).resolves.toBeUndefined();
    expect(live.problems.map((p) => p.reason)).toContain('catalogue-threw');
  });

  it('never fails a replay because history could not be written', async () => {
    const live = await rig({ failing: true });
    await recorded(live);
    await live.reporter.airingBegan(RUN, STARTED);
    await live.reporter.sync(RUN.runId);
    await live.reporter.airingEnded(RUN.runId, STARTED + 90_000);

    const record = await live.archive.describe(RUN.runId);
    expect(record?.status).toBe('available');
    expect(record?.failure).toBeNull();
  });

  it('tells an operator, without naming a path or a viewer', async () => {
    const live = await rig({ failing: true });
    await live.reporter.airingBegan(RUN, STARTED);
    const reported = JSON.stringify(live.problems);

    expect(live.problems).toHaveLength(1);
    expect(reported).not.toContain(live.root);
    expect(reported).not.toContain(live.spool);
    expect(reported).toContain('run_1');
  });
});

/* =============================================================== finishing */

describe('when the broadcast ends', () => {
  it('syncs the recording first, then writes the ending', async () => {
    const live = await rig();
    await recorded(live);
    await live.reporter.airingBegan(
      RUN,
      STARTED,
      summariseReplay((await live.archive.describe(RUN.runId)) ?? (() => { throw new Error('x'); })()),
    );

    await live.reporter.airingEnded(RUN.runId, STARTED + 90_000);
    const held = await live.catalogue.findByRunId(RUN.runId);
    expect(held?.endedAtMs).toBe(STARTED + 90_000);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('available');
  });

  it('keeps the first ending when told twice', async () => {
    const live = await rig();
    await live.reporter.airingBegan(RUN, STARTED);
    await live.reporter.airingEnded(RUN.runId, STARTED + 90_000);
    await live.reporter.airingEnded(RUN.runId, STARTED + 999_000);

    expect((await live.catalogue.findByRunId(RUN.runId))?.endedAtMs).toBe(STARTED + 90_000);
  });
});
