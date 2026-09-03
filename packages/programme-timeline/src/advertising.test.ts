/** @author masterzee001 */
/**
 * The advertising boundary, tested as a boundary.
 *
 * Most of these are about what an operator CANNOT do and what a listener
 * CANNOT see. The commercial model depends on C7 owning campaign selection,
 * and a broadcaster who could skip an advertiser they dislike -- or read what
 * one pays -- would make the platform unsellable to advertisers.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeTimeline } from './index.js';
import { ProgrammeOutputBuffer } from './buffer.js';
import {
  NO_ADVERTISING,
  offerBreakOpportunity,
  operatorAdvertisingView,
  placeAdvertisement,
  type AdDecision,
  type AdvertisingAuthority,
} from './advertising.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

function decision(over: Partial<AdDecision> = {}): AdDecision {
  return {
    decisionId: 'dec_1',
    runId: 'run_1',
    campaignId: 'camp_9',
    creativeId: 'crea_3',
    programmeTimeMs: 60_000,
    durationMs: 30_000,
    policyVersion: 'policy-2026.09',
    origin: 'scheduled',
    decidedAtMs: 1_000,
    ...over,
  };
}

function authoritySaying(outcome: AdDecision | null): AdvertisingAuthority {
  return {
    async decide() {
      return outcome === null
        ? { decided: false, reason: 'frequency cap reached' }
        : { decided: true, decision: outcome };
    },
  };
}

describe('an advert is a moment in the programme, not a fetch at playback', () => {
  it('is placed at a programme time and carried by the buffer like anything else', () => {
    const timeline = new ProgrammeTimeline(RUN);
    const buffer = new ProgrammeOutputBuffer(timeline, 45_000);
    for (let i = 0; i < 120; i += 1) {
      timeline.append({ programmeTimeMs: i * 1000, kind: 'media', reference: `s${i}`, durationMs: 1000 });
    }
    placeAdvertisement(timeline, decision({ programmeTimeMs: 60_000 }));

    const released = buffer.advance();
    const advert = released.find((e) => e.kind === 'advertisement');
    expect(advert?.programmeTimeMs).toBe(60_000);
    // Every viewer receives it at programme minute one, whatever their delay,
    // sitting between the segments it was placed among. The media segment
    // beginning at the same instant was authored first and so precedes it.
    const order = released.map((e) => `${e.kind}@${e.programmeTimeMs}`);
    expect(order.indexOf('advertisement@60000')).toBeGreaterThan(order.indexOf('media@59000'));
    expect(order.indexOf('advertisement@60000')).toBeLessThan(order.indexOf('media@61000'));
  });

  it('reaches a delayed viewer in the same place as an undelayed one', () => {
    const build = (delayMs: number): readonly string[] => {
      const timeline = new ProgrammeTimeline(RUN);
      const buffer = new ProgrammeOutputBuffer(timeline, delayMs);
      for (let i = 0; i < 200; i += 1) {
        timeline.append({ programmeTimeMs: i * 1000, kind: 'media', reference: `s${i}`, durationMs: 1000 });
      }
      placeAdvertisement(timeline, decision({ programmeTimeMs: 60_000 }));
      return buffer.advance().map((e) => `${e.kind}@${e.programmeTimeMs}`);
    };

    const live = build(0);
    const delayed = build(45_000);
    const positionIn = (order: readonly string[]): number =>
      order.indexOf('advertisement@60000') - order.indexOf('media@59000');
    // Same neighbours, same order. Only the wall-clock instant differs.
    expect(positionIn(delayed)).toBe(positionIn(live));
  });
});

describe('the operator offers an opening; C7 decides', () => {
  it('places an advert when the authority accepts', async () => {
    const timeline = new ProgrammeTimeline(RUN);
    const outcome = await offerBreakOpportunity(
      authoritySaying(decision({ programmeTimeMs: 90_000, durationMs: 30_000 })),
      timeline,
      { runId: 'run_1', programmeTimeMs: 90_000, availableMs: 60_000 },
    );

    expect(outcome.decided).toBe(true);
    expect(timeline.all().filter((e) => e.kind === 'advertisement')).toHaveLength(1);
  });

  it('places nothing when the authority declines', async () => {
    const timeline = new ProgrammeTimeline(RUN);
    const outcome = await offerBreakOpportunity(authoritySaying(null), timeline, {
      runId: 'run_1',
      programmeTimeMs: 90_000,
      availableMs: 60_000,
    });

    // An opening is a request, and declining it is a complete answer. The
    // operator does not get to ask again with a different advertiser.
    expect(outcome.decided).toBe(false);
    expect(timeline.all()).toHaveLength(0);
  });

  it('refuses an advert longer than the opening rather than trimming it', async () => {
    const timeline = new ProgrammeTimeline(RUN);
    const outcome = await offerBreakOpportunity(
      authoritySaying(decision({ durationMs: 60_000 })),
      timeline,
      { runId: 'run_1', programmeTimeMs: 90_000, availableMs: 30_000 },
    );

    // Trimming would cut a creative mid-sentence and still bill for it;
    // overrunning would do what the operator asked us not to do.
    expect(outcome.decided).toBe(false);
    expect(timeline.all()).toHaveLength(0);
  });

  it('records that the operator offered it, for the audit', async () => {
    const timeline = new ProgrammeTimeline(RUN);
    await offerBreakOpportunity(
      authoritySaying(decision({ origin: 'opportunity', durationMs: 10_000 })),
      timeline,
      { runId: 'run_1', programmeTimeMs: 90_000, availableMs: 30_000 },
    );
    const [advert] = timeline.all().filter((e) => e.kind === 'advertisement');
    expect(advert?.attributes['origin']).toBe('opportunity');
  });
});

describe('commercial facts do not travel to clients', () => {
  it('puts no price, priority or targeting on the timeline event', () => {
    const timeline = new ProgrammeTimeline(RUN);
    placeAdvertisement(timeline, decision());
    const [advert] = timeline.all();

    const keys = Object.keys(advert?.attributes ?? {});
    // Ids and provenance, nothing a viewer with developer tools should read.
    expect(keys.sort()).toEqual(['campaignId', 'creativeId', 'origin', 'policyVersion']);
    const serialised = JSON.stringify(advert);
    for (const forbidden of ['price', 'cpm', 'rate', 'priority', 'targeting', 'revenue']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('shows an operator that a break is coming and nothing about who bought it', () => {
    const timeline = new ProgrammeTimeline(RUN);
    placeAdvertisement(timeline, decision({ programmeTimeMs: 120_000, durationMs: 30_000 }));
    const view = operatorAdvertisingView(timeline, 60_000, true);

    expect(view).toEqual({
      configured: true,
      breaksPlaced: 1,
      nextBreakAtProgrammeTimeMs: 120_000,
      nextBreakDurationMs: 30_000,
    });
    // No advertiser, no campaign name: an operator needs to know not to talk
    // over it, and needs nothing else.
    expect(JSON.stringify(view)).not.toContain('camp_9');
  });

  it('does not offer a break the audience has already passed', () => {
    const timeline = new ProgrammeTimeline(RUN);
    placeAdvertisement(timeline, decision({ programmeTimeMs: 10_000 }));
    expect(operatorAdvertisingView(timeline, 60_000, true).nextBreakAtProgrammeTimeMs).toBeNull();
  });
});

describe('a deployment with no advertising says so', () => {
  it('declines rather than inventing a placeholder advert', async () => {
    const timeline = new ProgrammeTimeline(RUN);
    const outcome = await offerBreakOpportunity(NO_ADVERTISING, timeline, {
      runId: 'run_1',
      programmeTimeMs: 1_000,
      availableMs: 60_000,
    });
    expect(outcome.decided).toBe(false);
    // Silence is a correct answer. A house advert nobody sold is not.
    expect(timeline.all()).toHaveLength(0);
    expect(operatorAdvertisingView(timeline, 0, false).configured).toBe(false);
  });
});
