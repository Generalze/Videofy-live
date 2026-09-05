/** @author masterzee001 */
/**
 * Programme history: identity that cannot move, projections that cannot regress.
 *
 * WHY A MODELLED POOL RATHER THAN A REAL DATABASE, following this directory's
 * existing convention: these tests must run in CI without Postgres, and the
 * property under test is not "does SQL work" -- it is whether THIS CODE locks
 * the run's row before deciding, refuses an identity change, ignores a stale
 * snapshot, and pages by keyset rather than offset. The fake below implements
 * the two behaviours those invariants depend on:
 *
 *   - `FOR UPDATE` on a run's row blocks a second writer for that SAME run
 *     until the first COMMITs, and blocks nobody else
 *   - ROLLBACK discards every write made since BEGIN
 *
 * The SQL itself is proven against a real server by `npm run test:migrations`.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  REPLAY_NOT_KEPT,
  summariseReplay,
  type ProgrammeAiringRecord,
  type ReplayDisposition,
  type ReplayRecord,
  type ReplayStatus,
} from '@videofy-live/programme-replay';
import { createPostgresAiringCatalogue } from './programme-airings-postgres.js';

const STARTED = 1_700_000_000_000;

interface Row {
  run_id: string;
  channel_id: string;
  programme_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  replay_disposition: string;
  replay_status: string | null;
  replay_policy: string | null;
  replay_visibility: string | null;
  replay_expires_at_ms: number | null;
  replay_finalised_at_ms: number | null;
  replay_failure_reason: string | null;
  replay_failure_summary: string | null;
  replay_bytes: number | null;
  replay_segment_count: number | null;
  replay_init_count: number | null;
}

/**
 * A Postgres-shaped fake.
 *
 * `serialize: false` models a database WITHOUT the row lock, which is how the
 * read-then-write race gets tested on its own: with the lock working, a naive
 * implementation still passes, so a suite that only ever exercises both
 * together cannot catch either being removed.
 */
function fakePool(options: { failOn?: RegExp; serialize?: boolean } = {}): Pool & {
  rows: Map<string, Row>;
  statements: string[];
  parameters: unknown[];
} {
  const serialize = options.serialize !== false;
  const rows = new Map<string, Row>();
  const statements: string[] = [];
  /** Everything the adapter has bound. A leak has to pass through here. */
  const parameters: unknown[] = [];
  const lockedRuns = new Set<string>();
  const waiting: (() => void)[] = [];

  function connect(): Promise<unknown> {
    let held: string | null = null;
    let staged: Map<string, Row> | null = null;

    const client = {
      async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
        statements.push(text.trim().split('\n')[0]?.trim() ?? '');
        parameters.push(...values);
        if (options.failOn?.test(text) === true) throw new Error('database is unwell');

        if (/^BEGIN/u.test(text.trim())) {
          staged = new Map([...rows].map(([key, row]) => [key, { ...row }]));
          return { rows: [] };
        }
        if (/^COMMIT/u.test(text.trim())) {
          staged = null;
          if (held !== null) release(held);
          held = null;
          return { rows: [] };
        }
        if (/^ROLLBACK/u.test(text.trim())) {
          if (staged !== null) {
            rows.clear();
            for (const [key, row] of staged) rows.set(key, row);
          }
          staged = null;
          if (held !== null) release(held);
          held = null;
          return { rows: [] };
        }

        const store = rows;

        if (/FOR UPDATE/u.test(text)) {
          const runId = String(values[0]);
          if (serialize) {
            while (lockedRuns.has(runId)) {
              await new Promise<void>((done) => waiting.push(done));
            }
            lockedRuns.add(runId);
            held = runId;
          }
          const row = store.get(runId);
          return { rows: row === undefined ? [] : [{ ...row }] };
        }

        if (/^INSERT INTO programme_airings/u.test(text.trim())) {
          const [runId, channelId, programmeId, startedAtMs, ...replay] = values;
          store.set(String(runId), {
            run_id: String(runId),
            channel_id: String(channelId),
            programme_id: String(programmeId),
            started_at_ms: Number(startedAtMs),
            ended_at_ms: null,
            replay_disposition: String(replay[0]),
            replay_status: replay[1] as string | null,
            replay_policy: replay[2] as string | null,
            replay_visibility: replay[3] as string | null,
            replay_expires_at_ms: replay[4] as number | null,
            replay_finalised_at_ms: replay[5] as number | null,
            replay_failure_reason: replay[6] as string | null,
            replay_failure_summary: replay[7] as string | null,
            replay_bytes: replay[8] as number | null,
            replay_segment_count: replay[9] as number | null,
            replay_init_count: replay[10] as number | null,
          });
          return { rows: [] };
        }

        if (/^UPDATE programme_airings SET\s+replay_disposition/u.test(text.trim())) {
          const runId = String(values[0]);
          const row = store.get(runId);
          if (row !== undefined) {
            store.set(runId, {
              ...row,
              replay_disposition: String(values[1]),
              replay_status: values[2] as string | null,
              replay_policy: values[3] as string | null,
              replay_visibility: values[4] as string | null,
              replay_expires_at_ms: values[5] as number | null,
              replay_finalised_at_ms: values[6] as number | null,
              replay_failure_reason: values[7] as string | null,
              replay_failure_summary: values[8] as string | null,
              replay_bytes: values[9] as number | null,
              replay_segment_count: values[10] as number | null,
              replay_init_count: values[11] as number | null,
            });
          }
          return { rows: [] };
        }

        if (/^UPDATE programme_airings SET ended_at_ms/u.test(text.trim())) {
          const runId = String(values[0]);
          const row = store.get(runId);
          if (row !== undefined && row.ended_at_ms === null) {
            store.set(runId, { ...row, ended_at_ms: Number(values[1]) });
          }
          return { rows: [] };
        }

        if (/WHERE run_id = \$1/u.test(text)) {
          const row = store.get(String(values[0]));
          return { rows: row === undefined ? [] : [{ ...row }] };
        }

        if (/WHERE (channel_id|programme_id) = \$1/u.test(text)) {
          /*
           * Read the column out of the WHERE clause, not the statement: every
           * SELECT lists `channel_id` among its columns, so testing the whole
           * text answers "channel" for a programme query and quietly returns
           * nothing.
           */
          const column = /WHERE channel_id = \$1/u.test(text) ? 'channel_id' : 'programme_id';
          const wanted = String(values[0]);
          let matching = [...store.values()].filter((row) => row[column] === wanted);
          matching.sort((a, b) =>
            a.started_at_ms === b.started_at_ms
              ? b.run_id.localeCompare(a.run_id)
              : b.started_at_ms - a.started_at_ms,
          );
          if (/\(started_at_ms, run_id\) </u.test(text)) {
            const afterTime = Number(values[1]);
            const afterRun = String(values[2]);
            matching = matching.filter(
              (row) =>
                row.started_at_ms < afterTime ||
                (row.started_at_ms === afterTime && row.run_id < afterRun),
            );
          }
          const limit = Number(values[values.length - 1]);
          return { rows: matching.slice(0, limit).map((row) => ({ ...row })) };
        }

        return { rows: [] };
      },
      release(): void {
        if (held !== null) release(held);
        held = null;
      },
    };
    return Promise.resolve(client);
  }

  function release(runId: string): void {
    lockedRuns.delete(runId);
    const next = waiting.shift();
    next?.();
  }

  return {
    rows,
    statements,
    parameters,
    connect,
    query: async (text: string, values: readonly unknown[] = []) => {
      const client = (await connect()) as { query: (t: string, v: readonly unknown[]) => Promise<{ rows: Row[] }> };
      return client.query(text, values);
    },
  } as unknown as Pool & {
    rows: Map<string, Row>;
    statements: string[];
    parameters: unknown[];
  };
}

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

function replayRecord(status: ReplayStatus, overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    identity: RUN,
    retention: { policy: 'keep' },
    visibility: 'unlisted',
    status,
    startedAtMs: STARTED,
    finalisedAtMs: status === 'available' ? STARTED + 60_000 : null,
    expiresAtMs: null,
    segments: [
      {
        runId: RUN.runId,
        segmentId: 'run_1.g0.00000',
        startProgrammeTimeMs: 0,
        endProgrammeTimeMs: 2000,
        keyframeAligned: true,
        hasVideo: true,
        hasAudio: true,
        storageReference: '/replay/runs/abc/media/deadbeef.bin',
        bytes: 100_000,
      },
    ],
    initialisations: [
      { runId: RUN.runId, generation: 0, storageReference: '/replay/runs/abc/init/g0.bin', bytes: 1_000 },
    ],
    bytes: 101_000,
    failure: null,
    history: [],
    ...overrides,
  };
}

function projection(status: ReplayStatus, overrides: Partial<ReplayRecord> = {}): ReplayDisposition {
  return summariseReplay(replayRecord(status, overrides));
}

async function opened(
  pool: ReturnType<typeof fakePool>,
  replay?: ReplayDisposition,
): Promise<ProgrammeAiringRecord> {
  const catalogue = createPostgresAiringCatalogue(pool);
  const outcome = await catalogue.recordAiring({
    identity: RUN,
    startedAtMs: STARTED,
    ...(replay === undefined ? {} : { replay }),
  });
  if (!outcome.ok) throw new Error(`could not record: ${outcome.failure.detail}`);
  return outcome.value;
}

/* ================================================================= identity */

describe('an airing belongs to one channel and one programme', () => {
  it('records the airing', async () => {
    const pool = fakePool();
    const airing = await opened(pool);
    expect(airing.identity).toEqual(RUN);
    expect(airing.startedAtMs).toBe(STARTED);
    expect(airing.endedAtMs).toBeNull();
    expect(airing.replay).toEqual({ disposition: 'none' });
  });

  it('absorbs the exact same airing twice', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });
    const again = await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    expect(again.ok).toBe(true);
    expect(pool.rows.size).toBe(1);
  });

  it('refuses to move a run to another channel', async () => {
    /*
     * A broadcast does not change whose it was. The write that would do it
     * looks exactly like an ordinary retry, which is why it is refused rather
     * than applied.
     */
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    const moved = await catalogue.recordAiring({
      identity: { ...RUN, channelId: 'ch_2' },
      startedAtMs: STARTED,
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error('unreachable');
    expect(moved.failure.reason).toBe('identity-conflict');
    expect(pool.rows.get('run_1')?.channel_id).toBe('ch_1');
  });

  it('refuses to move a run to another programme', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    const moved = await catalogue.recordAiring({
      identity: { ...RUN, programmeId: 'prog_2' },
      startedAtMs: STARTED,
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error('unreachable');
    expect(moved.failure.reason).toBe('identity-conflict');
  });

  it('treats an id shaped like SQL as data', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    const hostile = "run_1'; DROP TABLE programme_airings; --";
    await catalogue.recordAiring({
      identity: { ...RUN, runId: hostile },
      startedAtMs: STARTED,
    });

    expect(pool.rows.has(hostile)).toBe(true);
    expect(await catalogue.findByRunId(hostile)).not.toBeNull();
    // Every statement is parameterised: the id never reaches the text.
    expect(pool.statements.some((text) => text.includes('DROP TABLE'))).toBe(false);
  });
});

/* ===================================================================== NONE */

describe('a programme that kept no recording still has history', () => {
  it('stores the airing with a disposition of none', async () => {
    const pool = fakePool();
    await opened(pool, REPLAY_NOT_KEPT);
    const row = pool.rows.get('run_1');

    expect(row?.replay_disposition).toBe('none');
    // The constraint in the migration says the same thing; the adapter must not
    // be the one writing a replay status against a programme with no replay.
    expect(row?.replay_status).toBeNull();
    expect(row?.replay_bytes).toBeNull();
    expect(row?.replay_visibility).toBeNull();
  });

  it('refuses to become a recorded airing later', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, REPLAY_NOT_KEPT);

    const projected = await catalogue.projectReplay('run_1', projection('recording'));
    expect(projected.ok).toBe(false);
    if (projected.ok) throw new Error('unreachable');
    expect(projected.failure.reason).toBe('disposition-conflict');
  });
});

/* =============================================================== projection */

describe('the recording summary follows the archive', () => {
  it('projects each lifecycle state in turn', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));

    for (const status of ['processing', 'available', 'expired'] as const) {
      const projected = await catalogue.projectReplay('run_1', projection(status));
      expect(projected.ok, status).toBe(true);
      if (!projected.ok) throw new Error('unreachable');
      expect(projected.value.replay.disposition).toBe('replay');
      if (projected.value.replay.disposition !== 'replay') throw new Error('unreachable');
      expect(projected.value.replay.summary.status).toBe(status);
    }
  });

  it('projects a failure with its reason', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));

    await catalogue.projectReplay(
      'run_1',
      projection('failed', {
        failure: { reason: 'media-origin-failed', detail: 'the encoder died', liveImpact: 'none' },
      }),
    );
    const row = pool.rows.get('run_1');
    expect(row?.replay_status).toBe('failed');
    expect(row?.replay_failure_reason).toBe('media-origin-failed');
    expect(row?.replay_failure_summary).toBe(
      'The programme media origin failed before the replay completed.',
    );
    // The archive's own words, which can name a spool file, never arrive.
    expect(row?.replay_failure_summary).not.toContain('the encoder died');
  });

  it('bounds how much failure text it will keep', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));

    await catalogue.projectReplay(
      'run_1',
      projection('failed', {
        failure: { reason: 'archive-unavailable', detail: 'x'.repeat(5_000), liveImpact: 'none' },
      }),
    );
    const held = pool.rows.get('run_1')?.replay_failure_summary ?? '';
    expect(held.length).toBeLessThanOrEqual(500);
    // And it is the mapped sentence, not five thousand characters of anything.
    expect(held).toBe('The replay archive was unavailable.');
  });

  it('keeps an expiry only for a policy that has one', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));
    await catalogue.projectReplay(
      'run_1',
      projection('available', {
        retention: { policy: 'expire', expiresAtMs: STARTED + 1_000 },
        expiresAtMs: STARTED + 1_000,
      }),
    );

    const row = pool.rows.get('run_1');
    expect(row?.replay_policy).toBe('expire');
    expect(row?.replay_expires_at_ms).toBe(STARTED + 1_000);
  });

  it('never lets the archive failure text reach the database', async () => {
    /*
     * THE LEAK THIS CLOSES, proven where it would actually happen: in the
     * parameters bound to the statement, and in the row that results. A
     * `source-media-unavailable` detail names the spool file that could not be
     * copied, which belongs in a log on the box and nowhere near a product
     * database that is queried by other things and backed up elsewhere.
     */
    for (const leak of [
      'C:\\videofy\\spool\\run\\segment.m4s',
      '/srv/videofy/spool/run/segment.m4s',
    ]) {
      const pool = fakePool();
      const catalogue = createPostgresAiringCatalogue(pool);
      await opened(pool, projection('recording'));
      await catalogue.projectReplay(
        'run_1',
        projection('failed', {
          failure: {
            reason: 'source-media-unavailable',
            detail: `programme media at ${leak} could not be copied`,
            liveImpact: 'none',
          },
        }),
      );

      const bound = JSON.stringify(pool.parameters);
      const stored = JSON.stringify([...pool.rows.values()]);
      const returned = JSON.stringify(await catalogue.findByRunId('run_1'));
      for (const shape of [bound, stored, returned]) {
        expect(shape).not.toContain(leak);
        expect(shape).not.toContain('spool');
        expect(shape).not.toContain('segment.m4s');
      }
      // The reason survives, because that is what an operator needs.
      expect(pool.rows.get('run_1')?.replay_failure_reason).toBe('source-media-unavailable');
      expect(pool.rows.get('run_1')?.replay_failure_summary).toBe(
        'Programme media became unavailable before replay retention completed.',
      );
    }
  });

  it('stores nothing that says where the media lives', async () => {
    const pool = fakePool();
    await opened(pool, projection('available'));
    const stored = JSON.stringify([...pool.rows.values()]);

    expect(stored).not.toContain('/replay/runs');
    expect(stored).not.toContain('.bin');
    expect(stored).not.toContain('deadbeef');
    expect(stored).not.toContain('storageReference');
  });

  it('refuses to project onto an airing nobody recorded', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    const projected = await catalogue.projectReplay('run_nobody', projection('available'));

    expect(projected.ok).toBe(false);
    if (projected.ok) throw new Error('unreachable');
    expect(projected.failure.reason).toBe('unknown-airing');
  });
});

/* ============================================================ stale updates */

describe('a late snapshot never rewinds history', () => {
  it('ignores a recording snapshot arriving after a deletion', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));
    await catalogue.projectReplay('run_1', projection('available'));
    await catalogue.projectReplay('run_1', projection('deleted'));

    const late = await catalogue.projectReplay('run_1', projection('recording'));
    // Success, because a duplicate arriving out of order is ordinary traffic.
    expect(late.ok).toBe(true);
    expect(pool.rows.get('run_1')?.replay_status).toBe('deleted');
  });

  it('ignores an available snapshot arriving after an expiry', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('available'));
    await catalogue.projectReplay('run_1', projection('expired'));

    await catalogue.projectReplay('run_1', projection('available'));
    expect(pool.rows.get('run_1')?.replay_status).toBe('expired');
  });

  it('absorbs the same snapshot twice without changing anything', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('available'));
    const before = { ...pool.rows.get('run_1') };

    await catalogue.projectReplay('run_1', projection('available'));
    expect({ ...pool.rows.get('run_1') }).toEqual(before);
  });
});

/* ================================================================ finishing */

describe('a broadcast ends once', () => {
  it('records when it ended', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool);
    const finished = await catalogue.finishAiring('run_1', STARTED + 90_000);

    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error('unreachable');
    expect(finished.value.endedAtMs).toBe(STARTED + 90_000);
  });

  it('keeps the first ending when told again', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool);
    await catalogue.finishAiring('run_1', STARTED + 90_000);
    await catalogue.finishAiring('run_1', STARTED + 999_000);

    expect(pool.rows.get('run_1')?.ended_at_ms).toBe(STARTED + 90_000);
  });

  it('refuses to finish an airing nobody recorded', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    const finished = await catalogue.finishAiring('run_nobody', STARTED);

    expect(finished.ok).toBe(false);
    if (finished.ok) throw new Error('unreachable');
    expect(finished.failure.reason).toBe('unknown-airing');
  });
});

/* ================================================================= history */

describe('history survives its media', () => {
  it('keeps the airing after the recording is deleted', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('available'));
    await catalogue.projectReplay('run_1', projection('deleted'));

    const held = await catalogue.findByRunId('run_1');
    expect(held).not.toBeNull();
    expect(held?.identity).toEqual(RUN);
    if (held?.replay.disposition !== 'replay') throw new Error('unreachable');
    expect(held.replay.summary.status).toBe('deleted');
  });

  it('keeps the airing after the recording expires', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('available'));
    await catalogue.projectReplay('run_1', projection('expired'));

    expect(await catalogue.findByRunId('run_1')).not.toBeNull();
  });

  it('keeps the airing after the recording failed', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));
    await catalogue.projectReplay('run_1', projection('failed'));

    expect(await catalogue.findByRunId('run_1')).not.toBeNull();
  });
});

/* ================================================================= listing */

describe('what a channel aired, newest first', () => {
  async function withAirings(count: number): Promise<{
    pool: ReturnType<typeof fakePool>;
    catalogue: ReturnType<typeof createPostgresAiringCatalogue>;
  }> {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    for (let index = 0; index < count; index += 1) {
      await catalogue.recordAiring({
        identity: {
          channelId: index % 2 === 0 ? 'ch_1' : 'ch_2',
          programmeId: 'prog_1',
          runId: `run_${String(index).padStart(3, '0')}`,
        },
        startedAtMs: STARTED + index * 1_000,
      });
    }
    return { pool, catalogue };
  }

  it('lists only the channel asked for, newest first', async () => {
    const { catalogue } = await withAirings(6);
    const page = await catalogue.listByChannel('ch_1');

    expect(page.airings.map((a) => a.identity.runId)).toEqual(['run_004', 'run_002', 'run_000']);
    expect(page.airings.every((a) => a.identity.channelId === 'ch_1')).toBe(true);
  });

  it('lists by programme too', async () => {
    const { catalogue } = await withAirings(4);
    const page = await catalogue.listByProgramme('prog_1');
    expect(page.airings).toHaveLength(4);
  });

  it('pages by cursor rather than offset', async () => {
    /*
     * History grows while somebody reads it. An offset shifts under them and
     * they see one airing twice and miss another; a cursor names the last row
     * seen, so pages stay stable however much is appended.
     */
    const { catalogue } = await withAirings(10);
    const first = await catalogue.listByProgramme('prog_1', { limit: 4 });
    expect(first.airings).toHaveLength(4);
    expect(first.next).not.toBeNull();

    const second = await catalogue.listByProgramme('prog_1', {
      limit: 4,
      ...(first.next === null ? {} : { after: first.next }),
    });
    const seen = [...first.airings, ...second.airings].map((a) => a.identity.runId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      'run_009',
      'run_008',
      'run_007',
      'run_006',
      'run_005',
      'run_004',
      'run_003',
      'run_002',
    ]);
  });

  it('says when there is no next page', async () => {
    const { catalogue } = await withAirings(3);
    const page = await catalogue.listByProgramme('prog_1', { limit: 10 });
    expect(page.airings).toHaveLength(3);
    expect(page.next).toBeNull();
  });

  it('can tell the visibility tiers apart', async () => {
    // R1-E exposes no public discovery route; what it must prove is that the
    // stored metadata is rich enough for R4 to decide with.
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    for (const [index, visibility] of (['public', 'unlisted', 'private'] as const).entries()) {
      const runId = `run_${visibility}`;
      await catalogue.recordAiring({
        identity: { channelId: 'ch_1', programmeId: 'prog_1', runId },
        startedAtMs: STARTED + index,
        replay: summariseReplay(replayRecord('available', { visibility })),
      });
    }
    await catalogue.recordAiring({
      identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_none' },
      startedAtMs: STARTED + 9,
      replay: REPLAY_NOT_KEPT,
    });

    const page = await catalogue.listByChannel('ch_1');
    const tiers = page.airings.map((a) =>
      a.replay.disposition === 'none' ? 'none' : a.replay.summary.visibility,
    );
    expect(new Set(tiers)).toEqual(new Set(['public', 'unlisted', 'private', 'none']));
  });
});

/* ============================================================= concurrency */

describe('two reports for one broadcast', () => {
  it('serializes identical updates onto one row', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));

    const [first, second] = await Promise.all([
      catalogue.projectReplay('run_1', projection('available')),
      catalogue.projectReplay('run_1', projection('available')),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(pool.rows.size).toBe(1);
    expect(pool.rows.get('run_1')?.replay_status).toBe('available');
  });

  it('does not let a slower stale update overwrite a newer one', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await opened(pool, projection('recording'));

    await Promise.all([
      catalogue.projectReplay('run_1', projection('deleted')),
      catalogue.projectReplay('run_1', projection('available')),
    ]);
    // Whichever ran first, the row must not end up behind where it reached.
    expect(pool.rows.get('run_1')?.replay_status).toBe('deleted');
  });

  it('refuses a conflicting identity without corrupting the row', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    await Promise.all([
      catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED }),
      catalogue.recordAiring({ identity: { ...RUN, channelId: 'ch_hostile' }, startedAtMs: STARTED }),
    ]);
    expect(pool.rows.get('run_1')?.channel_id).toBe('ch_1');
    expect(pool.rows.size).toBe(1);
  });

  it('does not let one broadcast block another', async () => {
    const pool = fakePool();
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });
    await catalogue.recordAiring({
      identity: { ...RUN, runId: 'run_2' },
      startedAtMs: STARTED,
    });

    const finished: string[] = [];
    await Promise.all([
      catalogue.finishAiring('run_1', STARTED + 1).then(() => finished.push('run_1')),
      catalogue.finishAiring('run_2', STARTED + 2).then(() => finished.push('run_2')),
    ]);
    expect(finished).toHaveLength(2);
  });
});

/* ============================================================ unavailability */

describe('a database that is unwell', () => {
  it('refuses rather than throwing, and says nothing about the connection', async () => {
    const pool = fakePool({ failOn: /FOR UPDATE/u });
    const catalogue = createPostgresAiringCatalogue(pool);
    const outcome = await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('catalogue-unavailable');
    expect(outcome.failure.liveImpact).toBe('none');
    expect(outcome.failure.detail).not.toContain('database is unwell');
  });

  it('leaves nothing half-written', async () => {
    const pool = fakePool({ failOn: /^INSERT INTO programme_airings/u });
    const catalogue = createPostgresAiringCatalogue(pool);
    await catalogue.recordAiring({ identity: RUN, startedAtMs: STARTED });

    expect(pool.rows.size).toBe(0);
  });
});
