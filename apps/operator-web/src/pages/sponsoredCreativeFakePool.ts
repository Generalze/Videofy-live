/** @author masterzee001 */
/**
 * A Postgres-shaped fake for the sponsored creative table.
 *
 * SEPARATE FROM THE VOCABULARY FAKE because it is a different schema, not a
 * different opinion: one row per programme rather than a state row plus
 * entries. Sharing one fake across both would mean a model that is wrong for
 * each in a different way.
 *
 * IT HONOURS THE STATEMENT. The vocabulary fake once incremented on every
 * UPDATE regardless of what the SQL said, which made three concurrency tests
 * pass while proving nothing. So this one actually implements the two clauses
 * the store depends on: `FOR UPDATE` serialises writers on a programme, and
 * `IS DISTINCT FROM` returns zero rows when nothing semantic changed -- which
 * is what makes a no-op leave the revision alone.
 */

interface CreativeRow {
  programme_id: string;
  revision: number;
  headline: string;
  body: string;
  cta: string;
  href: string | null;
  enabled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
}

export function makeCreativeFakePool(options: { serialize?: boolean } = {}) {
  const serialize = options.serialize !== false;
  const rows = new Map<string, CreativeRow>();
  const locks = new Map<string, Promise<void>>();

  function toDate(value: unknown): Date | null {
    if (value === null || value === undefined || value === '') return null;
    return value instanceof Date ? value : new Date(String(value));
  }

  /** Null-safe comparison, which is the whole point of IS DISTINCT FROM. */
  function sameAs(row: CreativeRow, p: readonly unknown[]): boolean {
    const startsAt = toDate(p[6]);
    const endsAt = toDate(p[7]);
    return (
      row.headline === p[1] &&
      row.body === p[2] &&
      row.cta === p[3] &&
      row.href === (p[4] ?? null) &&
      row.enabled === p[5] &&
      (row.starts_at?.getTime() ?? null) === (startsAt?.getTime() ?? null) &&
      (row.ends_at?.getTime() ?? null) === (endsAt?.getTime() ?? null)
    );
  }

  function project(row: CreativeRow) {
    return {
      // Postgres hands bigint back as text; the store parses it, so the fake
      // must hand back text too or it would never exercise that path.
      revision: String(row.revision),
      headline: row.headline,
      body: row.body,
      cta: row.cta,
      href: row.href,
      enabled: row.enabled,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
    };
  }

  async function run(sql: string, params: readonly unknown[] = []) {
    const text = sql.trim();

    if (/^BEGIN|^COMMIT|^ROLLBACK/u.test(text)) return { rows: [] };

    if (/^SELECT/iu.test(text)) {
      const programmeId = String(params[0]);
      if (/FOR UPDATE/iu.test(text) && serialize) {
        // Queue behind any writer already holding this programme.
        const held = locks.get(programmeId);
        if (held) await held;
        let release = (): void => {};
        const gate = new Promise<void>((r) => { release = r; });
        locks.set(programmeId, gate);
        // Released when the transaction ends; modelled by clearing on the next
        // COMMIT/ROLLBACK through releaseAll below.
        pending.push(() => { locks.delete(programmeId); release(); });
      }
      const row = rows.get(programmeId);
      return { rows: row === undefined ? [] : [project(row)] };
    }

    if (/^INSERT/iu.test(text)) {
      const programmeId = String(params[0]);
      const row: CreativeRow = {
        programme_id: programmeId,
        revision: 1,
        headline: String(params[1]),
        body: String(params[2]),
        cta: String(params[3]),
        href: (params[4] ?? null) as string | null,
        enabled: params[5] === true,
        starts_at: toDate(params[6]),
        ends_at: toDate(params[7]),
      };
      rows.set(programmeId, row);
      return { rows: [project(row)] };
    }

    if (/^UPDATE/iu.test(text)) {
      const programmeId = String(params[0]);
      const row = rows.get(programmeId);
      if (row === undefined) return { rows: [] };
      /*
       * THE NO-OP CLAUSE, APPLIED ONLY WHEN THE STATEMENT ASKS FOR IT.
       *
       * Reading the SQL rather than always behaving well is the whole point. An
       * earlier version of this fake skipped the update whenever the values
       * matched, regardless of what the query said -- so deleting
       * `IS DISTINCT FROM` from the store changed nothing here and the tests
       * stayed green while the real database would have advanced the revision
       * on every save. The vocabulary fake had the same fault in the opposite
       * direction. A fake that is kinder than the statement proves nothing.
       */
      if (/IS DISTINCT FROM/iu.test(text) && sameAs(row, params)) return { rows: [] };
      row.headline = String(params[1]);
      row.body = String(params[2]);
      row.cta = String(params[3]);
      row.href = (params[4] ?? null) as string | null;
      row.enabled = params[5] === true;
      row.starts_at = toDate(params[6]);
      row.ends_at = toDate(params[7]);
      row.revision += 1;
      return { rows: [project(row)] };
    }

    return { rows: [] };
  }

  let pending: (() => void)[] = [];
  function releaseAll(): void {
    const held = pending;
    pending = [];
    for (const release of held) release();
  }

  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      const result = await run(sql, params);
      if (/^COMMIT|^ROLLBACK/u.test(sql.trim())) releaseAll();
      return result;
    },
    release(): void {
      // A transaction that ended without COMMIT must not hold a lock forever.
      releaseAll();
    },
  };

  const pool = {
    async query(sql: string, params?: readonly unknown[]) {
      return run(sql, params);
    },
    async connect() {
      return client;
    },
  };

  return {
    pool: pool as never,
    /** For assertions that want to look straight at storage. */
    peek(programmeId: string): CreativeRow | undefined {
      return rows.get(programmeId);
    },
  };
}
