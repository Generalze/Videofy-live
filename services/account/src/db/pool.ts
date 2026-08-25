/**
 * The PostgreSQL connection, and the settings that stop one bad query from
 * taking the service down with it.
 *
 * WHY THIS LIVES IN THE ACCOUNT SERVICE rather than a shared package. Nothing
 * else persists anything yet. When a second service needs a database this moves
 * to a package, and moving it then is cheap; creating a workspace now for one
 * consumer is a workspace whose tests have to be remembered in the root script
 * or they silently never run.
 *
 * WHAT THIS DOES NOT GIVE YOU. Durability, not horizontal scale. AccountStore
 * still keeps an in-memory index as its read authority and writes through to
 * Postgres, so two instances would each hold their own view and diverge. That
 * is acceptable for one instance and must not be mistaken for multi-instance
 * safety just because the word "Postgres" now appears. Making reads go to the
 * database is a separate, larger change.
 */
import { Pool, type PoolConfig } from 'pg';

/**
 * How long any single statement may run before the server cancels it.
 *
 * Without this a query that never finishes holds its connection forever, and
 * enough of them exhaust the pool and take down sign-in for everybody. Ten
 * seconds is far beyond anything this service legitimately does -- these are
 * single-row reads and writes -- so anything reaching it is wrong rather than
 * slow.
 */
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * How long a transaction may sit open doing nothing.
 *
 * A connection left idle inside a transaction holds its locks the entire time.
 * One of those against the seat-reservation rows would block every other member
 * of that organization indefinitely, and the symptom -- everything hanging for
 * one company -- is miserable to trace back to its cause.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * Pool size, deliberately small.
 *
 * This runs beside Postgres on a single modest VPS, where every connection
 * costs a backend process and memory. A large pool does not make a small box
 * faster; it makes it thrash and then run out of connections in a way that
 * looks like the application is broken. Raise it against a measurement, never
 * against a hope.
 */
const MAX_CONNECTIONS = 10;

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly max?: number;
}

/**
 * Read the connection string, or refuse.
 *
 * FAIL CLOSED, exactly as `requireSessionSecret` does for the signing key. A
 * service that started without a database and fell back to memory would look
 * healthy, accept registrations, and lose every one of them on restart -- which
 * is the failure this whole migration exists to end. Refusing at boot is loud
 * and happens before anybody has trusted it with anything.
 */
export function requireDatabaseUrl(value: string | undefined, variableName: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new Error(
      `${variableName} must be set before this service can start. ` +
        'It is the account database; there is no in-memory fallback, because a service ' +
        'that silently forgot every account would look perfectly healthy while doing it.',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    // A path, a bare host, or a copied-in password would all otherwise reach
    // the driver and fail with something far less obvious than this.
    throw new Error(`${variableName} must be a postgres:// connection string.`);
  }
  return trimmed;
}

/**
 * Create the pool.
 *
 * The timeouts are set as connection OPTIONS rather than issued as statements
 * after connecting, so they apply to every connection the pool ever opens --
 * including ones created later to meet demand, which a one-off SET after
 * startup would miss entirely.
 */
export function createDatabasePool(config: DatabaseConfig): Pool {
  const options: PoolConfig = {
    connectionString: config.connectionString,
    max: config.max ?? MAX_CONNECTIONS,
    // A connection that cannot be established should fail the request quickly
    // rather than holding it open while somebody waits at a sign-in form.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options:
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS} ` +
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  };

  const pool = new Pool(options);

  /*
   * An idle client erroring -- the server restarted, the network dropped -- is
   * emitted on the pool. Unhandled, an 'error' event on an EventEmitter is
   * rethrown and takes the process down, so a brief database blip would become
   * a crash. The pool discards the broken client itself; this only stops the
   * default handler from being fatal.
   *
   * Deliberately not logged with the error object: connection errors from pg
   * can carry the connection string, and that carries the password.
   */
  pool.on('error', () => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message: 'idle database client errored; it was discarded and the pool continues',
      }),
    );
  });

  return pool;
}

/**
 * Prove the database is actually reachable, at boot.
 *
 * Creating a pool connects to nothing -- pg is lazy, so a wrong host or a bad
 * password stays invisible until the first real query, which is somebody's
 * sign-in. This turns that into a startup failure instead.
 */
export async function assertDatabaseReachable(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
