/** @author masterzee001 */
/**
 * C7 decides the advertising. The programme operator does not.
 *
 * THE BOUNDARY, stated once so every function below can be read against it:
 * the operator runs the programme and may say when a break would not cut
 * somebody off mid-sentence. C7 owns campaign selection, creative selection,
 * eligibility, frequency, targeting and the decision to insert. A broadcaster
 * cannot choose their advertiser, skip one they dislike, or learn what a
 * campaign pays.
 *
 * WHY IT IS A TIMELINE EVENT. Today a listener fetches whatever advert happens
 * to be available at the moment it renders. That is invisible while everything
 * is roughly live and catastrophic the moment output is delayed: the advert
 * plays over content it was never placed against, and two viewers on different
 * delays see different breaks. Deciding once, placing at a programme time, and
 * letting the buffer carry it means every viewer receives the same break in
 * the same place -- at a different wall-clock instant, which is the point.
 *
 * WHAT LEAVES THIS MODULE. A decision carries ids and a duration. It does not
 * carry price, priority, targeting rules or campaign performance: those are
 * commercial facts, they are nobody's business on a listener client, and a
 * viewer with developer tools is not an authorised reader of them.
 */

import type { ProgrammeTimeline, ProgrammeTimelineEvent } from './index.js';

/** Why C7 placed a break here. Recorded so a schedule can be audited. */
export type BreakOrigin =
  /** C7's own schedule decided it was time. */
  | 'scheduled'
  /** The operator offered a safe opening and C7 accepted it. */
  | 'opportunity';

/**
 * An advertisement, decided and fixed.
 *
 * Immutable once made. A decision that could be revised after placement would
 * mean two viewers at different delays receiving different adverts from the
 * same break, which is the exact failure the timeline exists to prevent.
 */
export interface AdDecision {
  readonly decisionId: string;
  readonly runId: string;
  readonly campaignId: string;
  readonly creativeId: string;
  /** Where in the broadcast it plays. */
  readonly programmeTimeMs: number;
  readonly durationMs: number;
  /** Which policy produced it, so an audit can reproduce the reasoning. */
  readonly policyVersion: string;
  readonly origin: BreakOrigin;
  readonly decidedAtMs: number;
}

/**
 * What a programme operator is allowed to ask for.
 *
 * Not "play this advertiser". Only: a break here would not interrupt anybody.
 * Interviews, ceremonies and live discussion are why this exists -- an
 * automated schedule should not cut across a sentence -- and it is a REQUEST,
 * which C7 may decline.
 */
export interface BreakOpportunity {
  readonly runId: string;
  readonly programmeTimeMs: number;
  /** How long the operator believes is safely available. */
  readonly availableMs: number;
}

export type AdDecisionOutcome =
  | { readonly decided: true; readonly decision: AdDecision }
  /** C7 considered and declined. The reason is for C7's audit, not the operator. */
  | { readonly decided: false; readonly reason: string };

/**
 * The questions C7 answers and nobody else does.
 *
 * An interface rather than an implementation because the deciding lives in a
 * commercial system that does not belong in a media pipeline: media-ingest
 * must never learn what a campaign is worth. This is the seam it reaches
 * across.
 */
export interface AdvertisingAuthority {
  /**
   * Should a break run at this point, and if so which one?
   *
   * The authority sees the run and the position and decides everything else.
   * A `false` answer is complete: the caller does not get to try again with a
   * different campaign, because it never knew there were campaigns.
   */
  decide(request: {
    readonly runId: string;
    readonly programmeTimeMs: number;
    readonly availableMs: number;
    readonly origin: BreakOrigin;
  }): Promise<AdDecisionOutcome>;
}

/**
 * An authority that never advertises.
 *
 * The honest default for a deployment with no advertising system attached, and
 * the one used by every test that is not about advertising. Silence is a
 * correct answer; a placeholder advert would not be.
 */
export const NO_ADVERTISING: AdvertisingAuthority = {
  async decide() {
    return { decided: false, reason: 'no advertising authority is configured' };
  },
};

/**
 * Place a decided advert on the timeline.
 *
 * The ONLY way an advert enters a broadcast. Returning the written event means
 * a caller can see where it actually landed rather than assuming, and the
 * buffer then carries it to every viewer in the same place.
 *
 * The event carries ids and a duration. Deliberately no campaign economics:
 * this record travels to listener clients, and a viewer with developer tools
 * is not an authorised reader of what a break is worth.
 */
export function placeAdvertisement(
  timeline: ProgrammeTimeline,
  decision: AdDecision,
): ProgrammeTimelineEvent {
  return timeline.append({
    programmeTimeMs: decision.programmeTimeMs,
    kind: 'advertisement',
    reference: decision.decisionId,
    durationMs: decision.durationMs,
    attributes: {
      campaignId: decision.campaignId,
      creativeId: decision.creativeId,
      origin: decision.origin,
      policyVersion: decision.policyVersion,
    },
  });
}

/**
 * The operator says a break would be safe here; C7 decides whether to take it.
 *
 * The whole shape of the split, in one function: what comes in is an opening,
 * what goes out is C7's decision, and nothing in between lets the caller
 * influence which advert runs.
 */
export async function offerBreakOpportunity(
  authority: AdvertisingAuthority,
  timeline: ProgrammeTimeline,
  opportunity: BreakOpportunity,
): Promise<AdDecisionOutcome> {
  const outcome = await authority.decide({
    runId: opportunity.runId,
    programmeTimeMs: opportunity.programmeTimeMs,
    availableMs: opportunity.availableMs,
    origin: 'opportunity',
  });
  if (!outcome.decided) return outcome;
  /*
   * A decision longer than the opening is refused rather than trimmed.
   *
   * Trimming would cut an advertiser's creative mid-sentence and still bill
   * for it, and stretching the break would do the thing the operator asked us
   * not to do. Neither is ours to choose.
   */
  if (outcome.decision.durationMs > opportunity.availableMs) {
    return { decided: false, reason: 'the decided advert is longer than the opening offered' };
  }
  placeAdvertisement(timeline, outcome.decision);
  return outcome;
}

/**
 * What an operator may see about advertising: state, never commerce.
 *
 * No campaign name, no advertiser, no rate. An operator needs to know a break
 * is coming so they do not talk over it, and needs nothing else.
 */
export interface OperatorAdvertisingView {
  readonly configured: boolean;
  readonly breaksPlaced: number;
  readonly nextBreakAtProgrammeTimeMs: number | null;
  readonly nextBreakDurationMs: number | null;
}

export function operatorAdvertisingView(
  timeline: ProgrammeTimeline,
  publicOutputTimeMs: number,
  configured: boolean,
): OperatorAdvertisingView {
  const adverts = timeline.all().filter((event) => event.kind === 'advertisement');
  const upcoming = adverts
    .filter((event) => event.programmeTimeMs > publicOutputTimeMs)
    .sort((a, b) => a.programmeTimeMs - b.programmeTimeMs)[0];
  return {
    configured,
    breaksPlaced: adverts.length,
    nextBreakAtProgrammeTimeMs: upcoming?.programmeTimeMs ?? null,
    nextBreakDurationMs: upcoming?.durationMs ?? null,
  };
}
