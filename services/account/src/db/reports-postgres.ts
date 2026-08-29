/** @author masterzee001 */
/** Postgres port for reports. See reports.ts. One COLUMNS constant, like the others. */
import type { Pool } from 'pg';
import type { ReportPort } from '../reports.js';

const COLUMNS =
  'report_id, reporter_account_id, target_account_id, message_id, reason, note, created_at_ms';

export function createPostgresReports(pool: Pool): ReportPort {
  return {
    async insert(report) {
      await pool.query(
        `INSERT INTO reports (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (report_id) DO NOTHING`,
        [
          report.reportId,
          report.reporterAccountId,
          report.targetAccountId,
          report.messageId,
          report.reason,
          report.note,
          report.createdAtMs,
        ],
      );
    },
    async countByReporterSince(reporterAccountId, sinceMs) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM reports WHERE reporter_account_id = $1 AND created_at_ms >= $2`,
        [reporterAccountId, sinceMs],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}
