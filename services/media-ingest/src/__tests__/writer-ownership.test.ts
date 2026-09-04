/** @author masterzee001 */
/**
 * One writer per broadcast, and the process that must not come back.
 *
 * The case worth testing is never the process that fails to acquire. It is the
 * one that HAD ownership, stalled long enough to lose it, and woke up holding
 * a handle it still believes in. Its writes look perfectly ordinary. Its own
 * fence has only ever seen its own token and admits it for ever. The only
 * thing that can recognise it is a check against something the SUCCESSOR has
 * written to -- which is why the lease is on the volume and why the store asks
 * the volume rather than itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileRunWriterLease } from '../file-run-writer-lease.js';
import { ProgrammeWriterOwnership } from '../programme-writer-ownership.js';
import { JournalTimelineStore } from '../journal-timeline-store.js';
import { LEASE_TTL_MS, type LeaseOwner } from '@videofy-live/programme-timeline';

const A: LeaseOwner = { processId: 'pid-1', hostId: 'host-a' };
const B: LeaseOwner = { processId: 'pid-2', hostId: 'host-a' };

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'videofy-lease-'));
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('a lease two processes can both see', () => {
  it('grants a free run', async () => {
    const lease = new FileRunWriterLease(directory());
    expect((await lease.acquire('run_1', A)).granted).toBe(true);
  });

  it('refuses a second claimant while the first is alive, and names them', async () => {
    const lease = new FileRunWriterLease(directory());
    await lease.acquire('run_1', A);
    const second = await lease.acquire('run_1', B);
    expect(second.granted).toBe(false);
    if (second.granted) throw new Error('unreachable');
    expect(second.heldBy).toEqual(A);
  });

  it('survives a new instance of the lease object, because it is on the volume', async () => {
    /*
     * The whole point. An in-memory lease cannot see another process, so
     * composing one would have produced a fence that fences nothing.
     */
    const where = directory();
    await new FileRunWriterLease(where).acquire('run_1', A);
    const second = await new FileRunWriterLease(where).acquire('run_1', B);
    expect(second.granted).toBe(false);
  });

  it('lets a successor take over an expired lease with a HIGHER token', async () => {
    const time = clock();
    const where = directory();
    const first = await new FileRunWriterLease(where, time.now).acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');

    time.advance(LEASE_TTL_MS + 1);
    const second = await new FileRunWriterLease(where, time.now).acquire('run_1', B);
    if (!second.granted) throw new Error('unreachable');
    // A higher token is what INVALIDATES the previous owner rather than
    // merely replacing it.
    expect(second.grant.fenceToken).toBeGreaterThan(first.grant.fenceToken);
  });

  it('refuses to renew a lease that has been taken away', async () => {
    const time = clock();
    const where = directory();
    const lease = new FileRunWriterLease(where, time.now);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    time.advance(LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);

    // The stalled process waking up and trying to carry on.
    expect(await lease.renew('run_1', first.grant)).toBe(false);
  });

  it('ignores a release from somebody who no longer owns it', async () => {
    const time = clock();
    const where = directory();
    const lease = new FileRunWriterLease(where, time.now);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    time.advance(LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);

    await lease.release('run_1', first.grant);
    // A late release must not free the new owner's run.
    expect(await lease.holder('run_1')).not.toBeNull();
  });

  it('produces exactly one winner when claimants race', async () => {
    const where = directory();
    const results = await Promise.all([
      new FileRunWriterLease(where).acquire('run_1', A),
      new FileRunWriterLease(where).acquire('run_1', B),
      new FileRunWriterLease(where).acquire('run_1', { processId: 'pid-3', hostId: 'host-a' }),
    ]);
    // Decided by the kernel's exclusive create, not by a read-modify-write
    // that can interleave.
    expect(results.filter((r) => r.granted)).toHaveLength(1);
  });

  it('refuses a run id that is not a run id, rather than building a path from it', async () => {
    const lease = new FileRunWriterLease(directory());
    await expect(lease.acquire('../escape', A)).rejects.toThrow();
  });
});

describe('the write path is where it is enforced', () => {
  it('stops a superseded process writing, though its own fence would admit it', async () => {
    const where = directory();
    const lease = new FileRunWriterLease(where);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');

    const store = new JournalTimelineStore({
      directory: where,
      sharedFence: { highestIssued: (runId) => lease.highestIssued(runId) },
      // Checked on every write here, so the assertion is about the rule and
      // not about how long a test is willing to wait.
      revalidateMs: 0,
    });
    store.writeUnder(first.grant.fenceToken);

    const before = await store.append({
      runId: 'run_1',
      sequence: 1,
      programmeTimeMs: 0,
      kind: 'caption',
      reference: 'c1',
      durationMs: 100,
      attributes: {},
    });
    expect(before).toBe(true);

    // A successor takes over. This process has not noticed and does not need
    // to: its next write is checked against what the successor wrote.
    const time = clock(Date.now() + LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);

    const after = await store.append({
      runId: 'run_1',
      sequence: 2,
      programmeTimeMs: 100,
      kind: 'caption',
      reference: 'c2',
      durationMs: 100,
      attributes: {},
    });
    expect(after).toBe(false);
  });

  it('keeps refusing, because waiting does not restore authority', async () => {
    const where = directory();
    const lease = new FileRunWriterLease(where);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    const store = new JournalTimelineStore({
      directory: where,
      sharedFence: { highestIssued: (runId) => lease.highestIssued(runId) },
      revalidateMs: 0,
    });
    store.writeUnder(first.grant.fenceToken);

    const time = clock(Date.now() + LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const written = await store.append({
        runId: 'run_1',
        sequence: attempt,
        programmeTimeMs: attempt * 100,
        kind: 'caption',
        reference: `c${attempt}`,
        durationMs: 100,
        attributes: {},
      });
      expect(written).toBe(false);
    }
  });

  it('refuses to move the cursor too, not only to append', async () => {
    const where = directory();
    const lease = new FileRunWriterLease(where);
    const first = await lease.acquire('run_1', A);
    if (!first.granted) throw new Error('unreachable');
    const store = new JournalTimelineStore({
      directory: where,
      sharedFence: { highestIssued: (runId) => lease.highestIssued(runId) },
      revalidateMs: 0,
    });
    store.writeUnder(first.grant.fenceToken);

    const time = clock(Date.now() + LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);

    // A fenced process moving the cursor would tell the world an audience had
    // received material it never did.
    expect(await store.saveCursor('run_1', 45_000)).toBe(false);
  });

  it('writes unfenced when no lease is presented, which is honest for one writer', async () => {
    const store = new JournalTimelineStore({ directory: directory() });
    expect(
      await store.append({
        runId: 'run_1',
        sequence: 1,
        programmeTimeMs: 0,
        kind: 'caption',
        reference: 'c1',
        durationMs: 100,
        attributes: {},
      }),
    ).toBe(true);
  });
});

describe('holding it, and losing it', () => {
  function ownershipOver(where: string, owner: LeaseOwner, now?: () => number) {
    const surrendered: { runId: string; reason: string }[] = [];
    const tokens: number[] = [];
    const ownership = new ProgrammeWriterOwnership({
      lease: new FileRunWriterLease(where, now),
      owner,
      writeUnder: (token) => tokens.push(token),
      surrender: (runId, reason) => surrendered.push({ runId, reason }),
    });
    return { ownership, surrendered, tokens };
  }

  it('claims a run and starts writing under its token', async () => {
    const { ownership, tokens } = ownershipOver(directory(), A);
    expect(await ownership.claim('run_1')).toBe(true);
    expect(tokens).toHaveLength(1);
    expect(ownership.owns('run_1')).toBe(true);
  });

  it('refuses a run another writer holds', async () => {
    const where = directory();
    await new FileRunWriterLease(where).acquire('run_1', B);
    const { ownership, tokens } = ownershipOver(where, A);
    expect(await ownership.claim('run_1')).toBe(false);
    // And it does not present a token it does not hold.
    expect(tokens).toEqual([]);
  });

  it('fails the broadcast when the lease is lost, rather than warning', async () => {
    const time = clock();
    const where = directory();
    const { ownership, surrendered } = ownershipOver(where, A, time.now);
    await ownership.claim('run_1');

    time.advance(LEASE_TTL_MS + 1);
    await new FileRunWriterLease(where, time.now).acquire('run_1', B);
    const lost = await ownership.renewAll();

    /*
     * Decisive, not advisory. A superseded process that carried on would be
     * producing a second version of a broadcast somebody else is also
     * producing, and nothing downstream can reconcile two of those.
     */
    expect(lost).toEqual(['run_1']);
    expect(surrendered[0]?.reason).toContain('another process');
    expect(ownership.owns('run_1')).toBe(false);
  });

  it('keeps a healthy owner across renewals', async () => {
    const time = clock();
    const { ownership, surrendered } = ownershipOver(directory(), A, time.now);
    await ownership.claim('run_1');
    for (let i = 0; i < 5; i += 1) {
      time.advance(LEASE_TTL_MS / 2);
      await ownership.renewAll();
    }
    // Ordinary pauses must not cost somebody their broadcast.
    expect(surrendered).toEqual([]);
    expect(ownership.owns('run_1')).toBe(true);
  });

  it('releases deliberately, so a successor need not wait out the TTL', async () => {
    const where = directory();
    const { ownership } = ownershipOver(where, A);
    await ownership.claim('run_1');
    await ownership.surrender('run_1');
    expect((await new FileRunWriterLease(where).acquire('run_1', B)).granted).toBe(true);
  });
});

describe('the composition root claims it', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('builds a lease on the volume, not one in this process', () => {
    expect(source).toContain('new FileRunWriterLease(programmeTimelineDirectory)');
    expect(source).not.toContain('new InMemoryRunWriterLease(');
  });

  it('gives the journal the shared fence to check against', () => {
    expect(source).toContain('sharedFence: { highestIssued: (runId) => programmeWriterLease.highestIssued(runId) }');
  });

  it('claims ownership before a broadcast is written, and fails it if refused', () => {
    expect(source).toContain('programmeTimelines.onRunOpened((runId) => {');
    expect(source).toContain("fail('another process is already writing this broadcast')");
  });
});
