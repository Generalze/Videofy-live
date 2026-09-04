/** @author masterzee001 */
/** Postgres port for conversation translation modes. See conversation-modes.ts. */
import type { Pool } from 'pg';
import type { ConversationModePort, ConversationModeRecord } from '../conversation-modes.js';

export function createPostgresConversationModes(pool: Pool): ConversationModePort {
  return {
    async get(lowAccountId, highAccountId) {
      const result = await pool.query(
        `SELECT low_account_id, high_account_id, mode, set_by_account_id, updated_at_ms
           FROM conversation_modes
          WHERE low_account_id = $1 AND high_account_id = $2`,
        [lowAccountId, highAccountId],
      );
      const row = result.rows[0] as
        | {
            low_account_id: string;
            high_account_id: string;
            mode: string;
            set_by_account_id: string;
            updated_at_ms: string | number;
          }
        | undefined;
      if (!row) return null;
      return {
        lowAccountId: row.low_account_id,
        highAccountId: row.high_account_id,
        mode: row.mode === 'translated' ? 'translated' : 'normal',
        setByAccountId: row.set_by_account_id,
        updatedAtMs: Number(row.updated_at_ms),
      };
    },
    async set(record: ConversationModeRecord) {
      await pool.query(
        `INSERT INTO conversation_modes
           (low_account_id, high_account_id, mode, set_by_account_id, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (low_account_id, high_account_id) DO UPDATE SET
           mode              = EXCLUDED.mode,
           set_by_account_id = EXCLUDED.set_by_account_id,
           updated_at_ms     = EXCLUDED.updated_at_ms`,
        [
          record.lowAccountId,
          record.highAccountId,
          record.mode,
          record.setByAccountId,
          record.updatedAtMs,
        ],
      );
    },
  };
}
