/** @author masterzee001 */
/**
 * The one place this service tells the catalogue what happened.
 *
 * WHY ONE PLACE. Programme history could be written from the producer when a
 * run opens, from the capture chain when a fragment lands, and from the door
 * when a viewer asks. Three callers means three retry policies, three ideas of
 * what a failure means, and three chances for one of them to await a database
 * inside a live broadcast. So every catalogue call in this service goes through
 * here, and the rules live in one file.
 *
 * BOOKKEEPING, NOT BROADCASTING. Nothing below can fail a programme, fail a
 * recording, or delay either. A catalogue that is unreachable makes history
 * briefly wrong; a catalogue that is allowed to matter makes a broadcast stop.
 * Those are not comparable, so the trade is made once, here, in favour of the
 * broadcast every time.
 *
 * THE ARCHIVE IS THE AUTHORITY. Everything reported is a snapshot of what the
 * archive already committed. If the two ever disagree, the archive is right --
 * it holds the media and it decides what may be played. This is a projection of
 * that truth for a history page, and it never becomes an input to playback.
 *
 * AT-LEAST-ONCE, AND THAT IS FINE. Every catalogue mutation is idempotent and
 * refuses to move backwards, so a report sent twice, late, or out of order
 * costs nothing. Which is what lets `sync` below be the whole repair mechanism:
 * the CURRENT snapshot is always enough, and no history of transitions has to
 * be replayed.
 */

import type {
  ProgrammeAiringCatalogue,
  ReplayDisposition,
  ReplayRecord,
} from '@videofy-live/programme-replay';
import { REPLAY_NOT_KEPT, summariseReplay } from '@videofy-live/programme-replay';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import { logger } from './logger.js';

/** The one thing history needs of the archive: what does it say right now. */
export interface ReplayStateSource {
  describe(runId: string): Promise<ReplayRecord | null>;
}

/** Something an operator should see. Carries no path and no viewer identity. */
export interface AiringReportProblem {
  readonly runId: string;
  readonly operation: 'record' | 'project' | 'finish';
  readonly reason: string;
}

export interface ProgrammeAiringReporterDeps {
  readonly catalogue: ProgrammeAiringCatalogue;
  /**
   * Where the current truth about a recording is read from.
   *
   * The archive, always. Reporting from anything else -- a cached snapshot, a
   * value passed along by a caller -- is how a catalogue starts describing a
   * recording that no longer exists in the state it was described in.
   *
   * NARROWED TO THE ONE QUESTION IT ASKS. Reporting history needs to read a
   * recording, never to begin, finalise or delete one, and a dependency that
   * demanded the whole port would be handing a bookkeeping component the
   * ability to change what it is supposed to be describing.
   */
  readonly archive?: ReplayStateSource;
  readonly onProblem?: (problem: AiringReportProblem) => void;
}

export class ProgrammeAiringReporter {
  constructor(private readonly deps: ProgrammeAiringReporterDeps) {}

  /**
   * A programme went on air.
   *
   * Called whether or not anything will be recorded: the airing is the history,
   * and a broadcast the operator chose not to keep still happened.
   */
  async airingBegan(
    identity: ProgrammeRunIdentity,
    startedAtMs: number,
    replay: ReplayDisposition = REPLAY_NOT_KEPT,
  ): Promise<void> {
    const outcome = await this.attempt('record', identity.runId, () =>
      this.deps.catalogue.recordAiring({ identity, startedAtMs, replay }),
    );
    if (!outcome) return;
  }

  /** This broadcast will keep no recording, and history should say so. */
  async keepingNothing(identity: ProgrammeRunIdentity, startedAtMs: number): Promise<void> {
    await this.airingBegan(identity, startedAtMs, REPLAY_NOT_KEPT);
  }

  /**
   * Bring the catalogue up to date with whatever the archive says right now.
   *
   * THE WHOLE REPAIR MECHANISM. Because projections are idempotent and cannot
   * regress, the current snapshot is sufficient to correct a row that went
   * stale during an outage -- there is no journal of transitions to replay, and
   * none is needed. The lifecycle history of a recording lives on the
   * `ReplayRecord`, where it belongs; this is a product catalogue.
   */
  async sync(runId: string): Promise<void> {
    const archive = this.deps.archive;
    if (archive === undefined) return;

    let disposition: ReplayDisposition;
    try {
      const record = await archive.describe(runId);
      /*
       * No record means the archive is not keeping one. That is `none` --
       * which is a fact about this airing, not an absence of information --
       * and the catalogue will refuse it if it disagrees, which is the point.
       */
      disposition = record === null ? REPLAY_NOT_KEPT : summariseReplay(record);
    } catch {
      this.report({ runId, operation: 'project', reason: 'archive-unreadable' });
      return;
    }

    await this.attempt('project', runId, () =>
      this.deps.catalogue.projectReplay(runId, disposition),
    );
  }

  /** The broadcast ended. Reported after a final sync, so the row settles once. */
  async airingEnded(runId: string, endedAtMs: number): Promise<void> {
    await this.sync(runId);
    await this.attempt('finish', runId, () => this.deps.catalogue.finishAiring(runId, endedAtMs));
  }

  /* ------------------------------------------------------------- internals */

  /**
   * One catalogue call, with the broadcast held harmless.
   *
   * Returns whether it landed, for a caller that cares. Nothing in this service
   * currently does, which is the intended shape: the answer to "did history
   * record that?" must never change what a programme does next.
   */
  private async attempt(
    operation: AiringReportProblem['operation'],
    runId: string,
    call: () => Promise<{ readonly ok: boolean; readonly failure?: { readonly reason: string } }>,
  ): Promise<boolean> {
    try {
      const outcome = await call();
      if (outcome.ok) return true;
      this.report({ runId, operation, reason: outcome.failure?.reason ?? 'unknown' });
      return false;
    } catch {
      // The port promises not to throw. An implementation that does must not
      // take a broadcast with it.
      this.report({ runId, operation, reason: 'catalogue-threw' });
      return false;
    }
  }

  private report(problem: AiringReportProblem): void {
    this.deps.onProblem?.(problem);
    logger.warn('Programme airing could not be catalogued', { ...problem });
  }
}
