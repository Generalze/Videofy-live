/** @author masterzee001 */
/**
 * The durable sponsored creative, with Page 05's revision doctrine.
 *
 * SAME RULES, DELIBERATELY. A revision that advances once per SEMANTIC change,
 * an optimistic gate that refuses a stale write rather than picking a winner,
 * and mutations that serialize on the programme's own row. Two operators
 * editing one programme's advert is exactly as plausible as two editing its
 * vocabulary, and the failure is worse here because the loser's copy is what
 * every viewer would have seen.
 *
 * ONE ROW IS THE WHOLE STATE, so a plain single-row SELECT is already a
 * coherent read -- there is no revision-here-and-rows-there to fall out of step,
 * which is the race that had to be closed for vocabulary. Mutations still take
 * `FOR UPDATE` on the row, because two writers reading revision 3 and both
 * writing 4 would otherwise lose one edit silently.
 *
 * NO-OPS DO NOT ADVANCE THE REVISION. Saving the same creative twice leaves it
 * at 3. Advancing would tell an operator their unchanged form was a change, and
 * would invalidate somebody else's open page for nothing.
 */

import type { Pool, PoolClient } from 'pg';
import type { ProgrammeSponsoredCreative } from '@videofy-live/shared-types';

/**
 * What a save returns.
 *
 * A conflict is not a fault; it is the software noticing two people edited the
 * same thing and declining to choose between them.
 */
export type CreativeSaveOutcome =
  | { ok: true; revision: number; creative: ProgrammeSponsoredCreative }
  | {
      ok: false;
      conflict: 'revision-conflict';
      expectedRevision: number;
      currentRevision: number;
    };

export interface StoredCreative {
  /** 0 when nothing has ever been saved for this programme. */
  readonly revision: number;
  /** Null when nothing has ever been saved. Never a blank placeholder. */
  readonly creative: ProgrammeSponsoredCreative | null;
}

export interface DurableSponsoredCreativePort {
  read(programmeId: string): Promise<StoredCreative>;
  save(
    programmeId: string,
    creative: ProgrammeSponsoredCreative,
    expectedRevision: number,
  ): Promise<CreativeSaveOutcome>;
}

interface Row {
  revision: string | number;
  headline: string;
  body: string;
  cta: string;
  href: string | null;
  enabled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
}

/** Postgres returns bigint as text to avoid silent precision loss. */
function toRevision(raw: string | number): number {
  return typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
}

function toCreative(row: Row): ProgrammeSponsoredCreative {
  return {
    headline: row.headline,
    body: row.body,
    cta: row.cta,
    href: row.href,
    enabled: row.enabled,
    // Back to the canonical ISO string the contract stores, so what comes out
    // is byte-identical to what validation produced going in.
    startsAt: row.starts_at === null ? null : row.starts_at.toISOString(),
    endsAt: row.ends_at === null ? null : row.ends_at.toISOString(),
  };
}

export function createPostgresSponsoredCreative(pool: Pool): DurableSponsoredCreativePort {
  return {
    async read(programmeId) {
      if (programmeId.trim() === '') {
        throw new Error('read requires a programmeId');
      }
      const result = await pool.query(
        `SELECT revision, headline, body, cta, href, enabled, starts_at, ends_at
           FROM programme_sponsored_creative
          WHERE programme_id = $1`,
        [programmeId],
      );
      const row = result.rows[0] as Row | undefined;
      // NEVER a blank placeholder. "No creative" is null, and the caller falls
      // back to the house creative rather than rendering empty strings.
      if (row === undefined) return { revision: 0, creative: null };
      return { revision: toRevision(row.revision), creative: toCreative(row) };
    },

    async save(programmeId, creative, expectedRevision) {
      if (programmeId.trim() === '') {
        throw new Error('save requires a programmeId');
      }
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');

        /*
         * FOR UPDATE on this programme's row. The second writer waits here
         * rather than reading the same revision as the first and writing the
         * same next one. Keyed by programme, so A never blocks B.
         */
        const current = await client.query(
          `SELECT revision, headline, body, cta, href, enabled, starts_at, ends_at
             FROM programme_sponsored_creative
            WHERE programme_id = $1
              FOR UPDATE`,
          [programmeId],
        );
        const existing = current.rows[0] as Row | undefined;
        const currentRevision = existing === undefined ? 0 : toRevision(existing.revision);

        if (currentRevision !== expectedRevision) {
          // No merge, no "last write wins". The operator is told, and reloads.
          await client.query('ROLLBACK');
          return {
            ok: false,
            conflict: 'revision-conflict',
            expectedRevision,
            currentRevision,
          };
        }

        if (existing === undefined) {
          const inserted = await client.query(
            `INSERT INTO programme_sponsored_creative
               (programme_id, revision, headline, body, cta, href, enabled, starts_at, ends_at, updated_at)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, now())
             RETURNING revision, headline, body, cta, href, enabled, starts_at, ends_at`,
            [
              programmeId, creative.headline, creative.body, creative.cta,
              creative.href, creative.enabled, creative.startsAt, creative.endsAt,
            ],
          );
          await client.query('COMMIT');
          const row = inserted.rows[0] as Row;
          return { ok: true, revision: toRevision(row.revision), creative: toCreative(row) };
        }

        /*
         * `IS DISTINCT FROM` across every semantic column, so a save that
         * changes nothing advances nothing. Null-safe, which matters here:
         * `href = NULL` is never true, and a plain `<>` would treat clearing a
         * link as no change at all.
         */
        const updated = await client.query(
          `UPDATE programme_sponsored_creative
              SET headline = $2, body = $3, cta = $4, href = $5,
                  enabled = $6, starts_at = $7, ends_at = $8,
                  revision = revision + 1, updated_at = now()
            WHERE programme_id = $1
              AND (headline, body, cta, href, enabled, starts_at, ends_at)
                  IS DISTINCT FROM
                  ($2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
          RETURNING revision, headline, body, cta, href, enabled, starts_at, ends_at`,
          [
            programmeId, creative.headline, creative.body, creative.cta,
            creative.href, creative.enabled, creative.startsAt, creative.endsAt,
          ],
        );

        await client.query('COMMIT');

        if (updated.rows.length === 0) {
          // A genuine no-op. Reported as success at the UNCHANGED revision.
          return { ok: true, revision: currentRevision, creative: toCreative(existing) };
        }
        const row = updated.rows[0] as Row;
        return { ok: true, revision: toRevision(row.revision), creative: toCreative(row) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
