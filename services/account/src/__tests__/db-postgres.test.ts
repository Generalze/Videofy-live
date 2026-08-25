/**
 * The PostgreSQL account store.
 *
 * SPLIT IN TWO ON PURPOSE. The configuration and migration-ordering rules are
 * pure and always run. The adapter tests need a real database and are SKIPPED
 * when TEST_DATABASE_URL is unset, so the suite stays green on a machine with
 * no Postgres -- but they are real tests against a real server when it is
 * there, not mocks pretending a driver behaves as somebody remembers.
 *
 * A mocked pg client would have proved nothing here. Every property worth
 * testing in this file -- that a NULL column comes back as an absent key, that
 * ON CONFLICT replaces rather than duplicates, that a failed import leaves an
 * empty table -- is a property of PostgreSQL, not of our code calling it.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireDatabaseUrl } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { MIGRATIONS } from '../db/migrations.js';
import {
  createPostgresAccountRecords,
  importAccountsOnce,
} from '../db/account-records-postgres.js';
import type { AccountRecord } from '../account-store.js';

describe('the connection string', () => {
  it('is required, because there is no in-memory fallback', () => {
    expect(() => requireDatabaseUrl(undefined, 'DATABASE_URL')).toThrow(/must be set/);
    expect(() => requireDatabaseUrl('', 'DATABASE_URL')).toThrow(/must be set/);
    expect(() => requireDatabaseUrl('   ', 'DATABASE_URL')).toThrow(/must be set/);
  });

  /*
   * A service that fell back to memory would look healthy, accept
   * registrations, and lose every one on restart -- the exact failure this
   * migration exists to end.
   */
  it('says why it refuses rather than only that it did', () => {
    expect(() => requireDatabaseUrl(undefined, 'DATABASE_URL')).toThrow(/no in-memory fallback/);
  });

  it('refuses something that is not a postgres URL', () => {
    expect(() => requireDatabaseUrl('/var/lib/postgres', 'DATABASE_URL')).toThrow(/postgres:\/\//);
    expect(() => requireDatabaseUrl('localhost:5432', 'DATABASE_URL')).toThrow(/postgres:\/\//);
  });

  it('accepts both postgres:// and postgresql://', () => {
    expect(requireDatabaseUrl('postgres://u:p@h/db', 'X')).toBe('postgres://u:p@h/db');
    expect(requireDatabaseUrl('postgresql://u:p@h/db', 'X')).toBe('postgresql://u:p@h/db');
  });
});

describe('migration ordering', () => {
  it('has no duplicate names in the real list', () => {
    const names = MIGRATIONS.map((migration) => migration.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/*
 * Everything below needs a server. `docker run -d -p 15433:5432 \
 *   -e POSTGRES_PASSWORD=... -e POSTGRES_DB=c7test postgres:16-alpine`
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const withDatabase = DATABASE_URL ? describe : describe.skip;

withDatabase('against a real database', () => {
  let pool: Pool;

  const base: AccountRecord = {
    accountId: 'acc_1',
    email: 'zoe@example.com',
    passwordHash: 'scrypt$1$2$3$c2FsdA==$aGFzaA==',
    tokenVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    seenCallbackEvents: [],
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE accounts');
  });

  describe('migrations', () => {
    it('are idempotent: running again applies nothing', async () => {
      const second = await migrate(pool);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toContain('001_accounts');
    });

    it('refuses a duplicate migration name rather than silently skipping one', async () => {
      await expect(
        migrate(pool, [
          { name: 'dup', sql: 'SELECT 1' },
          { name: 'dup', sql: 'SELECT 1' },
        ]),
      ).rejects.toThrow(/duplicate migration name/);
    });

    /*
     * Transactional DDL is the property that makes a half-applied schema
     * impossible. Without it a failed migration leaves the database in a state
     * nobody can describe.
     */
    it('rolls a failing migration back and records nothing', async () => {
      await expect(
        migrate(pool, [
          {
            name: '999_broken',
            sql: 'CREATE TABLE will_not_survive (id int); SELECT * FROM no_such_table;',
          },
        ]),
      ).rejects.toThrow(/999_broken/);

      const { rows } = await pool.query(
        `SELECT to_regclass('will_not_survive') AS present`,
      );
      expect(rows[0]?.present).toBeNull();
      const recorded = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [
        '999_broken',
      ]);
      expect(recorded.rowCount).toBe(0);
    });
  });

  describe('the account adapter', () => {
    it('round-trips a minimal record', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert(base);
      const loaded = await port.load();

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.accountId).toBe('acc_1');
      expect(loaded[0]?.email).toBe('zoe@example.com');
      expect(loaded[0]?.passwordHash).toBe(base.passwordHash);
      expect(loaded[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    /*
     * The distinction the `optional` helper exists for. A NULL column must come
     * back as an ABSENT key, not a key holding null, or every record that went
     * through the database has a subtly different shape from one that did not.
     */
    it('brings a NULL column back as an absent key, not null', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert(base);
      const [loaded] = await port.load();

      expect('trust' in (loaded as object)).toBe(false);
      expect('phoneNumber' in (loaded as object)).toBe(false);
      expect('emailChallenge' in (loaded as object)).toBe(false);
    });

    it('round-trips the nested structures it does have', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert({
        ...base,
        voiceGender: 'female',
        phoneNumber: '+2348000000000',
        trust: {
          email: 'verified',
          phone: 'unverified',
          identity: 'unverified',
          risk: 'normal',
          restriction: 'none',
        },
        seenCallbackEvents: ['evt_1', 'evt_2'],
      });
      const [loaded] = await port.load();

      expect(loaded?.voiceGender).toBe('female');
      expect(loaded?.phoneNumber).toBe('+2348000000000');
      expect(loaded?.trust?.email).toBe('verified');
      expect(loaded?.seenCallbackEvents).toEqual(['evt_1', 'evt_2']);
    });

    it('replaces rather than duplicating on a second upsert', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert(base);
      await port.upsert({ ...base, tokenVersion: 9, updatedAt: '2026-02-02T00:00:00.000Z' });
      const loaded = await port.load();

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.tokenVersion).toBe(9);
    });

    /*
     * Clearing a field must actually clear it. Listing every column on the
     * UPDATE is what makes this true; omitting one leaves a stale value behind
     * on a record the caller believed it had replaced whole.
     */
    it('clears a field that was set and is now absent', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert({ ...base, phoneNumber: '+2348000000000' });
      await port.upsert(base);
      const [loaded] = await port.load();

      expect('phoneNumber' in (loaded as object)).toBe(false);
    });

    /*
     * The database enforces one account per address. The application's own
     * check races with itself across processes; a unique index cannot.
     */
    it('refuses two accounts sharing an email', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert(base);
      await expect(port.upsert({ ...base, accountId: 'acc_2' })).rejects.toThrow();
    });

    it('loads in a deterministic order', async () => {
      const port = createPostgresAccountRecords(pool);
      await port.upsert({ ...base, accountId: 'acc_b', email: 'b@example.com' });
      await port.upsert({
        ...base,
        accountId: 'acc_a',
        email: 'a@example.com',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      const loaded = await port.load();
      expect(loaded.map((entry) => entry.accountId)).toEqual(['acc_a', 'acc_b']);
    });
  });

  describe('importing the old file store', () => {
    it('imports into an empty table', async () => {
      const outcome = await importAccountsOnce(pool, [base]);
      expect(outcome).toEqual({ imported: 1 });
    });

    /*
     * A repeated import would resurrect accounts closed since the file was
     * written, or overwrite live records with a stale snapshot. Emptiness is
     * the only state in which importing is unambiguous.
     */
    it('refuses when the table already holds anything', async () => {
      await importAccountsOnce(pool, [base]);
      const second = await importAccountsOnce(pool, [
        { ...base, accountId: 'acc_2', email: 'other@example.com' },
      ]);

      expect(second).toEqual({ refused: 'table-not-empty', existing: 1 });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM accounts');
      expect(rows[0]?.n).toBe(1);
    });

    /*
     * All or nothing. A partial import leaves somebody working out where the
     * file stopped being represented, which is worse than starting again.
     */
    it('imports nothing at all when one record fails', async () => {
      const clash = { ...base, accountId: 'acc_2' }; // same email, violates UNIQUE
      await expect(importAccountsOnce(pool, [base, clash])).rejects.toThrow(/acc_2/);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM accounts');
      expect(rows[0]?.n).toBe(0);
    });
  });
});
