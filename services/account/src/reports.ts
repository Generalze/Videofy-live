/** @author masterzee001 */
/**
 * Reporting a person, or one of their messages.
 *
 * WRITE-ONLY FROM THE PRODUCT'S SIDE. Nothing public reads a report back:
 * not the reporter, not the reported, not a count. A report is evidence for
 * moderation, and an endpoint that echoed it would tell a harasser whether
 * their target had complained.
 *
 * THE MESSAGE IS REFERENCED, NEVER COPIED. A report names a message id; the
 * message row is the evidence and is read by a moderator with the right to
 * read it. Copying the text here would be a second place message content
 * lives, outside every rule the message store enforces about it.
 *
 * RATE LIMITED PER REPORTER, and the limit is counted from the store rather
 * than an in-memory window so a restart does not reset it.
 */

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'abuse' | 'impersonation' | 'other';
export const REPORT_REASONS: readonly ReportReason[] = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'abuse', 'impersonation', 'other'];
export const REPORT_NOTE_MAX_LENGTH = 500;
export const REPORTS_PER_HOUR = 10;

export interface Report {
  readonly reportId: string;
  readonly reporterAccountId: string;
  readonly targetAccountId: string;
  readonly messageId: string | null;
  readonly reason: ReportReason;
  readonly note: string;
  readonly createdAtMs: number;
}

export interface ReportPort {
  insert(report: Report): Promise<void>;
  /** Reports this person filed since `sinceMs`. The rate-limit question. */
  countByReporterSince(reporterAccountId: string, sinceMs: number): Promise<number>;
}

export function createInMemoryReportPort(): ReportPort {
  const rows = new Map<string, Report>();
  return {
    async insert(report) {
      rows.set(report.reportId, report);
    },
    async countByReporterSince(reporterAccountId, sinceMs) {
      return [...rows.values()].filter(
        (row) => row.reporterAccountId === reporterAccountId && row.createdAtMs >= sinceMs,
      ).length;
    },
  };
}

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}
