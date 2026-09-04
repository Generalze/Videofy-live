/** @author masterzee001 */
/**
 * Postgres port for channel follows. See channel-follows.ts.
 *
 * One COLUMNS constant, interpolated by every statement, so the write list
 * and the read list cannot drift -- the accounts port's bug, made impossible
 * rather than tested for.
 */
import type { Pool } from 'pg';
import type { ChannelFollow, ChannelFollowPort } from '../channel-follows.js';

const COLUMNS = 'account_id, channel_id, followed_at_ms, remind';

interface Row {
  account_id: string;
  channel_id: string;
  followed_at_ms: string;
  remind: boolean;
}

function toFollow(row: Row): ChannelFollow {
  return {
    accountId: row.account_id,
    channelId: row.channel_id,
    followedAtMs: Number(row.followed_at_ms),
    remind: row.remind,
  };
}

export function createPostgresChannelFollows(pool: Pool): ChannelFollowPort {
  return {
    async upsert(follow) {
      await pool.query(
        `INSERT INTO channel_follows (${COLUMNS})
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, channel_id) DO UPDATE SET
           remind = EXCLUDED.remind`,
        [follow.accountId, follow.channelId, follow.followedAtMs, follow.remind],
      );
    },
    async remove(accountId, channelId) {
      await pool.query(`DELETE FROM channel_follows WHERE account_id = $1 AND channel_id = $2`, [
        accountId,
        channelId,
      ]);
    },
    async followsOf(accountId) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM channel_follows WHERE account_id = $1 ORDER BY followed_at_ms DESC`,
        [accountId],
      );
      return result.rows.map(toFollow);
    },
    async followersOf(channelId) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM channel_follows WHERE channel_id = $1`,
        [channelId],
      );
      return result.rows.map(toFollow);
    },
    async countFor(channelIds) {
      const counts = new Map<string, number>();
      if (channelIds.length === 0) return counts;
      const result = await pool.query<{ channel_id: string; count: string }>(
        `SELECT channel_id, count(*) AS count FROM channel_follows
          WHERE channel_id = ANY($1::text[])
          GROUP BY channel_id`,
        [[...channelIds]],
      );
      for (const row of result.rows) counts.set(row.channel_id, Number(row.count));
      return counts;
    },
    async countOf(accountId) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM channel_follows WHERE account_id = $1`,
        [accountId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}
