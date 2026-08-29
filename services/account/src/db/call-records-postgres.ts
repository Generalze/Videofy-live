/** @author masterzee001 */
/** Postgres port for call history. See call-records.ts. */
import type { Pool } from 'pg';
import type { CallOutcome, CallRecord, CallRecordPort } from '../call-records.js';

const COLUMNS =
  'call_id, low_account_id, high_account_id, caller_account_id, peer_account_id, mode, created_at_ms, answered_at_ms, connected_at_ms, ended_at_ms, outcome, ended_by_account_id, duration_seconds';

interface Row {
  call_id: string;
  low_account_id: string;
  high_account_id: string;
  caller_account_id: string;
  peer_account_id: string;
  mode: string;
  created_at_ms: string;
  answered_at_ms: string | null;
  connected_at_ms: string | null;
  ended_at_ms: string;
  outcome: string;
  ended_by_account_id: string | null;
  duration_seconds: number;
}

function toRecord(row: Row): CallRecord {
  return {
    callId: row.call_id,
    lowAccountId: row.low_account_id,
    highAccountId: row.high_account_id,
    callerAccountId: row.caller_account_id,
    peerAccountId: row.peer_account_id,
    mode: row.mode === 'translated' ? 'translated' : 'normal',
    createdAtMs: Number(row.created_at_ms),
    answeredAtMs: row.answered_at_ms === null ? null : Number(row.answered_at_ms),
    connectedAtMs: row.connected_at_ms === null ? null : Number(row.connected_at_ms),
    endedAtMs: Number(row.ended_at_ms),
    outcome: row.outcome as CallOutcome,
    endedByAccountId: row.ended_by_account_id,
    durationSeconds: row.duration_seconds,
  };
}

export function createPostgresCallRecords(pool: Pool): CallRecordPort {
  return {
    async upsert(record) {
      await pool.query(
        `INSERT INTO call_records (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (call_id) DO UPDATE SET
           answered_at_ms      = EXCLUDED.answered_at_ms,
           connected_at_ms     = EXCLUDED.connected_at_ms,
           ended_at_ms         = EXCLUDED.ended_at_ms,
           outcome             = EXCLUDED.outcome,
           ended_by_account_id = EXCLUDED.ended_by_account_id,
           duration_seconds    = EXCLUDED.duration_seconds`,
        [
          record.callId,
          record.lowAccountId,
          record.highAccountId,
          record.callerAccountId,
          record.peerAccountId,
          record.mode,
          record.createdAtMs,
          record.answeredAtMs,
          record.connectedAtMs,
          record.endedAtMs,
          record.outcome,
          record.endedByAccountId,
          record.durationSeconds,
        ],
      );
    },
    async forPair(low, high, limit) {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM call_records
          WHERE low_account_id = $1 AND high_account_id = $2
          ORDER BY ended_at_ms DESC
          LIMIT $3`,
        [low, high, limit],
      );
      return (result.rows as Row[]).map(toRecord);
    },
    async countForAccount(accountId) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM call_records WHERE low_account_id = $1 OR high_account_id = $1`,
        [accountId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}
