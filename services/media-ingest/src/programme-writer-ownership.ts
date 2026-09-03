/** @author masterzee001 */
/**
 * Acquiring, holding and losing the right to write a broadcast.
 *
 * The lease itself is a small thing on disk. What makes it worth anything is
 * this: something has to ask for it before the first event is written, keep
 * asking while the broadcast runs, and -- the part that is always missing --
 * do something decisive the moment the answer is no.
 *
 * LOSING THE LEASE FAILS THE BROADCAST. Not a warning, not a retry: the buffer
 * is failed, which stops the cursor and stops the output. A process that has
 * been superseded and carries on producing is producing a second version of a
 * broadcast that somebody else is also producing, and nothing downstream can
 * reconcile two of those afterwards.
 *
 * ACQUIRING IS NOT OPTIONAL AND NOT SILENT. A run this process cannot claim is
 * a run somebody else is writing, so it is refused here rather than discovered
 * as two journals disagreeing.
 */

import type { RunWriterLease, LeaseGrant, LeaseOwner } from '@videofy-live/programme-timeline';

export interface WriterOwnershipDeps {
  readonly lease: RunWriterLease;
  readonly owner: LeaseOwner;
  /** Told the token to write under, once it is held. */
  readonly writeUnder: (fenceToken: number) => void;
  /** Stop a broadcast this process may no longer write. */
  readonly surrender: (runId: string, reason: string) => void;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
  /** How often a held lease is renewed. Well inside its own expiry. */
  readonly renewMs?: number;
}

export class ProgrammeWriterOwnership {
  private readonly held = new Map<string, LeaseGrant>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WriterOwnershipDeps) {}

  /**
   * Claim the right to write a broadcast.
   *
   * False means somebody else holds it. The caller must not write: two writers
   * on one run produce two journals, two cursors and two versions of what the
   * audience received.
   */
  async claim(runId: string): Promise<boolean> {
    const existing = this.held.get(runId);
    if (existing !== undefined) return true;

    const result = await this.deps.lease.acquire(runId, this.deps.owner);
    if (!result.granted) {
      this.deps.log?.('Refused ownership of a broadcast another writer holds', {
        runId,
        // Named so an operator can see WHICH process, without it being a
        // secret: a process and host id are operational, not sensitive.
        heldBy: result.heldBy,
      });
      return false;
    }

    this.held.set(runId, result.grant);
    this.deps.writeUnder(result.grant.fenceToken);
    this.deps.log?.('Took ownership of a broadcast', {
      runId,
      fenceToken: result.grant.fenceToken,
    });
    this.start();
    return true;
  }

  /** Give a run up deliberately, so a successor need not wait out the TTL. */
  async surrender(runId: string): Promise<void> {
    const grant = this.held.get(runId);
    if (grant === undefined) return;
    this.held.delete(runId);
    await this.deps.lease.release(runId, grant);
    if (this.held.size === 0) this.stop();
  }

  /** Whether this process currently holds the right to write a run. */
  owns(runId: string): boolean {
    return this.held.has(runId);
  }

  /**
   * Renew everything held, and act on anything lost.
   *
   * Public so a test drives it directly rather than waiting on a timer, and so
   * a caller with a better moment than a tick can force the question.
   */
  async renewAll(): Promise<readonly string[]> {
    const lost: string[] = [];
    for (const [runId, grant] of [...this.held]) {
      const renewed = await this.deps.lease.renew(runId, grant).catch(() => false);
      if (renewed) continue;
      /*
       * THE STALLED-PROCESS CASE, arriving from our own side. We believed we
       * owned this broadcast and we do not. Stopping is not enough on its own
       * -- the store's fence is what prevents a write already in flight -- but
       * it is what stops the next thousand.
       */
      this.held.delete(runId);
      lost.push(runId);
      this.deps.surrender(runId, 'another process has taken ownership of this broadcast');
      this.deps.log?.('Lost ownership of a broadcast', { runId, fenceToken: grant.fenceToken });
    }
    if (this.held.size === 0) this.stop();
    return lost;
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.renewAll();
    }, this.deps.renewMs ?? 5_000);
    // A lease renewal must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
