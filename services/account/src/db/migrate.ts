/**
 * Schema migrations: forward-only, applied once, in order.
 *
 * NO MIGRATION FRAMEWORK. The whole mechanism is a table of what has been
 * applied and an ordered list of statements, which is about eighty lines and
 * has no opinions about how the rest of the codebase is written. A framework
 * here would bring a schema DSL, a code generator and its own migration state
 * to keep in sync with reality -- all to solve a problem this service does not
 * have. The migrations themselves live in migrations.ts; see the note there on
 * why they are modules rather than .sql files.
 *
 * THREE PROPERTIES CARRY THE WHOLE DESIGN:
 *
 *  1. AN ADVISORY LOCK. Two instances starting at the same moment -- a rolling
 *     deploy, a restart storm, a developer running the service while CI runs
 *     it too -- would otherwise both read "001 is not applied" and both apply
 *     it. Postgres advisory locks are held for the session and released even
 *     if the process dies, which a lock table would not be.
 *
 *  2. EACH MIGRATION IN ITS OWN TRANSACTION, together with the record that it
 *     ran. If the file fails halfway, the schema change and the bookkeeping
 *     roll back together -- so a retry starts from a known state rather than
 *     from a schema nobody can describe. Postgres has transactional DDL, which
 *     is what makes this possible at all; the same design on MySQL would not
 *     work and would need a different approach.
 *
 *  3. FORWARD ONLY. There are no down-migrations. A down-migration is written
 *     when the schema is fresh in mind and run, if ever, during an incident
 *     months later against data it was never tested on -- and the usual way it
 *     "works" is by dropping the column somebody is paging about. Recovery is
 *     restore-from-backup plus a new forward migration, which is slower to say
 *     and far likelier to preserve the data.
 */
import type { Pool, PoolClient } from 'pg';
import { MIGRATIONS, type Migration } from './migrations.js';

/**
 * A fixed, arbitrary key identifying THIS migration runner.
 *
 * Advisory locks share one namespace per database, so the number only has to
 * be one nothing else picks. It is a constant rather than a hash of something
 * so that reading the value in `pg_locks` during an incident leads back here.
 */
const MIGRATION_LOCK_KEY = 8_274_113;

/**
 * Guard against a duplicated migration name.
 *
 * Two entries sharing a name would mean the second is skipped forever: the
 * first records the name, and the runner then treats the second as already
 * applied. The schema would be quietly incomplete and every check would say it
 * was up to date. Cheap to detect, invisible otherwise.
 */
function assertDistinctNames(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) {
      throw new Error(
        `duplicate migration name ${migration.name}: the second would be skipped forever, ` +
          'because the first records the name and the runner then considers both applied',
      );
    }
    seen.add(migration.name);
  }
}

async function ensureBookkeeping(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Apply every migration that has not run yet.
 *
 * Returns what it did rather than logging it, so the caller decides how to
 * report and a test can assert on the outcome instead of scraping output.
 */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationOutcome> {
  assertDistinctNames(migrations);
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    // Blocks rather than failing if another instance holds it: the loser waits
    // and then finds every migration already recorded, which is the correct
    // outcome. Trying and giving up would mean starting against a half-migrated
    // schema.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureBookkeeping(client);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const file of migrations) {
      if (done.has(file.name)) {
        alreadyApplied.push(file.name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        // Recorded inside the SAME transaction as the change it describes, so
        // the schema and the record of it can never disagree.
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        // Named, because "migration failed" without saying which one turns a
        // two-minute fix into an archaeology exercise.
        throw new Error(
          `migration ${file.name} failed and was rolled back: ` +
            `${(error as Error)?.message ?? 'unknown error'}`,
        );
      }
    }
    return { applied, alreadyApplied };
  } finally {
    // Released explicitly rather than left to session end, because this client
    // goes back to the pool and would carry the lock with it.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
