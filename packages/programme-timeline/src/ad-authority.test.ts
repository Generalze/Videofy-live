/** @author masterzee001 */
/**
 * The commercial rules, and the boundary they must not cross.
 *
 * Two kinds of test here. The first kind is arithmetic: caps, spacing,
 * targeting, validity. The second kind is the one that matters commercially --
 * that nothing about price, priority or why a campaign won can reach a
 * broadcaster or a viewer through the decision it produces.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_IMPRESSIONS,
  assessCampaign,
  selectAdvertisement,
  withImpression,
  type Campaign,
  type DecisionContext,
  createC7AdvertisingAuthority,
} from './ad-authority.js';
import { ProgrammeTimeline } from './index.js';
import { offerBreakOpportunity } from './advertising.js';

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaignId: 'camp_a',
    creativeIds: ['crea_1'],
    durationMs: 30_000,
    priority: 10,
    startsAtMs: 0,
    endsAtMs: 10_000_000_000,
    programmeIds: [],
    languages: [],
    regions: [],
    maxPerRun: 2,
    minSpacingMs: 300_000,
    ...over,
  };
}

function context(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    runId: 'run_1',
    programmeId: 'prog_news',
    programmeTimeMs: 600_000,
    availableMs: 60_000,
    origin: 'scheduled',
    sourceLanguage: 'en',
    region: 'NG',
    nowMs: 1_000_000,
    ...over,
  };
}

const mint = (): string => 'dec_1';

describe('eligibility, one rule at a time', () => {
  it('accepts a campaign that satisfies everything', () => {
    expect(assessCampaign(campaign(), context(), NO_IMPRESSIONS).eligible).toBe(true);
  });

  it('refuses one outside its validity window', () => {
    const expired = campaign({ endsAtMs: 500 });
    expect(assessCampaign(expired, context(), NO_IMPRESSIONS).reason).toBe('outside-validity-window');
  });

  it('refuses one targeted at a different programme', () => {
    const other = campaign({ programmeIds: ['prog_sport'] });
    expect(assessCampaign(other, context(), NO_IMPRESSIONS).reason).toBe(
      'not-targeted-at-this-programme',
    );
  });

  it('targets by language and region', () => {
    expect(
      assessCampaign(campaign({ languages: ['yo'] }), context(), NO_IMPRESSIONS).reason,
    ).toBe('not-targeted-at-this-language');
    expect(assessCampaign(campaign({ regions: ['GB'] }), context(), NO_IMPRESSIONS).reason).toBe(
      'not-targeted-at-this-region',
    );
  });

  it('refuses one longer than the break rather than trimming it', () => {
    // Trimming cuts a creative mid-sentence and still bills for it.
    const long = campaign({ durationMs: 90_000 });
    expect(assessCampaign(long, context({ availableMs: 30_000 }), NO_IMPRESSIONS).reason).toBe(
      'longer-than-the-break',
    );
  });

  it('refuses one with no creative to play', () => {
    expect(assessCampaign(campaign({ creativeIds: [] }), context(), NO_IMPRESSIONS).reason).toBe(
      'no-creative',
    );
  });

  it('applies a frequency cap per broadcast', () => {
    let history = NO_IMPRESSIONS;
    history = withImpression(history, 'camp_a', 0);
    history = withImpression(history, 'camp_a', 300_000);
    expect(assessCampaign(campaign(), context(), history).reason).toBe('frequency-cap-reached');
  });

  it('applies minimum spacing between impressions', () => {
    const history = withImpression(NO_IMPRESSIONS, 'camp_a', 550_000);
    // Fifty seconds after the last one, against five minutes of spacing.
    expect(assessCampaign(campaign(), context(), history).reason).toBe(
      'too-soon-after-its-last-impression',
    );
  });

  it('names every refusal, because unexplained missing revenue costs a day', () => {
    const verdict = assessCampaign(campaign({ regions: ['GB'] }), context(), NO_IMPRESSIONS);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).not.toBeNull();
  });
});

describe('selection is deterministic and auditable', () => {
  it('chooses the highest priority among the eligible', () => {
    const selection = selectAdvertisement(
      [campaign({ campaignId: 'low', priority: 1 }), campaign({ campaignId: 'high', priority: 9 })],
      context(),
      NO_IMPRESSIONS,
      mint,
      'policy-1',
    );
    expect(selection.decision?.campaignId).toBe('high');
  });

  it('breaks a tie the same way every time', () => {
    const tied = [campaign({ campaignId: 'b' }), campaign({ campaignId: 'a' })];
    // Not the order a store happened to return rows in: "why did that advert
    // run" must have an answer.
    const first = selectAdvertisement(tied, context(), NO_IMPRESSIONS, mint, 'policy-1');
    const second = selectAdvertisement([...tied].reverse(), context(), NO_IMPRESSIONS, mint, 'policy-1');
    expect(first.decision?.campaignId).toBe(second.decision?.campaignId);
  });

  it('decides nothing when nothing is eligible, and says why for each', () => {
    const selection = selectAdvertisement(
      [campaign({ campaignId: 'a', regions: ['GB'] }), campaign({ campaignId: 'b', durationMs: 999_000 })],
      context(),
      NO_IMPRESSIONS,
      mint,
      'policy-1',
    );
    expect(selection.decision).toBeNull();
    expect(selection.verdicts.map((v) => v.reason)).toEqual([
      'not-targeted-at-this-region',
      'longer-than-the-break',
    ]);
  });

  it('binds the decision to the run and the programme moment', () => {
    const selection = selectAdvertisement([campaign()], context(), NO_IMPRESSIONS, mint, 'policy-9');
    // Bound before it can become public: two viewers on different delays must
    // receive the same advert in the same place.
    expect(selection.decision?.runId).toBe('run_1');
    expect(selection.decision?.programmeTimeMs).toBe(600_000);
    expect(selection.decision?.policyVersion).toBe('policy-9');
  });

  it('records whether the operator offered the opening', () => {
    const selection = selectAdvertisement(
      [campaign()],
      context({ origin: 'opportunity' }),
      NO_IMPRESSIONS,
      mint,
      'policy-1',
    );
    expect(selection.decision?.origin).toBe('opportunity');
  });
});

describe('commercial facts stay inside C7', () => {
  it('puts no price, priority or targeting on the decision', () => {
    const selection = selectAdvertisement(
      [campaign({ priority: 97, regions: ['NG'], languages: ['en'] })],
      context(),
      NO_IMPRESSIONS,
      mint,
      'policy-1',
    );
    const serialised = JSON.stringify(selection.decision).toLowerCase();

    // The decision travels to a timeline and onward to clients. A broadcaster
    // who could read priority, or a viewer who could read a rate, would make
    // the platform unsellable to advertisers.
    for (const forbidden of ['priority', 'region', 'language', 'price', 'cpm', 'rate', 'maxperrun']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(Object.keys(selection.decision ?? {}).sort()).toEqual([
      'campaignId',
      'creativeId',
      'decidedAtMs',
      'decisionId',
      'durationMs',
      'origin',
      'policyVersion',
      'programmeTimeMs',
      'runId',
    ]);
  });

  it('keeps the reasons for C7 rather than the operator', () => {
    const selection = selectAdvertisement(
      [campaign({ campaignId: 'rival', maxPerRun: 0 })],
      context(),
      NO_IMPRESSIONS,
      mint,
      'policy-1',
    );
    // Available for audit, deliberately separate from the decision itself:
    // knowing a rival's campaign is capped is commercially useful.
    expect(selection.verdicts[0]?.reason).toBe('frequency-cap-reached');
    expect(selection.decision).toBeNull();
  });
});

describe('two airings of one programme each get their own allowance', () => {
  it('counts impressions per run', () => {
    // History is per broadcast, so a second airing is not penalised for the
    // first one's breaks.
    const first = withImpression(withImpression(NO_IMPRESSIONS, 'camp_a', 0), 'camp_a', 400_000);
    expect(assessCampaign(campaign(), context(), first).eligible).toBe(false);
    expect(assessCampaign(campaign(), context({ runId: 'run_2' }), NO_IMPRESSIONS).eligible).toBe(true);
  });
});

/*
 * THE JOIN. The engine above is worthless if nothing calls it, and a rule
 * that is written, tested and never reached is this repository's recurring
 * defect. `offerBreakOpportunity` asks an AdvertisingAuthority; this proves
 * the engine is one, and that the timeline ends up with the decision.
 */
describe('the engine is what the timeline actually asks', () => {
  function authorityOver(campaigns: readonly Campaign[]): ReturnType<typeof createC7AdvertisingAuthority> {
    let minted = 0;
    return createC7AdvertisingAuthority({
      campaigns: () => campaigns,
      programmeId: () => 'prog_news',
      sourceLanguage: () => 'en',
      region: () => 'NG',
      policyVersion: 'policy-2026.09',
      mintDecisionId: () => `dec_${(minted += 1)}`,
      now: () => 1_000_000,
    });
  }

  it('places a decided advert on the timeline through the real entry point', async () => {
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
    const adverts = timeline.all().filter((event) => event.kind === 'advertisement');
    expect(adverts).toHaveLength(1);
    expect(adverts[0]?.attributes['campaignId']).toBe('camp_a');
  });

  it('applies the frequency cap across breaks in one broadcast', async () => {
    const authority = authorityOver([campaign({ maxPerRun: 1, minSpacingMs: 0 })]);
    const timeline = new ProgrammeTimeline({
      channelId: 'ch_1',
      programmeId: 'prog_news',
      runId: 'run_1',
    });

    const first = await offerBreakOpportunity(authority, timeline, {
      runId: 'run_1',
      programmeTimeMs: 600_000,
      availableMs: 60_000,
    });
    const second = await offerBreakOpportunity(authority, timeline, {
      runId: 'run_1',
      programmeTimeMs: 1_200_000,
      availableMs: 60_000,
    });

    expect(first.decided).toBe(true);
    // The cap survives across breaks because the authority remembers.
    expect(second.decided).toBe(false);
    expect(timeline.all().filter((e) => e.kind === 'advertisement')).toHaveLength(1);
  });

  it('gives a second airing its own allowance', async () => {
    const authority = authorityOver([campaign({ maxPerRun: 1 })]);
    const one = new ProgrammeTimeline({ channelId: 'ch_1', programmeId: 'prog_news', runId: 'run_1' });
    const two = new ProgrammeTimeline({ channelId: 'ch_1', programmeId: 'prog_news', runId: 'run_2' });

    await offerBreakOpportunity(authority, one, { runId: 'run_1', programmeTimeMs: 1, availableMs: 60_000 });
    const other = await offerBreakOpportunity(authority, two, {
      runId: 'run_2',
      programmeTimeMs: 1,
      availableMs: 60_000,
    });
    expect(other.decided).toBe(true);
  });

  it('tells the operator nothing about why a rival was skipped', async () => {
    const audited: string[] = [];
    const authority = createC7AdvertisingAuthority({
      campaigns: () => [campaign({ campaignId: 'rival', maxPerRun: 0 })],
      programmeId: () => 'prog_news',
      sourceLanguage: () => 'en',
      region: () => 'NG',
      policyVersion: 'p',
      mintDecisionId: () => 'dec_1',
      now: () => 1_000_000,
      onAudit: (_runId, verdicts) => audited.push(...verdicts.map((v) => v.reason ?? '')),
    });

    const outcome = await authority.decide({
      runId: 'run_1',
      programmeTimeMs: 1,
      availableMs: 60_000,
      origin: 'scheduled',
    });

    expect(outcome.decided).toBe(false);
    if (outcome.decided) throw new Error('unreachable');
    // C7 knows precisely why; the caller is told only that there is none.
    expect(audited).toContain('frequency-cap-reached');
    expect(outcome.reason).not.toContain('cap');
  });
});
