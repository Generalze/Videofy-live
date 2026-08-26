/** @author masterzee001 */
/**
 * Devices, in Postgres.
 *
 * A DEVICE LIST THAT EMPTIES ON DEPLOY IS NOT A DEVICE LIST. Every phone would
 * silently stop ringing until its owner next opened the app, and nothing would
 * report it -- the calls simply would not arrive.
 *
 * ONE COLUMN LIST, interpolated into both statements, so the INSERT and the
 * SELECT cannot drift apart. That drift is not hypothetical here: an accounts
 * SELECT once ran five columns behind its INSERT and returned a username of
 * null after every restart, and nothing failed until a person noticed.
 */
import type { Pool } from 'pg';
import type { DevicePlatform, DeviceRecord, DeviceRecordPort } from '../device-store.js';

interface DeviceRow {
  device_id: string;
  account_id: string;
  platform: string;
  push_token: string;
  label: string;
  /** bigint, which node-postgres returns as a STRING. Converted deliberately. */
  registered_at_ms: string;
  last_seen_at_ms: string;
}

const COLUMNS =
  'device_id, account_id, platform, push_token, label, registered_at_ms, last_seen_at_ms';

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    accountId: row.account_id,
    platform: row.platform as DevicePlatform,
    pushToken: row.push_token,
    label: row.label,
    registeredAtMs: Number(row.registered_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms),
  };
}

export function createPostgresDeviceRecords(pool: Pool): DeviceRecordPort {
  return {
    async all() {
      const result = await pool.query<DeviceRow>(`SELECT ${COLUMNS} FROM devices`);
      return result.rows.map(toRecord);
    },

    async save(record) {
      /*
       * Upsert on the device, because a client re-registers on every launch and
       * that is a heartbeat rather than a new device. The application has
       * already removed any other row holding this token, so the unique index
       * on push_token cannot be violated by this statement.
       */
      await pool.query(
        `INSERT INTO devices (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (device_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           platform = EXCLUDED.platform,
           push_token = EXCLUDED.push_token,
           label = EXCLUDED.label,
           registered_at_ms = EXCLUDED.registered_at_ms,
           last_seen_at_ms = EXCLUDED.last_seen_at_ms`,
        [
          record.deviceId,
          record.accountId,
          record.platform,
          record.pushToken,
          record.label,
          record.registeredAtMs,
          record.lastSeenAtMs,
        ],
      );
    },

    async remove(deviceId) {
      await pool.query('DELETE FROM devices WHERE device_id = $1', [deviceId]);
    },
  };
}
