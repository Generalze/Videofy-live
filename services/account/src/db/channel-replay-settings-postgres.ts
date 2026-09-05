/** @author masterzee001 */
/**
 * A channel's standing answer about keeping its broadcasts.
 *
 * WHY THIS IS ITS OWN TABLE AND ITS OWN PORT rather than four more fields on
 * `ChannelProfile`. A profile is what a viewer is shown -- a name, a handle, an
 * avatar, whether the channel is listed. Retention is what an operator
 * instructs, and it is read by a completely different consumer at a completely
 * different moment: the media service, when a broadcast opens. Folding them
 * together would put operator policy inside the shape that is serialised to the
 * public, which is the sort of adjacency that becomes a leak the first time
 * somebody adds a field without thinking about both audiences.
 *
 * NO ROW IS AN ANSWER. `read` returning null means this channel has not been
 * configured, and the resolver treats that as a refusal rather than a default.
 * An adapter that invented an empty settings object here would defeat the whole
 * point one layer below where anybody would look for it.
 *
 * VALIDATED BEFORE IT IS WRITTEN, by the same function the resolver uses. The
 * CHECK constraints in the migration say the same things again; neither is
 * redundant. A constraint catches anything reaching the table by another route,
 * and this catches an operator's mistake with a sentence they can act on.
 */

import type { Pool } from 'pg';
import {
  validateChannelReplaySettings,
  type ChannelReplaySettings,
  type ChannelReplaySettingsStore,
  type SettingsOutcome,
} from '@videofy-live/programme-replay-policy';

interface SettingsRow {
  channel_id: string;
  default_policy: string;
  default_duration_days: string | number | null;
  default_visibility: string;
  allow_overrides: boolean;
}

const COLUMNS = `
  channel_id, default_policy, default_duration_days, default_visibility, allow_overrides
`;

function toSettings(row: SettingsRow): ChannelReplaySettings {
  const days = row.default_duration_days;
  return {
    channelId: row.channel_id,
    defaultPolicy: row.default_policy as ChannelReplaySettings['defaultPolicy'],
    defaultDurationDays: days === null || days === undefined ? null : Number(days),
    defaultVisibility: row.default_visibility as ChannelReplaySettings['defaultVisibility'],
    allowOverrides: row.allow_overrides,
  };
}

export function createPostgresChannelReplaySettings(pool: Pool): ChannelReplaySettingsStore {
  return {
    async read(channelId) {
      const { rows } = await pool.query<SettingsRow>(
        `SELECT ${COLUMNS} FROM channel_replay_settings WHERE channel_id = $1`,
        [channelId],
      );
      const row = rows[0];
      /*
       * NULL, NOT AN EMPTY DEFAULT. The caller has to be able to tell "this
       * channel decided nothing" from "this channel decided to keep nothing",
       * and an adapter that blurred them would start recordings on the strength
       * of a missing row.
       */
      return row === undefined ? null : toSettings(row);
    },

    async save(settings): Promise<SettingsOutcome<ChannelReplaySettings>> {
      const problem = validateChannelReplaySettings(settings);
      if (problem !== null) {
        return { ok: false, refusal: 'invalid-settings', detail: problem };
      }

      try {
        /*
         * IDEMPOTENT BY UPSERT. An operator saving the same settings twice --
         * or a retried request -- writes one row and reports the same success.
         * The channel id is the key, so there is nothing to race over.
         */
        const { rows } = await pool.query<SettingsRow>(
          `INSERT INTO channel_replay_settings (
             channel_id, default_policy, default_duration_days,
             default_visibility, allow_overrides
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (channel_id) DO UPDATE SET
             default_policy = EXCLUDED.default_policy,
             default_duration_days = EXCLUDED.default_duration_days,
             default_visibility = EXCLUDED.default_visibility,
             allow_overrides = EXCLUDED.allow_overrides,
             updated_at = now()
           RETURNING ${COLUMNS}`,
          [
            settings.channelId,
            settings.defaultPolicy,
            settings.defaultDurationDays,
            settings.defaultVisibility,
            settings.allowOverrides,
          ],
        );
        const row = rows[0];
        if (row === undefined) {
          return { ok: false, refusal: 'settings-unavailable', detail: 'the settings were not stored' };
        }
        return { ok: true, value: toSettings(row) };
      } catch {
        /*
         * A refusal, never an exception, and never the driver's own text: this
         * is called from an operator route and a database's error message is
         * not something to hand back to one.
         */
        return {
          ok: false,
          refusal: 'settings-unavailable',
          detail: `the replay settings for channel ${settings.channelId} could not be stored`,
        };
      }
    },
  };
}
