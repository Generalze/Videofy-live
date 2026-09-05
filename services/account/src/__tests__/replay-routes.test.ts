/** @author masterzee001 */
/**
 * The Replay product surface, over HTTP, as a console and a viewer receive it.
 *
 * MOST OF THIS FILE IS ABOUT WHAT A STRANGER CAN WORK OUT. The functional half
 * -- settings save, overrides resolve, history pages -- is straightforward and
 * tested here because it must keep working. The half that matters is the half
 * where a defect is invisible:
 *
 *   AN EXISTENCE ORACLE. A private channel and a channel that does not exist
 *   must answer identically, or anybody can walk a list of ids and learn which
 *   private channels are real.
 *
 *   A SHAPE ORACLE. Within a public listing, an airing whose recording is
 *   hidden must be byte-identical to an airing that was never recorded, or
 *   anybody can enumerate exactly the recordings an operator chose to hide.
 *
 *   A DISABLED CONTROL IS NOT AUTHORISATION. A channel that forbids overrides
 *   refuses them at this API, whatever a console did or did not grey out.
 *
 *   A PATH IS NEVER A LOCATION. No response carries a storage reference, an
 *   archive root or an object key, and the sweep at the end of this file says
 *   so about every response the suite produced rather than about a chosen few.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiringQuery,
  ProgrammeAiringCatalogue,
  ProgrammeAiringPage,
  ProgrammeAiringRecord,
  ReplayDisposition,
  ReplaySummary,
} from '@videofy-live/programme-replay';
import { REPLAY_NOT_KEPT, pageSize } from '@videofy-live/programme-replay';
import type {
  ChannelReplaySettings,
  ChannelReplaySettingsStore,
  ProgrammeReplayOverrideRecord,
  ProgrammeReplayOverrideStore,
} from '@videofy-live/programme-replay-policy';
import { validateChannelReplaySettings } from '@videofy-live/programme-replay-policy';
import type { ChannelVisibility } from '@videofy-live/shared-types';
import {
  registerReplayRoutes,
  sealCursor,
  unsealCursor,
  type ReplayRouteChannel,
} from '../replay-routes.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Any 32 bytes; the routes derive their own key from it. */
const CURSOR_SECRET = Buffer.from('a-test-secret-for-sealing-cursors');

/**
 * Every body this suite received.
 *
 * Collected so the leak sweep at the end is about EVERY response the tests
 * produced, not about the handful somebody remembered to check. A path that
 * escapes through a route nobody thought to audit is exactly the shape of the
 * defect this guards.
 */
const seenBodies: string[] = [];

/* ------------------------------------------------------------- the doubles */

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    status: 'available',
    retention: { policy: 'keep' },
    visibility: 'public',
    finalisedAtMs: NOW - 1000,
    expiresAtMs: null,
    failure: null,
    bytes: 8_192,
    segmentCount: 4,
    initialisationCount: 1,
    ...overrides,
  };
}

function kept(overrides: Partial<ReplaySummary> = {}): ReplayDisposition {
  return { disposition: 'replay', summary: summary(overrides) };
}

function airing(
  runId: string,
  channelId: string,
  replay: ReplayDisposition,
  startedAtMs = NOW - 3_600_000,
): ProgrammeAiringRecord {
  return {
    identity: { channelId, programmeId: channelId, runId },
    startedAtMs,
    endedAtMs: startedAtMs + 60_000,
    replay,
  };
}

/** A catalogue with real keyset paging, so the cursor tests mean something. */
function fakeCatalogue(records: readonly ProgrammeAiringRecord[]): ProgrammeAiringCatalogue {
  const all = [...records].sort((a, b) =>
    b.startedAtMs - a.startedAtMs || (a.identity.runId < b.identity.runId ? 1 : -1),
  );
  const page = (
    match: (record: ProgrammeAiringRecord) => boolean,
    query: AiringQuery | undefined,
  ): ProgrammeAiringPage => {
    const limit = pageSize(query);
    const after = query?.after;
    const eligible = all.filter(
      (record) =>
        match(record) &&
        (after === undefined ||
          record.startedAtMs < after.startedAtMs ||
          (record.startedAtMs === after.startedAtMs && record.identity.runId < after.runId)),
    );
    const airings = eligible.slice(0, limit);
    const last = airings[airings.length - 1];
    return {
      airings,
      next:
        eligible.length > limit && last !== undefined
          ? { startedAtMs: last.startedAtMs, runId: last.identity.runId }
          : null,
    };
  };
  return {
    async recordAiring() {
      throw new Error('not used by these routes');
    },
    async projectReplay() {
      throw new Error('not used by these routes');
    },
    async finishAiring() {
      throw new Error('not used by these routes');
    },
    async findByRunId(runId) {
      return all.find((record) => record.identity.runId === runId) ?? null;
    },
    async listByChannel(channelId, query) {
      return page((record) => record.identity.channelId === channelId, query);
    },
    async listByProgramme(programmeId, query) {
      return page((record) => record.identity.programmeId === programmeId, query);
    },
  };
}

function fakeSettings(seed: ChannelReplaySettings | null): ChannelReplaySettingsStore & {
  rows: Map<string, ChannelReplaySettings>;
} {
  const rows = new Map<string, ChannelReplaySettings>();
  if (seed !== null) rows.set(seed.channelId, seed);
  return {
    rows,
    async read(channelId) {
      return rows.get(channelId) ?? null;
    },
    async save(settings) {
      const problem = validateChannelReplaySettings(settings);
      if (problem !== null) return { ok: false, refusal: 'invalid-settings', detail: problem };
      rows.set(settings.channelId, settings);
      return { ok: true, value: settings };
    },
  };
}

function fakeOverrides(): ProgrammeReplayOverrideStore & {
  rows: Map<string, ProgrammeReplayOverrideRecord>;
} {
  const rows = new Map<string, ProgrammeReplayOverrideRecord>();
  return {
    rows,
    async read(programmeId) {
      return rows.get(programmeId) ?? null;
    },
    async save(record) {
      rows.set(record.programmeId, record);
      return { ok: true, value: record };
    },
    async clear(programmeId) {
      rows.delete(programmeId);
      return { ok: true, value: null };
    },
  };
}

/* ------------------------------------------------------------- the harness */

interface HarnessOptions {
  readonly signedIn?: boolean;
  readonly hasChannel?: boolean;
  readonly visibility?: ChannelVisibility;
  readonly settings?: ChannelReplaySettings | null;
  readonly records?: readonly ProgrammeAiringRecord[];
  readonly mayAdminister?: boolean;
  /** Other channels, reachable by id or handle, for the oracle tests. */
  readonly others?: readonly ReplayRouteChannel[];
  readonly now?: number;
}

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly settings: ReturnType<typeof fakeSettings>;
  readonly overrides: ReturnType<typeof fakeOverrides>;
  readonly events: { event: string; detail: Record<string, string | number> }[];
}

const OWN: string = 'ch_own';

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const visibility = options.visibility ?? 'public';
  const own: ReplayRouteChannel = { channelId: OWN, visibility };
  const channels = new Map<string, ReplayRouteChannel>([[OWN, own]]);
  const handles = new Map<string, ReplayRouteChannel>([['own', own]]);
  for (const other of options.others ?? []) {
    channels.set(other.channelId, other);
    handles.set(other.channelId, other);
  }

  const settings = fakeSettings(options.settings === undefined ? null : options.settings);
  const overrides = fakeOverrides();
  const events: { event: string; detail: Record<string, string | number> }[] = [];

  const app = express();
  app.use(express.json());
  registerReplayRoutes(app, {
    settings,
    overrides,
    airings: fakeCatalogue(options.records ?? []),
    callerAccountId: () => (options.signedIn === false ? null : { accountId: 'acct_1' }),
    cursorSecret: CURSOR_SECRET,
    ownChannel: async () => (options.hasChannel === false ? null : own),
    channelById: async (channelId) => channels.get(channelId) ?? null,
    channelByHandle: async (handle) => handles.get(handle) ?? null,
    mayAdminister: async () => options.mayAdminister !== false,
    now: () => options.now ?? NOW,
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    settings,
    overrides,
    events,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let open: Harness | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  open = await harness(options);
  return open;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${h.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  seenBodies.push(text);
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const get = (h: Harness, path: string): Promise<Answer> => call(h, 'GET', path);

function settingsOf(overrides: Partial<ChannelReplaySettings> = {}): ChannelReplaySettings {
  return {
    channelId: OWN,
    defaultPolicy: 'keep',
    defaultDurationDays: null,
    defaultVisibility: 'unlisted',
    allowOverrides: true,
    ...overrides,
  };
}

/* ============================================================= the sessions */

describe('the owner is found by their session and never by a path', () => {
  const ownerPaths = [
    'GET /channels/mine/replay-settings',
    'PUT /channels/mine/replay-settings',
    'GET /channels/mine/airings',
    'GET /operator/programmes/prog_1/replay-override',
    'PUT /operator/programmes/prog_1/replay-override',
    'DELETE /operator/programmes/prog_1/replay-override',
    'GET /operator/programmes/prog_1/airings',
  ];

  it('refuses every owner route without a session', async () => {
    const h = await start({ signedIn: false });
    for (const spec of ownerPaths) {
      const [method = 'GET', path = '/'] = spec.split(' ');
      const answer = await call(h, method, path, method === 'GET' ? undefined : {});
      expect(answer.status, spec).toBe(401);
    }
  });

  it('tells a signed-in operator with no channel so, rather than inventing one', async () => {
    const h = await start({ hasChannel: false });
    const answer = await get(h, '/channels/mine/replay-settings');
    expect(answer.status).toBe(404);
    expect(answer.body['error']).toContain('do not have a channel');
  });

  it('writes settings against the session channel, ignoring any channelId in the body', async () => {
    /*
     * THE TENANT BOUNDARY. A channelId in a payload is a value the caller
     * chose. Preferring it -- or even comparing against it -- is how this stops
     * being a boundary and starts being a suggestion.
     */
    const h = await start();
    const answer = await call(h, 'PUT', '/channels/mine/replay-settings', {
      channelId: 'ch_somebody_else',
      defaultPolicy: 'keep',
      defaultVisibility: 'public',
      allowOverrides: true,
    });
    expect(answer.status).toBe(200);
    expect(h.settings.rows.has('ch_somebody_else')).toBe(false);
    expect(h.settings.rows.get(OWN)?.defaultVisibility).toBe('public');
  });
});

/* ============================================================ the defaults */

describe('a channel that has decided nothing is told it has decided nothing', () => {
  it('answers null settings rather than an invented default', async () => {
    const h = await start();
    const answer = await get(h, '/channels/mine/replay-settings');
    expect(answer.status).toBe(200);
    expect(answer.body['settings']).toBeNull();
    // Not `{}`, not a keep-forever object, not a policy nobody chose.
    expect(answer.text).not.toContain('"defaultPolicy"');
  });

  it('carries the duration bound so a form does not invent one', async () => {
    const h = await start();
    expect((await get(h, '/channels/mine/replay-settings')).body['maxDurationDays']).toBe(3650);
  });

  it('says whether the platform publishes this channel at all', async () => {
    const published = await start({ visibility: 'public' });
    expect((await get(published, '/channels/mine/replay-settings')).body['channelPublished']).toBe(true);
    await published.close();
    open = null;

    for (const visibility of ['private', 'locked'] as const) {
      const h = await start({ visibility });
      expect(
        (await get(h, '/channels/mine/replay-settings')).body['channelPublished'],
        visibility,
      ).toBe(false);
      await h.close();
      open = null;
    }
  });
});

describe('saving a channel default', () => {
  it('stores a coherent one and reads it back', async () => {
    const h = await start();
    const saved = await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'expire',
      defaultDurationDays: 30,
      defaultVisibility: 'unlisted',
      allowOverrides: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.body['settings']).toEqual({
      channelId: OWN,
      defaultPolicy: 'expire',
      defaultDurationDays: 30,
      defaultVisibility: 'unlisted',
      allowOverrides: false,
    });
    expect((await get(h, '/channels/mine/replay-settings')).body['settings']).toEqual(
      saved.body['settings'],
    );
  });

  it('refuses expire with no duration, and keep with one', async () => {
    const h = await start();
    const noDuration = await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'expire',
      defaultVisibility: 'public',
    });
    expect(noDuration.status).toBe(400);
    expect(String(noDuration.body['error'])).toContain('requires a duration');

    const strayDuration = await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'keep',
      defaultDurationDays: 30,
      defaultVisibility: 'public',
    });
    expect(strayDuration.status).toBe(400);
    expect(h.settings.rows.size).toBe(0);
  });

  it('refuses a channel access tier offered as a replay tier', async () => {
    // `locked` is a door. A replay is a stored object and has no such tier.
    const h = await start();
    const answer = await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'keep',
      defaultVisibility: 'locked',
    });
    expect(answer.status).toBe(400);
    expect(String(answer.body['error'])).toContain('visibility');
  });

  it('refuses a duration that is not a number at all', async () => {
    const h = await start();
    const answer = await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'expire',
      defaultDurationDays: '30',
      defaultVisibility: 'public',
    });
    expect(answer.status).toBe(400);
  });

  it('logs the decision without logging anybody', async () => {
    const h = await start();
    await call(h, 'PUT', '/channels/mine/replay-settings', {
      defaultPolicy: 'keep',
      defaultVisibility: 'public',
    });
    expect(h.events).toEqual([
      {
        event: 'channel.replay.settings.updated',
        detail: { policy: 'keep', visibility: 'public', overrides: 'true' },
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain('acct_');
  });
});

/* ============================================================ the overrides */

describe('a programme asking to differ', () => {
  it('previews what the override will actually do, using the real resolver', async () => {
    /*
     * THE PREVIEW IS NOT A SECOND IMPLEMENTATION. It comes from the same
     * function the media service will use when this programme opens, so a
     * console cannot promise something that is not going to happen.
     */
    const h = await start({ settings: settingsOf({ defaultPolicy: 'expire', defaultDurationDays: 30 }) });
    const saved = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { durationDays: 7 });
    expect(saved.status).toBe(200);
    const resolution = saved.body['resolution'] as Record<string, unknown>;
    expect(resolution['ok']).toBe(true);
    expect((resolution['resolved'] as Record<string, unknown>)['retention']).toEqual({
      policy: 'expire',
      expiresAtMs: NOW + 7 * DAY_MS,
    });
  });

  it('an empty override is a removal, not a stored row saying nothing', async () => {
    const h = await start({ settings: settingsOf() });
    await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { policy: 'none' });
    expect(h.overrides.rows.size).toBe(1);

    const cleared = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', {});
    expect(cleared.status).toBe(200);
    expect(cleared.body['override']).toBeNull();
    expect(h.overrides.rows.size).toBe(0);
  });

  it('DELETE removes it, and removing nothing is not a failure', async () => {
    const h = await start({ settings: settingsOf() });
    await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { policy: 'none' });
    expect((await call(h, 'DELETE', '/operator/programmes/prog_1/replay-override')).status).toBe(200);
    expect((await call(h, 'DELETE', '/operator/programmes/prog_1/replay-override')).status).toBe(200);
    expect(h.overrides.rows.size).toBe(0);
  });

  it('a channel that forbids overrides refuses them here, whatever a console greyed out', async () => {
    /*
     * A DISABLED CONTROL IS NOT AUTHORISATION. The console may well disable the
     * form, and this is the answer for everybody who did not go through it.
     * 409 rather than 400: nothing is wrong with what was sent, the channel
     * does not permit it.
     */
    const h = await start({ settings: settingsOf({ allowOverrides: false }) });
    const answer = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { policy: 'none' });
    expect(answer.status).toBe(409);
    expect(answer.body['refusal']).toBe('overrides-forbidden');
    expect(h.overrides.rows.size).toBe(0);
  });

  it('refuses an override on a channel that has decided nothing', async () => {
    // Missing configuration is unresolved, never a default.
    const h = await start({ settings: null });
    const answer = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { policy: 'keep' });
    expect(answer.status).toBe(400);
    expect(answer.body['refusal']).toBe('channel-unconfigured');
    expect(h.overrides.rows.size).toBe(0);
  });

  it('refuses an override that cannot resolve, at save time rather than at broadcast time', async () => {
    const h = await start({ settings: settingsOf({ defaultPolicy: 'keep' }) });
    // A duration alone cannot turn `keep` into `expire`.
    const answer = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { durationDays: 7 });
    expect(answer.status).toBe(400);
    expect(answer.body['refusal']).toBe('invalid-override');
    expect(h.overrides.rows.size).toBe(0);
  });

  it('keeps absent and null apart for the duration, all the way through the API', async () => {
    /*
     * `{ policy: 'expire' }` inherits the channel's thirty days.
     * `{ policy: 'expire', durationDays: null }` is incoherent and refused.
     * If the body reader flattened them, one of these two answers would be
     * silently wrong -- and the wrong one is a recording that lives forever.
     */
    const h = await start({ settings: settingsOf({ defaultPolicy: 'expire', defaultDurationDays: 30 }) });
    const inherit = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { policy: 'expire' });
    expect(inherit.status).toBe(200);
    expect(
      ((inherit.body['resolution'] as Record<string, unknown>)['resolved'] as Record<string, unknown>)[
        'retention'
      ],
    ).toEqual({ policy: 'expire', expiresAtMs: NOW + 30 * DAY_MS });

    const cleared = await call(h, 'PUT', '/operator/programmes/prog_2/replay-override', {
      policy: 'expire',
      durationDays: null,
    });
    expect(cleared.status).toBe(400);
  });

  it('refuses a value it does not recognise before anything is stored', async () => {
    const h = await start({ settings: settingsOf() });
    for (const body of [
      { policy: 'forever' },
      { visibility: 'locked' },
      { durationDays: 0 },
      { durationDays: 'seven' },
      { durationDays: 1.5 },
    ]) {
      const answer = await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.overrides.rows.size).toBe(0);
  });

  it('answers the same for another operator programme as for one that does not exist', async () => {
    const h = await start({ mayAdminister: false, settings: settingsOf() });
    const read = await get(h, '/operator/programmes/somebody_elses/replay-override');
    const write = await call(h, 'PUT', '/operator/programmes/somebody_elses/replay-override', {
      policy: 'none',
    });
    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
    expect(read.body).toEqual(write.body);
    expect(h.overrides.rows.size).toBe(0);
  });

  it('reads back what was stored, with the channel settings it resolves against', async () => {
    const h = await start({ settings: settingsOf({ defaultVisibility: 'unlisted' }) });
    await call(h, 'PUT', '/operator/programmes/prog_1/replay-override', { visibility: 'public' });
    const read = await get(h, '/operator/programmes/prog_1/replay-override');
    expect(read.body['override']).toEqual({ visibility: 'public' });
    expect((read.body['channelSettings'] as ChannelReplaySettings).defaultVisibility).toBe('unlisted');
    const resolved = (read.body['resolution'] as Record<string, unknown>)['resolved'] as Record<
      string,
      unknown
    >;
    expect(resolved['visibility']).toBe('public');
    expect(resolved['visibilitySource']).toBe('programme-override');
    expect(resolved['retentionSource']).toBe('channel-default');
  });
});

/* ========================================================= the owner history */

describe('the operator sees the truth about their own broadcasts', () => {
  const records = [
    airing('run_public', OWN, kept({ visibility: 'public' }), NOW - 1000),
    airing('run_unlisted', OWN, kept({ visibility: 'unlisted' }), NOW - 2000),
    airing('run_private', OWN, kept({ visibility: 'private' }), NOW - 3000),
    airing('run_none', OWN, REPLAY_NOT_KEPT, NOW - 4000),
    airing(
      'run_failed',
      OWN,
      kept({
        status: 'failed',
        failure: { reason: 'no-media-retained', summary: 'No programme media was retained for this replay.' },
      }),
      NOW - 5000,
    ),
    airing('run_other_channel', 'ch_other', kept(), NOW - 6000),
  ];

  it('lists their own channel, newest first, and nobody else', async () => {
    const h = await start({ records });
    const answer = await get(h, '/channels/mine/airings');
    const airings = answer.body['airings'] as { runId: string }[];
    expect(airings.map((a) => a.runId)).toEqual([
      'run_public',
      'run_unlisted',
      'run_private',
      'run_none',
      'run_failed',
    ]);
  });

  it('says why a recording failed, in the words this platform chose', async () => {
    const h = await start({ records });
    const airings = (await get(h, '/channels/mine/airings')).body['airings'] as {
      runId: string;
      replay: { failure: { reason: string; summary: string } | null } | null;
    }[];
    const failed = airings.find((a) => a.runId === 'run_failed');
    expect(failed?.replay?.failure?.reason).toBe('no-media-retained');
    expect(failed?.replay?.failure?.summary).toContain('No programme media');
  });

  it('distinguishes "kept nothing" from every other reason there is nothing to watch', async () => {
    const h = await start({ records });
    const airings = (await get(h, '/channels/mine/airings')).body['airings'] as {
      runId: string;
      replay: { watchable: boolean } | null;
    }[];
    expect(airings.find((a) => a.runId === 'run_none')?.replay).toBeNull();
    expect(airings.find((a) => a.runId === 'run_failed')?.replay).not.toBeNull();
    expect(airings.find((a) => a.runId === 'run_failed')?.replay?.watchable).toBe(false);
  });

  it('tells them plainly which of their recordings a stranger would find', async () => {
    const h = await start({ records });
    const airings = (await get(h, '/channels/mine/airings')).body['airings'] as {
      runId: string;
      replay: { listedPublicly: boolean } | null;
    }[];
    expect(airings.find((a) => a.runId === 'run_public')?.replay?.listedPublicly).toBe(true);
    expect(airings.find((a) => a.runId === 'run_unlisted')?.replay?.listedPublicly).toBe(false);
    expect(airings.find((a) => a.runId === 'run_private')?.replay?.listedPublicly).toBe(false);
  });

  it('and says none of them are listed when the channel itself is not published', async () => {
    const h = await start({ records, visibility: 'private' });
    const answer = await get(h, '/channels/mine/airings');
    expect(answer.body['channelPublished']).toBe(false);
    for (const entry of answer.body['airings'] as { replay: { listedPublicly: boolean } | null }[]) {
      expect(entry.replay?.listedPublicly ?? false).toBe(false);
    }
  });

  it('pages by cursor, and the pages tile the history exactly once', async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      airing(`run_${String(index).padStart(2, '0')}`, OWN, kept(), NOW - index * 1000),
    );
    const h = await start({ records: many });
    const seen: string[] = [];
    let path = '/channels/mine/airings?limit=7';
    for (let guard = 0; guard < 10; guard += 1) {
      const answer = await get(h, path);
      expect(answer.status).toBe(200);
      for (const entry of answer.body['airings'] as { runId: string }[]) seen.push(entry.runId);
      const next = answer.body['next'] as { startedAtMs: number; runId: string } | null;
      if (next === null) break;
      path = `/channels/mine/airings?limit=7&afterStartedAtMs=${next.startedAtMs}&afterRunId=${next.runId}`;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(many.map((record) => record.identity.runId));
  });

  it('lists by programme too, under the same authority', async () => {
    const h = await start({ records });
    const answer = await get(h, '/operator/programmes/ch_own/airings');
    expect(answer.status).toBe(200);
    expect((answer.body['airings'] as unknown[]).length).toBe(5);
  });

  it('refuses a programme history the caller may not administer', async () => {
    const h = await start({ records, mayAdminister: false });
    expect((await get(h, '/operator/programmes/ch_own/airings')).status).toBe(404);
  });
});

describe('a page request is read strictly', () => {
  it('refuses a limit that is not a usable whole number', async () => {
    const h = await start();
    for (const limit of ['abc', '0', '-1', '1.5', '201', '1e3']) {
      const answer = await get(h, `/channels/mine/airings?limit=${limit}`);
      expect(answer.status, limit).toBe(400);
    }
  });

  it('refuses half a cursor rather than quietly starting again', async () => {
    /*
     * Half a cursor is a client bug, and the lenient reading -- "start from the
     * beginning" -- shows a reader page one forever while they press Next.
     */
    const h = await start();
    expect((await get(h, '/channels/mine/airings?afterStartedAtMs=1')).status).toBe(400);
    expect((await get(h, '/channels/mine/airings?afterRunId=run_a')).status).toBe(400);
    expect((await get(h, '/channels/mine/airings')).status).toBe(200);
  });

  it('refuses a cursor instant that is not one', async () => {
    const h = await start();
    const answer = await get(h, '/channels/mine/airings?afterStartedAtMs=yesterday&afterRunId=r');
    expect(answer.status).toBe(400);
  });
});

/* ======================================================== the public surface */

describe('a channel that does not publish is indistinguishable from one that does not exist', () => {
  it('gives the same status and the same sentence for both', async () => {
    /*
     * THE EXISTENCE ORACLE. Two different answers here and anybody can walk a
     * list of ids and learn which private channels are real, which is precisely
     * the fact a private channel is keeping.
     */
    const h = await start({
      others: [
        { channelId: 'ch_private', visibility: 'private' },
        { channelId: 'ch_locked', visibility: 'locked' },
      ],
    });
    const missing = await get(h, '/channels/ch_nothing_here/airings');
    const priv = await get(h, '/channels/ch_private/airings');
    const locked = await get(h, '/channels/ch_locked/airings');
    expect(missing.status).toBe(404);
    expect(priv.status).toBe(404);
    expect(locked.status).toBe(404);
    expect(priv.text).toBe(missing.text);
    expect(locked.text).toBe(missing.text);
  });

  it('the same by handle', async () => {
    const h = await start({ others: [{ channelId: 'ch_private', visibility: 'private' }] });
    const missing = await get(h, '/streams/nobody/airings');
    const priv = await get(h, '/streams/ch_private/airings');
    expect(priv.status).toBe(404);
    expect(priv.text).toBe(missing.text);
  });

  it('and the same for a single airing on an unpublished channel', async () => {
    const h = await start({
      others: [{ channelId: 'ch_private', visibility: 'private' }],
      records: [airing('run_hidden', 'ch_private', kept())],
    });
    const missing = await get(h, '/channels/ch_nothing/airings/run_hidden');
    const priv = await get(h, '/channels/ch_private/airings/run_hidden');
    expect(priv.text).toBe(missing.text);
    expect(priv.status).toBe(404);
  });

  it('serves a published channel by id and by handle alike', async () => {
    const h = await start({ records: [airing('run_a', OWN, kept())] });
    const byId = await get(h, `/channels/${OWN}/airings`);
    const byHandle = await get(h, '/streams/own/airings');
    expect(byId.status).toBe(200);
    expect(byHandle.text).toBe(byId.text);
  });
});

describe('a public listing never reveals a hidden recording by changing shape', () => {
  const records = [
    airing('run_public', OWN, kept({ visibility: 'public' }), NOW - 1000),
    airing('run_unlisted', OWN, kept({ visibility: 'unlisted' }), NOW - 2000),
    airing('run_private', OWN, kept({ visibility: 'private' }), NOW - 3000),
    airing('run_none', OWN, REPLAY_NOT_KEPT, NOW - 4000),
    airing(
      'run_expired',
      OWN,
      kept({ retention: { policy: 'expire', expiresAtMs: NOW - 1 }, expiresAtMs: NOW - 1 }),
      NOW - 5000,
    ),
    airing('run_recording', OWN, kept({ status: 'recording' }), NOW - 6000),
    airing(
      'run_failed',
      OWN,
      kept({ status: 'failed', failure: { reason: 'archive-unavailable', summary: 'The replay archive was unavailable.' } }),
      NOW - 7000,
    ),
  ];

  it('every airing appears -- history does not disappear with its media', async () => {
    const h = await start({ records });
    const airings = (await get(h, `/channels/${OWN}/airings`)).body['airings'] as {
      startedAtMs: number;
    }[];
    // Identified by WHEN, not by run id: a public listing has no run ids in it.
    expect(airings.map((a) => a.startedAtMs)).toEqual(records.map((r) => r.startedAtMs));
  });

  it('only the public, available, unexpired one is watchable', async () => {
    const h = await start({ records });
    const airings = (await get(h, `/channels/${OWN}/airings`)).body['airings'] as {
      startedAtMs: number;
      replay: unknown;
    }[];
    for (const entry of airings) {
      const isThePublicOne = entry.startedAtMs === NOW - 1000;
      expect(entry.replay === null, String(entry.startedAtMs)).toBe(!isThePublicOne);
    }
  });

  it('every withheld entry is byte-identical to a never-recorded one', async () => {
    /*
     * THE SHAPE ORACLE, closed. If `run_private` and `run_none` differed by so
     * much as a key, a stranger could enumerate exactly the recordings this
     * operator chose to hide.
     */
    const h = await start({ records });
    const airings = (await get(h, `/channels/${OWN}/airings`)).body['airings'] as Record<
      string,
      unknown
    >[];
    const withheld = airings.filter((entry) => entry['replay'] === null);
    expect(withheld.length).toBe(6);
    const shapes = new Set(withheld.map((entry) => JSON.stringify(Object.keys(entry).sort())));
    expect(shapes.size).toBe(1);
    // And the shown one has the same keys too, so the key set says nothing.
    const shown = airings.find((entry) => entry['replay'] !== null);
    expect(Object.keys(shown ?? {}).sort()).toEqual(JSON.parse([...shapes][0] ?? '[]'));
  });

  it('never mentions a status, a visibility, a byte count or a failure', async () => {
    /*
     * OPAQUE RUN IDS ON PURPOSE. The fixtures elsewhere in this file are named
     * `run_unlisted`, `run_failed` and so on for legibility, and those words
     * would then appear in the response as identifiers and make this assertion
     * pass or fail for the wrong reason. Real run ids are opaque; these are too.
     */
    const opaque = [
      airing('r1', OWN, kept({ visibility: 'public' }), NOW - 1000),
      airing('r2', OWN, kept({ visibility: 'unlisted' }), NOW - 2000),
      airing('r3', OWN, kept({ visibility: 'private' }), NOW - 3000),
      airing('r4', OWN, REPLAY_NOT_KEPT, NOW - 4000),
      airing('r5', OWN, kept({ status: 'recording' }), NOW - 5000),
      airing(
        'r6',
        OWN,
        kept({
          status: 'failed',
          failure: { reason: 'archive-unavailable', summary: 'The replay archive was unavailable.' },
        }),
        NOW - 6000,
      ),
    ];
    const h = await start({ records: opaque });
    const answer = await get(h, `/channels/${OWN}/airings`);
    for (const forbidden of [
      'unlisted',
      'private',
      'failed',
      'recording',
      'archive-unavailable',
      'bytes',
      'segmentCount',
      'retention',
      'visibility',
      'listedPublicly',
    ]) {
      expect(answer.text, forbidden).not.toContain(forbidden);
    }
  });

  it('an expiry a viewer can act on is carried, and only on what they can watch', async () => {
    const expiresAtMs = NOW + 2 * DAY_MS;
    const h = await start({
      records: [
        airing('run_soon', OWN, kept({ retention: { policy: 'expire', expiresAtMs }, expiresAtMs })),
      ],
    });
    const airings = (await get(h, `/channels/${OWN}/airings`)).body['airings'] as {
      replay: { watchUrl: string; expiresAtMs: number } | null;
    }[];
    expect(airings[0]?.replay).toEqual({
      watchUrl: '/replays/run_soon/playlist.m3u8',
      expiresAtMs,
    });
  });
});

describe('unlisted means a known link, and private means no', () => {
  const records = [
    airing('run_unlisted', OWN, kept({ visibility: 'unlisted' })),
    airing('run_private', OWN, kept({ visibility: 'private' })),
    airing('run_public', OWN, kept({ visibility: 'public' })),
    airing('run_elsewhere', 'ch_other', kept({ visibility: 'public' })),
  ];

  it('an unlisted recording is absent from the listing and served to a link', async () => {
    const h = await start({ records });
    const listing = await get(h, `/channels/${OWN}/airings`);
    // Not merely a null replay: the id is not in the response at all.
    expect(listing.text).not.toContain('run_unlisted');

    const byLink = await get(h, `/channels/${OWN}/airings/run_unlisted`);
    expect(byLink.status).toBe(200);
    expect((byLink.body['airing'] as { replay: unknown }).replay).toEqual({
      watchUrl: '/replays/run_unlisted/playlist.m3u8',
      expiresAtMs: null,
    });
  });

  it('a private recording is refused to a link too, in the same shape as never-recorded', async () => {
    const h = await start({ records: [...records, airing('run_none', OWN, REPLAY_NOT_KEPT)] });
    const priv = await get(h, `/channels/${OWN}/airings/run_private`);
    const none = await get(h, `/channels/${OWN}/airings/run_none`);
    expect(priv.status).toBe(200);
    expect((priv.body['airing'] as Record<string, unknown>)['replay']).toBeNull();
    expect(Object.keys(priv.body['airing'] as object).sort()).toEqual(
      Object.keys(none.body['airing'] as object).sort(),
    );
  });

  it('a public channel id is not a key to another channel run', async () => {
    /*
     * WITHOUT THE OWNERSHIP CHECK, a published channel's id would unlock any
     * run in the catalogue -- a private channel's included. The run in the path
     * must belong to the channel in the path.
     */
    const h = await start({
      records,
      others: [{ channelId: 'ch_other', visibility: 'private' }],
    });
    const answer = await get(h, `/channels/${OWN}/airings/run_elsewhere`);
    expect(answer.status).toBe(404);
    const missing = await get(h, `/channels/${OWN}/airings/run_does_not_exist`);
    expect(answer.text).toBe(missing.text);
  });
});

describe('a replay visibility never widens what the channel decided', () => {
  it('a public recording on an unpublished channel is reachable by nobody', async () => {
    const h = await start({
      others: [{ channelId: 'ch_private', visibility: 'private' }],
      records: [airing('run_pub', 'ch_private', kept({ visibility: 'public' }))],
    });
    expect((await get(h, '/channels/ch_private/airings')).status).toBe(404);
    expect((await get(h, '/channels/ch_private/airings/run_pub')).status).toBe(404);
  });

  it('every channel tier, every replay tier: only public over public is listed', async () => {
    for (const channelVisibility of ['public', 'private', 'locked'] as const) {
      for (const replayVisibility of ['public', 'unlisted', 'private'] as const) {
        const h = await start({
          visibility: channelVisibility,
          records: [airing('run_x', OWN, kept({ visibility: replayVisibility }))],
        });
        const answer = await get(h, `/channels/${OWN}/airings`);
        const label = `${channelVisibility}/${replayVisibility}`;
        if (channelVisibility !== 'public') {
          expect(answer.status, label).toBe(404);
        } else {
          const airings = answer.body['airings'] as { replay: unknown }[];
          expect(airings[0]?.replay !== null, label).toBe(replayVisibility === 'public');
        }
        await h.close();
        open = null;
      }
    }
  });
});

/* ================================================ the locator, not just the state */

describe('a public listing does not hand out the address of what it just hid', () => {
  /*
   * THE HALF OF THE RULE THAT IS EASIER TO MISS, and this suite shipped without
   * it: collapsing hidden state to `replay: null` protects nothing while the
   * same object carries the run id.
   *
   *     { startedAtMs: ..., runId: "unlisted-secret-run-92817", replay: null }
   *         -> GET /channels/<channel>/airings/unlisted-secret-run-92817
   *         -> the unlisted recording, from the listing that hid it
   *
   * And it is a COMPLETE enumeration rather than a lucky guess: page at
   * limit=1 and every run id on the channel falls out, in order -- including
   * the ones that would come back through the page cursor.
   *
   * `unlisted` is defined as reachable by whoever holds the exact link. A
   * listing that prints the link has redefined it as reachable by everybody.
   */
  const SECRET_RUN = 'unlisted-secret-run-92817';
  const PRIVATE_RUN = 'private-secret-run-55501';
  const PUBLIC_RUN = 'public-run-00042';

  const records = [
    airing(PUBLIC_RUN, OWN, kept({ visibility: 'public' }), NOW - 1000),
    airing(SECRET_RUN, OWN, kept({ visibility: 'unlisted' }), NOW - 2000),
    airing(PRIVATE_RUN, OWN, kept({ visibility: 'private' }), NOW - 3000),
  ];

  /** Every shape the run id could be reconstructed from. */
  function absent(body: string, runId: string, label: string): void {
    for (const form of [
      runId,
      '/replays/' + runId,
      '/airings/' + runId,
      encodeURIComponent(runId),
      Buffer.from(runId).toString('base64'),
      Buffer.from(runId).toString('base64url'),
      Buffer.from(runId).toString('hex'),
    ]) {
      expect(body.includes(form), label + ': ' + form).toBe(false);
    }
  }

  it('the unlisted run id is nowhere in the public listing', async () => {
    const h = await start({ records });
    const listing = await get(h, '/channels/' + OWN + '/airings');
    expect(listing.status).toBe(200);
    absent(listing.text, SECRET_RUN, 'unlisted');
  });

  it('nor the private one', async () => {
    const h = await start({ records });
    absent((await get(h, '/channels/' + OWN + '/airings')).text, PRIVATE_RUN, 'private');
  });

  it('nor for any other reason a recording is withheld', async () => {
    const withheld: readonly (readonly [string, ReplayDisposition])[] = [
      ['never-recorded-run-1', REPLAY_NOT_KEPT],
      [
        'failed-run-2',
        kept({ status: 'failed', failure: { reason: 'archive-unavailable', summary: 'x' } }),
      ],
      [
        'expired-run-3',
        kept({ retention: { policy: 'expire', expiresAtMs: NOW - 1 }, expiresAtMs: NOW - 1 }),
      ],
      ['deleted-run-4', kept({ status: 'deleted' })],
      ['recording-run-5', kept({ status: 'recording' })],
      ['processing-run-6', kept({ status: 'processing' })],
    ];
    const h = await start({
      records: withheld.map(([runId, replay], index) =>
        airing(runId, OWN, replay, NOW - index * 10),
      ),
    });
    const listing = await get(h, '/channels/' + OWN + '/airings');
    for (const [runId] of withheld) absent(listing.text, runId, runId);
  });

  it('and the page cursor does not leak one either', async () => {
    /*
     * THE ENUMERATION VECTOR. The cursor names the LAST airing on the page, and
     * that name is a run id. At limit=1 the cursors alone walk the channel.
     */
    const h = await start({ records });
    let token: string | null = null;
    let pages = 0;
    for (let page = 0; page < 6; page += 1) {
      const path =
        '/channels/' + OWN + '/airings?limit=1' +
        (token === null ? '' : '&after=' + encodeURIComponent(token));
      const answer = await get(h, path);
      expect(answer.status, path).toBe(200);
      pages += 1;
      absent(answer.text, SECRET_RUN, 'page ' + page + ' unlisted');
      absent(answer.text, PRIVATE_RUN, 'page ' + page + ' private');
      const next = answer.body['next'];
      if (next === null || next === undefined) break;
      expect(typeof next).toBe('string');
      token = next as string;
    }
    // The walk really did reach the end, so the assertions covered every page.
    expect(pages).toBe(3);
    expect(token).not.toBeNull();
  });

  it('the known link still works, which is what unlisted means', async () => {
    const h = await start({ records });
    const byLink = await get(h, '/channels/' + OWN + '/airings/' + SECRET_RUN);
    expect(byLink.status).toBe(200);
    expect((byLink.body['airing'] as { replay: { watchUrl: string } | null }).replay).toEqual({
      watchUrl: '/replays/' + SECRET_RUN + '/playlist.m3u8',
      expiresAtMs: null,
    });
  });

  it('and the private one is still refused at that same link', async () => {
    const h = await start({ records });
    const byLink = await get(h, '/channels/' + OWN + '/airings/' + PRIVATE_RUN);
    expect(byLink.status).toBe(200);
    expect((byLink.body['airing'] as { replay: unknown }).replay).toBeNull();
  });

  it('a public available recording still gives a viewer something to press', async () => {
    const h = await start({ records });
    const airings = (await get(h, '/channels/' + OWN + '/airings')).body['airings'] as {
      replay: { watchUrl: string; expiresAtMs: number | null } | null;
    }[];
    const watchable = airings.filter((entry) => entry.replay !== null);
    expect(watchable).toHaveLength(1);
    expect(watchable[0]?.replay?.watchUrl).toBe('/replays/' + PUBLIC_RUN + '/playlist.m3u8');
  });

  it('no public body carries a run id key at all', async () => {
    // The FIELD is gone, not merely emptied, so nothing can start populating it
    // again without this failing.
    const h = await start({ records });
    const airings = (await get(h, '/channels/' + OWN + '/airings')).body['airings'] as Record<
      string,
      unknown
    >[];
    for (const entry of airings) {
      expect(Object.keys(entry).sort()).toEqual([
        'channelId',
        'endedAtMs',
        'programmeId',
        'replay',
        'startedAtMs',
      ]);
    }
  });

  it('the owner still sees their own run ids, because they may', async () => {
    const h = await start({ records });
    const airings = (await get(h, '/channels/mine/airings')).body['airings'] as {
      runId: string;
    }[];
    expect(airings.map((a) => a.runId)).toContain(SECRET_RUN);
  });
});

describe('the sealed page cursor', () => {
  it('is refused when it is not one of ours, rather than starting again', async () => {
    /*
     * Starting again would page a reader in a circle for ever while they
     * pressed Next, and would hide a client bug behind something that looks
     * like data.
     */
    const h = await start({ records: [airing('r1', OWN, kept())] });
    for (const token of [
      'nonsense',
      Buffer.from(JSON.stringify([NOW, 'r1'])).toString('base64url'),
      sealCursor(Buffer.from('a completely different service secret'), {
        startedAtMs: NOW,
        runId: 'r1',
      }),
    ]) {
      const answer = await get(h, '/channels/' + OWN + '/airings?after=' + encodeURIComponent(token));
      expect(answer.status, token.slice(0, 20)).toBe(400);
    }
  });

  it('refuses a tampered token rather than opening another page', async () => {
    const sealed = sealCursor(CURSOR_SECRET, { startedAtMs: NOW, runId: 'r1' });
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    const h = await start({ records: [airing('r1', OWN, kept())] });
    const answer = await get(
      h,
      '/channels/' + OWN + '/airings?after=' + encodeURIComponent(bytes.toString('base64url')),
    );
    expect(answer.status).toBe(400);
  });

  it('round-trips exactly, so paging is not merely opaque but correct', () => {
    const cursor = { startedAtMs: NOW, runId: 'run_with/odd chars' };
    expect(unsealCursor(CURSOR_SECRET, sealCursor(CURSOR_SECRET, cursor))).toEqual(cursor);
  });

  it('is not the same token twice, so it is not a stable handle for a run', () => {
    // A deterministic seal would be a pseudonym an observer could collect and
    // correlate across pages and channels.
    const cursor = { startedAtMs: NOW, runId: 'r1' };
    expect(sealCursor(CURSOR_SECRET, cursor)).not.toBe(sealCursor(CURSOR_SECRET, cursor));
  });

  it('the owner cursor stays in the clear, and still pages', async () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      airing('run_' + index, OWN, kept(), NOW - index * 1000),
    );
    const h = await start({ records: many });
    const first = await get(h, '/channels/mine/airings?limit=2');
    const next = first.body['next'] as { startedAtMs: number; runId: string };
    expect(next.runId).toBe('run_1');
    const second = await get(
      h,
      '/channels/mine/airings?limit=2&afterStartedAtMs=' + next.startedAtMs + '&afterRunId=' + next.runId,
    );
    expect((second.body['airings'] as { runId: string }[]).map((a) => a.runId)).toEqual([
      'run_2',
      'run_3',
    ]);
  });

  it('a public caller cannot state a run id in the query either', async () => {
    // The owner's two cursor fields ARE a run id. A public caller offering them
    // is ignored rather than honoured, so there is no path where a guessed run
    // id changes what comes back.
    const h = await start({
      records: [airing('r1', OWN, kept(), NOW), airing('r2', OWN, kept(), NOW - 1000)],
    });
    const plain = await get(h, '/channels/' + OWN + '/airings');
    const spoofed = await get(
      h,
      '/channels/' + OWN + '/airings?afterStartedAtMs=' + NOW + '&afterRunId=r1',
    );
    expect(spoofed.status).toBe(200);
    expect(spoofed.text).toBe(plain.text);
  });
});

/* ================================================================ the sweep */

describe('no response this suite produced carries a location', () => {
  it('not one', () => {
    /*
     * ABOUT EVERY BODY, not a chosen few. A path escaping through a route
     * nobody remembered to audit is the exact shape of this defect, and R1-E
     * found a real one of them: an archive failure detail carrying a spool
     * path into a product database.
     */
    expect(seenBodies.length).toBeGreaterThan(60);
    for (const body of seenBodies) {
      for (const forbidden of [
        'storageReference',
        'archiveRoot',
        'REPLAY_ROOT',
        '/replay/runs/',
        '.bin',
        'spool',
        '/var/',
        'C:\\',
      ]) {
        expect(body.includes(forbidden), `${forbidden} in ${body.slice(0, 200)}`).toBe(false);
      }
    }
  });
});
