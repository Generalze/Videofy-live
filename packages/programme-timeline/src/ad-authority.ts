/** @author masterzee001 */
/**
 * C7 decides which advertisement runs. Nobody else can.
 *
 * The commercial model depends on it. A broadcaster who could choose their
 * advertiser, skip one they disliked, or read what a campaign pays would make
 * the platform unsellable to advertisers -- and a listener client that picked
 * its own advert would make impressions unauditable. So selection lives here,
 * server-side, and the only thing an operator may contribute is knowledge C7
 * does not have: whether a break would cut somebody off mid-sentence.
 *
 * A DECISION IS IMMUTABLE ONCE MADE. It is bound to a programme run and a
 * programme time before it becomes public, and from then on it is a fact about
 * the broadcast rather than a preference that can be revised. Two viewers on
 * different delays must receive the same advert in the same place, and a
 * decision that could change between them makes that impossible.
 *
 * WHAT DOES NOT LEAVE THIS MODULE: price, priority, targeting rules, campaign
 * performance, or why one campaign beat another. Those are commercial facts.
 * The timeline carries ids and a duration.
 */

import type { AdDecision, AdvertisingAuthority, BreakOrigin } from './advertising.js';

/** A campaign as the decision engine sees it. Never exposed beyond C7. */
export interface Campaign {
  readonly campaignId: string;
  readonly creativeIds: readonly string[];
  readonly durationMs: number;
  /** Higher wins when several are eligible. Commercially sensitive. */
  readonly priority: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  /** Empty means every programme. */
  readonly programmeIds: readonly string[];
  /** Empty means every language. Matched against the programme's source. */
  readonly languages: readonly string[];
  /** Empty means everywhere. Matched against the channel's region. */
  readonly regions: readonly string[];
  /** How many times one broadcast may carry this campaign. */
  readonly maxPerRun: number;
  /** How close together two impressions of it may be. */
  readonly minSpacingMs: number;
}

export interface DecisionContext {
  readonly runId: string;
  readonly programmeId: string;
  readonly programmeTimeMs: number;
  /** How long the break may be. A decision longer than this is not eligible. */
  readonly availableMs: number;
  readonly origin: BreakOrigin;
  readonly sourceLanguage: string;
  readonly region: string;
  readonly nowMs: number;
}

/** What has already run in this broadcast, so caps and spacing can be applied. */
export interface ImpressionHistory {
  /** Programme times at which each campaign has already been placed. */
  readonly placedAtByCampaign: ReadonlyMap<string, readonly number[]>;
}

export const NO_IMPRESSIONS: ImpressionHistory = { placedAtByCampaign: new Map() };

/**
 * Why a campaign was not chosen.
 *
 * Recorded for C7's own audit and never returned to an operator: knowing that
 * a rival's campaign was capped is commercially useful information.
 */
export type IneligibilityReason =
  | 'outside-validity-window'
  | 'not-targeted-at-this-programme'
  | 'not-targeted-at-this-language'
  | 'not-targeted-at-this-region'
  | 'longer-than-the-break'
  | 'frequency-cap-reached'
  | 'too-soon-after-its-last-impression'
  | 'no-creative';

export interface CampaignVerdict {
  readonly campaignId: string;
  readonly eligible: boolean;
  readonly reason: IneligibilityReason | null;
}

/**
 * Is this campaign allowed to run, here, now?
 *
 * Every rule is separate and every refusal is named, because "no eligible
 * campaign" with no reason is the kind of answer that costs a day when
 * revenue is missing and nobody knows why.
 */
export function assessCampaign(
  campaign: Campaign,
  context: DecisionContext,
  history: ImpressionHistory,
): CampaignVerdict {
  const no = (reason: IneligibilityReason): CampaignVerdict => ({
    campaignId: campaign.campaignId,
    eligible: false,
    reason,
  });

  if (campaign.creativeIds.length === 0) return no('no-creative');
  if (context.nowMs < campaign.startsAtMs || context.nowMs >= campaign.endsAtMs) {
    return no('outside-validity-window');
  }
  if (campaign.programmeIds.length > 0 && !campaign.programmeIds.includes(context.programmeId)) {
    return no('not-targeted-at-this-programme');
  }
  if (
    campaign.languages.length > 0 &&
    !campaign.languages.some((language) => language.toLowerCase() === context.sourceLanguage.toLowerCase())
  ) {
    return no('not-targeted-at-this-language');
  }
  if (
    campaign.regions.length > 0 &&
    !campaign.regions.some((region) => region.toLowerCase() === context.region.toLowerCase())
  ) {
    return no('not-targeted-at-this-region');
  }
  /*
   * A campaign longer than the break is REFUSED, never trimmed. Trimming cuts
   * a creative mid-sentence and still bills for it; overrunning does the thing
   * the operator asked us not to do.
   */
  if (campaign.durationMs > context.availableMs) return no('longer-than-the-break');

  const placed = history.placedAtByCampaign.get(campaign.campaignId) ?? [];
  if (placed.length >= campaign.maxPerRun) return no('frequency-cap-reached');
  const mostRecent = placed.length === 0 ? null : Math.max(...placed);
  if (mostRecent !== null && context.programmeTimeMs - mostRecent < campaign.minSpacingMs) {
    return no('too-soon-after-its-last-impression');
  }

  return { campaignId: campaign.campaignId, eligible: true, reason: null };
}

export interface AdSelection {
  readonly decision: AdDecision | null;
  /** Every campaign considered and why. C7's audit trail, not the operator's. */
  readonly verdicts: readonly CampaignVerdict[];
}

/**
 * Choose the advertisement for this break, or decide there is none.
 *
 * Deterministic: given the same campaigns, context and history it always
 * chooses the same one. An auditable commercial system cannot select at
 * random, because "why did that advert run" must have an answer.
 */
export function selectAdvertisement(
  campaigns: readonly Campaign[],
  context: DecisionContext,
  history: ImpressionHistory,
  mintDecisionId: () => string,
  policyVersion: string,
): AdSelection {
  const verdicts = campaigns.map((campaign) => assessCampaign(campaign, context, history));
  const eligible = campaigns.filter(
    (campaign) => verdicts.find((v) => v.campaignId === campaign.campaignId)?.eligible === true,
  );
  if (eligible.length === 0) return { decision: null, verdicts };

  /*
   * Highest priority wins; ties break on campaign id so the outcome is stable
   * rather than dependent on the order a store happened to return rows in.
   */
  const chosen = [...eligible].sort((a, b) =>
    a.priority === b.priority ? a.campaignId.localeCompare(b.campaignId) : b.priority - a.priority,
  )[0];
  if (chosen === undefined) return { decision: null, verdicts };

  return {
    decision: {
      decisionId: mintDecisionId(),
      runId: context.runId,
      campaignId: chosen.campaignId,
      // Stable choice within the campaign, for the same auditability reason.
      creativeId: chosen.creativeIds[0] ?? '',
      programmeTimeMs: context.programmeTimeMs,
      durationMs: chosen.durationMs,
      policyVersion,
      origin: context.origin,
      decidedAtMs: context.nowMs,
    },
    verdicts,
  };
}

/**
 * Record an impression so caps and spacing apply to the next break.
 *
 * Keyed by run: a frequency cap is per broadcast, and two airings of one
 * programme each get their own allowance.
 */
export function withImpression(
  history: ImpressionHistory,
  campaignId: string,
  programmeTimeMs: number,
): ImpressionHistory {
  const placed = new Map(history.placedAtByCampaign);
  placed.set(campaignId, [...(placed.get(campaignId) ?? []), programmeTimeMs]);
  return { placedAtByCampaign: placed };
}

/**
 * The decision engine, wearing the interface the timeline actually calls.
 *
 * Built here rather than left as two halves, because this repository's
 * recurring defect is precisely a rule that is written, tested and never
 * reached. `offerBreakOpportunity` asks an `AdvertisingAuthority`; this is one.
 *
 * It keeps its own impression history per run, so frequency caps and spacing
 * survive across breaks within a broadcast and reset for the next airing.
 */
export function createC7AdvertisingAuthority(options: {
  readonly campaigns: () => readonly Campaign[];
  readonly programmeId: (runId: string) => string;
  readonly sourceLanguage: (runId: string) => string;
  readonly region: (runId: string) => string;
  readonly policyVersion: string;
  readonly mintDecisionId: () => string;
  readonly now?: () => number;
  /** C7's audit: which campaigns lost, and why. Never shown to an operator. */
  readonly onAudit?: (runId: string, verdicts: readonly CampaignVerdict[]) => void;
}): AdvertisingAuthority {
  const histories = new Map<string, ImpressionHistory>();
  const now = options.now ?? ((): number => Date.now());

  return {
    async decide(request) {
      const history = histories.get(request.runId) ?? NO_IMPRESSIONS;
      const selection = selectAdvertisement(
        options.campaigns(),
        {
          runId: request.runId,
          programmeId: options.programmeId(request.runId),
          programmeTimeMs: request.programmeTimeMs,
          availableMs: request.availableMs,
          origin: request.origin,
          sourceLanguage: options.sourceLanguage(request.runId),
          region: options.region(request.runId),
          nowMs: now(),
        },
        history,
        options.mintDecisionId,
        options.policyVersion,
      );

      options.onAudit?.(request.runId, selection.verdicts);
      if (selection.decision === null) {
        /*
         * The reason reaches C7's audit above and not the caller. An operator
         * learning that a rival's campaign is frequency-capped would be
         * learning something commercially useful about somebody else.
         */
        return { decided: false, reason: 'no campaign is eligible for this break' };
      }

      histories.set(
        request.runId,
        withImpression(history, selection.decision.campaignId, request.programmeTimeMs),
      );
      return { decided: true, decision: selection.decision };
    },
  };
}
