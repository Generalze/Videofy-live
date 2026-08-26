/** @author masterzee001 */
/**
 * The tariff history, in Postgres.
 *
 * NO ON CONFLICT CLAUSE ANYWHERE, and that is deliberate. Everywhere else in
 * this directory an upsert is the friendly choice; here it would silently
 * overwrite a price that charges have already been raised under. A duplicate
 * version is a bug in the caller -- two operators publishing at once, a retry
 * that should not have retried -- and it is worth an error rather than a quiet
 * rewrite of history. The table also carries a trigger refusing UPDATE and
 * DELETE, so this port could not rewrite a row even if it tried to.
 *
 * COLUMN PARITY IS CHECKED BY A TEST, because it has bitten this codebase
 * before: an account SELECT that had drifted five columns behind its INSERT
 * returned a username of `None` after a restart, and nothing failed until a
 * person noticed. The list below and the list in `append` must agree.
 */
import type { Pool } from 'pg';
import type { Grade, GradeTerms, Tariff } from '@videofy-live/billing-tariff';
import type { TariffRecordPort } from '../tariff-store.js';

interface TariffRow {
  version: number;
  /**
   * bigint, which node-postgres returns as a STRING.
   *
   * Epoch milliseconds sit far inside the range a double holds exactly, so the
   * conversion is safe -- but it has to be done on purpose. Left as a string, a
   * date comparison puts text beside a number and JavaScript coerces it often
   * enough to look correct until the boundary nobody tested.
   */
  effective_from_ms: string;
  currency: string;
  grades: unknown;
  published_by: string;
  published_at_ms: string;
  note: string | null;
}

/** The one list. `append` binds these in this order; the test holds them equal. */
const COLUMNS =
  'version, effective_from_ms, currency, grades, published_by, published_at_ms, note';

function toTariff(row: TariffRow): Tariff {
  const tariff: Tariff = {
    version: row.version,
    effectiveFrom: new Date(Number(row.effective_from_ms)).toISOString(),
    currency: row.currency,
    grades: row.grades as Readonly<Record<Grade, GradeTerms>>,
    publishedBy: row.published_by,
    publishedAt: new Date(Number(row.published_at_ms)).toISOString(),
  };
  /*
   * `exactOptionalPropertyTypes` is on, so an absent note must be an absent
   * PROPERTY rather than a present undefined one.
   */
  return row.note === null ? tariff : { ...tariff, note: row.note };
}

export function createPostgresTariffPort(pool: Pool): TariffRecordPort {
  return {
    async all() {
      const result = await pool.query<TariffRow>(
        `SELECT ${COLUMNS} FROM billing_tariffs ORDER BY version ASC`,
      );
      return result.rows.map(toTariff);
    },

    async append(tariff) {
      await pool.query(
        `INSERT INTO billing_tariffs (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tariff.version,
          Date.parse(tariff.effectiveFrom),
          tariff.currency,
          JSON.stringify(tariff.grades),
          tariff.publishedBy,
          Date.parse(tariff.publishedAt),
          tariff.note ?? null,
        ],
      );
    },
  };
}
