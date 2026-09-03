/** @author masterzee001 */
/**
 * C7's campaigns, as this service reads them, and the impressions it writes back.
 *
 * The decision engine is synchronous by design -- given the same campaigns,
 * context and history it must always choose the same advert, and an engine
 * that awaited a database mid-decision could not promise that. So campaigns
 * are held here, refreshed on a cadence, and handed over as a plain list.
 *
 * A STALE LIST IS BETTER THAN NO LIST, AND WORSE THAN A CURRENT ONE. A break
 * arrives at a moment nobody chose, and blocking it on an account service
 * round trip would put a database's latency inside a live broadcast. The cache
 * is therefore refreshed in the background and read instantly; the cost is
 * that a campaign paused seconds ago may still be chosen once, which is a
 * commercial rounding error next to a break that missed its opening.
 *
 * AN EMPTY LIST IS AN ANSWER, NOT A FAILURE. It means nothing is sold for this
 * moment, and the correct behaviour is silence. What must never happen is a
 * placeholder advert standing in for a real one.
 *
 * IMPRESSIONS ARE WRITTEN AFTER THE DECISION, NOT BEFORE. A decision that was
 * made and then failed to reach the timeline must not be billed, and the
 * account service treats a replay as the same impression, so a retry costs an
 * advertiser nothing.
 */

import type { Campaign } from '@videofy-live/programme-timeline';
import { logger } from './logger.js';

export interface C7AdvertisingClientOptions {
  readonly accountServiceUrl: string;
  /** Presented as X-Videofy-Internal-Token. Never logged, here or anywhere. */
  readonly internalToken: string;
  readonly refreshMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface ImpressionRecord {
  readonly decisionId: string;
  readonly runId: string;
  readonly campaignId: string;
  readonly creativeId: string;
  readonly programmeTimeMs: number;
  readonly durationMs: number;
  readonly policyVersion: string;
  readonly origin: string;
  readonly decidedAtMs: number;
}

export interface C7AdvertisingClient {
  /** What is currently held. Instant, and never blocks a break. */
  campaigns(): readonly Campaign[];
  /** Bring the list up to date. Failure leaves the previous list standing. */
  refresh(): Promise<boolean>;
  /** What a broadcast has already carried, so caps survive a restart. */
  impressionsForRun(runId: string): Promise<ReadonlyMap<string, readonly number[]>>;
  /** Record what ran. False means it had already been recorded. */
  record(impression: ImpressionRecord): Promise<boolean>;
  /** Whether a real campaign source is attached at all. */
  readonly configured: boolean;
}

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;

interface CampaignRow {
  readonly campaignId: string;
  readonly priority: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly programmeIds: readonly string[];
  readonly languages: readonly string[];
  readonly regions: readonly string[];
  readonly maxPerRun: number;
  readonly minSpacingMs: number;
  readonly creativeIds: readonly string[];
  readonly durationMs: number;
}

/**
 * The client for a deployment with no account service.
 *
 * Never advertises, and says why rather than looking like a deployment where
 * nothing happens to be sold.
 */
export const NO_CAMPAIGN_SOURCE: C7AdvertisingClient = {
  campaigns: () => [],
  refresh: async () => false,
  impressionsForRun: async () => new Map(),
  record: async () => false,
  configured: false,
};

export function createC7AdvertisingClient(
  options: C7AdvertisingClientOptions,
): C7AdvertisingClient {
  const base = options.accountServiceUrl.replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let held: readonly Campaign[] = [];

  async function ask<T>(path: string, init?: RequestInit): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          'X-Videofy-Internal-Token': options.internalToken,
          ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured: true,
    campaigns: () => held,

    async refresh(): Promise<boolean> {
      const body = await ask<{ campaigns?: readonly CampaignRow[] }>(
        '/internal/advertising/campaigns',
      );
      if (body?.campaigns === undefined) {
        /*
         * The previous list stands. Emptying it on a failed read would take a
         * deployment's whole advertising offline because one request timed
         * out, which is a worse answer than a slightly stale one.
         */
        logger.warn('C7 campaigns could not be refreshed; the previous list stands', {
          held: held.length,
        });
        return false;
      }
      held = body.campaigns.map((row) => ({
        campaignId: row.campaignId,
        creativeIds: row.creativeIds,
        durationMs: row.durationMs,
        priority: row.priority,
        startsAtMs: row.startsAtMs,
        endsAtMs: row.endsAtMs,
        programmeIds: row.programmeIds,
        languages: row.languages,
        regions: row.regions,
        maxPerRun: row.maxPerRun,
        minSpacingMs: row.minSpacingMs,
      }));
      return true;
    },

    async impressionsForRun(runId: string): Promise<ReadonlyMap<string, readonly number[]>> {
      const body = await ask<{
        impressions?: readonly { campaignId: string; programmeTimeMs: number }[];
      }>(`/internal/advertising/runs/${encodeURIComponent(runId)}/impressions`);
      const placed = new Map<string, number[]>();
      for (const impression of body?.impressions ?? []) {
        const at = placed.get(impression.campaignId) ?? [];
        at.push(impression.programmeTimeMs);
        placed.set(impression.campaignId, at);
      }
      return placed;
    },

    async record(impression: ImpressionRecord): Promise<boolean> {
      const body = await ask<{ recorded?: boolean }>('/internal/advertising/impressions', {
        method: 'POST',
        body: JSON.stringify(impression),
      });
      if (body === null) {
        /*
         * LOUD, because this is revenue. The advert ran; the record of it did
         * not land. The account service treats a replay as the same
         * impression, so the honest recovery is a retry rather than a second
         * decision -- and an operator needs to know a reconciliation is owed.
         */
        logger.error('An advert ran and its impression could not be recorded', {
          runId: impression.runId,
          decisionId: impression.decisionId,
        });
        return false;
      }
      return body.recorded === true;
    },
  };
}

/** How often the campaign list is brought up to date. */
export const CAMPAIGN_REFRESH_MS = DEFAULT_REFRESH_MS;
