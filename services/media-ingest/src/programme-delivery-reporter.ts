/** @author masterzee001 */
/**
 * The run's own answer about how its original media reaches the audience.
 *
 * Assembled here from things that were actually observed -- an encoder that is
 * running, an initialisation segment that exists, segments the cursor has
 * released -- and published to everybody who must act on it. Nothing in this
 * file infers readiness from configuration: a deployment with FFmpeg installed
 * and no contribution arriving is not a delivery chain, and calling it one is
 * how a console ends up reporting PROTECTED over an audience hearing the
 * studio.
 *
 * ANNOUNCED ON CHANGE, NOT ON A TICK. The gateway holds the last answer and
 * acts on it when a listener joins, so a stream of identical messages buys
 * nothing and buries the transitions that matter in a log. A change is a
 * change in the answer, not in the facts behind it.
 *
 * AND ANNOUNCED WHEN IT GETS WORSE, LOUDLY. A run that was ready and is no
 * longer ready is the case where somebody is already watching, so it is
 * reported the moment it is noticed rather than at the next poll.
 */

import {
  assessProgrammeDelivery,
  type DeliveryChainFacts,
  type ProgrammeDeliveryMode,
  type ProgrammeMediaDelivery,
} from '@videofy-live/shared-types';

export interface DeliveryReporterDeps {
  /** What this deployment is configured to do. */
  readonly configuredMode: ProgrammeDeliveryMode;
  /** Whether a media origin is configured at all. Structural. */
  readonly originConfigured: boolean;
  /** Runs this process is tracking, so a report describes something real. */
  readonly trackedRuns: () => readonly string[];
  readonly facts: (runId: string) => Omit<DeliveryChainFacts, 'configuredMode' | 'originConfigured'>;
  /** Where the public manifest for a run lives, absolute, for a browser. */
  readonly manifestUrl: (runId: string) => string;
  readonly announce: (delivery: ProgrammeMediaDelivery) => void;
}

/** Two answers are the same when every field a reader acts on is the same. */
function same(a: ProgrammeMediaDelivery, b: ProgrammeMediaDelivery): boolean {
  return (
    a.mode === b.mode &&
    a.readiness === b.readiness &&
    a.publicManifestUrl === b.publicManifestUrl &&
    a.reason === b.reason
  );
}

export class ProgrammeDeliveryReporter {
  private readonly last = new Map<string, ProgrammeMediaDelivery>();

  constructor(private readonly deps: DeliveryReporterDeps) {}

  /** The current answer for one run, whether or not anything has changed. */
  assess(runId: string): ProgrammeMediaDelivery {
    return assessProgrammeDelivery({
      programmeRunId: runId,
      facts: {
        configuredMode: this.deps.configuredMode,
        originConfigured: this.deps.originConfigured,
        ...this.deps.facts(runId),
      },
      publicManifestUrl: this.deps.manifestUrl(runId),
    });
  }

  /**
   * Publish anything that has changed.
   *
   * Returns what was announced, so a caller can log or test it without a
   * second traversal disagreeing with the first.
   */
  report(): readonly ProgrammeMediaDelivery[] {
    const announced: ProgrammeMediaDelivery[] = [];
    const live = new Set(this.deps.trackedRuns());

    for (const runId of live) {
      const current = this.assess(runId);
      const previous = this.last.get(runId);
      if (previous !== undefined && same(previous, current)) continue;
      this.last.set(runId, current);
      this.deps.announce(current);
      announced.push(current);
    }

    /*
     * A run this process no longer tracks is forgotten, so that a later run
     * with the same id -- a restart, a replay -- is announced afresh rather
     * than suppressed as unchanged.
     */
    for (const runId of [...this.last.keys()]) {
      if (!live.has(runId)) this.last.delete(runId);
    }
    return announced;
  }

  /** Announce one run now, whatever it says. For a listener that just joined. */
  reportNow(runId: string): ProgrammeMediaDelivery {
    const current = this.assess(runId);
    this.last.set(runId, current);
    this.deps.announce(current);
    return current;
  }
}
