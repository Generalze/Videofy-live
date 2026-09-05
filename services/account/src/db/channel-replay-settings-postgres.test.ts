/** @author masterzee001 */
/**
 * A channel's standing answer, and what "no answer" has to keep meaning.
 *
 * WHY A MODELLED POOL, following this directory's convention: these run in CI
 * without Postgres, and the property under test is not "does SQL work" -- the
 * DDL is proven against a real server by `npm run test:migrations` -- it is
 * whether THIS CODE refuses incoherent settings before writing them, upserts
 * idempotently, keeps channels apart, and returns null rather than an empty
 * default for a channel nobody has configured.
 *
 * THAT LAST ONE IS THE POINT. An adapter that invented a settings object for a
 * missing row would defeat the whole no-fallback rule one layer below where
 * anybody would look for it.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ChannelReplaySettings } from '@videofy-live/programme-replay-policy';
import { resolveReplayPolicy } from '@videofy-live/programme-replay-policy';
import { createPostgresChannelReplaySettings } from './channel-replay-settings-postgres.js';

const STARTED = 1_700_000_000_000;

interface Row {
  channel_id: string;
  default_policy: string;
  default_duration_days: number | null;
  default_visibility: string;
  allow_overrides: boolean;
}

function fakePool(options: { failOn?: RegExp } = {}): Pool & {
  rows: Map<string, Row>;
  statements: string[];
  parameters: unknown[];
} {
  const rows = new Map<string, Row>();
  const statements: string[] = [];
  const parameters: unknown[] = [];

  async function query(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    statements.push(text.trim().split('\n')[0]?.trim() ?? '');
    parameters.push(...values);
    if (options.failOn?.test(text) === true) throw new Error('database is unwell');

    if (/^INSERT INTO channel_replay_settings/u.test(text.trim())) {
      const row: Row = {
        channel_id: String(values[0]),
        default_policy: String(values[1]),
        default_duration_days: values[2] as number | null,
        default_visibility: String(values[3]),
        allow_overrides: Boolean(values[4]),
      };
      // ON CONFLICT (channel_id) DO UPDATE: one row per channel, always.
      rows.set(row.channel_id, row);
      return { rows: [{ ...row }] };
    }
    if (/FROM channel_replay_settings WHERE channel_id = \$1/u.test(text)) {
      const row = rows.get(String(values[0]));
      return { rows: row === undefined ? [] : [{ ...row }] };
    }
    return { rows: [] };
  }

  return { rows, statements, parameters, query } as unknown as Pool & {
    rows: Map<string, Row>;
    statements: string[];
    parameters: unknown[];
  };
}

function settings(overrides: Partial<ChannelReplaySettings> = {}): ChannelReplaySettings {
  return {
    channelId: 'ch_1',
    defaultPolicy: 'keep',
    defaultDurationDays: null,
    defaultVisibility: 'unlisted',
    allowOverrides: true,
    ...overrides,
  };
}

/* ============================================================ round trips */

describe('what a channel decided survives being written down', () => {
  it('keeps indefinitely', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    const saved = await store.save(settings({ defaultPolicy: 'keep' }));

    expect(saved.ok).toBe(true);
    expect(await store.read('ch_1')).toEqual(settings({ defaultPolicy: 'keep' }));
  });

  it('keeps nothing', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'none' }));

    expect((await store.read('ch_1'))?.defaultPolicy).toBe('none');
    expect((await store.read('ch_1'))?.defaultDurationDays).toBeNull();
  });

  it('keeps for a stated number of days', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'expire', defaultDurationDays: 30 }));

    const held = await store.read('ch_1');
    expect(held?.defaultPolicy).toBe('expire');
    expect(held?.defaultDurationDays).toBe(30);
  });

  it('carries every visibility tier', async () => {
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      const pool = fakePool();
      const store = createPostgresChannelReplaySettings(pool);
      await store.save(settings({ defaultVisibility: visibility }));
      expect((await store.read('ch_1'))?.defaultVisibility).toBe(visibility);
    }
  });

  it('remembers that a channel forbids overrides', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ allowOverrides: false }));
    expect((await store.read('ch_1'))?.allowOverrides).toBe(false);
  });
});

/* ============================================================= no defaults */

describe('a channel nobody configured', () => {
  it('reads as nothing, not as an empty set of defaults', async () => {
    /*
     * THE WHOLE NO-FALLBACK RULE, one layer below where anybody would look for
     * it. An adapter that answered with a settings object here would start
     * recordings on the strength of a missing row.
     */
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    expect(await store.read('ch_nobody')).toBeNull();
  });

  it('cannot be resolved into a policy', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    const outcome = resolveReplayPolicy(await store.read('ch_nobody'), null, STARTED);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('channel-unconfigured');
  });
});

/* ============================================================== validation */

describe('settings that do not make sense are never written', () => {
  it('refuses expire with no duration', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    const saved = await store.save(settings({ defaultPolicy: 'expire' }));

    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe('invalid-settings');
    expect(pool.rows.size).toBe(0);
  });

  it('refuses a duration attached to keep or none', async () => {
    for (const policy of ['keep', 'none'] as const) {
      const pool = fakePool();
      const store = createPostgresChannelReplaySettings(pool);
      const saved = await store.save(
        settings({ defaultPolicy: policy, defaultDurationDays: 7 }),
      );
      expect(saved.ok, policy).toBe(false);
      expect(pool.rows.size).toBe(0);
    }
  });

  it('refuses a duration that is not a whole positive number of days', async () => {
    for (const days of [0, -1, 2.5]) {
      const pool = fakePool();
      const store = createPostgresChannelReplaySettings(pool);
      const saved = await store.save(
        settings({ defaultPolicy: 'expire', defaultDurationDays: days }),
      );
      expect(saved.ok, String(days)).toBe(false);
    }
  });

  it('refuses a policy or visibility it has never heard of', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    expect((await store.save(settings({ defaultPolicy: 'forever' as never }))).ok).toBe(false);
    expect((await store.save(settings({ defaultVisibility: 'locked' as never }))).ok).toBe(false);
    expect(pool.rows.size).toBe(0);
  });
});

/* ============================================================= idempotence */

describe('saving the same thing twice', () => {
  it('writes one row and reports the same success', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    const first = await store.save(settings({ defaultPolicy: 'expire', defaultDurationDays: 7 }));
    const again = await store.save(settings({ defaultPolicy: 'expire', defaultDurationDays: 7 }));

    expect(first.ok && again.ok).toBe(true);
    expect(first.value).toEqual(again.value);
    expect(pool.rows.size).toBe(1);
  });

  it('replaces the answer when an operator changes their mind', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'keep' }));
    await store.save(settings({ defaultPolicy: 'expire', defaultDurationDays: 14 }));

    const held = await store.read('ch_1');
    expect(held?.defaultPolicy).toBe('expire');
    expect(held?.defaultDurationDays).toBe(14);
    expect(pool.rows.size).toBe(1);
  });

  it('is deterministic when two saves land together', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await Promise.all([
      store.save(settings({ defaultPolicy: 'keep' })),
      store.save(settings({ defaultPolicy: 'keep' })),
    ]);
    expect(pool.rows.size).toBe(1);
    expect((await store.read('ch_1'))?.defaultPolicy).toBe('keep');
  });
});

/* =============================================================== isolation */

describe('one channel is not another channel', () => {
  it('keeps their answers apart', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ channelId: 'ch_1', defaultPolicy: 'keep' }));
    await store.save(
      settings({ channelId: 'ch_2', defaultPolicy: 'expire', defaultDurationDays: 3 }),
    );

    expect((await store.read('ch_1'))?.defaultPolicy).toBe('keep');
    expect((await store.read('ch_2'))?.defaultPolicy).toBe('expire');
    expect((await store.read('ch_1'))?.defaultDurationDays).toBeNull();
  });

  it('treats a channel id shaped like SQL as data', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    const hostile = "ch_1'; DROP TABLE channel_replay_settings; --";
    await store.save(settings({ channelId: hostile }));

    expect((await store.read(hostile))?.channelId).toBe(hostile);
    expect(pool.statements.some((text) => text.includes('DROP TABLE'))).toBe(false);
  });
});

/* =========================================================== unavailability */

describe('a database that is unwell', () => {
  it('refuses rather than throwing, and says nothing about the driver', async () => {
    const pool = fakePool({ failOn: /INSERT INTO channel_replay_settings/u });
    const store = createPostgresChannelReplaySettings(pool);
    const saved = await store.save(settings());

    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe('settings-unavailable');
    expect(saved.detail).not.toContain('database is unwell');
  });
});

/* ============================================================ end to end */

describe('from a stored answer to a decision', () => {
  it('resolves a channel default with no override', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'expire', defaultDurationDays: 30 }));

    const outcome = resolveReplayPolicy(await store.read('ch_1'), null, STARTED);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.value.retention).toEqual({
      policy: 'expire',
      expiresAtMs: STARTED + 30 * 24 * 60 * 60 * 1000,
    });
    expect(outcome.value.visibility).toBe('unlisted');
    expect(outcome.value.retentionSource).toBe('channel-default');
  });

  it('honours an override on a channel that permits one', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'none', allowOverrides: true }));

    const outcome = resolveReplayPolicy(
      await store.read('ch_1'),
      { policy: 'keep', visibility: 'public' },
      STARTED,
    );
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.value.retention).toEqual({ policy: 'keep' });
    expect(outcome.value.visibility).toBe('public');
    expect(outcome.value.retentionSource).toBe('programme-override');
  });

  it('refuses an override on a channel that forbids one, even after a round trip', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'keep', allowOverrides: false }));

    const outcome = resolveReplayPolicy(await store.read('ch_1'), { policy: 'none' }, STARTED);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusal).toBe('overrides-forbidden');
  });

  it('carries nothing about the database into the decision', async () => {
    const pool = fakePool();
    const store = createPostgresChannelReplaySettings(pool);
    await store.save(settings({ defaultPolicy: 'keep' }));

    const outcome = resolveReplayPolicy(await store.read('ch_1'), null, STARTED);
    const serialised = JSON.stringify(outcome);
    expect(serialised).not.toContain('channel_replay_settings');
    expect(serialised).not.toContain('ch_1');
    expect(serialised).not.toContain('default_policy');
  });
});
