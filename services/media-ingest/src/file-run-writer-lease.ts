/** @author masterzee001 */
/**
 * Exactly one writer per broadcast, enforced where the writing happens.
 *
 * `InMemoryRunWriterLease` cannot see another process, so composing it would
 * have produced a fence that fences nothing -- protection in appearance only,
 * which is worse than none. This one lives on the same volume as the journal
 * it protects, which is the only place both writers are guaranteed to look.
 *
 * THE DANGEROUS CASE IS NOT THE PROCESS THAT FAILS TO ACQUIRE. It is the one
 * that HAD the lease, stalled long enough to lose it, and woke up holding a
 * handle it still believes in. It has valid-looking authority and a stale
 * view of the world, and a lock alone does not stop it: it thinks it owns the
 * broadcast. Only a token that has been superseded can, and only if the token
 * is checked where the bytes are written rather than where the lease is held.
 *
 * ATOMICITY COMES FROM THE FILESYSTEM. A lease is claimed by creating a file
 * with `wx` -- exclusive create, which fails if it exists -- so two processes
 * racing produce exactly one winner and one `EEXIST`, decided by the kernel
 * rather than by a read-modify-write that can interleave.
 *
 * WHAT THIS DOES NOT DO: coordinate across hosts. Two machines with separate
 * disks each see their own lease file and both win. That is a real limit, it
 * is why the deployment invariant is enforced separately, and it is stated
 * here rather than discovered when a second host is added.
 */

import { mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LEASE_TTL_MS,
  type LeaseGrant,
  type LeaseOwner,
  type LeaseResult,
  type RunWriterLease,
} from '@videofy-live/programme-timeline';

interface PersistedLease {
  readonly owner: LeaseOwner;
  readonly fenceToken: number;
  readonly expiresAtMs: number;
}

function sameOwner(a: LeaseOwner, b: LeaseOwner): boolean {
  return a.processId === b.processId && a.hostId === b.hostId;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export class FileRunWriterLease implements RunWriterLease {
  constructor(
    /** The directory the journal lives in. The lease belongs beside it. */
    private readonly directory: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private path(runId: string): string {
    /*
     * Shape-checked before it becomes a filename. Every caller today passes a
     * validated id, and "every caller today" is not a property a path
     * construction should rely on.
     */
    if (!RUN_ID.test(runId)) throw new Error('Not a run id.');
    return join(this.directory, `${runId}.lease`);
  }

  private async read(runId: string): Promise<PersistedLease | null> {
    try {
      const raw = await readFile(this.path(runId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedLease>;
      if (
        typeof parsed.fenceToken !== 'number' ||
        typeof parsed.expiresAtMs !== 'number' ||
        typeof parsed.owner?.processId !== 'string' ||
        typeof parsed.owner?.hostId !== 'string'
      ) {
        return null;
      }
      return { owner: parsed.owner, fenceToken: parsed.fenceToken, expiresAtMs: parsed.expiresAtMs };
    } catch {
      // Absent, or unreadable. Both mean nobody demonstrably holds it, and a
      // corrupt lease must not lock a broadcast out for ever.
      return null;
    }
  }

  private async write(runId: string, lease: PersistedLease): Promise<void> {
    await writeFile(this.path(runId), JSON.stringify(lease), 'utf8');
  }

  /**
   * Claim a run, or learn who has it.
   *
   * The token is drawn from a per-run counter that only ever goes up, kept in
   * the lease file itself. A successor's token is strictly higher than the one
   * it replaced, which is what invalidates the previous owner rather than
   * merely replacing it.
   */
  async acquire(runId: string, owner: LeaseOwner): Promise<LeaseResult> {
    await mkdir(this.directory, { recursive: true });
    const at = this.now();
    const held = await this.read(runId);

    if (held !== null && held.expiresAtMs > at && !sameOwner(held.owner, owner)) {
      return { granted: false, heldBy: held.owner, expiresAtMs: held.expiresAtMs };
    }

    /*
     * THE RACE, DECIDED BY THE KERNEL. Two processes that both read an expired
     * lease would both decide to take it. The exclusive-create claim file is
     * the tie-break: one gets it, the other gets EEXIST and backs off, and no
     * interleaving of reads and writes can produce two winners.
     */
    const claimPath = `${this.path(runId)}.claim`;
    let claim: Awaited<ReturnType<typeof open>>;
    try {
      claim = await open(claimPath, 'wx');
    } catch {
      const current = await this.read(runId);
      return current === null
        ? { granted: false, heldBy: owner, expiresAtMs: at }
        : { granted: false, heldBy: current.owner, expiresAtMs: current.expiresAtMs };
    }

    try {
      // Re-read under the claim: the state may have changed while we waited.
      const confirmed = await this.read(runId);
      if (confirmed !== null && confirmed.expiresAtMs > at && !sameOwner(confirmed.owner, owner)) {
        return { granted: false, heldBy: confirmed.owner, expiresAtMs: confirmed.expiresAtMs };
      }
      const grant: LeaseGrant = {
        runId,
        owner,
        // Monotonic per run, and never reused, including for the same owner
        // re-acquiring: the token's only job is to be higher than every token
        // before it.
        fenceToken: (confirmed?.fenceToken ?? 0) + 1,
        expiresAtMs: at + LEASE_TTL_MS,
      };
      await this.write(runId, {
        owner,
        fenceToken: grant.fenceToken,
        expiresAtMs: grant.expiresAtMs,
      });
      return { granted: true, grant };
    } finally {
      await claim.close();
      await rm(claimPath, { force: true }).catch(() => undefined);
    }
  }

  async renew(runId: string, grant: LeaseGrant): Promise<boolean> {
    const held = await this.read(runId);
    /*
     * Renewing something you no longer hold is exactly the stalled-process
     * case. It must fail rather than quietly extend somebody else's lease --
     * and the token, not the owner, is what identifies the holding, because
     * the same process can legitimately be a previous owner.
     */
    if (held === null || held.fenceToken !== grant.fenceToken) return false;
    await this.write(runId, { ...held, expiresAtMs: this.now() + LEASE_TTL_MS });
    return true;
  }

  async release(runId: string, grant: LeaseGrant): Promise<void> {
    const held = await this.read(runId);
    // A late release from a former owner must not free the new owner's run.
    if (held === null || held.fenceToken !== grant.fenceToken) return;
    await rm(this.path(runId), { force: true }).catch(() => undefined);
  }

  async holder(runId: string): Promise<LeaseGrant | null> {
    const held = await this.read(runId);
    if (held === null || held.expiresAtMs <= this.now()) return null;
    return {
      runId,
      owner: held.owner,
      fenceToken: held.fenceToken,
      expiresAtMs: held.expiresAtMs,
    };
  }

  /**
   * The highest token ever issued for a run, as recorded on the volume.
   *
   * THIS IS WHAT THE WRITE PATH CHECKS, and it is the reason the lease lives
   * on disk rather than in a process. A stalled writer's own in-memory fence
   * would happily admit its own token: it is the only one it has ever seen.
   * Asking the volume asks something the successor has already written to.
   */
  async highestIssued(runId: string): Promise<number | null> {
    return (await this.read(runId))?.fenceToken ?? null;
  }
}
