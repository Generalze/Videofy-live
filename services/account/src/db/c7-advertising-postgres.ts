/** @author masterzee001 */
/**
 * The campaigns C7 sells, and the impressions that actually ran.
 *
 * READ WIDE, WRITE NARROW. Decisioning needs every campaign that could
 * possibly be eligible right now, because eligibility depends on the
 * programme, the language, the region and what has already run in this
 * broadcast -- none of which a SQL WHERE clause should be deciding, since the
 * rules live in one place and that place is the decision engine. So the read
 * filters on the two things that are unambiguous, status and validity window,
 * and hands the rest over.
 *
 * IMPRESSIONS ARE WRITTEN ONCE PER DECISION. A reconnect gives a broadcast a
 * new transport and the same run, so a decision replayed after a network
 * hiccup must land on the row it already wrote rather than bill an advertiser
 * for an impression they did not buy. The key is what the decision IS -- this
 * run, this campaign, this moment in the programme -- and `ON CONFLICT DO
 * NOTHING` makes the retry a no-op instead of an error somebody has to
 * interpret.
 *
 * COMMERCIAL FACTS STOP HERE. Priority and advertiser are columns this module
 * reads and no route publishes: what leaves C7 is an id and a duration.
 */

import type { Pool } from 'pg';

/** A campaign as the decision engine needs to see it. Never sent to a client. */
export interface StoredCampaign {
  readonly campaignId: string;
  readonly advertiser: string;
  readonly priority: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly programmeIds: readonly string[];
  readonly languages: readonly string[];
  readonly regions: readonly string[];
  readonly maxPerRun: number;
  readonly minSpacingMs: number;
  /** Active creatives only; a withdrawn one is not a thing that may run. */
  readonly creativeIds: readonly string[];
  /** The longest a creative in this campaign runs for. */
  readonly durationMs: number;
}

export interface RecordedImpression {
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

export interface C7AdvertisingStore {
  /** Every campaign that could be eligible now. Filtering beyond this is the engine's. */
  eligibleCampaigns(nowMs: number): Promise<readonly StoredCampaign[]>;
  /** Record what ran. Returns false when this decision was already recorded. */
  recordImpression(impression: RecordedImpression): Promise<boolean>;
  /** What has already run in one broadcast, for caps and spacing across a restart. */
  impressionsForRun(runId: string): Promise<readonly RecordedImpression[]>;
  /** The media a creative points at, for a client that has been told its id. */
  creativeMedia(creativeId: string): Promise<{ readonly mediaUrl: string; readonly durationMs: number } | null>;
}

export function createC7AdvertisingStore(pool: Pool): C7AdvertisingStore {
  return {
    async eligibleCampaigns(nowMs: number): Promise<readonly StoredCampaign[]> {
      const { rows } = await pool.query<{
        campaign_id: string;
        advertiser: string;
        priority: number;
        starts_at: Date;
        ends_at: Date;
        programme_ids: string[];
        languages: string[];
        regions: string[];
        max_per_run: number;
        min_spacing_ms: string;
        creative_ids: string[] | null;
        duration_ms: number | null;
      }>(
        `SELECT c.campaign_id, c.advertiser, c.priority, c.starts_at, c.ends_at,
                c.programme_ids, c.languages, c.regions, c.max_per_run, c.min_spacing_ms,
                array_remove(array_agg(cr.creative_id ORDER BY cr.creative_id), NULL)
                  AS creative_ids,
                max(cr.duration_ms) AS duration_ms
           FROM c7_ad_campaigns c
           LEFT JOIN c7_ad_creatives cr
             ON cr.campaign_id = c.campaign_id AND cr.status = 'active'
          WHERE c.status = 'active'
            AND c.starts_at <= to_timestamp($1 / 1000.0)
            AND c.ends_at   >  to_timestamp($1 / 1000.0)
          GROUP BY c.campaign_id`,
        [nowMs],
      );

      return rows.map((row) => ({
        campaignId: row.campaign_id,
        advertiser: row.advertiser,
        priority: row.priority,
        startsAtMs: row.starts_at.getTime(),
        endsAtMs: row.ends_at.getTime(),
        programmeIds: row.programme_ids,
        languages: row.languages,
        regions: row.regions,
        maxPerRun: row.max_per_run,
        minSpacingMs: Number(row.min_spacing_ms),
        creativeIds: row.creative_ids ?? [],
        /*
         * Zero when a campaign has no active creative. The engine refuses a
         * campaign with nothing to play, so this reaches it as an obviously
         * ineligible duration rather than as a null it has to interpret.
         */
        durationMs: row.duration_ms ?? 0,
      }));
    },

    async recordImpression(impression: RecordedImpression): Promise<boolean> {
      const { rowCount } = await pool.query(
        `INSERT INTO c7_ad_impressions
           (decision_id, run_id, campaign_id, creative_id, programme_time_ms,
            duration_ms, policy_version, origin, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
         ON CONFLICT (run_id, campaign_id, programme_time_ms) DO NOTHING`,
        [
          impression.decisionId,
          impression.runId,
          impression.campaignId,
          impression.creativeId,
          impression.programmeTimeMs,
          impression.durationMs,
          impression.policyVersion,
          impression.origin,
          impression.decidedAtMs,
        ],
      );
      // False means it was already there: a reconnect replayed a decision, and
      // the advertiser is billed once.
      return (rowCount ?? 0) > 0;
    },

    async impressionsForRun(runId: string): Promise<readonly RecordedImpression[]> {
      const { rows } = await pool.query<{
        decision_id: string;
        run_id: string;
        campaign_id: string;
        creative_id: string;
        programme_time_ms: string;
        duration_ms: number;
        policy_version: string;
        origin: string;
        decided_at: Date;
      }>(
        `SELECT decision_id, run_id, campaign_id, creative_id, programme_time_ms,
                duration_ms, policy_version, origin, decided_at
           FROM c7_ad_impressions
          WHERE run_id = $1
          ORDER BY programme_time_ms`,
        [runId],
      );
      return rows.map((row) => ({
        decisionId: row.decision_id,
        runId: row.run_id,
        campaignId: row.campaign_id,
        creativeId: row.creative_id,
        programmeTimeMs: Number(row.programme_time_ms),
        durationMs: row.duration_ms,
        policyVersion: row.policy_version,
        origin: row.origin,
        decidedAtMs: row.decided_at.getTime(),
      }));
    },

    async creativeMedia(creativeId: string) {
      const { rows } = await pool.query<{ media_url: string; duration_ms: number }>(
        `SELECT media_url, duration_ms FROM c7_ad_creatives
          WHERE creative_id = $1 AND status = 'active'`,
        [creativeId],
      );
      const row = rows[0];
      return row === undefined ? null : { mediaUrl: row.media_url, durationMs: row.duration_ms };
    },
  };
}
