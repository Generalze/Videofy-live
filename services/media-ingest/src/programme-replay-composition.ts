/** @author masterzee001 */
/**
 * The one place a broadcast becomes a replay.
 *
 * WHY THIS FILE EXISTS AT ALL. Every piece it uses is already built, frozen and
 * tested: a policy resolver, an archive, a capture seam, a catalogue reporter, a
 * lifecycle worker. What was missing is the JOIN -- and both halves built with
 * the join left to nobody is the repeat defect in this repository. Scattering
 * these calls through the handlers that happen to be nearby is how a deployment
 * ends up recording on one path and not another, or reporting history for runs
 * that started one way and not the other. There is one path, and this is it.
 *
 * THE ORDER IS THE PRODUCT DECISION, IN ORDER:
 *
 *   1. A programme opens. Its identity is known; nothing else is.
 *   2. The policy is RESOLVED -- never assumed, never defaulted. The account
 *      service owns the channel's settings and the programme's override.
 *   3. The airing is written to history, whatever the answer turns out to be.
 *      A broadcast that happened is history even if nothing is kept of it.
 *   4a. Policy `none`: the catalogue says `none`, no recording is opened, and
 *       no byte is ever offered to an archive. `none` is a first-class answer
 *       and is never dressed up as a deleted or failed recording.
 *   4b. Otherwise: the archive opens a recording with the EXACT resolved
 *       retention and visibility, and capture is attached non-blockingly.
 *   5. The programme ends: finalise, then project the result to history.
 *
 * POLICY FAILURE IS NOT LIVE FAILURE, and it is not a guess either.
 *
 * If the account service is down, slow, unconfigured, or answers with something
 * that is not a usable policy, this records a diagnostic and opens NO recording.
 * The broadcast goes out exactly as it would have. What it does not do -- ever
 * -- is invent a retention: not `keep`, not `none`, not thirty days, not a
 * visibility. Every one of those is somebody's data kept or discarded on the
 * strength of a network timeout, and both directions are wrong. An operator
 * whose Replay was configured and did not happen has a diagnostic to look at; an
 * operator whose broadcast was kept for a month because a service blinked has a
 * problem nobody can see.
 *
 * THE GATE IS PER RUN. `archiveFor` hands the origin an archive only for runs
 * this file actually opened a recording for. A `none` run, or one whose policy
 * could not be resolved, gets nothing -- so the capture seam has nothing to
 * offer to, rather than offering into an archive that will refuse it.
 */

import type {
  ProgrammeAiringCatalogue,
  ProgrammeReplayArchive,
  ReplayRecord,
} from '@videofy-live/programme-replay';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import { ProgrammeAiringReporter } from './programme-airing-reporter.js';

/** What the account service answered about one programme's retention. */
export type ReplayPolicyAnswer =
  | {
      readonly ok: true;
      readonly retention: { readonly policy: 'keep' } | { readonly policy: 'expire'; readonly expiresAtMs: number };
      readonly visibility: 'public' | 'unlisted' | 'private';
    }
  /** The operator chose to keep nothing. A decision, not an absence. */
  | { readonly ok: true; readonly retention: { readonly policy: 'none' }; readonly visibility: 'private' }
  /** Nothing usable came back. Never a reason to invent one. */
  | { readonly ok: false; readonly refusal: string; readonly detail: string };

export interface ReplayPolicyResolver {
  resolve(
    identity: ProgrammeRunIdentity,
    startedAtMs: number,
  ): Promise<ReplayPolicyAnswer>;
}

/** Something an operator should see. Carries no path and no credential. */
export interface ReplayCompositionDiagnostic {
  readonly runId: string;
  readonly stage: 'policy' | 'begin' | 'finalise' | 'catalogue';
  readonly outcome: 'unresolved' | 'refused' | 'unavailable';
  readonly detail: string;
}

export interface ReplayCompositionDeps {
  readonly policy: ReplayPolicyResolver;
  readonly archive: ProgrammeReplayArchive;
  /** Absent on a deployment with no durable catalogue: history simply lags. */
  readonly catalogue?: ProgrammeAiringCatalogue;
  readonly now?: () => number;
  readonly onDiagnostic?: (diagnostic: ReplayCompositionDiagnostic) => void;
}

/** What happened when a programme opened. For a log, and for the tests. */
export type ProgrammeOpening =
  /** A recording was opened with a resolved policy. */
  | 'recording'
  /** The operator's policy is to keep nothing. History still records it. */
  | 'none'
  /** No policy could be resolved. Nothing recorded, nothing guessed. */
  | 'unresolved'
  /** The archive refused to open a recording. Nothing recorded. */
  | 'refused';

export class ProgrammeReplayComposition {
  /** Runs this composition actually opened a recording for. Nothing else. */
  private readonly recording = new Set<string>();
  private readonly reporter: ProgrammeAiringReporter | null;
  private readonly now: () => number;

  constructor(private readonly deps: ReplayCompositionDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.reporter =
      deps.catalogue === undefined
        ? null
        : new ProgrammeAiringReporter({
            catalogue: deps.catalogue,
            archive: { describe: (runId) => deps.archive.describe(runId) },
            onProblem: (problem) =>
              this.diagnose(problem.runId, 'catalogue', 'unavailable', problem.reason),
          });
  }

  /**
   * A programme has opened. Decide, once, what becomes of its recording.
   *
   * NEVER THROWS, AND NEVER BLOCKS THE BROADCAST. The caller awaits this only
   * to know what to log; a live path that had to wait on an account service
   * before it could put a programme to air would have made Replay a dependency
   * of broadcasting, which is exactly backwards.
   */
  async programmeOpened(
    identity: ProgrammeRunIdentity,
    startedAtMs: number,
  ): Promise<ProgrammeOpening> {
    let answer: ReplayPolicyAnswer;
    try {
      answer = await this.deps.policy.resolve(identity, startedAtMs);
    } catch (error) {
      /*
       * DOWN, SLOW, OR SHOUTING. All three land here, and all three mean the
       * same thing: nobody knows what this operator asked for, so nothing is
       * kept. The broadcast is already going out.
       */
      this.diagnose(identity.runId, 'policy', 'unavailable', describe(error));
      await this.recordAiring(identity, startedAtMs, false);
      return 'unresolved';
    }

    if (!answer.ok) {
      /*
       * A REFUSAL IS AN ANSWER AND IT IS STILL NOT A POLICY. An unconfigured
       * channel, an override the channel forbids, a duration that makes no
       * sense -- each is a thing an operator can fix, and none of them is a
       * reason to record something they did not ask for.
       */
      this.diagnose(identity.runId, 'policy', 'unresolved', `${answer.refusal}: ${answer.detail}`);
      await this.recordAiring(identity, startedAtMs, false);
      return 'unresolved';
    }

    if (answer.retention.policy === 'none') {
      /*
       * `none` IS FIRST-CLASS. The programme still appears in history, the
       * catalogue says `none`, and no recording is opened -- so there is no
       * `deleted` or `failed` status pretending something existed and stopped.
       */
      await this.recordAiring(identity, startedAtMs, true);
      return 'none';
    }

    const begun = await this.deps.archive.begin({
      identity,
      retention: answer.retention,
      visibility: answer.visibility,
      startedAtMs,
    });
    if (!begun.ok) {
      this.diagnose(identity.runId, 'begin', 'refused', begun.failure.detail);
      await this.recordAiring(identity, startedAtMs, false);
      return 'refused';
    }

    this.recording.add(identity.runId);
    await this.recordAiring(identity, startedAtMs, false);
    // The catalogue learns the recording exists as soon as it does.
    await this.reporter?.sync(identity.runId);
    return 'recording';
  }

  /**
   * The archive the capture seam may use for this run, or null.
   *
   * THE GATE. A `none` run, or one whose policy never resolved, gets null -- so
   * the origin has nothing to offer to rather than offering into an archive
   * that would refuse it a thousand times over the course of a broadcast.
   */
  archiveFor(runId: string): ProgrammeReplayArchive | null {
    return this.recording.has(runId) ? this.deps.archive : null;
  }

  /** Whether this run is being recorded. For health and for tests. */
  isRecording(runId: string): boolean {
    return this.recording.has(runId);
  }

  /**
   * The programme is over.
   *
   * FINALISATION IS THE ORIGIN'S, NOT THIS FILE'S. The producer knows when the
   * last fragment landed and already calls `finalise`; calling it again here
   * would be a second opinion about when a broadcast ended. What this does is
   * project the RESULT -- whatever it turned out to be -- into history, and
   * write down that the airing ended.
   */
  async programmeClosed(runId: string, endedAtMs: number): Promise<void> {
    if (this.reporter !== null) {
      if (this.recording.has(runId)) await this.reporter.sync(runId);
      await this.reporter.airingEnded(runId, endedAtMs);
    }
    this.recording.delete(runId);
  }

  /**
   * Bring history back into line with the archive for one run.
   *
   * WHAT RECONCILIATION IS FOR. A catalogue that was unavailable during a
   * broadcast has a row that stops partway through the truth; the archive is
   * unaffected, because it never depended on the catalogue for anything. This
   * replays the CURRENT snapshot, which is idempotent by construction, so
   * running it against a run that is already correct changes nothing.
   */
  async reconcile(runId: string): Promise<void> {
    await this.reporter?.sync(runId);
  }

  /** Project a lifecycle result -- an expiry, a deletion -- into history. */
  async project(record: ReplayRecord): Promise<void> {
    await this.reporter?.sync(record.identity.runId);
  }

  private async recordAiring(
    identity: ProgrammeRunIdentity,
    startedAtMs: number,
    keepingNothing: boolean,
  ): Promise<void> {
    if (this.reporter === null) return;
    /*
     * HISTORY IS WRITTEN WHATEVER THE POLICY TURNED OUT TO BE, including when
     * it turned out to be nothing at all. A broadcast that happened is history;
     * a retention decision is not allowed to edit the past.
     */
    if (keepingNothing) {
      await this.reporter.keepingNothing(identity, startedAtMs);
      return;
    }
    await this.reporter.airingBegan(identity, startedAtMs);
  }

  private diagnose(
    runId: string,
    stage: ReplayCompositionDiagnostic['stage'],
    outcome: ReplayCompositionDiagnostic['outcome'],
    detail: string,
  ): void {
    this.deps.onDiagnostic?.({ runId, stage, outcome, detail });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
