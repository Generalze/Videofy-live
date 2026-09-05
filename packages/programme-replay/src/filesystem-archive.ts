/** @author masterzee001 */
/**
 * A recording that outlives the spool it was copied from, and the process too.
 *
 * THE ONE INVARIANT THIS FILE EXISTS FOR:
 *
 *     a successful retention means REPLAY OWNS THE BYTES
 *
 * Not "Replay wrote down where the bytes are". The reference a segment arrives
 * with points into the live spool, which prunes as the audience advances and is
 * released the moment the broadcast ends -- roughly the moment a replay starts
 * being useful. An archive that stored that path would be an archive of dead
 * links, and it would discover this weeks later, from a viewer.
 *
 * So retention copies. `retainSegment` does not answer until the bytes are in
 * this archive's own file, that file has been flushed, published under its
 * final name, and named by metadata that has itself been made durable. After
 * that the source may be pruned, deleted, or unplugged.
 *
 * ORDERING IS THE WHOLE OF CRASH SAFETY. Media is made durable BEFORE the
 * metadata that references it, always. The two ways to die are therefore:
 *
 *   object durable, metadata never written  -> an orphan. Harmless, and swept
 *                                              on the next open.
 *   metadata written, object never durable  -> a recording that claims media
 *                                              nobody has. FORBIDDEN, and the
 *                                              ordering makes it unreachable.
 *
 * WHAT THIS FILE DOES NOT DO: decode, probe, transcode, or start an encoder.
 * It copies bytes it was told the size of, and refuses if the count disagrees.
 * It does not schedule anything either -- expiry is still a caller's decision.
 *
 * The rules of a recording are NOT here. They are in `recording.ts`, shared
 * with the in-memory archive, so that "what a replay is" cannot drift apart
 * from "where a replay is kept".
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type {
  ProgrammeReplayArchive,
  ReplayBeginRequest,
  ReplayRecord,
  ReplayRetentionReceipt,
} from './archive.js';
import { canTransition, isReplayStatus } from './lifecycle.js';
import type { ReplayInitialisation } from './media.js';
import {
  replayOk,
  replayRefused,
  type ReplayFailure,
  type ReplayFailureReason,
  type ReplayOutcome,
} from './outcome.js';
import { isReplayPolicy, isReplayVisibility } from './policy.js';
import {
  replayInitialisationPath,
  replayRunKey,
  replaySegmentPath,
} from './filesystem-layout.js';
import {
  beginFinalisation,
  finalisationComplaint,
  judgeBegin,
  judgeInitialisation,
  judgeSegment,
  move,
  receiptOf,
  recordFailure,
  recordInitialisation,
  recordSegment,
  releaseMedia,
  snapshotOf,
  type RecordingState,
  type RetainedInitialisation,
  type RetainedSegment,
} from './recording.js';

/**
 * The shape of what is written down.
 *
 * Bumped when a change would make an older archive unreadable. An archive
 * written by a NEWER version is refused rather than guessed at: a field this
 * build does not understand is a field it cannot honour, and honouring most of
 * a recording is how a replay becomes quietly wrong.
 */
export const REPLAY_ARCHIVE_SCHEMA_VERSION = 1;

/** How much is moved per read while copying. Large enough not to syscall-bound. */
const COPY_CHUNK_BYTES = 1 << 16;

/* --------------------------------------------------------------- diagnosis */

/** A run whose durable state could not be trusted, and why. */
export interface CorruptReplayRun {
  /** The on-disk directory. Always known, even when the run id is not. */
  readonly runKey: string;
  /** Null when the metadata was too damaged to say whose broadcast it was. */
  readonly runId: string | null;
  readonly reason: string;
}

/** What opening an archive produced: the archive, and what it could not trust. */
export interface ReplayArchiveOpening {
  readonly archive: FilesystemReplayArchive;
  /**
   * Runs that would not load.
   *
   * SURFACED RATHER THAN THROWN. One damaged run must not stop a service from
   * recording every other broadcast, and it must not be silently skipped
   * either -- an operator has to be able to see it. Operations against a
   * corrupt run refuse deterministically; operations against every other run
   * are unaffected.
   */
  readonly corrupt: readonly CorruptReplayRun[];
}

/* ------------------------------------------------------------ persistence */

interface PersistedEntry<T> {
  readonly offered: T;
  readonly archiveReference: string;
}

interface PersistedRun {
  readonly schemaVersion: number;
  readonly identity: RecordingState['identity'];
  readonly retention: RecordingState['retention'];
  readonly visibility: RecordingState['visibility'];
  readonly status: RecordingState['status'];
  readonly startedAtMs: number;
  readonly finalisedAtMs: number | null;
  readonly failure: ReplayFailure | null;
  readonly history: RecordingState['history'];
  readonly initialisations: readonly PersistedEntry<ReplayInitialisation>[];
  readonly segments: readonly PersistedEntry<ProgrammeMediaSegment>[];
}

function persistedOf(state: RecordingState): PersistedRun {
  return {
    schemaVersion: REPLAY_ARCHIVE_SCHEMA_VERSION,
    identity: state.identity,
    retention: state.retention,
    visibility: state.visibility,
    status: state.status,
    startedAtMs: state.startedAtMs,
    finalisedAtMs: state.finalisedAtMs,
    failure: state.failure,
    history: state.history,
    initialisations: state.initialisations,
    segments: state.segments,
  };
}

/** What a loaded file has to prove before it is believed. */
function stateFrom(raw: unknown): RecordingState | string {
  if (typeof raw !== 'object' || raw === null) return 'state is not an object';
  const candidate = raw as Partial<PersistedRun>;

  if (candidate.schemaVersion !== REPLAY_ARCHIVE_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${String(candidate.schemaVersion)}; this build writes ${REPLAY_ARCHIVE_SCHEMA_VERSION}`;
  }
  const identity = candidate.identity;
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity.runId !== 'string' ||
    typeof identity.channelId !== 'string' ||
    typeof identity.programmeId !== 'string'
  ) {
    return 'identity is missing or malformed';
  }
  if (!isReplayStatus(candidate.status)) return `unknown status ${String(candidate.status)}`;
  if (!isReplayVisibility(candidate.visibility)) {
    return `unknown visibility ${String(candidate.visibility)}`;
  }
  const retention = candidate.retention;
  if (typeof retention !== 'object' || retention === null || !isReplayPolicy(retention.policy)) {
    return 'retention is missing or malformed';
  }
  if (retention.policy === 'expire' && !Number.isFinite(retention.expiresAtMs)) {
    return 'an expire retention carries no usable expiry';
  }
  if (typeof candidate.startedAtMs !== 'number') return 'startedAtMs is missing';
  if (!Array.isArray(candidate.history)) return 'history is missing';
  if (!Array.isArray(candidate.segments)) return 'segments are missing';
  if (!Array.isArray(candidate.initialisations)) return 'initialisations are missing';

  return {
    identity,
    retention,
    visibility: candidate.visibility,
    startedAtMs: candidate.startedAtMs,
    status: candidate.status,
    finalisedAtMs: candidate.finalisedAtMs ?? null,
    segments: [...(candidate.segments as RetainedSegment[])],
    initialisations: [...(candidate.initialisations as RetainedInitialisation[])],
    failure: candidate.failure ?? null,
    history: [...candidate.history],
  };
}

function cloneState(state: RecordingState): RecordingState {
  return {
    identity: state.identity,
    retention: state.retention,
    visibility: state.visibility,
    startedAtMs: state.startedAtMs,
    status: state.status,
    finalisedAtMs: state.finalisedAtMs,
    segments: [...state.segments],
    initialisations: [...state.initialisations],
    failure: state.failure,
    history: [...state.history],
  };
}

/* ------------------------------------------------------------ the archive */

export class FilesystemReplayArchive implements ProgrammeReplayArchive {
  /** Loaded state, by run key. The disk is the authority; this is the copy. */
  private readonly runs = new Map<string, RecordingState>();
  /** Run ids whose operator asked for no replay, remembered durably. */
  private readonly declined = new Set<string>();
  /** Runs that would not load. Every operation against one refuses. */
  private readonly damaged = new Map<string, CorruptReplayRun>();
  /** One ordered chain per run: same run serialised, different runs free. */
  private readonly chains = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly root: string,
    private readonly now: () => number,
  ) {}

  /**
   * Open an archive over a directory, restoring whatever is already there.
   *
   * A RESTART NEVER IMPLIES AN ENDING. A run that was recording is restored as
   * recording and may carry straight on being written to; nothing here
   * finalises, fails, or expires anything on the way in. Recovery is reading
   * back what was written, not deciding what it must have meant.
   */
  static async open(
    root: string,
    now: () => number = () => Date.now(),
  ): Promise<ReplayArchiveOpening> {
    const archive = new FilesystemReplayArchive(root, now);
    await mkdir(join(root, 'runs'), { recursive: true });
    await mkdir(join(root, 'declined'), { recursive: true });
    await archive.loadDeclined();
    await archive.loadRuns();
    return { archive, corrupt: archive.corruptRuns() };
  }

  /** Runs whose durable state could not be trusted. For an operator to see. */
  corruptRuns(): readonly CorruptReplayRun[] {
    return [...this.damaged.values()];
  }

  /* ------------------------------------------------------------- the port */

  async begin(request: ReplayBeginRequest): Promise<ReplayOutcome<ReplayRecord>> {
    const runId = request.identity.runId;
    return this.withRun(runId, async () => {
      const damaged = this.refusalIfDamaged(runId);
      if (damaged !== null) return { ok: false, failure: damaged };

      const key = replayRunKey(runId);
      const judgement = judgeBegin(request, {
        declined: this.declined.has(runId),
        existingStatus: this.runs.get(key)?.status ?? null,
      });

      if (judgement.kind === 'declined') {
        /*
         * The refusal is written down BEFORE it is returned. A `none` run that
         * forgot its own decision would answer `unknown-replay` after a
         * restart, which reads as a broken wiring rather than as an operator's
         * choice -- and those call for opposite responses.
         */
        const written = await this.rememberDeclined(runId);
        if (written !== null) return { ok: false, failure: written };
        this.declined.add(runId);
        return { ok: false, failure: judgement.failure };
      }
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };

      await mkdir(join(this.root, 'runs', key, 'media'), { recursive: true });
      await mkdir(join(this.root, 'runs', key, 'init'), { recursive: true });
      await mkdir(join(this.root, 'runs', key, 'tmp'), { recursive: true });

      const failure = await this.persist(key, judgement.state);
      if (failure !== null) return { ok: false, failure };
      this.runs.set(key, judgement.state);
      return replayOk(snapshotOf(judgement.state));
    });
  }

  async retainInitialisation(
    runId: string,
    initialisation: ReplayInitialisation,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      const judgement = judgeInitialisation(state, runId, initialisation);
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
      if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

      const owned = await this.own(
        key,
        replayInitialisationPath(this.root, runId, initialisation.generation),
        initialisation.storageReference,
        initialisation.bytes,
      );
      if (!owned.ok) return { ok: false, failure: owned.failure };

      const next = cloneState(state);
      recordInitialisation(next, initialisation, owned.value);
      const failure = await this.persist(key, next);
      if (failure !== null) return { ok: false, failure };
      this.runs.set(key, next);
      return replayOk(receiptOf(next, true));
    });
  }

  async retainSegment(
    runId: string,
    segment: ProgrammeMediaSegment,
  ): Promise<ReplayOutcome<ReplayRetentionReceipt>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      const judgement = judgeSegment(state, runId, segment);
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
      if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

      const owned = await this.own(
        key,
        replaySegmentPath(this.root, runId, segment.segmentId),
        segment.storageReference,
        segment.bytes,
      );
      if (!owned.ok) return { ok: false, failure: owned.failure };

      const next = cloneState(state);
      recordSegment(next, segment, owned.value);
      const failure = await this.persist(key, next);
      if (failure !== null) return { ok: false, failure };
      this.runs.set(key, next);
      return replayOk(receiptOf(next, true));
    });
  }

  async finalise(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      /*
       * THE WHOLE FINALISATION IS DECIDED BEFORE ANY OF IT IS WRITTEN, and
       * written once. Persisting the intermediate `processing` would leave a
       * crash halfway through recorded as a state nobody can act on, and a
       * retry after that would append `processing` a second time. Dying before
       * the single write leaves the run exactly as it was: still recording,
       * and finalisable again with a history that reads correctly.
       */
      const next = cloneState(state);
      const refusal = beginFinalisation(next, this.now());
      if (refusal !== null) return { ok: false, failure: refusal };

      const complaint = finalisationComplaint(next, runId);
      const damaged = complaint === null ? await this.missingObject(next) : null;

      if (complaint !== null || damaged !== null) {
        const failure =
          complaint !== null
            ? recordFailure(next, complaint.reason, complaint.detail, this.now())
            : recordFailure(next, 'archive-unavailable', damaged ?? 'unknown', this.now());
        const wrote = await this.persist(key, next);
        if (wrote !== null) return { ok: false, failure: wrote };
        this.runs.set(key, next);
        return { ok: false, failure };
      }

      next.finalisedAtMs = this.now();
      move(next, 'available', this.now());
      const wrote = await this.persist(key, next);
      if (wrote !== null) return { ok: false, failure: wrote };
      this.runs.set(key, next);
      return replayOk(snapshotOf(next));
    });
  }

  async fail(
    runId: string,
    reason: ReplayFailureReason,
    detail: string,
  ): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      if (!canTransition(state.status, 'failed')) {
        return replayRefused(
          'lifecycle-transition-refused',
          `a replay in status ${state.status} cannot be failed`,
        );
      }

      const next = cloneState(state);
      recordFailure(next, reason, detail, this.now());
      const failure = await this.persist(key, next);
      if (failure !== null) return { ok: false, failure };
      this.runs.set(key, next);
      return replayOk(snapshotOf(next));
    });
  }

  async expire(runId: string, nowMs: number): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      // Already expired is a success, checked before the policy and the clock:
      // an at-least-once cleanup may retry carrying a different instant.
      if (state.status === 'expired') return replayOk(snapshotOf(state));

      if (state.retention.policy !== 'expire') {
        return replayRefused(
          'lifecycle-transition-refused',
          `run ${runId} is retained under policy ${state.retention.policy}, which never expires`,
        );
      }
      if (nowMs < state.retention.expiresAtMs) {
        return replayRefused(
          'lifecycle-transition-refused',
          `run ${runId} expires at ${state.retention.expiresAtMs} and it is ${nowMs}`,
        );
      }
      if (!canTransition(state.status, 'expired')) {
        return replayRefused(
          'lifecycle-transition-refused',
          `a replay in status ${state.status} cannot expire`,
        );
      }
      return this.letGo(key, state, 'expired');
    });
  }

  async delete(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { key, state } = found.value;

      // The second delete succeeds as a no-op: cleanup is at-least-once, and
      // "make sure this is gone" is already satisfied.
      if (state.status === 'deleted') return replayOk(snapshotOf(state));

      if (!canTransition(state.status, 'deleted')) {
        return replayRefused(
          'lifecycle-transition-refused',
          `a replay in status ${state.status} cannot be deleted`,
        );
      }
      return this.letGo(key, state, 'deleted');
    });
  }

  async describe(runId: string): Promise<ReplayRecord | null> {
    const state = this.runs.get(replayRunKey(runId));
    return state === undefined ? null : snapshotOf(state);
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Serialise work per run, and only per run.
   *
   * Two callers retaining the same segment at once must produce one object and
   * one byte contribution, which needs ordering. Two callers working on
   * DIFFERENT broadcasts must not wait for each other, which rules out one
   * lock for the archive: a single slow copy would otherwise stall the
   * recording of every other programme on the box.
   */
  private withRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const key = replayRunKey(runId);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // Never let a rejection poison the chain: a later link must still run.
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private refusalIfDamaged(runId: string): ReplayFailure | null {
    const damaged = this.damaged.get(replayRunKey(runId));
    if (damaged === undefined) return null;
    return {
      reason: 'archive-unavailable',
      detail: `the durable state for run ${runId} could not be trusted: ${damaged.reason}`,
      liveImpact: 'none',
    };
  }

  private recording(
    runId: string,
  ): ReplayOutcome<{ readonly key: string; readonly state: RecordingState }> {
    const damaged = this.refusalIfDamaged(runId);
    if (damaged !== null) return { ok: false, failure: damaged };
    if (this.declined.has(runId)) {
      return replayRefused('policy-forbids-replay', `run ${runId} is configured to keep no replay`);
    }
    const key = replayRunKey(runId);
    const state = this.runs.get(key);
    if (state === undefined) {
      return replayRefused('unknown-replay', `no replay was begun for run ${runId}`);
    }
    return replayOk({ key, state });
  }

  /**
   * Take ownership of some bytes, or say why not.
   *
   * The sequence is the contract: copy into a temporary file, count what
   * actually arrived, refuse if it disagrees with what was declared, flush it,
   * publish it under its final name, and make the directory entry durable.
   * Only then does the caller get a reference, and only then may metadata name
   * it.
   */
  private async own(
    key: string,
    destination: string,
    sourceReference: string,
    declaredBytes: number,
  ): Promise<ReplayOutcome<string>> {
    const runDirectory = join(this.root, 'runs', key);
    const temporary = join(runDirectory, 'tmp', `${randomUUID()}.part`);

    let copied: number;
    try {
      copied = await copyInto(sourceReference, temporary);
    } catch (error) {
      await discard(temporary);
      return replayRefused(
        'source-media-unavailable',
        `programme media at ${sourceReference} could not be copied into the replay archive: ${describe(error)}`,
      );
    }

    /*
     * THE COUNT IS NOT ADVISORY. The producer's metadata is authoritative for
     * what this fragment IS, so a copy of a different length is not a smaller
     * segment -- it is a segment that was still being written, or truncated,
     * or a different file altogether. Quietly recording what arrived would
     * make the archive's own byte totals a fiction.
     */
    if (copied !== declaredBytes) {
      await discard(temporary);
      return replayRefused(
        'source-media-unavailable',
        `programme media at ${sourceReference} declared ${declaredBytes} bytes and yielded ${copied}`,
      );
    }

    try {
      await rename(temporary, destination);
      await syncDirectory(join(destination, '..'));
    } catch (error) {
      await discard(temporary);
      return replayRefused(
        'archive-unavailable',
        `the replay archive could not publish this object: ${describe(error)}`,
      );
    }
    return replayOk(destination);
  }

  /** Replace a run's durable state atomically. Returns a failure, or null. */
  private async persist(key: string, state: RecordingState): Promise<ReplayFailure | null> {
    const directory = join(this.root, 'runs', key);
    const target = join(directory, 'state.json');
    const temporary = join(directory, 'tmp', `${randomUUID()}.state`);
    try {
      const body = `${JSON.stringify(persistedOf(state), null, 2)}\n`;
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(body, 'utf8');
        // Flushed before it is published: a renamed file whose contents are
        // still in a cache is a state file that can come back empty.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await syncDirectory(directory);
      return null;
    } catch (error) {
      await discard(temporary);
      return {
        reason: 'archive-unavailable',
        detail: `the replay archive could not record the state of this run: ${describe(error)}`,
        liveImpact: 'none',
      };
    }
  }

  /**
   * Let a recording go: metadata first, then the bytes.
   *
   * THAT ORDER IS DELIBERATE. Once the state says `deleted` the media is gone
   * as far as anybody can see, so a crash during the physical removal leaves
   * files nobody references rather than a recording that comes back. The next
   * open sweeps them.
   */
  private async letGo(
    key: string,
    state: RecordingState,
    to: 'expired' | 'deleted',
  ): Promise<ReplayOutcome<ReplayRecord>> {
    const next = cloneState(state);
    releaseMedia(next);
    move(next, to, this.now());
    const failure = await this.persist(key, next);
    if (failure !== null) return { ok: false, failure };
    this.runs.set(key, next);
    await this.sweep(key, next);
    return replayOk(snapshotOf(next));
  }

  /**
   * The first retained object this state names that is not really there, or is
   * not the object it is supposed to be.
   *
   * TWO QUESTIONS, NOT ONE. "Does a file of the right length exist at this
   * path" was never sufficient: every other object in this run is also a file
   * of some length inside this run, so a reference edited to name a NEIGHBOUR
   * -- the run's own init object, or its next fragment -- passes that check
   * completely and serves the wrong material under the right name. So each
   * reference is also required to BE the canonical path for the logical object
   * it belongs to, derived here from ids rather than read from the metadata
   * under suspicion.
   */
  private async missingObject(state: RecordingState): Promise<string | null> {
    const runId = state.identity.runId;
    for (const entry of state.initialisations) {
      const canonical = replayInitialisationPath(this.root, runId, entry.offered.generation);
      if (resolve(entry.archiveReference) !== resolve(canonical)) {
        return `initialisation generation ${entry.offered.generation}: its reference is not the canonical archive path for it`;
      }
      const complaint = await verify(entry.archiveReference, entry.offered.bytes);
      if (complaint !== null) return `initialisation generation ${entry.offered.generation}: ${complaint}`;
    }
    for (const entry of state.segments) {
      const canonical = replaySegmentPath(this.root, runId, entry.offered.segmentId);
      if (resolve(entry.archiveReference) !== resolve(canonical)) {
        return `segment ${entry.offered.segmentId}: its reference is not the canonical archive path for it`;
      }
      const complaint = await verify(entry.archiveReference, entry.offered.bytes);
      if (complaint !== null) return `segment ${entry.offered.segmentId}: ${complaint}`;
    }
    return null;
  }

  /* ------------------------------------------------------------- recovery */

  private async rememberDeclined(runId: string): Promise<ReplayFailure | null> {
    const target = join(this.root, 'declined', `${replayRunKey(runId)}.json`);
    try {
      await writeFile(
        target,
        `${JSON.stringify({ schemaVersion: REPLAY_ARCHIVE_SCHEMA_VERSION, runId }, null, 2)}\n`,
        'utf8',
      );
      await syncDirectory(join(this.root, 'declined'));
      return null;
    } catch (error) {
      return {
        reason: 'archive-unavailable',
        detail: `the replay archive could not record that run ${runId} keeps no replay: ${describe(error)}`,
        liveImpact: 'none',
      };
    }
  }

  private async loadDeclined(): Promise<void> {
    for (const name of await listing(join(this.root, 'declined'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw: unknown = JSON.parse(
          await readFile(join(this.root, 'declined', name), 'utf8'),
        );
        const runId = (raw as { runId?: unknown }).runId;
        if (typeof runId === 'string') this.declined.add(runId);
      } catch {
        /*
         * A decline marker that will not parse is not a reason to record a
         * broadcast nobody asked for. It is left alone and simply not applied;
         * the run then answers `unknown-replay`, which is honest -- this
         * archive genuinely does not know what was decided.
         */
      }
    }
  }

  private async loadRuns(): Promise<void> {
    for (const key of await listing(join(this.root, 'runs'))) {
      const directory = join(this.root, 'runs', key);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      } catch (error) {
        /*
         * NO STATE AT ALL IS NOT DAMAGE. `begin` makes a run's directories
         * before it writes the first record, so a process that died in between
         * -- or one whose very first state write failed -- leaves exactly this
         * shape: folders, and nothing that was ever true. Calling that corrupt
         * would raise an alarm about a recording that never began, on every
         * interrupted start.
         *
         * A state file that EXISTS and will not parse is a different animal,
         * and keeps its alarm.
         */
        if ((error as { code?: string }).code === 'ENOENT') {
          await this.sweep(key, emptyState());
          continue;
        }
        this.damaged.set(key, {
          runKey: key,
          runId: null,
          reason: `state could not be read: ${describe(error)}`,
        });
        continue;
      }

      const loaded = stateFrom(raw);
      if (typeof loaded === 'string') {
        this.damaged.set(key, {
          runKey: key,
          runId: runIdIn(raw),
          reason: loaded,
        });
        continue;
      }

      /*
       * THE RECORD MUST AGREE WITH WHERE IT IS KEPT.
       *
       * The directory is named for the run it holds. A state file claiming a
       * DIFFERENT run id is either a restore into the wrong place or an edit,
       * and either way the identity inside it is the thing every later
       * decision keys on -- including which material a viewer may reach. It is
       * cheaper and far safer to refuse the run here than to discover the
       * disagreement one authorisation later.
       */
      if (replayRunKey(loaded.identity.runId) !== key) {
        this.damaged.set(key, {
          runKey: key,
          runId: loaded.identity.runId,
          reason: 'the durable state claims a different run from the directory holding it',
        });
        continue;
      }

      /*
       * THE METADATA IS CHECKED AGAINST THE DISK, not trusted over it. A
       * record naming an object that is absent or the wrong size is the one
       * failure direction the write ordering is supposed to make impossible,
       * so meeting it here means something outside this archive has been at
       * the files. Reporting it is the only safe answer; a recording that
       * quietly dropped the missing fragment would be a different broadcast.
       */
      const missing = await this.missingObject(loaded);
      if (missing !== null) {
        this.damaged.set(key, {
          runKey: key,
          runId: loaded.identity.runId,
          reason: `durable state references media that is not intact: ${missing}`,
        });
        continue;
      }

      this.runs.set(key, loaded);
      await this.sweep(key, loaded);
    }
  }

  /**
   * Remove what nothing references: abandoned copies, and finished cleanups.
   *
   * Both kinds of leftover come from a crash. A temporary file is a copy that
   * never finished, and can never be anything else. A published object that
   * the state does not name is either a retention that died before its
   * metadata or a delete that died after it -- and in both cases the record is
   * the authority, so the object goes.
   *
   * ONLY EVER FOR A RUN WHOSE STATE LOADED. Sweeping against metadata that
   * could not be trusted would turn a diagnosable problem into a destroyed
   * recording.
   */
  private async sweep(key: string, state: RecordingState): Promise<void> {
    const directory = join(this.root, 'runs', key);
    const referenced = new Set([
      ...state.segments.map((entry) => entry.archiveReference),
      ...state.initialisations.map((entry) => entry.archiveReference),
    ]);

    for (const name of await listing(join(directory, 'tmp'))) {
      await discard(join(directory, 'tmp', name));
    }
    for (const folder of ['media', 'init']) {
      for (const name of await listing(join(directory, folder))) {
        const path = join(directory, folder, name);
        if (!referenced.has(path)) await discard(path);
      }
    }
  }
}

/* ------------------------------------------------------------- file plumbing */

/** Copy a source into a temporary file, answering how many bytes moved. */
async function copyInto(source: string, temporary: string): Promise<number> {
  const from = await open(source, 'r');
  try {
    const to = await open(temporary, 'w');
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let copied = 0;
      for (;;) {
        const read = await from.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        await to.write(buffer, 0, read.bytesRead);
        copied += read.bytesRead;
      }
      // Durable before it is published, and published before anything names it.
      await to.sync();
      return copied;
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

/** Whether an archive object is present and the size it was recorded as. */
async function verify(path: string, expectedBytes: number): Promise<string | null> {
  try {
    const found = await stat(path);
    if (found.size !== expectedBytes) {
      return `the archive object holds ${found.size} bytes where ${expectedBytes} were recorded`;
    }
    return null;
  } catch (error) {
    return `the archive object could not be read: ${describe(error)}`;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch {
    // Windows will not open a directory this way. The file sync is what
    // protects the bytes; this protects the name, where it can.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Some filesystems refuse to sync a directory handle. Nothing to do.
  } finally {
    await handle.close();
  }
}

async function listing(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function discard(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // A leftover that cannot be removed is untidy and harmless: nothing
    // references it, and the next open will try again.
  }
}

function runIdIn(raw: unknown): string | null {
  const identity = (raw as { identity?: { runId?: unknown } } | null)?.identity;
  return typeof identity?.runId === 'string' ? identity.runId : null;
}

/** A run that holds nothing, for sweeping the leftovers of one that never began. */
function emptyState(): RecordingState {
  return {
    identity: { channelId: '', programmeId: '', runId: '' },
    retention: { policy: 'keep' },
    visibility: 'private',
    startedAtMs: 0,
    status: 'recording',
    finalisedAtMs: null,
    segments: [],
    initialisations: [],
    failure: null,
    history: [],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
