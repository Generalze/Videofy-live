/** @author masterzee001 */
/**
 * THE FIRST SAVE IS ITS OWN RACE.
 *
 * `SELECT ... FOR UPDATE` serialises writers on a row. At revision 0 there is
 * no row, so it locks nothing: two operators setting up a programme's advert at
 * the same moment BOTH see absence and both believe they may insert revision 1.
 * The lock protects every save except the one where two people are most likely
 * to be working at once.
 *
 * What made it a defect rather than a curiosity is the shape of the failure.
 * The primary key stops the second write, so no data is lost -- but the loser
 * received a unique-key violation surfacing as a 500, not the structured
 * `revision-conflict` the whole optimistic contract promises. An operator
 * cannot act on a 500; they can act on "somebody else saved, reload".
 *
 * The interleaving below is CONTROLLED, not timed. A sleep would make this pass
 * or fail by scheduler luck.
 *
 * It lives beside the Postgres-shaped fake rather than in services/account
 * because that package's `rootDir` is its own `src`, so it cannot reach the
 * fake -- and a second fake written to satisfy a path would be a second model
 * of the database, which is exactly what the shared one exists to avoid.
 */
import { describe, expect, it } from 'vitest';
import { createPostgresSponsoredCreative } from '../../../../services/account/src/db/programme-sponsored-creative-postgres';
import { makeCreativeFakePool } from './sponsoredCreativeFakePool';
import type { ProgrammeSponsoredCreative } from '@videofy-live/shared-types';

function creative(headline: string): ProgrammeSponsoredCreative {
  return {
    headline,
    body: 'Speak to your audience in the language they think in.',
    cta: 'Find out how',
    href: 'https://example.com/offer',
    enabled: true,
    startsAt: null,
    endsAt: null,
  };
}

describe('two operators save a programme’s first creative at the same moment', () => {
  it('one succeeds at revision 1, the other gets a conflict, and neither errors', async () => {
    // Park the FIRST insert so the second save is guaranteed to begin while the
    // first is still in flight -- the window the old code could not close.
    const pool = makeCreativeFakePool({ pauseFirst: /^INSERT/iu });
    const store = createPostgresSponsoredCreative(pool.pool);

    const first = store.save('prog_A', creative('First operator'), 0);

    // Let the first reach its parked INSERT before the second starts.
    for (let i = 0; i < 20 && !pool.isPaused(); i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(pool.isPaused()).toBe(true);

    const second = store.save('prog_A', creative('Second operator'), 0);
    // Give the second every chance to read absence and decide it may insert.
    await new Promise((r) => setTimeout(r, 5));

    pool.resume();
    const [a, b] = await Promise.all([first, second]);

    const successes = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok);

    // EXACTLY ONE of each. Never two writes, never an unhandled error.
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const winner = successes[0]!;
    if (!winner.ok) throw new Error('unreachable');
    expect(winner.revision).toBe(1);

    const loser = conflicts[0]!;
    if (loser.ok) throw new Error('unreachable');
    // The structured conflict the contract promises, not a database error.
    expect(loser.conflict).toBe('revision-conflict');
    expect(loser.expectedRevision).toBe(0);
    expect(loser.currentRevision).toBe(1);
  });

  it('the winner’s creative is what is stored, whole; the loser wrote nothing', async () => {
    const pool = makeCreativeFakePool({ pauseFirst: /^INSERT/iu });
    const store = createPostgresSponsoredCreative(pool.pool);

    const first = store.save('prog_A', creative('First operator'), 0);
    for (let i = 0; i < 20 && !pool.isPaused(); i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const second = store.save('prog_A', creative('Second operator'), 0);
    await new Promise((r) => setTimeout(r, 5));
    pool.resume();
    const [a, b] = await Promise.all([first, second]);

    /*
     * WHICH ONE WINS IS NOT THE POINT, and asserting a name here was wrong:
     * the PARKED save is the delayed one, so the other reaches the insert
     * first. What must hold is that the stored creative belongs entirely to
     * whichever save succeeded -- one row, one author, no blend.
     */
    const winner = [a, b].find((r) => r.ok);
    if (winner === undefined || !winner.ok) throw new Error('nobody won');

    const stored = await store.read('prog_A');
    expect(stored.revision).toBe(1);
    expect(stored.creative?.headline).toBe(winner.creative.headline);
    expect(stored.creative).toEqual(winner.creative);
  });

  it('a save throws nothing at all in the losing path', async () => {
    // The old failure mode was an exception escaping as a 500. Asserted
    // explicitly because "returns a conflict" and "does not throw" are
    // different promises and only one of them was broken.
    const pool = makeCreativeFakePool({ pauseFirst: /^INSERT/iu });
    const store = createPostgresSponsoredCreative(pool.pool);

    const first = store.save('prog_A', creative('First'), 0);
    for (let i = 0; i < 20 && !pool.isPaused(); i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const second = store.save('prog_A', creative('Second'), 0);
    await new Promise((r) => setTimeout(r, 5));
    pool.resume();

    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});

describe('the ordinary first save is unaffected', () => {
  it('a single operator still gets revision 1', async () => {
    const pool = makeCreativeFakePool();
    const store = createPostgresSponsoredCreative(pool.pool);
    const outcome = await store.save('prog_A', creative('Only operator'), 0);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.revision).toBe(1);
  });

  it('a second save against a stale revision 0 still conflicts', async () => {
    // No concurrency at all: the row simply exists already. The same answer.
    const pool = makeCreativeFakePool();
    const store = createPostgresSponsoredCreative(pool.pool);
    await store.save('prog_A', creative('First'), 0);
    const late = await store.save('prog_A', creative('Late'), 0);
    expect(late.ok).toBe(false);
    if (late.ok) throw new Error('unreachable');
    expect(late.currentRevision).toBe(1);
  });
});
