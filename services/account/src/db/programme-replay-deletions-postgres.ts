/** @author masterzee001 */
/**
 * Deletion requests as durable work, claimed by one worker at a time.
 *
 * `FOR UPDATE SKIP LOCKED` IS THE WHOLE MECHANISM, and the reason is worth
 * stating plainly. Two workers polling the same table will select the same rows
 * within microseconds of each other; a plain `SELECT` hands both of them the
 * same request, both delete the same recording, and the loser's report describes
 * a state that was never true. `FOR UPDATE` makes the second one wait; the
 * `SKIP LOCKED` makes it take the NEXT row instead, so two workers do twice the
 * work rather than one worker's work twice.
 *
 * AND A LEASE ON TOP OF THE LOCK, because they protect against different
 * things. The row lock lives inside the claiming transaction and is gone the
 * moment that transaction ends -- which is correct, and useless when the worker
 * is killed between claiming and settling. `claim_expires_at` is what makes an
 * abandoned claim reclaimable after a bounded wait, without anybody having to
 * notice a process died.
 *
 * A DEFERRAL IS NOT A FAILURE. A request about a broadcast that is still on air
 * comes back later at full attempt count; a request the archive refused comes
 * back with a back-off and its attempt counted. They are different facts and the
 * table keeps them apart, because "we chose not to yet" and "we tried and could
 * not" call for different attention.
 *
 * NOTHING HERE HOLDS A PATH, and the driver's own error text never becomes a
 * stored detail: this is read by operators.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  ReplayDeletionQueue,
  ReplayDeletionRequest,
  ReplayDeletionSettlement,
} from '@videofy-live/programme-replay';

/**
 * How long a claim is held before another worker may take it.
 *
 * Long enough that an ordinary delete -- which is a state write and a handful of
 * object removals -- finishes inside it, short enough that a killed worker does
 * not strand a request for an afternoon.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * How long a refused request waits before it is tried again.
 *
 * Fixed rather than exponential, on purpose. The failures this backs off from
 * are an archive that is briefly unreachable, not a thundering herd: a request
 * arrives at human pace and there is one of it. An exponential schedule would
 * add state to store and a long tail nobody wants during an incident.
 */
const RETRY_AFTER_MS = 60_000;

/** How long a deferral waits. A broadcast finishing is a minutes-scale event. */
const DEFER_AFTER_MS = 2 * 60_000;

/** How much wording the table will hold about one attempt. */
const DETAIL_LIMIT = 500;

interface DeletionRow {
  request_id: string;
  run_id: string;
  requested_at_ms: string | number;
  attempts: number;
}

export interface PostgresReplayDeletionQueue extends ReplayDeletionQueue {
  /**
   * Ask for a recording to be removed.
   *
   * IDEMPOTENT PER RUN WHILE ONE IS OUTSTANDING. Asking twice collapses onto the
   * same request rather than queueing two deletes of one recording -- and
   * because the index is partial, a run deleted long ago can be asked about
   * again if it ever comes back.
   */
  request(runId: string, requestId: string, nowMs: number): Promise<'queued' | 'already-queued'>;
}

export function createPostgresReplayDeletionQueue(pool: Pool): PostgresReplayDeletionQueue {
  return {
    async request(runId, requestId, nowMs) {
      const { rows } = await pool.query<{ request_id: string }>(
        `INSERT INTO programme_replay_deletions (
           request_id, run_id, requested_at_ms, state, visible_at_ms
         ) VALUES ($1, $2, $3, 'pending', $3)
         ON CONFLICT DO NOTHING
         RETURNING request_id`,
        [requestId, runId, nowMs],
      );
      // ON CONFLICT covers both the primary key and the partial unique index:
      // the same request id twice, and a second request for a run that already
      // has one outstanding, are both "already asked".
      return rows.length === 0 ? 'already-queued' : 'queued';
    },

    async claim(limit, nowMs) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        /*
         * SKIP LOCKED, AND THE LEASE IN THE SAME PREDICATE. A row is claimable
         * when it is pending, due, and either unclaimed or claimed by somebody
         * who has stopped answering. Both conditions live here rather than in
         * the application, so two workers cannot disagree about what is free.
         */
        const { rows } = await client.query<DeletionRow>(
          `SELECT request_id, run_id, requested_at_ms, attempts
             FROM programme_replay_deletions
            WHERE state = 'pending'
              AND visible_at_ms <= $1
              AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
            ORDER BY visible_at_ms
            LIMIT $2
              FOR UPDATE SKIP LOCKED`,
          [nowMs, limit],
        );
        if (rows.length > 0) {
          await client.query(
            `UPDATE programme_replay_deletions
                SET claim_expires_at = $2, updated_at = now()
              WHERE request_id = ANY($1::text[])`,
            [rows.map((row) => row.request_id), nowMs + CLAIM_LEASE_MS],
          );
        }
        await client.query('COMMIT');
        return rows.map(
          (row): ReplayDeletionRequest => ({
            requestId: row.request_id,
            runId: row.run_id,
            requestedAtMs: Number(row.requested_at_ms),
            attempts: row.attempts,
          }),
        );
      } catch (error) {
        await rollback(client);
        /*
         * NOTHING IS CLAIMED. The worker reports a refusal for the pass rather
         * than an empty batch, which is honest: "there was no work" and "the
         * queue could not be read" are different facts and only one of them is
         * a reason to look at something.
         */
        throw new Error(`replay deletion requests could not be claimed: ${describe(error)}`);
      } finally {
        client.release();
      }
    },

    async settle(requestId, settlement, detail, nowMs) {
      const trimmed = detail.slice(0, DETAIL_LIMIT);
      if (settlement === 'done') {
        await pool.query(
          `UPDATE programme_replay_deletions
              SET state = 'done', claim_expires_at = NULL,
                  attempts = attempts + 1, last_detail = $2, updated_at = now()
            WHERE request_id = $1`,
          [requestId, trimmed],
        );
        return;
      }

      /*
       * A DEFERRAL DOES NOT COUNT AS AN ATTEMPT. The request was not tried --
       * the broadcast was still on air and a background queue is the last thing
       * that should reach into one. Counting it would eventually make a
       * long-running programme look like a failing request.
       */
      const attempted = settlement === 'retry';
      await pool.query(
        `UPDATE programme_replay_deletions
            SET state = 'pending', claim_expires_at = NULL,
                visible_at_ms = $2,
                attempts = attempts + $3,
                last_detail = $4, updated_at = now()
          WHERE request_id = $1`,
        [requestId, nowMs + (attempted ? RETRY_AFTER_MS : DEFER_AFTER_MS), attempted ? 1 : 0, trimmed],
      );
    },
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The transaction is already gone; there is nothing left to undo.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { CLAIM_LEASE_MS, RETRY_AFTER_MS, DEFER_AFTER_MS };
export type { ReplayDeletionSettlement };
