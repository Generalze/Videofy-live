/** @author masterzee001 */
/**
 * The case that matters is not the process that fails to acquire.
 *
 * It is the one that HAD ownership, stalled long enough to lose it, and woke
 * up holding a valid-looking handle and stale authority. A plain lock does not
 * stop it: it still believes it owns the broadcast. Only a token that has been
 * superseded can, and only if every write checks.
 */
import { describe, expect, it } from 'vitest';
import { FenceGuard, InMemoryRunWriterLease, LEASE_TTL_MS, type LeaseOwner } from './lease.js';

const A: LeaseOwner = { processId: 'pid-1', hostId: 'host-a' };
const B: LeaseOwner = { processId: 'pid-2', hostId: 'host-a' };

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

describe('one writer at a time', () => {
  it('grants a free run', async () => {
    const lease = new InMemoryRunWriterLease();
    const result = await lease.acquire('run_1', A);
    expect(result.granted).toBe(true);
  });

  it('refuses a second claimant while the first is alive', async () => {
    const lease = new InMemoryRunWriterLease();
    await lease.acquire('run_1', A);
    const second = await lease.acquire('run_1', B);

    expect(second.granted).toBe(false);
    if (second.granted) throw new Error('unreachable');
    // Named, so an operator can see which process is holding a broadcast.
    expect(second.heldBy).toEqual(A);
  });

  it('lets different runs be owned by different processes', async () => {
    const lease = new InMemoryRunWriterLease();
    expect((await lease.acquire('run_1', A)).granted).toBe(true);
    expect((await lease.acquire('run_2', B)).granted).toBe(true);
  });
});

describe('a stalled owner does not come back', () => {
  it('lets a successor take over an expired lease', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    await lease.acquire('run_1', A);

    // A hung process, a long garbage collection, a blocked event loop.
    time.advance(LEASE_TTL_MS + 1);
    const second = await lease.acquire('run_1', B);
    expect(second.granted).toBe(true);
  });

  it('gives the successor a HIGHER token than the owner it replaced', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    const first = await lease.acquire('run_1', A);
    time.advance(LEASE_TTL_MS + 1);
    const second = await lease.acquire('run_1', B);

    if (!first.granted || !second.granted) throw new Error('unreachable');
    /*
     * This is what invalidates the previous owner rather than merely
     * replacing it. Without a higher token the old process is
     * indistinguishable from the new one at the point of writing.
     */
    expect(second.grant.fenceToken).toBeGreaterThan(first.grant.fenceToken);
  });

  it('refuses to renew a lease that has been taken away', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');

    time.advance(LEASE_TTL_MS + 1);
    await lease.acquire('run_1', B);

    // The stalled process wakes and tries to carry on.
    expect(await lease.renew('run_1', first.grant)).toBe(false);
  });

  it('keeps a healthy owner alive across renewals', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    const grant = await lease.acquire('run_1', A);
    if (!grant.granted) throw new Error('unreachable');

    for (let i = 0; i < 5; i += 1) {
      time.advance(LEASE_TTL_MS / 2);
      expect(await lease.renew('run_1', grant.grant)).toBe(true);
    }
    // Ordinary pauses must not cost somebody their broadcast.
    expect((await lease.acquire('run_1', B)).granted).toBe(false);
  });

  it('releases immediately, so a successor need not wait out the TTL', async () => {
    const lease = new InMemoryRunWriterLease();
    const grant = await lease.acquire('run_1', A);
    if (!grant.granted) throw new Error('unreachable');

    await lease.release('run_1', grant.grant);
    expect((await lease.acquire('run_1', B)).granted).toBe(true);
  });

  it('ignores a release from somebody who no longer owns it', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    time.advance(LEASE_TTL_MS + 1);
    await lease.acquire('run_1', B);

    // A late release from the old owner must not free the new owner's run.
    await lease.release('run_1', first.grant);
    expect(await lease.holder('run_1')).not.toBeNull();
  });
});

describe('the fence is checked at the write, or it is decorative', () => {
  it('admits writes from the current owner', () => {
    const guard = new FenceGuard();
    expect(guard.admit('run_1', 7)).toBe(true);
    expect(guard.admit('run_1', 7)).toBe(true);
  });

  it('refuses a write carrying a superseded token', () => {
    const guard = new FenceGuard();
    guard.admit('run_1', 8);
    /*
     * The stalled process, awake again, with a handle it still believes in.
     * The store has already served a higher token, so this write is provably
     * from a previous life.
     */
    expect(guard.admit('run_1', 7)).toBe(false);
  });

  it('keeps refusing it, because waiting does not restore authority', () => {
    const guard = new FenceGuard();
    guard.admit('run_1', 8);
    expect(guard.admit('run_1', 7)).toBe(false);
    expect(guard.admit('run_1', 7)).toBe(false);
  });

  it('fences each run separately', () => {
    const guard = new FenceGuard();
    guard.admit('run_1', 9);
    // A high token on one broadcast must not lock another out.
    expect(guard.admit('run_2', 1)).toBe(true);
  });

  it('reports the highest token seen, for an operator looking at a conflict', () => {
    const guard = new FenceGuard();
    guard.admit('run_1', 4);
    guard.admit('run_1', 6);
    expect(guard.highestSeen('run_1')).toBe(6);
    expect(guard.highestSeen('run_absent')).toBeNull();
  });
});

describe('the two together', () => {
  it('fences a former owner the moment its successor writes', async () => {
    const time = clock();
    const lease = new InMemoryRunWriterLease(time.now);
    const guard = new FenceGuard();

    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    expect(guard.admit('run_1', first.grant.fenceToken)).toBe(true);

    time.advance(LEASE_TTL_MS + 1);
    const second = await lease.acquire('run_1', B);
    if (!second.granted) throw new Error('unreachable');
    expect(guard.admit('run_1', second.grant.fenceToken)).toBe(true);

    // The original process wakes up and tries to write its next segment.
    // Split-brain output is prevented here, not detected afterwards.
    expect(guard.admit('run_1', first.grant.fenceToken)).toBe(false);
  });
});
