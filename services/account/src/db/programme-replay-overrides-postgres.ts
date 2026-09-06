/** @author masterzee001 */
/**
 * One programme's departure from its channel's standing answer, durably.
 *
 * THE WHOLE DIFFICULTY IS ONE FIELD. `durationDays` has three states and a
 * nullable column has two:
 *
 *   absent   -- the programme said nothing about duration; inherit the channel's
 *   null     -- the programme said there is deliberately no duration
 *   a number -- that many days
 *
 * The middle one exists because `{ policy: 'expire', durationDays: null }` is
 * incoherent and must be REFUSED, while `{ policy: 'expire' }` on a channel
 * that expires after thirty days means thirty days. Collapsing them makes those
 * two the same row, and one of them is a recording that quietly lives forever.
 * So the discriminator is stored beside the value, and the mapping in and out
 * of it is the only interesting code in this file.
 *
 * READ RETURNING NULL MEANS THIS PROGRAMME ASKED FOR NOTHING, which resolves to
 * the channel's defaults. Deliberately unlike an unconfigured CHANNEL, where
 * null is a refusal: a channel must decide, a programme need not.
 *
 * SHAPE IS CHECKED HERE; THE COMBINATION IS NOT. Whether `keep` may carry a
 * duration, or whether this channel permits any override at all, is decided by
 * `resolveReplayPolicy` against settings this adapter cannot see, and the route
 * above asks it. Repeating half of that rule here would be a second copy of a
 * decision with one home.
 *
 * A DRIVER'S ERROR TEXT IS NEVER RETURNED. These are operator routes, and a
 * database's message is not something to hand to an operator.
 */

import type { Pool } from 'pg';
import {
  validateProgrammeReplayOverride,
  type ProgrammeReplayOverride,
  type ProgrammeReplayOverrideRecord,
  type ProgrammeReplayOverrideStore,
  type SettingsOutcome,
} from '@videofy-live/programme-replay-policy';

interface OverrideRow {
  programme_id: string;
  channel_id: string;
  policy: string | null;
  visibility: string | null;
  duration_days: string | number | null;
  duration_days_stated: boolean;
}

const COLUMNS = `
  programme_id, channel_id, policy, visibility, duration_days, duration_days_stated
`;

/**
 * The row as the domain shape, with the three-state duration reassembled.
 *
 * `exactOptionalPropertyTypes` is on, so an absent field must be genuinely
 * ABSENT rather than present-and-undefined -- which is exactly the distinction
 * this whole file is about, and the reason the draft below is assembled by
 * assignment rather than by spreading conditionals: a spread of `{}` widens the
 * property to `T | undefined` and the compiler stops being able to tell the two
 * apart on our behalf.
 */
type OverridePolicy = NonNullable<ProgrammeReplayOverride['policy']>;
type OverrideVisibility = NonNullable<ProgrammeReplayOverride['visibility']>;

interface OverrideDraft {
  policy?: OverridePolicy;
  durationDays?: number | null;
  visibility?: OverrideVisibility;
}

function toOverride(row: OverrideRow): ProgrammeReplayOverride {
  const draft: OverrideDraft = {};
  if (row.policy !== null) draft.policy = row.policy as OverridePolicy;
  if (row.visibility !== null) draft.visibility = row.visibility as OverrideVisibility;
  if (row.duration_days_stated) {
    const days = row.duration_days;
    draft.durationDays = days === null || days === undefined ? null : Number(days);
  }
  return draft;
}

function toRecord(row: OverrideRow): ProgrammeReplayOverrideRecord {
  return {
    programmeId: row.programme_id,
    channelId: row.channel_id,
    override: toOverride(row),
  };
}

export function createPostgresProgrammeReplayOverrides(
  pool: Pool,
): ProgrammeReplayOverrideStore {
  return {
    async read(programmeId) {
      const { rows } = await pool.query<OverrideRow>(
        `SELECT ${COLUMNS} FROM programme_replay_overrides WHERE programme_id = $1`,
        [programmeId],
      );
      const row = rows[0];
      /*
       * NO ROW IS AN ANSWER: this programme asked for nothing. Never an empty
       * override object, which would be the same answer with an extra
       * allocation, but would also let a caller believe something was stored.
       */
      return row === undefined ? null : toRecord(row);
    },

    async save(record): Promise<SettingsOutcome<ProgrammeReplayOverrideRecord>> {
      if (record.programmeId.trim() === '') {
        return { ok: false, refusal: 'invalid-settings', detail: 'a programme id is required' };
      }
      if (record.channelId.trim() === '') {
        return { ok: false, refusal: 'invalid-settings', detail: 'a channel id is required' };
      }
      const problem = validateProgrammeReplayOverride(record.override);
      if (problem !== null) {
        return { ok: false, refusal: 'invalid-settings', detail: problem };
      }

      const stated = record.override.durationDays !== undefined;
      try {
        /*
         * IDEMPOTENT BY UPSERT, and it replaces rather than merges. An override
         * is one statement, not an accumulation: an operator who removes the
         * visibility from their override and saves has removed it, and a merge
         * would leave the old value in place with nothing on screen to explain
         * why the programme still goes out unlisted.
         */
        const { rows } = await pool.query<OverrideRow>(
          `INSERT INTO programme_replay_overrides (
             programme_id, channel_id, policy, visibility, duration_days, duration_days_stated
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (programme_id) DO UPDATE SET
             channel_id = EXCLUDED.channel_id,
             policy = EXCLUDED.policy,
             visibility = EXCLUDED.visibility,
             duration_days = EXCLUDED.duration_days,
             duration_days_stated = EXCLUDED.duration_days_stated,
             updated_at = now()
           RETURNING ${COLUMNS}`,
          [
            record.programmeId,
            record.channelId,
            record.override.policy ?? null,
            record.override.visibility ?? null,
            stated ? (record.override.durationDays ?? null) : null,
            stated,
          ],
        );
        const row = rows[0];
        if (row === undefined) {
          return {
            ok: false,
            refusal: 'settings-unavailable',
            detail: 'the replay override was not stored',
          };
        }
        return { ok: true, value: toRecord(row) };
      } catch {
        return {
          ok: false,
          refusal: 'settings-unavailable',
          detail: `the replay override for programme ${record.programmeId} could not be stored`,
        };
      }
    },

    async clear(programmeId): Promise<SettingsOutcome<null>> {
      try {
        /*
         * SUCCEEDS ON A PROGRAMME THAT HAD NO OVERRIDE. The caller asked for
         * "no override", and there is none; reporting that as a failure would
         * make an operator pressing "use the channel default" twice look like a
         * mistake, and would make a retried request unsafe.
         */
        await pool.query('DELETE FROM programme_replay_overrides WHERE programme_id = $1', [
          programmeId,
        ]);
        return { ok: true, value: null };
      } catch {
        return {
          ok: false,
          refusal: 'settings-unavailable',
          detail: `the replay override for programme ${programmeId} could not be removed`,
        };
      }
    },
  };
}
