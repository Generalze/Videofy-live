/** @author masterzee001 */
/**
 * C7 decides which advert runs, and this is where that stops being a design
 * note and becomes something a broadcaster cannot get around.
 *
 * The founder's ruling has one commercial consequence and one operational one.
 * Commercially: a broadcaster who could choose their advertiser, skip one they
 * disliked, or read what a campaign pays would make the platform unsellable.
 * Operationally: a viewer who could pick their own advert would make
 * impressions unauditable. Both are structural here rather than checked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createC7AdvertisingClient, NO_CAMPAIGN_SOURCE } from '../c7-advertising-client.js';
import {
  createC7AdvertisingAuthority,
  offerBreakOpportunity,
  ProgrammeTimeline,
  type Campaign,
} from '@videofy-live/programme-timeline';

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

function campaignRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: 'camp_a',
    priority: 10,
    startsAtMs: 0,
    endsAtMs: 10_000_000_000_000,
    programmeIds: [],
    languages: [],
    regions: [],
    maxPerRun: 2,
    minSpacingMs: 0,
    creativeIds: ['crea_1'],
    durationMs: 30_000,
    ...over,
  };
}

function clientOver(handler: (url: string, init?: RequestInit) => Response) {
  return createC7AdvertisingClient({
    accountServiceUrl: 'http://account.internal/',
    internalToken: 'internal-token',
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      handler(String(input), init)) as typeof fetch,
  });
}

describe('reading what C7 has sold', () => {
  it('holds the campaigns the account service returns', async () => {
    const client = clientOver(() =>
      new Response(JSON.stringify({ campaigns: [campaignRow()] }), { status: 200 }),
    );
    expect(await client.refresh()).toBe(true);
    expect(client.campaigns()).toHaveLength(1);
    expect(client.campaigns()[0]?.campaignId).toBe('camp_a');
  });

  it('presents the internal token, because these are commercial records', async () => {
    let sawToken: string | null = null;
    const client = clientOver((_url, init) => {
      sawToken = new Headers(init?.headers).get('X-Videofy-Internal-Token');
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    });
    await client.refresh();
    expect(sawToken).toBe('internal-token');
  });

  it('keeps the previous list when a refresh fails', async () => {
    let healthy = true;
    const client = clientOver(() =>
      healthy
        ? new Response(JSON.stringify({ campaigns: [campaignRow()] }), { status: 200 })
        : new Response('nope', { status: 500 }),
    );
    await client.refresh();
    healthy = false;

    expect(await client.refresh()).toBe(false);
    /*
     * Emptying the list on a failed read would take a deployment's whole
     * advertising offline because one request timed out, which is a worse
     * answer than a slightly stale one.
     */
    expect(client.campaigns()).toHaveLength(1);
  });

  it('advertises nothing at all with no campaign source, and says so', async () => {
    expect(NO_CAMPAIGN_SOURCE.configured).toBe(false);
    expect(NO_CAMPAIGN_SOURCE.campaigns()).toEqual([]);
  });

  it('reads a run impressions so a restart does not reset a frequency cap', async () => {
    const client = clientOver(() =>
      new Response(
        JSON.stringify({
          impressions: [
            { campaignId: 'camp_a', programmeTimeMs: 60_000 },
            { campaignId: 'camp_a', programmeTimeMs: 600_000 },
          ],
        }),
        { status: 200 },
      ),
    );
    const placed = await client.impressionsForRun('run_1');
    // Otherwise an advertiser is overserved by exactly as many breaks as
    // follow the restart.
    expect(placed.get('camp_a')).toEqual([60_000, 600_000]);
  });

  it('reports a replayed impression as already recorded rather than as a fault', async () => {
    const client = clientOver(() =>
      new Response(JSON.stringify({ recorded: false }), { status: 200 }),
    );
    const recorded = await client.record({
      decisionId: 'dec_1',
      runId: 'run_1',
      campaignId: 'camp_a',
      creativeId: 'crea_1',
      programmeTimeMs: 60_000,
      durationMs: 30_000,
      policyVersion: 'p',
      origin: 'opportunity',
      decidedAtMs: 1_000,
    });
    // A reconnect replaying a decision is ordinary; the advertiser is billed
    // once and nobody is asked to interpret an error.
    expect(recorded).toBe(false);
  });
});

describe('the engine, over what the client holds', () => {
  function authorityOver(campaigns: readonly Campaign[]) {
    let minted = 0;
    return createC7AdvertisingAuthority({
      campaigns: () => campaigns,
      programmeId: () => 'prog_news',
      sourceLanguage: () => 'en',
      region: () => 'NG',
      policyVersion: 'p',
      mintDecisionId: () => `dec_${(minted += 1)}`,
      now: () => 1_000_000,
    });
  }

  const campaign = (over: Partial<Campaign> = {}): Campaign => ({
    campaignId: 'camp_a',
    creativeIds: ['crea_1'],
    durationMs: 30_000,
    priority: 10,
    startsAtMs: 0,
    endsAtMs: 10_000_000_000_000,
    programmeIds: [],
    languages: [],
    regions: [],
    maxPerRun: 2,
    minSpacingMs: 0,
    ...over,
  });

  it('places a decided advert on the timeline', async () => {
    const timeline = new ProgrammeTimeline({
      channelId: 'ch_1',
      programmeId: 'prog_news',
      runId: 'run_1',
    });
    const outcome = await offerBreakOpportunity(authorityOver([campaign()]), timeline, {
      runId: 'run_1',
      programmeTimeMs: 600_000,
      availableMs: 60_000,
    });
    expect(outcome.decided).toBe(true);
    expect(timeline.all().filter((event) => event.kind === 'advertisement')).toHaveLength(1);
  });

  it('honours a cap restored from storage, as though this process had placed it', async () => {
    const authority = authorityOver([campaign({ maxPerRun: 1 })]);
    authority.primeHistory('run_1', new Map([['camp_a', [60_000]]]));

    const timeline = new ProgrammeTimeline({
      channelId: 'ch_1',
      programmeId: 'prog_news',
      runId: 'run_1',
    });
    const outcome = await offerBreakOpportunity(authority, timeline, {
      runId: 'run_1',
      programmeTimeMs: 600_000,
      availableMs: 60_000,
    });
    // The restart case. Without this the cap resets and the advertiser is
    // overserved for the rest of the broadcast.
    expect(outcome.decided).toBe(false);
  });

  it('does not let a restored history overwrite what this process already knows', async () => {
    const authority = authorityOver([campaign({ maxPerRun: 1 })]);
    const timeline = new ProgrammeTimeline({
      channelId: 'ch_1',
      programmeId: 'prog_news',
      runId: 'run_1',
    });
    await offerBreakOpportunity(authority, timeline, {
      runId: 'run_1',
      programmeTimeMs: 60_000,
      availableMs: 60_000,
    });
    // A read that started before that decision must not erase it.
    authority.primeHistory('run_1', new Map());
    const second = await offerBreakOpportunity(authority, timeline, {
      runId: 'run_1',
      programmeTimeMs: 600_000,
      availableMs: 60_000,
    });
    expect(second.decided).toBe(false);
  });
});

describe('what the operator cannot do', () => {
  it('offers a break and nothing else', () => {
    expect(INDEX).toContain("app.post('/programmes/:runId/advertising/break', operatorOnly");
    /*
     * The whole shape of the split. A body field naming a campaign, creative
     * or advertiser would be the ruling quietly reversed, so none is read.
     */
    for (const forbidden of ['campaignId', 'creativeId', 'advertiser', 'priority']) {
      const readsIt = new RegExp(`req\\.body[\\s\\S]{0,200}${forbidden}`, 'u');
      expect(INDEX).not.toMatch(readsIt);
    }
  });

  it('is told whether an advert ran, never which campaign lost or why', () => {
    expect(INDEX).toContain('res.status(200).json({ decided: false, reason: outcome.reason });');
    // The verdicts go to C7's own audit at debug, and nowhere near a reply.
    expect(INDEX).toContain("logger.debug('C7 advertising verdicts'");
    expect(INDEX).not.toMatch(/json\([^)]*verdicts/u);
  });

  it('bills only after the advert reached the timeline', () => {
    // A decision that was made and never placed must not be billed.
    const decisionIndex = INDEX.indexOf('await offerBreakOpportunity(advertisingAuthority');
    const recordIndex = INDEX.indexOf('await advertisingClient.record({');
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(decisionIndex);
  });

  it('places the advert at the input edge, so every viewer meets it in the same place', () => {
    /*
     * Two viewers on different delays must receive the same advert at the same
     * programme moment. Placing it at the cursor would put it where the
     * furthest-behind viewer happens to be.
     */
    expect(INDEX).toContain('programmeTimeMs: status.cursor.programmeTimeMs');
  });
});

describe('the composition root builds a real one', () => {
  it('reads campaigns from the account service, not from a placeholder', () => {
    expect(INDEX).toContain('createC7AdvertisingClient({');
    expect(INDEX).toContain('createC7AdvertisingAuthority({');
    expect(INDEX).toContain('campaigns: () => advertisingClient.campaigns()');
  });

  it('says out loud when no campaign source is attached', () => {
    // Otherwise a deployment with nothing sold and one that cannot read
    // campaigns look identical: both simply never advertise.
    expect(INDEX).toContain('no campaign source; no advert will ever be decided');
  });

  it('primes a run history before any break can be offered', () => {
    expect(INDEX).toContain('advertisingAuthority.primeHistory(runId, placed)');
  });
});
