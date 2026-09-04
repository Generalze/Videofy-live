/** @author masterzee001 */
/**
 * Exactly one writer owns a broadcast.
 *
 * Two processes writing one run's timeline and media produce split-brain
 * output: two journals, two cursors, two versions of what the audience
 * received. Nothing downstream can reconcile that afterwards, so it is
 * prevented rather than detected.
 *
 * THE FENCING TOKEN IS THE WHOLE POINT. A lock alone is not enough, because
 * the dangerous case is not a process that fails to acquire -- it is one that
 * HAD ownership, stalled long enough to lose it, and then woke up and carried
 * on writing as though nothing happened. It has a valid handle and stale
 * authority. A monotonically increasing token given out with each grant, and
 * checked on every write, makes that impossible: the store refuses anything
 * carrying a token below the one it has already seen.
 *
 * DELIBERATELY SMALL. Today's deployment is one host and one media-ingest, so
 * the implementation behind this can be a file. The interface is what matters:
 * it is shaped so a shared coordinator can replace the local adapter later
 * without any Programme contract changing.
 */

export interface LeaseOwner {
  /** Which process. Recorded so an operator can see who holds a broadcast. */
  readonly processId: string;
  /** Which host or container. Distinguishes a restart from a second instance. */
  readonly hostId: string;
}

export interface LeaseGrant {
  readonly runId: string;
  readonly owner: LeaseOwner;
  /**
   * Monotonic, and never reused for a run.
   *
   * Presented with every write. A store that has seen a higher token refuses
   * this one, which is what fences a woken-up former owner.
   */
  readonly fenceToken: number;
  readonly expiresAtMs: number;
}

export type LeaseResult =
  | { readonly granted: true; readonly grant: LeaseGrant }
  /** Somebody else holds it and their lease has not expired. */
  | { readonly granted: false; readonly heldBy: LeaseOwner; readonly expiresAtMs: number };

/**
 * How long a grant lasts without renewal.
 *
 * Long enough that ordinary pauses -- a slow disk, a garbage collection, a
 * blocked event loop -- do not lose a broadcast. Short enough that a genuinely
 * dead process does not hold one hostage for longer than a viewer would
 * tolerate.
 */
export const LEASE_TTL_MS = 15_000;

export interface RunWriterLease {
  /**
   * Claim a run, or learn who has it.
   *
   * An expired lease may be taken over, and the new grant always carries a
   * HIGHER token than the one it replaced -- which is what invalidates the
   * previous owner rather than merely replacing it.
   */
  acquire(runId: string, owner: LeaseOwner): Promise<LeaseResult>;
  /** Keep a grant alive. False means it was lost and writing must stop. */
  renew(runId: string, grant: LeaseGrant): Promise<boolean>;
  /** Give it up deliberately, so a successor need not wait out the TTL. */
  release(runId: string, grant: LeaseGrant): Promise<void>;
  /** Who holds this run right now, if anybody. */
  holder(runId: string): Promise<LeaseGrant | null>;
}

/**
 * A lease held in this process's memory.
 *
 * Correct for a single-process deployment and for tests, and honest about
 * being nothing more: it cannot see another process, so it must never be used
 * where two could run.
 */
export class InMemoryRunWriterLease implements RunWriterLease {
  private readonly grants = new Map<string, LeaseGrant>();
  private nextToken = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async acquire(runId: string, owner: LeaseOwner): Promise<LeaseResult> {
    const held = this.grants.get(runId);
    const at = this.now();
    if (held !== undefined && held.expiresAtMs > at && !sameOwner(held.owner, owner)) {
      return { granted: false, heldBy: held.owner, expiresAtMs: held.expiresAtMs };
    }
    /*
     * A NEW TOKEN EVERY TIME, including for the same owner re-acquiring. The
     * token's only job is to be higher than every token before it, so that a
     * write arriving with an older one is provably from a previous life.
     */
    const grant: LeaseGrant = {
      runId,
      owner,
      fenceToken: this.nextToken,
      expiresAtMs: at + LEASE_TTL_MS,
    };
    this.nextToken += 1;
    this.grants.set(runId, grant);
    return { granted: true, grant };
  }

  async renew(runId: string, grant: LeaseGrant): Promise<boolean> {
    const held = this.grants.get(runId);
    // Renewing something you no longer hold is exactly the stalled-process
    // case, and must fail rather than quietly extend somebody else's lease.
    if (held === undefined || held.fenceToken !== grant.fenceToken) return false;
    this.grants.set(runId, { ...held, expiresAtMs: this.now() + LEASE_TTL_MS });
    return true;
  }

  async release(runId: string, grant: LeaseGrant): Promise<void> {
    const held = this.grants.get(runId);
    if (held !== undefined && held.fenceToken === grant.fenceToken) this.grants.delete(runId);
  }

  async holder(runId: string): Promise<LeaseGrant | null> {
    const held = this.grants.get(runId);
    if (held === undefined) return null;
    return held.expiresAtMs > this.now() ? held : null;
  }
}

function sameOwner(a: LeaseOwner, b: LeaseOwner): boolean {
  return a.processId === b.processId && a.hostId === b.hostId;
}

/**
 * The guard a store applies to every write.
 *
 * Kept separate from the lease so any store can enforce fencing without
 * knowing how ownership is decided. It remembers the highest token it has
 * accepted for a run and refuses anything below it -- permanently, because a
 * process that has been fenced does not become valid again by waiting.
 */
export class FenceGuard {
  private readonly highest = new Map<string, number>();

  /** May a writer holding this token write to this run? */
  admit(runId: string, fenceToken: number): boolean {
    const seen = this.highest.get(runId);
    if (seen !== undefined && fenceToken < seen) return false;
    this.highest.set(runId, fenceToken);
    return true;
  }

  /** The highest token seen for a run, for diagnostics. */
  highestSeen(runId: string): number | null {
    return this.highest.get(runId) ?? null;
  }
}
