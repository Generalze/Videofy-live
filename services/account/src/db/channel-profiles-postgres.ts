/** @author masterzee001 */
/**
 * Postgres port for channel profiles. See channel-profiles.ts.
 *
 * One COLUMNS constant, interpolated by every statement, so the write list
 * and the read list cannot drift -- the accounts port's bug, made impossible
 * rather than tested for.
 *
 * THE THREE UNIQUENESSES ARE THE DATABASE'S. channel_id is the primary key,
 * owner_account_id is UNIQUE, and lower(handle) carries a unique index. An
 * insert that collides with any of them inserts nothing (the conflict clause
 * says DO NOTHING) and the port then looks to see WHICH, so the service can
 * answer "handle taken" and try the next candidate without parsing an error.
 */
import type { Pool } from 'pg';
import type { ChannelProfilePort, ChannelProfileRecord } from '../channel-profiles.js';
import type { ChannelCategory, ChannelVisibility } from '@videofy-live/shared-types';

const COLUMNS =
  'channel_id, owner_account_id, handle, display_name, description, category, visibility, avatar_ref, banner_ref, created_at_ms, updated_at_ms';

interface Row {
  channel_id: string;
  owner_account_id: string;
  handle: string;
  display_name: string;
  description: string;
  category: string | null;
  visibility: string;
  avatar_ref: string | null;
  banner_ref: string | null;
  created_at_ms: string;
  updated_at_ms: string;
}

function toRecord(row: Row): ChannelProfileRecord {
  return {
    channelId: row.channel_id,
    ownerAccountId: row.owner_account_id,
    handle: row.handle,
    displayName: row.display_name,
    description: row.description,
    // The CHECK constraints in migration 020 hold these to the controlled
    // lists; the casts state that rather than re-validate on every read.
    category: row.category as ChannelCategory | null,
    visibility: row.visibility as ChannelVisibility,
    avatarRef: row.avatar_ref,
    bannerRef: row.banner_ref,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

/** Postgres's unique_violation; the only error an UPDATE here can raise by design. */
const UNIQUE_VIOLATION = '23505';

export function createPostgresChannelProfiles(pool: Pool): ChannelProfilePort {
  const one = async (where: string, value: string): Promise<ChannelProfileRecord | null> => {
    const result = await pool.query<Row>(
      `SELECT ${COLUMNS} FROM channel_profiles WHERE ${where} = $1`,
      [value],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  };
  return {
    get(channelId) {
      return one('channel_id', channelId);
    },
    async getMany(channelIds) {
      const found = new Map<string, ChannelProfileRecord>();
      if (channelIds.length === 0) return found;
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM channel_profiles WHERE channel_id = ANY($1::text[])`,
        [[...channelIds]],
      );
      for (const row of result.rows) found.set(row.channel_id, toRecord(row));
      return found;
    },
    byOwner(ownerAccountId) {
      return one('owner_account_id', ownerAccountId);
    },
    byHandle(handle) {
      return one('lower(handle)', handle.toLowerCase());
    },
    async insert(record) {
      const result = await pool.query(
        `INSERT INTO channel_profiles (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [
          record.channelId,
          record.ownerAccountId,
          record.handle,
          record.displayName,
          record.description,
          record.category,
          record.visibility,
          record.avatarRef,
          record.bannerRef,
          record.createdAtMs,
          record.updatedAtMs,
        ],
      );
      if ((result.rowCount ?? 0) > 0) return 'inserted';
      if ((await one('channel_id', record.channelId)) !== null) return 'channel-exists';
      if ((await one('owner_account_id', record.ownerAccountId)) !== null) return 'owner-exists';
      return 'handle-taken';
    },
    async update(record) {
      try {
        const result = await pool.query(
          `UPDATE channel_profiles SET
             owner_account_id = $2,
             handle = $3,
             display_name = $4,
             description = $5,
             category = $6,
             visibility = $7,
             avatar_ref = $8,
             banner_ref = $9,
             created_at_ms = $10,
             updated_at_ms = $11
           WHERE channel_id = $1`,
          [
            record.channelId,
            record.ownerAccountId,
            record.handle,
            record.displayName,
            record.description,
            record.category,
            record.visibility,
            record.avatarRef,
            record.bannerRef,
            record.createdAtMs,
            record.updatedAtMs,
          ],
        );
        return (result.rowCount ?? 0) > 0 ? 'updated' : 'missing';
      } catch (error) {
        if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) return 'handle-taken';
        throw error;
      }
    },
  };
}
