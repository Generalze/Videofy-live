/** @author masterzee001 */
/**
 * The caretaker, on a timer.
 *
 * ONE PASS AT A TIME IN THIS PROCESS. A tick that fires while the previous pass
 * is still running is SKIPPED rather than queued: a slow store would otherwise
 * accumulate overlapping passes, each scanning the same candidates, each racing
 * the others to expire the same runs. The archive would refuse the duplicates
 * safely -- it is built to -- but the process would spend its afternoon
 * generating refusals, and the log would describe an incident that is really
 * just a schedule eating itself.
 *
 * ACROSS PROCESSES, NOTHING IS COORDINATED HERE, deliberately. Two instances
 * sweeping the same archive is a normal deployment, and it is safe for reasons
 * that live in the archive rather than in a scheduler: per-run serialisation,
 * compare-and-swap on state, and retry-safe terminal operations. Adding a lock
 * here would be a second, weaker answer to a question already answered where the
 * data is.
 *
 * STARTING AND RESTARTING ARE HARMLESS. Every operation a pass performs is one
 * the archive treats as retry-safe, so a worker that dies mid-batch and comes
 * back changes nothing except when the remaining work happens. There is no
 * cursor to lose and no partial state to reconcile.
 *
 * AND IT IS NOT WHAT ENFORCES ACCESS. If this never runs, expired recordings are
 * still refused at the exact retention instant by the playback admission check.
 * What stops happening is the release of BYTES -- a storage question, not a
 * privacy one.
 */

import {
  runReplayDeletionPass,
  runReplayExpiryPass,
  type ProgrammeReplayArchive,
  type ReplayCatalogueSync,
  type ReplayDeletionQueue,
  type ReplayLifecycleCandidateSource,
  type ReplayMaintenanceReport,
  type ReplayDeletionReport,
} from '@videofy-live/programme-replay';

export interface ReplayWorkerDeps {
  readonly archive: ProgrammeReplayArchive;
  readonly candidates: ReplayLifecycleCandidateSource;
  readonly deletions: ReplayDeletionQueue;
  readonly catalogue?: ReplayCatalogueSync;
  /** Required, all three. See the domain: no hidden defaults. */
  readonly cleanupGraceMs: number;
  readonly intervalMs: number;
  readonly batchLimit: number;
  readonly now?: () => number;
  readonly onPass?: (
    reports: { readonly expiry: ReplayMaintenanceReport; readonly deletion: ReplayDeletionReport },
  ) => void;
}

export class ProgrammeReplayWorker {
  private timer: NodeJS.Timeout | null = null;
  /** True while a pass is in flight. A tick during one is skipped, not queued. */
  private running = false;
  private readonly now: () => number;

  constructor(private readonly deps: ReplayWorkerDeps) {
    this.now = deps.now ?? ((): number => Date.now());
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pass();
    }, this.deps.intervalMs);
    /*
     * Nothing about retention maintenance should keep a process alive on its
     * own: a service asked to shut down must be able to, and the work is
     * resumable by construction.
     */
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass of both kinds of work. Exposed so a test can drive it directly. */
  async pass(): Promise<
    { readonly expiry: ReplayMaintenanceReport; readonly deletion: ReplayDeletionReport } | null
  > {
    if (this.running) return null;
    this.running = true;
    try {
      const nowMs = this.now();
      const expiry = await runReplayExpiryPass({
        archive: this.deps.archive,
        candidates: this.deps.candidates,
        ...(this.deps.catalogue === undefined ? {} : { catalogue: this.deps.catalogue }),
        nowMs,
        cleanupGraceMs: this.deps.cleanupGraceMs,
        limit: this.deps.batchLimit,
      });
      /*
       * DELETION AFTER EXPIRY, AND BOTH EVERY PASS. An explicit removal is an
       * operator waiting; retention maintenance is a schedule. Running expiry
       * first means a run that is both due and requested is expired by the
       * ordinary path and the deletion request then settles as a no-op, which
       * is the cheaper and less surprising order.
       */
      const deletion = await runReplayDeletionPass({
        archive: this.deps.archive,
        queue: this.deps.deletions,
        ...(this.deps.catalogue === undefined ? {} : { catalogue: this.deps.catalogue }),
        nowMs,
        limit: this.deps.batchLimit,
      });
      this.deps.onPass?.({ expiry, deletion });
      return { expiry, deletion };
    } finally {
      this.running = false;
    }
  }
}
