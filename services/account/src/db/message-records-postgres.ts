/** @author masterzee001 */
/**
 * Messages, in Postgres.
 *
 * ONE COLUMN LIST interpolated into every statement, the same discipline as the
 * tariff and device ports and for the same reason: an INSERT and a SELECT that
 * drift apart fail silently, on a restart, in a field somebody needed.
 *
 * SUMMARIES ARE TWO QUERIES, deliberately. "Latest message per pair" and
 * "unread count per pair" each have a clean, index-friendly shape; welding them
 * into one clever query trades legibility for nothing measurable at this scale.
 * They are merged in JS, keyed by the pair.
 */
import type { Pool } from 'pg';
import type {
  ConversationSummary,
  MessageKind,
  MessageRecord,
  MessageRecordPort,
} from '../message-store.js';

interface MessageRow {
  message_id: string;
  low_account_id: string;
  high_account_id: string;
  sender_id: string;
  kind: string;
  body: string | null;
  translated_body: string | null;
  translated_language: string | null;
  media_path: string | null;
  media_duration_ms: number | null;
  /** bigint arrives as a STRING from node-postgres. Converted deliberately. */
  created_at_ms: string;
  read_at_ms: string | null;
}

const COLUMNS =
  'message_id, low_account_id, high_account_id, sender_id, kind, body, translated_body, translated_language, media_path, media_duration_ms, created_at_ms, read_at_ms';

function toRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    lowAccountId: row.low_account_id,
    highAccountId: row.high_account_id,
    senderId: row.sender_id,
    kind: row.kind as MessageKind,
    body: row.body,
    translatedBody: row.translated_body,
    translatedLanguage: row.translated_language,
    mediaPath: row.media_path,
    mediaDurationMs: row.media_duration_ms,
    createdAtMs: Number(row.created_at_ms),
    readAtMs: row.read_at_ms === null ? null : Number(row.read_at_ms),
  };
}

export function createPostgresMessageRecords(pool: Pool): MessageRecordPort {
  return {
    async append(record) {
      await pool.query(
        `INSERT INTO messages (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          record.messageId,
          record.lowAccountId,
          record.highAccountId,
          record.senderId,
          record.kind,
          record.body,
          record.translatedBody ?? null,
          record.translatedLanguage ?? null,
          record.mediaPath,
          record.mediaDurationMs,
          record.createdAtMs,
          record.readAtMs,
        ],
      );
    },

    async conversation(low, high, options) {
      const before = options.beforeMs;
      const result =
        before === undefined
          ? await pool.query<MessageRow>(
              `SELECT ${COLUMNS} FROM messages
               WHERE low_account_id = $1 AND high_account_id = $2
               ORDER BY created_at_ms DESC LIMIT $3`,
              [low, high, options.limit],
            )
          : await pool.query<MessageRow>(
              `SELECT ${COLUMNS} FROM messages
               WHERE low_account_id = $1 AND high_account_id = $2 AND created_at_ms < $3
               ORDER BY created_at_ms DESC LIMIT $4`,
              [low, high, before, options.limit],
            );
      return result.rows.map(toRecord);
    },

    async summaries(accountId) {
      const latest = await pool.query<MessageRow>(
        `SELECT DISTINCT ON (low_account_id, high_account_id) ${COLUMNS}
         FROM messages
         WHERE low_account_id = $1 OR high_account_id = $1
         ORDER BY low_account_id, high_account_id, created_at_ms DESC`,
        [accountId],
      );
      const unread = await pool.query<{
        low_account_id: string;
        high_account_id: string;
        unread: string;
      }>(
        `SELECT low_account_id, high_account_id, count(*) AS unread
         FROM messages
         WHERE (low_account_id = $1 OR high_account_id = $1)
           AND sender_id <> $1 AND read_at_ms IS NULL
         GROUP BY low_account_id, high_account_id`,
        [accountId],
      );

      const unreadByPair = new Map<string, number>();
      for (const row of unread.rows) {
        unreadByPair.set(`${row.low_account_id} ${row.high_account_id}`, Number(row.unread));
      }

      const summaries: ConversationSummary[] = latest.rows.map((row) => {
        const last = toRecord(row);
        return {
          partnerId: last.lowAccountId === accountId ? last.highAccountId : last.lowAccountId,
          last,
          unread: unreadByPair.get(`${row.low_account_id} ${row.high_account_id}`) ?? 0,
        };
      });
      return summaries.sort((a, b) => b.last.createdAtMs - a.last.createdAtMs);
    },

    async markRead(low, high, readerId, atMs) {
      const result = await pool.query(
        `UPDATE messages SET read_at_ms = $4
         WHERE low_account_id = $1 AND high_account_id = $2
           AND sender_id <> $3 AND read_at_ms IS NULL`,
        [low, high, readerId, atMs],
      );
      return result.rowCount ?? 0;
    },

    async get(messageId) {
      const result = await pool.query<MessageRow>(
        `SELECT ${COLUMNS} FROM messages WHERE message_id = $1`,
        [messageId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };
}
