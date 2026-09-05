/** @author masterzee001 */
/**
 * The Replay page's state machine, driven directly.
 *
 * WHAT IS ACTUALLY WORTH ASSERTING is not what the page draws. It is:
 *
 *   A REFUSED SAVE CHANGES NOTHING ON SCREEN. An optimistic apply here shows an
 *   operator a retention that is not in force, and they go on air believing it.
 *
 *   THE RESOLUTION IS THE SERVICE'S, VERBATIM. Fed one nothing would compute,
 *   the controller stores it unchanged -- which is the observable proof that
 *   the console is not deciding retention for itself.
 *
 *   A 404 IS A CAPABILITY ANSWER AND NOT AN ERROR. The routes exist only where
 *   the service has durable storage.
 *
 *   PAGES ACCUMULATE BY CURSOR, AND A PAGE THAT ARRIVES TWICE DOES NOT
 *   DUPLICATE A ROW.
 */
import { describe, expect, it } from 'vitest';
import {
  ReplayRefusedError,
  ReplayUnavailableError,
  type AiringCursorDto,
  type ChannelReplayResponse,
  type OverrideResponse,
  type OwnerHistoryResponse,
  type ReplayClient,
} from './replayClient';
import { createReplayController, type ReplayState } from './replayController';
import type { ChannelReplaySettingsDto, OwnerAiringDto } from './replayConsole';

const NOW = 1_700_000_000_000;

function settings(overrides: Partial<ChannelReplaySettingsDto> = {}): ChannelReplaySettingsDto {
  return {
    channelId: 'ch_1',
    defaultPolicy: 'keep',
    defaultDurationDays: null,
    defaultVisibility: 'unlisted',
    allowOverrides: true,
    ...overrides,
  };
}

function airing(runId: string, startedAtMs = NOW): OwnerAiringDto {
  return {
    runId,
    channelId: 'ch_1',
    programmeId: 'ch_1',
    startedAtMs,
    endedAtMs: startedAtMs + 60_000,
    replay: null,
  };
}

interface FakeOptions {
  readonly settings?: ChannelReplaySettingsDto | null;
  readonly pages?: readonly OwnerHistoryResponse[];
  readonly failSettingsSave?: Error;
  readonly failOverrideSave?: Error;
  readonly failEverything?: Error;
}

function fakeClient(options: FakeOptions = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let stored: ChannelReplaySettingsDto | null =
    options.settings === undefined ? settings() : options.settings;
  let override: OverrideResponse['override'] = null;
  let historyIndex = 0;

  const resolution = (): OverrideResponse['resolution'] => ({
    ok: true,
    resolved: {
      retention: { policy: 'keep' },
      visibility: 'unlisted',
      retentionSource: 'channel-default',
      visibilitySource: 'channel-default',
    },
  });

  const client: ReplayClient = {
    async readChannelSettings(): Promise<ChannelReplayResponse> {
      calls.push('readChannelSettings');
      if (options.failEverything) throw options.failEverything;
      return { settings: stored, maxDurationDays: 3650, channelPublished: true };
    },
    async saveChannelSettings(body): Promise<ChannelReplayResponse> {
      calls.push('saveChannelSettings');
      bodies.push(body);
      if (options.failSettingsSave) throw options.failSettingsSave;
      stored = settings({
        defaultPolicy: body['defaultPolicy'] as ChannelReplaySettingsDto['defaultPolicy'],
      });
      return { settings: stored, maxDurationDays: 3650, channelPublished: true };
    },
    async readOverride(): Promise<OverrideResponse> {
      calls.push('readOverride');
      if (options.failEverything) throw options.failEverything;
      return {
        programmeId: 'prog_1',
        override,
        channelSettings: stored,
        resolution: resolution(),
        maxDurationDays: 3650,
      };
    },
    async saveOverride(_programmeId, body): Promise<OverrideResponse> {
      calls.push('saveOverride');
      bodies.push(body);
      if (options.failOverrideSave) throw options.failOverrideSave;
      override = body as OverrideResponse['override'];
      return {
        programmeId: 'prog_1',
        override,
        channelSettings: stored,
        resolution: resolution(),
        maxDurationDays: 3650,
      };
    },
    async readHistory(after: AiringCursorDto | null): Promise<OwnerHistoryResponse> {
      calls.push(after === null ? 'readHistory' : `readHistory:${after.runId}`);
      if (options.failEverything) throw options.failEverything;
      const pages = options.pages ?? [
        { airings: [airing('run_a')], next: null, pageSize: 50, channelPublished: true },
      ];
      const page = after === null ? pages[0] : pages[Math.min(historyIndex + 1, pages.length - 1)];
      if (after !== null) historyIndex = Math.min(historyIndex + 1, pages.length - 1);
      return page ?? { airings: [], next: null, pageSize: 50, channelPublished: true };
    },
  };
  return { client, calls, bodies };
}

function drive(fake: ReturnType<typeof fakeClient>, programmeId: string | null = 'prog_1') {
  const seen: ReplayState[] = [];
  const controller = createReplayController({
    client: fake.client,
    programmeId,
    onState: (state) => seen.push(state),
  });
  return { controller, seen };
}

/* =============================================================== the loading */

describe('loading', () => {
  it('reads settings, the override and the first history page', async () => {
    const fake = fakeClient();
    const { controller } = drive(fake);
    await controller.reload();
    expect(fake.calls).toEqual(['readChannelSettings', 'readOverride', 'readHistory']);
    expect(controller.state().loading).toBe(false);
    expect(controller.state().settings).not.toBeNull();
    expect(controller.state().airings).toHaveLength(1);
  });

  it('does not ask for an override when there is no programme', async () => {
    const fake = fakeClient();
    const { controller } = drive(fake, null);
    await controller.reload();
    expect(fake.calls).not.toContain('readOverride');
  });

  it('keeps null settings as null rather than inventing a default', async () => {
    /*
     * "THIS CHANNEL HAS DECIDED NOTHING" IS AN ANSWER. A controller that filled
     * it in would have made the decision on the operator's behalf, in a place
     * nobody would look for one.
     */
    const fake = fakeClient({ settings: null });
    const { controller } = drive(fake);
    await controller.reload();
    expect(controller.state().settings).toBeNull();
    expect(controller.state().unavailable).toBe(false);
  });

  it('treats a 404 as an absent capability, not as an error', async () => {
    const fake = fakeClient({ failEverything: new ReplayUnavailableError() });
    const { controller } = drive(fake);
    await controller.reload();
    expect(controller.state().unavailable).toBe(true);
    expect(controller.state().error).toBeNull();
    expect(controller.state().loading).toBe(false);
  });

  it('shows the service sentence for anything else', async () => {
    const fake = fakeClient({
      failEverything: new ReplayRefusedError('The database is not reachable.', null),
    });
    const { controller } = drive(fake);
    await controller.reload();
    expect(controller.state().error).toBe('The database is not reachable.');
    expect(controller.state().unavailable).toBe(false);
  });

  it('replaces the history rather than merging it', async () => {
    // A reload is a fresh answer. Merging would leave an expired or deleted
    // airing on screen from the previous one.
    const fake = fakeClient({
      pages: [{ airings: [airing('run_a')], next: null, pageSize: 50, channelPublished: true }],
    });
    const { controller } = drive(fake);
    await controller.reload();
    await controller.reload();
    expect(controller.state().airings.map((a) => a.runId)).toEqual(['run_a']);
  });
});

/* ================================================================ the saving */

describe('a refused save changes nothing', () => {
  it('leaves the stored settings exactly as they were', async () => {
    const fake = fakeClient({
      failSettingsSave: new ReplayRefusedError('policy expire requires a duration.', null),
    });
    const { controller } = drive(fake);
    await controller.reload();
    const before = controller.state().settings;

    const ok = await controller.saveSettings({ defaultPolicy: 'expire' });
    expect(ok).toBe(false);
    expect(controller.state().settings).toEqual(before);
    expect(controller.state().error).toBe('policy expire requires a duration.');
    expect(controller.state().saving).toBe(false);
  });

  it('leaves the stored override exactly as it was', async () => {
    const fake = fakeClient({
      failOverrideSave: new ReplayRefusedError(
        'this channel does not permit per-programme replay overrides',
        'overrides-forbidden',
      ),
    });
    const { controller } = drive(fake);
    await controller.reload();

    const ok = await controller.saveOverride({ policy: 'none' });
    expect(ok).toBe(false);
    expect(controller.state().override).toBeNull();
    expect(controller.state().error).toContain('does not permit');
  });

  it('never optimistically shows a state the service has not accepted', async () => {
    /*
     * THE ONE LIE THIS FEATURE CANNOT AFFORD. An operator who is shown "kept
     * for 30 days" after a refused save goes on air believing it.
     */
    const fake = fakeClient({ failSettingsSave: new ReplayRefusedError('no', null) });
    const { controller, seen } = drive(fake);
    await controller.reload();
    await controller.saveSettings({ defaultPolicy: 'expire', defaultDurationDays: 30 });
    for (const state of seen) {
      expect(state.settings?.defaultPolicy ?? 'keep').not.toBe('expire');
    }
  });

  it('sends exactly the body it was given', async () => {
    const fake = fakeClient();
    const { controller } = drive(fake);
    await controller.reload();
    await controller.saveOverride({ policy: 'expire', durationDays: 7 });
    expect(fake.bodies).toEqual([{ policy: 'expire', durationDays: 7 }]);
  });
});

describe('a channel default that moves takes the preview with it', () => {
  it('re-reads the override after the defaults change', async () => {
    /*
     * Changing a default changes what every programme that inherits it will do.
     * A preview left over from the previous defaults would be quietly wrong.
     */
    const fake = fakeClient();
    const { controller } = drive(fake);
    await controller.reload();
    fake.calls.length = 0;
    await controller.saveSettings({ defaultPolicy: 'none' });
    expect(fake.calls).toEqual(['saveChannelSettings', 'readOverride']);
  });

  it('does not when there is no programme in hand', async () => {
    const fake = fakeClient();
    const { controller } = drive(fake, null);
    await controller.reload();
    fake.calls.length = 0;
    await controller.saveSettings({ defaultPolicy: 'none' });
    expect(fake.calls).toEqual(['saveChannelSettings']);
  });
});

describe('the resolution is the service answer and nothing else', () => {
  it('stores one that nothing would have computed, unchanged', async () => {
    const contradictory: OverrideResponse['resolution'] = {
      ok: true,
      resolved: {
        retention: { policy: 'expire', expiresAtMs: NOW + 1 },
        visibility: 'private',
        retentionSource: 'programme-override',
        visibilitySource: 'programme-override',
      },
    };
    const fake = fakeClient();
    const originalRead = fake.client.readOverride.bind(fake.client);
    const patched: ReplayClient = {
      ...fake.client,
      async readOverride(programmeId) {
        return { ...(await originalRead(programmeId)), resolution: contradictory };
      },
    };
    const controller = createReplayController({
      client: patched,
      programmeId: 'prog_1',
      onState: () => {},
    });
    await controller.reload();
    expect(controller.state().resolution).toEqual(contradictory);
  });

  it('carries the refusal through as the service worded it', async () => {
    const refused: OverrideResponse['resolution'] = {
      ok: false,
      refusal: 'channel-unconfigured',
      detail: 'no replay settings are configured for channel ch_1',
    };
    const fake = fakeClient();
    const originalRead = fake.client.readOverride.bind(fake.client);
    const controller = createReplayController({
      client: {
        ...fake.client,
        async readOverride(programmeId) {
          return { ...(await originalRead(programmeId)), resolution: refused };
        },
      },
      programmeId: 'prog_1',
      onState: () => {},
    });
    await controller.reload();
    expect(controller.state().resolution).toEqual(refused);
  });
});

/* =============================================================== the paging */

describe('history pages accumulate by cursor', () => {
  const pages: OwnerHistoryResponse[] = [
    {
      airings: [airing('run_1', NOW), airing('run_2', NOW - 1)],
      next: { startedAtMs: NOW - 1, runId: 'run_2' },
      pageSize: 2,
      channelPublished: true,
    },
    {
      airings: [airing('run_3', NOW - 2), airing('run_4', NOW - 3)],
      next: null,
      pageSize: 2,
      channelPublished: true,
    },
  ];

  it('appends the next page and stops when there is none', async () => {
    const fake = fakeClient({ pages });
    const { controller } = drive(fake);
    await controller.reload();
    expect(controller.state().airings.map((a) => a.runId)).toEqual(['run_1', 'run_2']);
    await controller.loadMoreHistory();
    expect(controller.state().airings.map((a) => a.runId)).toEqual([
      'run_1',
      'run_2',
      'run_3',
      'run_4',
    ]);
    expect(controller.state().nextPage).toBeNull();
  });

  it('does nothing when there is no next page', async () => {
    const fake = fakeClient({ pages });
    const { controller } = drive(fake);
    await controller.reload();
    await controller.loadMoreHistory();
    fake.calls.length = 0;
    await controller.loadMoreHistory();
    expect(fake.calls).toEqual([]);
  });

  it('sends the cursor it was given rather than an offset', async () => {
    const fake = fakeClient({ pages });
    const { controller } = drive(fake);
    await controller.reload();
    await controller.loadMoreHistory();
    expect(fake.calls).toContain('readHistory:run_2');
  });

  it('a page that arrives twice does not duplicate a row', async () => {
    /*
     * A double click, a retried request. The run id is the only thing that
     * identifies a broadcast, so it is the key.
     */
    const repeating: OwnerHistoryResponse[] = [
      {
        airings: [airing('run_1'), airing('run_2')],
        next: { startedAtMs: NOW, runId: 'run_2' },
        pageSize: 2,
        channelPublished: true,
      },
      {
        airings: [airing('run_2'), airing('run_3')],
        next: null,
        pageSize: 2,
        channelPublished: true,
      },
    ];
    const fake = fakeClient({ pages: repeating });
    const { controller } = drive(fake);
    await controller.reload();
    await controller.loadMoreHistory();
    expect(controller.state().airings.map((a) => a.runId)).toEqual(['run_1', 'run_2', 'run_3']);
  });
});
