/** @author masterzee001 */
/**
 * The three-state duration, which is the only thing here worth a test file.
 *
 *   absent   -- inherit whatever the channel says
 *   null     -- there is deliberately no duration
 *   a number -- that many days
 *
 * A nullable column holds two of those. If the round trip through storage
 * loses the difference between the first two, then `{ policy: 'expire' }` on a
 * thirty-day channel and `{ policy: 'expire', durationDays: null }` become the
 * same stored row -- and one of those must resolve to thirty days while the
 * other must be refused. The failure is a recording that lives forever, found
 * months later on a storage bill.
 *
 * WHY A MODELLED POOL, as everywhere else in this directory: these run in CI
 * without Postgres, and the DDL is proven against a real server by
 * `npm run test:migrations`. What is under test is this code's mapping, its
 * refusals, and its idempotence.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  resolveReplayPolicy,
  type ChannelReplaySettings,
  type ProgrammeReplayOverride,
} from '@videofy-live/programme-replay-policy';
import { createPostgresProgrammeReplayOverrides } from './programme-replay-overrides-postgres.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  programme_id: string;
  channel_id: string;
  policy: string | null;
  visibility: string | null;
  duration_days: number | null;
  duration_days_stated: boolean;
}

function fakePool(options: { failOn?: RegExp } = {}): Pool & {
  rows: Map<string, Row>;
  statements: string[];
} {
  const rows = new Map<string, Row>();
  const statements: string[] = [];

  async function query(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    statements.push(text.trim().split('\n')[0]?.trim() ?? '');
    if (options.failOn?.test(text) === true) throw new Error('database is unwell');

    if (/^INSERT INTO programme_replay_overrides/u.test(text.trim())) {
      const row: Row = {
        programme_id: String(values[0]),
        channel_id: String(values[1]),
        policy: (values[2] ?? null) as string | null,
        visibility: (values[3] ?? null) as string | null,
        duration_days: (values[4] ?? null) as number | null,
        duration_days_stated: Boolean(values[5]),
      };
      /*
       * THE TABLE'S OWN CONSTRAINT, MODELLED. A row claiming a duration it
       * never stated is refused by Postgres, and a fake that accepted it would
       * let this adapter write something the real server rejects.
       */
      if (!row.duration_days_stated && row.duration_days !== null) {
        throw new Error('programme_replay_overrides_duration_needs_stating');
      }
      rows.set(row.programme_id, row);
      return { rows: [{ ...row }] };
    }
    /*
     * ANCHORED ON `SELECT`, and it has to be. `DELETE FROM
     * programme_replay_overrides WHERE programme_id = $1` matches an
     * unanchored FROM-clause pattern exactly as well as the read does, so a
     * looser fake answers deletes with rows and every clearing test passes
     * against a table nothing was ever removed from.
     */
    if (/^SELECT[\s\S]*FROM programme_replay_overrides WHERE programme_id = \$1/u.test(text.trim())) {
      const row = rows.get(String(values[0]));
      return { rows: row === undefined ? [] : [{ ...row }] };
    }
    if (/^DELETE FROM programme_replay_overrides/u.test(text.trim())) {
      rows.delete(String(values[0]));
      return { rows: [] };
    }
    return { rows: [] };
  }

  return { rows, statements, query } as unknown as Pool & {
    rows: Map<string, Row>;
    statements: string[];
  };
}

function settings(overrides: Partial<ChannelReplaySettings> = {}): ChannelReplaySettings {
  return {
    channelId: 'ch_1',
    defaultPolicy: 'expire',
    defaultDurationDays: 30,
    defaultVisibility: 'unlisted',
    allowOverrides: true,
    ...overrides,
  };
}

async function roundTrip(
  override: ProgrammeReplayOverride,
): Promise<ProgrammeReplayOverride | null> {
  const store = createPostgresProgrammeReplayOverrides(fakePoolShared);
  const saved = await store.save({ programmeId: 'prog_1', channelId: 'ch_1', override });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  const read = await store.read('prog_1');
  return read === null ? null : read.override;
}

let fakePoolShared = fakePool();

/* ================================================= the three-state duration */

describe('a duration that was never stated is not a duration that was cleared', () => {
  it('keeps absent absent through storage', async () => {
    fakePoolShared = fakePool();
    const back = await roundTrip({ policy: 'expire' });
    expect(back).toEqual({ policy: 'expire' });
    expect('durationDays' in (back ?? {})).toBe(false);
    expect(fakePoolShared.rows.get('prog_1')?.duration_days_stated).toBe(false);
  });

  it('keeps an explicit null explicit through storage', async () => {
    fakePoolShared = fakePool();
    const back = await roundTrip({ policy: 'keep', durationDays: null });
    expect(back).toEqual({ policy: 'keep', durationDays: null });
    expect('durationDays' in (back ?? {})).toBe(true);
    expect(fakePoolShared.rows.get('prog_1')?.duration_days_stated).toBe(true);
    expect(fakePoolShared.rows.get('prog_1')?.duration_days).toBeNull();
  });

  it('keeps a number a number', async () => {
    fakePoolShared = fakePool();
    expect(await roundTrip({ policy: 'expire', durationDays: 7 })).toEqual({
      policy: 'expire',
      durationDays: 7,
    });
  });

  it('the two survive resolution differently, which is why they are stored differently', async () => {
    /*
     * THE FAILURE THIS FILE EXISTS FOR, stated as one test. Both overrides
     * below say `expire` and neither carries a number. Restating the policy
     * inherits the channel's thirty days; clearing the duration is incoherent
     * and refused. If storage flattened them, one of these two answers would
     * be silently wrong.
     */
    fakePoolShared = fakePool();
    const inherit = await roundTrip({ policy: 'expire' });
    const inheritOutcome = resolveReplayPolicy(settings(), inherit, STARTED);
    expect(inheritOutcome.ok).toBe(true);
    if (!inheritOutcome.ok) throw new Error('unreachable');
    expect(inheritOutcome.value.retention).toEqual({
      policy: 'expire',
      expiresAtMs: STARTED + 30 * DAY_MS,
    });

    fakePoolShared = fakePool();
    const cleared = await roundTrip({ policy: 'expire', durationDays: null });
    const clearedOutcome = resolveReplayPolicy(settings(), cleared, STARTED);
    expect(clearedOutcome.ok).toBe(false);
    if (clearedOutcome.ok) throw new Error('unreachable');
    expect(clearedOutcome.refusal).toBe('invalid-override');
  });

  it('never writes a value against a duration it did not state', async () => {
    // The table refuses that combination; the fake models the refusal, and
    // this asserts the adapter never provokes it.
    fakePoolShared = fakePool();
    for (const override of [
      {},
      { policy: 'keep' as const },
      { visibility: 'private' as const },
      { policy: 'expire' as const },
    ]) {
      const store = createPostgresProgrammeReplayOverrides(fakePoolShared);
      const saved = await store.save({ programmeId: 'p', channelId: 'ch_1', override });
      expect(saved.ok, JSON.stringify(override)).toBe(true);
      expect(fakePoolShared.rows.get('p')?.duration_days).toBeNull();
    }
  });
});

/* ============================================================ absence, again */

describe('no row means this programme asked for nothing', () => {
  it('reads null rather than an empty override', async () => {
    const store = createPostgresProgrammeReplayOverrides(fakePool());
    expect(await store.read('never-configured')).toBeNull();
  });

  it('and that resolves to the channel default rather than to a refusal', async () => {
    /*
     * DELIBERATELY UNLIKE AN UNCONFIGURED CHANNEL, where null is a refusal. A
     * channel must decide; a programme need not.
     */
    const store = createPostgresProgrammeReplayOverrides(fakePool());
    const outcome = resolveReplayPolicy(settings(), (await store.read('p'))?.override ?? null, STARTED);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.value.retentionSource).toBe('channel-default');
  });
});

/* ============================================================== the writing */

describe('saving an override', () => {
  it('is idempotent: the same save twice leaves one row and the same answer', async () => {
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    const record = {
      programmeId: 'prog_1',
      channelId: 'ch_1',
      override: { policy: 'keep' as const, visibility: 'private' as const },
    };
    const first = await store.save(record);
    const second = await store.save(record);
    expect(first).toEqual(second);
    expect(pool.rows.size).toBe(1);
  });

  it('replaces rather than merges', async () => {
    /*
     * An operator who removes the visibility from their override and saves has
     * REMOVED it. A merge would leave the old value in place with nothing on
     * screen to explain why the programme still goes out unlisted.
     */
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    await store.save({
      programmeId: 'prog_1',
      channelId: 'ch_1',
      override: { policy: 'keep', visibility: 'private' },
    });
    await store.save({ programmeId: 'prog_1', channelId: 'ch_1', override: { policy: 'keep' } });
    expect((await store.read('prog_1'))?.override).toEqual({ policy: 'keep' });
  });

  it('keeps programmes apart', async () => {
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    await store.save({ programmeId: 'a', channelId: 'ch_1', override: { policy: 'keep' } });
    await store.save({ programmeId: 'b', channelId: 'ch_2', override: { policy: 'none' } });
    expect((await store.read('a'))?.override).toEqual({ policy: 'keep' });
    expect((await store.read('a'))?.channelId).toBe('ch_1');
    expect((await store.read('b'))?.override).toEqual({ policy: 'none' });
  });

  it('refuses a value it does not recognise, before writing anything', async () => {
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    const saved = await store.save({
      programmeId: 'prog_1',
      channelId: 'ch_1',
      // `locked` is a CHANNEL access tier and has no meaning for a stored object.
      override: { visibility: 'locked' as never },
    });
    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe('invalid-settings');
    expect(pool.rows.size).toBe(0);
    expect(pool.statements.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('refuses an unusable duration before writing anything', async () => {
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    for (const durationDays of [0, -1, 1.5, 3651]) {
      const saved = await store.save({
        programmeId: 'prog_1',
        channelId: 'ch_1',
        override: { policy: 'expire', durationDays },
      });
      expect(saved.ok, String(durationDays)).toBe(false);
    }
    expect(pool.rows.size).toBe(0);
  });

  it('requires both ids', async () => {
    const store = createPostgresProgrammeReplayOverrides(fakePool());
    expect((await store.save({ programmeId: ' ', channelId: 'ch', override: {} })).ok).toBe(false);
    expect((await store.save({ programmeId: 'p', channelId: '', override: {} })).ok).toBe(false);
  });

  it('turns a storage fault into a refusal, never an exception or a driver message', async () => {
    const store = createPostgresProgrammeReplayOverrides(fakePool({ failOn: /INSERT/u }));
    const saved = await store.save({ programmeId: 'p', channelId: 'ch', override: { policy: 'keep' } });
    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe('settings-unavailable');
    expect(saved.detail).not.toContain('unwell');
  });
});

/* ============================================================== the clearing */

describe('clearing an override', () => {
  it('removes it', async () => {
    const pool = fakePool();
    const store = createPostgresProgrammeReplayOverrides(pool);
    await store.save({ programmeId: 'p', channelId: 'ch', override: { policy: 'keep' } });
    expect((await store.clear('p')).ok).toBe(true);
    expect(await store.read('p')).toBeNull();
  });

  it('succeeds on a programme that never had one', async () => {
    // The caller asked for "no override", and there is none. A retried request
    // must not start failing because the first one worked.
    const store = createPostgresProgrammeReplayOverrides(fakePool());
    expect((await store.clear('never')).ok).toBe(true);
    expect((await store.clear('never')).ok).toBe(true);
  });

  it('turns a storage fault into a refusal', async () => {
    const store = createPostgresProgrammeReplayOverrides(fakePool({ failOn: /DELETE/u }));
    const cleared = await store.clear('p');
    expect(cleared.ok).toBe(false);
    expect(cleared.refusal).toBe('settings-unavailable');
    expect(cleared.detail).not.toContain('unwell');
  });
});
