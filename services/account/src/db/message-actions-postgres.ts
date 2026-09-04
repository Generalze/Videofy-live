/** @author masterzee001 */
/**
 * One reader's facts about messages, in Postgres. See message-actions.ts.
 *
 * EVERY WRITE IS AN UPSERT OR A DELETE keyed by the (message_id, account_id)
 * primary key, so a doubled tap -- two hides, two identical reactions -- is
 * one row, never an error the client has to explain. Reads take a list of
 * message ids and answer with `= ANY($1)`, one round trip per page rather
 * than one per message.
 */
import type { Pool } from 'pg';
import type {
  ConversationSettings,
  MessageActionPort,
  MessageReaction,
} from '../message-actions.js';
import { DEFAULT_CONVERSATION_SETTINGS } from '../message-actions.js';

export function createPostgresMessageActions(pool: Pool): MessageActionPort {
  return {
    async hide(messageId, accountId, atMs) {
      await pool.query(
        `INSERT INTO message_hides (message_id, account_id, hidden_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, account_id) DO NOTHING`,
        [messageId, accountId, atMs],
      );
    },

    async unhide(messageId, accountId) {
      await pool.query(`DELETE FROM message_hides WHERE message_id = $1 AND account_id = $2`, [
        messageId,
        accountId,
      ]);
    },

    async hiddenFor(accountId, messageIds) {
      if (messageIds.length === 0) return new Set();
      const result = await pool.query<{ message_id: string }>(
        `SELECT message_id FROM message_hides
          WHERE account_id = $1 AND message_id = ANY($2::text[])`,
        [accountId, [...messageIds]],
      );
      return new Set(result.rows.map((row) => row.message_id));
    },

    async setReaction(messageId, accountId, emoji, atMs) {
      if (emoji === null) {
        await pool.query(
          `DELETE FROM message_reactions WHERE message_id = $1 AND account_id = $2`,
          [messageId, accountId],
        );
        return;
      }
      await pool.query(
        `INSERT INTO message_reactions (message_id, account_id, emoji, reacted_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id, account_id) DO UPDATE SET
           emoji         = EXCLUDED.emoji,
           reacted_at_ms = EXCLUDED.reacted_at_ms`,
        [messageId, accountId, emoji, atMs],
      );
    },

    async reactionsFor(messageIds) {
      const byMessage = new Map<string, MessageReaction[]>();
      if (messageIds.length === 0) return byMessage;
      const result = await pool.query<{ message_id: string; account_id: string; emoji: string }>(
        `SELECT message_id, account_id, emoji FROM message_reactions
          WHERE message_id = ANY($1::text[])
          ORDER BY reacted_at_ms ASC`,
        [[...messageIds]],
      );
      for (const row of result.rows) {
        const list = byMessage.get(row.message_id) ?? [];
        list.push({ accountId: row.account_id, emoji: row.emoji });
        byMessage.set(row.message_id, list);
      }
      return byMessage;
    },

    async setPin(messageId, accountId, pinned, atMs) {
      if (!pinned) {
        await pool.query(`DELETE FROM message_pins WHERE message_id = $1 AND account_id = $2`, [
          messageId,
          accountId,
        ]);
        return;
      }
      await pool.query(
        `INSERT INTO message_pins (message_id, account_id, pinned_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, account_id) DO NOTHING`,
        [messageId, accountId, atMs],
      );
    },

    async pinnedFor(accountId, messageIds) {
      if (messageIds.length === 0) return new Set();
      const result = await pool.query<{ message_id: string }>(
        `SELECT message_id FROM message_pins
          WHERE account_id = $1 AND message_id = ANY($2::text[])`,
        [accountId, [...messageIds]],
      );
      return new Set(result.rows.map((row) => row.message_id));
    },

    async pinnedMessageIds(accountId) {
      const result = await pool.query<{ message_id: string }>(
        `SELECT message_id FROM message_pins WHERE account_id = $1 ORDER BY pinned_at_ms DESC`,
        [accountId],
      );
      return result.rows.map((row) => row.message_id);
    },

    async setSettings(accountId, partnerId, settings, atMs) {
      await pool.query(
        `INSERT INTO conversation_settings (account_id, partner_id, muted, archived, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, partner_id) DO UPDATE SET
           muted         = EXCLUDED.muted,
           archived      = EXCLUDED.archived,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [accountId, partnerId, settings.muted, settings.archived, atMs],
      );
    },

    async settings(accountId, partnerId) {
      const result = await pool.query<{ muted: boolean; archived: boolean }>(
        `SELECT muted, archived FROM conversation_settings
          WHERE account_id = $1 AND partner_id = $2`,
        [accountId, partnerId],
      );
      const row = result.rows[0];
      return row === undefined
        ? DEFAULT_CONVERSATION_SETTINGS
        : { muted: row.muted, archived: row.archived };
    },

    async settingsFor(accountId) {
      const result = await pool.query<{ partner_id: string; muted: boolean; archived: boolean }>(
        `SELECT partner_id, muted, archived FROM conversation_settings WHERE account_id = $1`,
        [accountId],
      );
      const out = new Map<string, ConversationSettings>();
      for (const row of result.rows) {
        out.set(row.partner_id, { muted: row.muted, archived: row.archived });
      }
      return out;
    },
  };
}
