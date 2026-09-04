#!/usr/bin/env node
/** @author masterzee001 */
/**
 * PROVE THE MIGRATIONS AGAINST A REAL POSTGRES, on both paths that matter.
 *
 * A unit test with a fake pool can prove ORDER and BOOKKEEPING, and nothing
 * about whether the SQL is valid: a typo in a CHECK constraint, a column type
 * Postgres will not accept, an index on a column that does not exist. Those
 * only appear when a real server parses them, and the first place that happens
 * must not be a deployment.
 *
 * TWO PATHS:
 *
 *   FRESH     an empty database takes every migration, in order, once.
 *   UPGRADE   a database already carrying the predecessor's migrations takes
 *             ONLY the outstanding ones, and reaches the identical schema.
 *
 * The upgrade path is the one that matters for a deployment that already
 * exists, and PARITY between the two is what proves an upgraded database is
 * not subtly different from a rebuilt one -- the difference that produces a
 * bug reproducible only in staging.
 *
 * Reads DATABASE_URL. Refuses to run against anything that is not obviously
 * disposable, because the whole point is that it drops and recreates schemas.
 */
import pg from 'pg';
import { MIGRATIONS } from '../services/account/dist/db/migrations.js';
import { migrate } from '../services/account/dist/db/migrate.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error(
    'migration proof: DATABASE_URL is not set.\n' +
      'This needs a REAL, DISPOSABLE Postgres; it drops and recreates schemas.\n' +
      'CI provides one as a service container.',
  );
  process.exit(2);
}

/*
 * A CRUDE GUARD, AND A DELIBERATE ONE. This script drops schemas. Anything
 * that looks like a real deployment is refused outright rather than trusted to
 * whoever set the variable.
 */
for (const forbidden of ['prod', 'production', 'staging', 'live']) {
  if (url.toLowerCase().includes(forbidden)) {
    console.error(`migration proof: refusing to run against a URL containing "${forbidden}".`);
    process.exit(2);
  }
}

/** The predecessor a deployed database is assumed to already carry. */
const PREDECESSOR_COUNT = Number(process.env['PREDECESSOR_MIGRATIONS'] ?? '20');

const pool = new pg.Pool({ connectionString: url, max: 4 });

/** Every table and column, as the database itself reports them. */
async function schemaFingerprint(schema) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, column_name`,
    [schema],
  );
  return rows.map(
    (r) =>
      `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default ?? ''}`,
  );
}

async function constraintFingerprint(schema) {
  const { rows } = await pool.query(
    `SELECT tc.table_name, tc.constraint_type, tc.constraint_name
       FROM information_schema.table_constraints tc
      WHERE tc.table_schema = $1 AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE','CHECK')
      ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name`,
    [schema],
  );
  // Names Postgres generates for unnamed constraints are stable per shape but
  // not worth comparing; the table and type are what matter.
  return rows.map((r) => `${r.table_name}:${r.constraint_type}`).sort();
}

async function withSchema(name, run) {
  await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await pool.query(`CREATE SCHEMA ${name}`);
  const scoped = new pg.Pool({ connectionString: url, max: 2 });
  scoped.on('connect', (client) => {
    void client.query(`SET search_path TO ${name}`);
  });
  try {
    return await run(scoped);
  } finally {
    await scoped.end();
  }
}

function fail(message) {
  console.error(`migration proof FAILED: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`migration proof: ${MIGRATIONS.length} migrations, against a real Postgres\n`);

  // ---- FRESH ----
  const fresh = await withSchema('proof_fresh', async (scoped) => {
    const outcome = await migrate(scoped);
    return outcome;
  });
  if (fresh.applied.length !== MIGRATIONS.length) {
    fail(
      `fresh: expected all ${MIGRATIONS.length} to apply, got ${fresh.applied.length}`,
    );
  }
  const expectedOrder = MIGRATIONS.map((m) => m.name);
  if (JSON.stringify(fresh.applied) !== JSON.stringify(expectedOrder)) {
    fail('fresh: migrations did not apply in the declared order');
    console.error('  expected:', expectedOrder.join(', '));
    console.error('  actual  :', fresh.applied.join(', '));
  } else {
    console.log(`  FRESH   ok: ${fresh.applied.length} applied, in order`);
  }
  const freshColumns = await schemaFingerprint('proof_fresh');
  const freshConstraints = await constraintFingerprint('proof_fresh');

  // ---- UPGRADE ----
  const predecessor = MIGRATIONS.slice(0, PREDECESSOR_COUNT);
  const outstanding = MIGRATIONS.slice(PREDECESSOR_COUNT);
  const upgrade = await withSchema('proof_upgrade', async (scoped) => {
    // The deployed predecessor.
    const before = await migrate(scoped, predecessor);
    // Then only what is outstanding, exactly as a deploy would.
    const after = await migrate(scoped);
    return { before, after };
  });

  if (upgrade.before.applied.length !== predecessor.length) {
    fail(`upgrade: predecessor did not apply cleanly (${upgrade.before.applied.length})`);
  }
  const expectedOutstanding = outstanding.map((m) => m.name);
  if (JSON.stringify(upgrade.after.applied) !== JSON.stringify(expectedOutstanding)) {
    fail('upgrade: the wrong set of migrations was outstanding');
    console.error('  expected:', expectedOutstanding.join(', '));
    console.error('  actual  :', upgrade.after.applied.join(', '));
  } else {
    console.log(
      `  UPGRADE ok: ${upgrade.before.applied.length} already present, ` +
        `${upgrade.after.applied.length} applied (${expectedOutstanding.join(', ')})`,
    );
  }
  // Nothing already present may be re-run: that is where a destructive
  // surprise would come from.
  if (upgrade.after.alreadyApplied.length !== predecessor.length) {
    fail('upgrade: an already-applied migration was not recognised as such');
  }

  // ---- PARITY ----
  const upgradeColumns = await schemaFingerprint('proof_upgrade');
  const upgradeConstraints = await constraintFingerprint('proof_upgrade');

  const columnDiff = [
    ...freshColumns.filter((c) => !upgradeColumns.includes(c)).map((c) => `fresh only: ${c}`),
    ...upgradeColumns.filter((c) => !freshColumns.includes(c)).map((c) => `upgrade only: ${c}`),
  ];
  if (columnDiff.length > 0) {
    fail('parity: an upgraded database is not identical to a rebuilt one');
    for (const line of columnDiff.slice(0, 20)) console.error(`  ${line}`);
  } else {
    console.log(`  PARITY  ok: ${freshColumns.length} columns identical on both paths`);
  }
  if (JSON.stringify(freshConstraints) !== JSON.stringify(upgradeConstraints)) {
    fail('parity: constraints differ between a fresh and an upgraded database');
  }

  await pool.query('DROP SCHEMA IF EXISTS proof_fresh CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS proof_upgrade CASCADE');
  await pool.end();

  if (process.exitCode === 1) return;
  console.log('\nmigration proof: fresh, upgrade and parity all pass');
}

main().catch((error) => {
  console.error('migration proof: crashed');
  console.error(error);
  process.exit(1);
});
