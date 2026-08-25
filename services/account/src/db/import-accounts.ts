/**
 * Move the JSON file store into PostgreSQL, once.
 *
 *   npm run import-accounts --workspace @videofy-live/account -- <path-to-accounts.json>
 *
 * WHY A SEPARATE COMMAND rather than something the service does at boot. An
 * import that runs automatically runs on every deploy, including the one after
 * somebody has been using the database for a week -- and then it is either a
 * no-op nobody verified or a disaster nobody authorised. This is a thing a
 * person does, once, having read what it says.
 *
 * IT REFUSES rather than merging if the table already holds anything. A
 * repeated import would resurrect accounts closed since the file was written,
 * or overwrite live records with a stale snapshot, and neither announces
 * itself. Emptiness is the only state in which importing is unambiguous.
 *
 * The file is READ ONLY. Nothing here deletes or rewrites it, so a failed
 * import leaves the old store exactly as it was and the service can be pointed
 * back at it.
 */
import '@videofy-live/service-env/auto';
import { createFileAccountRecords } from '../account-records.js';
import { assertDatabaseReachable, createDatabasePool, requireDatabaseUrl } from './pool.js';
import { migrate } from './migrate.js';
import { importAccountsOnce } from './account-records-postgres.js';

function report(fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ command: 'import-accounts', ...fields }));
}

async function main(): Promise<number> {
  const source = process.argv[2];
  if (!source) {
    report({
      error: 'no source file given',
      usage: 'import-accounts <path-to-accounts.json>',
    });
    return 2;
  }

  const pool = createDatabasePool({
    connectionString: requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL'),
  });

  try {
    await assertDatabaseReachable(pool);
    // The table has to exist before anything can be counted or written into it,
    // and running the migrations here means the import works against a database
    // the service has never started against.
    await migrate(pool);

    /*
     * Reads through the same adapter the service uses, so a file this refuses
     * to load is a file the service would also have refused. A bespoke reader
     * here could accept something malformed and import a half-understood
     * record, which is the one outcome worse than not importing.
     */
    const records = await createFileAccountRecords(source).load();
    if (records.length === 0) {
      report({ source, read: 0, imported: 0, note: 'nothing to import' });
      return 0;
    }

    const outcome = await importAccountsOnce(pool, records);
    if ('refused' in outcome) {
      report({
        source,
        read: records.length,
        imported: 0,
        refused: outcome.refused,
        existing: outcome.existing,
        note:
          'the accounts table already holds rows. Importing now could resurrect closed ' +
          'accounts or overwrite live ones with a stale snapshot. Empty the table ' +
          'deliberately if this is really what you want.',
      });
      return 1;
    }

    // A count, never an address. A log of who has an account is a record of who
    // uses this product.
    report({ source, read: records.length, imported: outcome.imported });
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    report({ error: (error as Error)?.message ?? 'unknown error', imported: 0 });
    process.exitCode = 1;
  });
