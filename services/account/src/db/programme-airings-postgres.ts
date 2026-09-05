/** @author masterzee001 */
/**
 * Programme history, durably, and never a way to reach any media.
 *
 * WHAT THIS ADAPTER GUARDS, beyond writing rows:
 *
 *   AN AIRING'S IDENTITY IS IMMUTABLE. A run belongs to one channel and one
 *   programme, decided when it went on air. A later write claiming a different
 *   one is refused rather than applied, because moving a broadcast between
 *   channels silently rewrites whose history it is -- and the write that would
 *   do it looks exactly like an ordinary retry.
 *
 *   A PROJECTION NEVER GOES BACKWARDS. The reporter feeding this is
 *   at-least-once and its messages can arrive late, so a `recording` snapshot
 *   from before a deletion will eventually turn up after it. Applying that
 *   would advertise a recording an operator removed. Stale updates are ignored
 *   -- not failed -- because a late duplicate is normal traffic, not a fault.
 *
 *   EVERY MUTATION IS IDEMPOTENT. Sending the same thing twice writes the same
 *   row and reports the same success, which is the only shape that makes a
 *   retrying reporter safe.
 *
 * SERIALIZED PER RUN. Read-then-write across two statements lets two reports
 * for one broadcast interleave, and the loser's decision is taken against state
 * that has already moved. `SELECT ... FOR UPDATE` on the run's own row orders
 * them; the lock is keyed by run, so one broadcast never blocks another.
 *
 * NOTHING HERE STORES A PATH. No storage reference, no archive root, no object
 * key, no segment list. This table describes broadcasts; the media archive
 * knows where their bytes are, and a product database that also knew would be
 * an archive-path leak with a schema.
 */

import type { Pool, PoolClient } from 'pg';
import {
  judgeProjection,
  pageSize,
  airingRefused,
  type AiringOutcome,
  type AiringQuery,
  type ProgrammeAiringCatalogue,
  type ProgrammeAiringPage,
  type ProgrammeAiringRecord,
  type ReplayDisposition,
} from '@videofy-live/programme-replay';

/**
 * How much failure wording the catalogue will hold.
 *
 * The text is chosen from a closed set by the domain, so this is a belt to the
 * braces rather than the protection itself -- but a column with no bound is a
 * column that grows one day for a reason nobody predicted.
 */
const FAILURE_SUMMARY_LIMIT = 500;

interface AiringRow {
  run_id: string;
  channel_id: string;
  programme_id: string;
  started_at_ms: string | number;
  ended_at_ms: string | number | null;
  replay_disposition: string;
  replay_status: string | null;
  replay_policy: string | null;
  replay_visibility: string | null;
  replay_expires_at_ms: string | number | null;
  replay_finalised_at_ms: string | number | null;
  replay_failure_reason: string | null;
  replay_failure_summary: string | null;
  replay_bytes: string | number | null;
  replay_segment_count: string | number | null;
  replay_init_count: string | number | null;
}

const COLUMNS = `
  run_id, channel_id, programme_id, started_at_ms, ended_at_ms,
  replay_disposition, replay_status, replay_policy, replay_visibility,
  replay_expires_at_ms, replay_finalised_at_ms,
  replay_failure_reason, replay_failure_summary,
  replay_bytes, replay_segment_count, replay_init_count
`;

/** `bigint` arrives as a string from `pg`; a history page needs a number. */
function count(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRecord(row: AiringRow): ProgrammeAiringRecord {
  return {
    identity: {
      channelId: row.channel_id,
      programmeId: row.programme_id,
      runId: row.run_id,
    },
    startedAtMs: count(row.started_at_ms) ?? 0,
    endedAtMs: count(row.ended_at_ms),
    replay: toDisposition(row),
  };
}

function toDisposition(row: AiringRow): ReplayDisposition {
  if (row.replay_disposition !== 'replay') return { disposition: 'none' };
  return {
    disposition: 'replay',
    summary: {
      status: (row.replay_status ?? 'recording') as never,
      retention:
        row.replay_policy === 'expire'
          ? { policy: 'expire', expiresAtMs: count(row.replay_expires_at_ms) ?? 0 }
          : ({ policy: (row.replay_policy ?? 'keep') as 'keep' | 'none' } as never),
      visibility: (row.replay_visibility ?? 'private') as never,
      finalisedAtMs: count(row.replay_finalised_at_ms),
      expiresAtMs: count(row.replay_expires_at_ms),
      failure:
        row.replay_failure_reason === null
          ? null
          : {
              reason: row.replay_failure_reason as never,
              summary: row.replay_failure_summary ?? '',
            },
      bytes: count(row.replay_bytes) ?? 0,
      segmentCount: count(row.replay_segment_count) ?? 0,
      initialisationCount: count(row.replay_init_count) ?? 0,
    },
  };
}

/** The replay columns for one disposition, in the order the statements use. */
function replayValues(replay: ReplayDisposition): readonly unknown[] {
  if (replay.disposition === 'none') {
    return ['none', null, null, null, null, null, null, null, null, null, null];
  }
  const held = replay.summary;
  return [
    'replay',
    held.status,
    held.retention.policy,
    held.visibility,
    held.retention.policy === 'expire' ? held.retention.expiresAtMs : null,
    held.finalisedAtMs,
    held.failure?.reason ?? null,
    /*
     * THE MAPPED SENTENCE, never anything the failure carried. `summariseReplay`
     * has already replaced the archive's operator text -- which can name a
     * spool file -- with wording chosen from a closed set. Clipped as well,
     * because an unbounded column is a column that surprises somebody later.
     */
    held.failure === null ? null : held.failure.summary.slice(0, FAILURE_SUMMARY_LIMIT),
    held.bytes,
    held.segmentCount,
    held.initialisationCount,
  ];
}

/** Take the run's row for update, creating nothing. Null when unknown. */
async function lockRun(client: PoolClient, runId: string): Promise<AiringRow | null> {
  const { rows } = await client.query<AiringRow>(
    `SELECT ${COLUMNS} FROM programme_airings WHERE run_id = $1 FOR UPDATE`,
    [runId],
  );
  return rows[0] ?? null;
}

async function readBack(client: PoolClient, runId: string): Promise<AiringRow> {
  const { rows } = await client.query<AiringRow>(
    `SELECT ${COLUMNS} FROM programme_airings WHERE run_id = $1`,
    [runId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`programme airing ${runId} vanished mid-transaction`);
  return row;
}

export function createPostgresAiringCatalogue(pool: Pool): ProgrammeAiringCatalogue {
  /**
   * Run one mutation inside its own transaction.
   *
   * Failures come back as refusals rather than exceptions: the caller is a
   * reporter that must not turn a database wobble into anything a broadcast
   * notices. The message is bounded and carries the run, never a connection
   * string or a driver's own text.
   */
  async function inTransaction<T>(
    runId: string,
    work: (client: PoolClient) => Promise<AiringOutcome<T>>,
  ): Promise<AiringOutcome<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      return airingRefused('catalogue-unavailable', `no connection to catalogue run ${runId}`);
    }
    try {
      await client.query('BEGIN');
      const outcome = await work(client);
      if (outcome.ok) await client.query('COMMIT');
      else await client.query('ROLLBACK');
      return outcome;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection is already gone; nothing to undo */
      }
      return airingRefused('catalogue-unavailable', `the catalogue could not record run ${runId}`);
    } finally {
      client.release();
    }
  }

  return {
    async recordAiring(airing) {
      const { channelId, programmeId, runId } = airing.identity;
      const replay = airing.replay ?? { disposition: 'none' as const };

      return inTransaction<ProgrammeAiringRecord>(runId, async (client) => {
        const held = await lockRun(client, runId);

        if (held !== null) {
          /*
           * THE IDENTITY IS SETTLED. A retry is welcome; a different channel or
           * programme under the same run id is two sources disagreeing about
           * whose broadcast this was, and picking one silently rewrites a
           * channel's history.
           */
          if (held.channel_id !== channelId || held.programme_id !== programmeId) {
            return airingRefused(
              'identity-conflict',
              `run ${runId} is already recorded against another channel or programme`,
            );
          }
          // Idempotent: the airing exists and its identity agrees. The replay
          // disposition is left to `projectReplay`, which knows the rules.
          return { ok: true, value: toRecord(held) };
        }

        await client.query(
          `INSERT INTO programme_airings (
             run_id, channel_id, programme_id, started_at_ms,
             replay_disposition, replay_status, replay_policy, replay_visibility,
             replay_expires_at_ms, replay_finalised_at_ms,
             replay_failure_reason, replay_failure_summary,
             replay_bytes, replay_segment_count, replay_init_count
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [runId, channelId, programmeId, airing.startedAtMs, ...replayValues(replay)],
        );
        return { ok: true, value: toRecord(await readBack(client, runId)) };
      });
    },

    async projectReplay(runId, replay) {
      return inTransaction<ProgrammeAiringRecord>(runId, async (client) => {
        const held = await lockRun(client, runId);
        if (held === null) {
          return airingRefused('unknown-airing', `no airing is recorded for run ${runId}`);
        }

        const judgement = judgeProjection(toDisposition(held), replay);
        if (judgement.kind === 'conflict') {
          return airingRefused('disposition-conflict', judgement.detail);
        }
        if (judgement.kind === 'stale') {
          /*
           * SUCCESS, NOT A FAILURE. A snapshot from before the current state is
           * ordinary traffic for an at-least-once reporter, and treating it as
           * an error would have operators chasing an alarm that means "a
           * message arrived in a different order than it was sent".
           */
          return { ok: true, value: toRecord(held) };
        }

        await client.query(
          `UPDATE programme_airings SET
             replay_disposition = $2, replay_status = $3, replay_policy = $4,
             replay_visibility = $5, replay_expires_at_ms = $6,
             replay_finalised_at_ms = $7, replay_failure_reason = $8,
             replay_failure_summary = $9, replay_bytes = $10,
             replay_segment_count = $11, replay_init_count = $12,
             updated_at = now()
           WHERE run_id = $1`,
          [runId, ...replayValues(replay)],
        );
        return { ok: true, value: toRecord(await readBack(client, runId)) };
      });
    },

    async finishAiring(runId, endedAtMs) {
      return inTransaction<ProgrammeAiringRecord>(runId, async (client) => {
        const held = await lockRun(client, runId);
        if (held === null) {
          return airingRefused('unknown-airing', `no airing is recorded for run ${runId}`);
        }
        // Already ended: keep the first answer. A broadcast ends once, and a
        // repeated report must not move the time it ended.
        if (held.ended_at_ms !== null) return { ok: true, value: toRecord(held) };

        await client.query(
          `UPDATE programme_airings SET ended_at_ms = $2, updated_at = now()
           WHERE run_id = $1 AND ended_at_ms IS NULL`,
          [runId, endedAtMs],
        );
        return { ok: true, value: toRecord(await readBack(client, runId)) };
      });
    },

    async findByRunId(runId) {
      const { rows } = await pool.query<AiringRow>(
        `SELECT ${COLUMNS} FROM programme_airings WHERE run_id = $1`,
        [runId],
      );
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async listByChannel(channelId, query) {
      return list('channel_id', channelId, query);
    },

    async listByProgramme(programmeId, query) {
      return list('programme_id', programmeId, query);
    },
  };

  /**
   * One page of history, newest first, resumable from where the last ended.
   *
   * KEYSET, NOT OFFSET. History grows while somebody reads it: a broadcast
   * ending between page one and page two shifts an offset and the reader sees
   * one airing twice and misses another. The cursor names the last row seen, so
   * the pages stay stable however much is appended.
   *
   * The column is chosen from a fixed pair by the two callers above and is
   * never caller-supplied text; every value is a parameter.
   */
  async function list(
    column: 'channel_id' | 'programme_id',
    value: string,
    query: AiringQuery | undefined,
  ): Promise<ProgrammeAiringPage> {
    const limit = pageSize(query);
    const after = query?.after;
    // One more than asked for, so the presence of a next page is known without
    // a second count query.
    const { rows } = after === undefined
      ? await pool.query<AiringRow>(
          `SELECT ${COLUMNS} FROM programme_airings
           WHERE ${column} = $1
           ORDER BY started_at_ms DESC, run_id DESC
           LIMIT $2`,
          [value, limit + 1],
        )
      : await pool.query<AiringRow>(
          `SELECT ${COLUMNS} FROM programme_airings
           WHERE ${column} = $1
             AND (started_at_ms, run_id) < ($2, $3)
           ORDER BY started_at_ms DESC, run_id DESC
           LIMIT $4`,
          [value, after.startedAtMs, after.runId, limit + 1],
        );

    const page = rows.slice(0, limit).map(toRecord);
    const last = page[page.length - 1];
    return {
      airings: page,
      next:
        rows.length > limit && last !== undefined
          ? { startedAtMs: last.startedAtMs, runId: last.identity.runId }
          : null,
    };
  }
}
