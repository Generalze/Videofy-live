/** @author masterzee001 */
/**
 * The deletion queue's claim protocol, which is the only interesting part.
 *
 * WHY A MODELLED POOL, as everywhere else in this directory: these run in CI
 * without Postgres, and the DDL is proven against a real server by
 * `npm run test:migrations`. What is under test here is the SHAPE of the
 * statements -- because the difference between a safe queue and a broken one is
 * a clause:
 *
 *   `FOR UPDATE SKIP LOCKED`. Two workers polling this table will select the
 *   same rows within microseconds of each other. Without the lock, both delete
 *   the same recording and the loser's report describes a state that was never
 *   true. Without the skip, the second one waits for the first instead of
 *   taking the next row, and two workers do one worker's work twice.
 *
 *   THE LEASE PREDICATE. A row lock lives inside the claiming transaction and
 *   is gone the moment it ends -- correct, and useless when the worker is
 *   killed between claiming and settling. Without `claim_expires_at` in the
 *   claim's WHERE clause, an abandoned claim strands a request for ever.
 *
 *   AND A DEFERRAL IS NOT AN ATTEMPT. A request about a broadcast still on air
 *   was not tried; counting it would eventually make a long programme look like
 *   a failing request.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresReplayDeletionQueue } from './programme-replay-deletions-postgres.js';

const NOW = 1_700_000_000_000;

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

function fakePool(options: { rows?: Record<string, unknown>[]; failOn?: RegExp } = {}): Pool & {
  statements: Statement[];
} {
  const statements: Statement[] = [];

  async function query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    statements.push({ text, values });
    if (options.failOn?.test(text) === true) throw new Error('database is unwell');
    if (/^SELECT[\s\S]*FROM programme_replay_deletions/u.test(text.trim())) {
      return { rows: options.rows ?? [] };
    }
    if (/^INSERT INTO programme_replay_deletions/u.test(text.trim())) {
      return { rows: options.rows ?? [{ request_id: 'req_1' }] };
    }
    return { rows: [] };
  }

  const client = { query, release: () => undefined };
  return {
    statements,
    query,
    connect: async () => client,
  } as unknown as Pool & { statements: Statement[] };
}

function textOf(pool: { statements: Statement[] }, matching: RegExp): string {
  const found = pool.statements.find((statement) => matching.test(statement.text));
  if (found === undefined) throw new Error(`no statement matching ${String(matching)}`);
  return found.text;
}

/**
 * The UPDATE statements, and only those.
 *
 * ANCHORED, AND IT HAS TO BE. The claim's own SELECT ends `FOR UPDATE SKIP
 * LOCKED`, so an unanchored search for "UPDATE" finds the read and every
 * assertion about the lease is then made against the wrong statement -- and
 * passes or fails for reasons that have nothing to do with the code.
 */
function updates(pool: { statements: Statement[] }): readonly Statement[] {
  return pool.statements.filter((statement) => /^UPDATE/u.test(statement.text.trim()));
}

/* =============================================================== the claim */

describe('claiming work', () => {
  it('locks the rows it takes and skips the ones somebody else has', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).claim(5, NOW);
    const select = textOf(pool, /SELECT/u);
    expect(select).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('claims only pending, due, unleased work', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).claim(5, NOW);
    const select = textOf(pool, /SELECT/u);
    expect(select).toContain("state = 'pending'");
    expect(select).toContain('visible_at_ms <= $1');
    // The lease, without which a killed worker strands a request for ever.
    expect(select).toContain('claim_expires_at IS NULL OR claim_expires_at <= $1');
  });

  it('runs inside a transaction, so the lock and the lease commit together', async () => {
    const pool = fakePool({ rows: [{ request_id: 'r1', run_id: 'run_a', requested_at_ms: NOW, attempts: 0 }] });
    await createPostgresReplayDeletionQueue(pool).claim(5, NOW);
    const texts = pool.statements.map((statement) => statement.text.trim());
    expect(texts[0]).toBe('BEGIN');
    expect(texts[texts.length - 1]).toBe('COMMIT');
  });

  it('takes the lease out on exactly what it claimed', async () => {
    const pool = fakePool({
      rows: [
        { request_id: 'r1', run_id: 'run_a', requested_at_ms: NOW, attempts: 0 },
        { request_id: 'r2', run_id: 'run_b', requested_at_ms: NOW, attempts: 2 },
      ],
    });
    const claimed = await createPostgresReplayDeletionQueue(pool).claim(5, NOW);
    expect(claimed.map((request) => request.requestId)).toEqual(['r1', 'r2']);
    const update = updates(pool)[0];
    expect(update?.values[0]).toEqual(['r1', 'r2']);
    expect(Number(update?.values[1])).toBeGreaterThan(NOW);
  });

  it('takes no lease when it claimed nothing', async () => {
    const pool = fakePool({ rows: [] });
    await createPostgresReplayDeletionQueue(pool).claim(5, NOW);
    expect(updates(pool)).toHaveLength(0);
  });

  it('oldest first, and bounded', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).claim(3, NOW);
    const select = textOf(pool, /SELECT/u);
    expect(select).toContain('ORDER BY visible_at_ms');
    expect(select).toContain('LIMIT $2');
    expect(pool.statements.find((s) => /SELECT/u.test(s.text))?.values[1]).toBe(3);
  });

  it('rolls back and refuses rather than reporting an empty batch', async () => {
    /*
     * "There was no work" and "the queue could not be read" are different facts
     * and only one of them is a reason to look at something.
     */
    const pool = fakePool({ failOn: /SELECT/u });
    await expect(createPostgresReplayDeletionQueue(pool).claim(5, NOW)).rejects.toThrow(
      /could not be claimed/u,
    );
    expect(pool.statements.some((statement) => statement.text.trim() === 'ROLLBACK')).toBe(true);
  });

  it('says what failed, and the driver text stays in the thrown error', async () => {
    /*
     * DELIBERATELY NOT SCRUBBED HERE. A claim failure goes to a worker's log,
     * where the database's own words are the most useful thing there is for
     * diagnosing it. What must never carry driver text is the STORED detail --
     * `last_detail` is application wording chosen by the worker, and the tests
     * below show it is only ever that.
     */
    const pool = fakePool({ failOn: /SELECT/u });
    await expect(createPostgresReplayDeletionQueue(pool).claim(5, NOW)).rejects.toThrow(
      /could not be claimed/u,
    );
  });
});

/* ============================================================= the settling */

describe('settling work', () => {
  it('done finishes the request and counts the attempt', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).settle('r1', 'done', 'the recording was removed', NOW);
    const update = textOf(pool, /UPDATE/u);
    expect(update).toContain("state = 'done'");
    expect(update).toContain('claim_expires_at = NULL');
    expect(update).toContain('attempts = attempts + 1');
  });

  it('retry returns it to pending with a back-off, and counts the attempt', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).settle('r1', 'retry', 'the archive refused', NOW);
    const statement = updates(pool)[0];
    expect(statement?.text).toContain("state = 'pending'");
    expect(Number(statement?.values[1])).toBeGreaterThan(NOW);
    expect(statement?.values[2]).toBe(1);
  });

  it('DEFER returns it without counting an attempt', async () => {
    /*
     * The request was not tried: the broadcast was still on air, and a
     * background queue is the last thing that should reach into one. Counting
     * it would eventually make a long-running programme look like a failure.
     */
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).settle('r1', 'defer', 'still recording', NOW);
    const statement = updates(pool)[0];
    expect(statement?.text).toContain("state = 'pending'");
    expect(statement?.values[2]).toBe(0);
  });

  it('a deferral waits longer than nothing and a retry waits too', async () => {
    const pool = fakePool();
    const queue = createPostgresReplayDeletionQueue(pool);
    await queue.settle('r1', 'defer', 'still recording', NOW);
    await queue.settle('r2', 'retry', 'refused', NOW);
    const [deferred, retried] = updates(pool);
    expect(Number(deferred?.values[1])).toBeGreaterThan(NOW);
    expect(Number(retried?.values[1])).toBeGreaterThan(NOW);
  });

  it('bounds how much wording it will store', async () => {
    const pool = fakePool();
    await createPostgresReplayDeletionQueue(pool).settle('r1', 'retry', 'x'.repeat(5_000), NOW);
    const statement = updates(pool)[0];
    expect(String(statement?.values[3]).length).toBe(500);
  });
});

/* ============================================================ the requesting */

describe('asking for a deletion', () => {
  it('is idempotent per run while one is outstanding', async () => {
    const pool = fakePool({ rows: [] });
    const outcome = await createPostgresReplayDeletionQueue(pool).request('run_a', 'req_1', NOW);
    // No row came back, so the partial unique index or the primary key caught
    // it: this run has already been asked about.
    expect(outcome).toBe('already-queued');
    expect(textOf(pool, /INSERT/u)).toContain('ON CONFLICT DO NOTHING');
  });

  it('queues a new request and says so', async () => {
    const pool = fakePool({ rows: [{ request_id: 'req_1' }] });
    expect(await createPostgresReplayDeletionQueue(pool).request('run_a', 'req_1', NOW)).toBe(
      'queued',
    );
  });

  it('makes it visible immediately', async () => {
    const pool = fakePool({ rows: [{ request_id: 'req_1' }] });
    await createPostgresReplayDeletionQueue(pool).request('run_a', 'req_1', NOW);
    const statement = pool.statements.find((s) => /INSERT/u.test(s.text));
    // requested_at_ms and visible_at_ms are the same parameter on purpose.
    expect(statement?.text).toContain('VALUES ($1, $2, $3, \'pending\', $3)');
  });

  it('stores a run id and nothing that could be a path', async () => {
    const pool = fakePool({ rows: [{ request_id: 'req_1' }] });
    await createPostgresReplayDeletionQueue(pool).request('run_a', 'req_1', NOW);
    const statement = pool.statements.find((s) => /INSERT/u.test(s.text));
    expect(statement?.values).toEqual(['req_1', 'run_a', NOW]);
    expect(statement?.text).not.toContain('storage');
    expect(statement?.text).not.toContain('key');
  });
});
