/** @author masterzee001 */
/**
 * The same Replay archive, over object storage.
 *
 * THE CONTRACT IS FROZEN AND THIS DOES NOT TOUCH IT. `ProgrammeReplayArchive`
 * says what a recording is and what may happen to it; that answer does not
 * change because the bytes moved from a volume to a bucket. Everything
 * interesting here is about keeping the SAME promises when the storage
 * underneath has different failure modes -- no rename, no fsync, no directory,
 * eventual anything, and other processes writing at the same time.
 *
 * THE ORDERING SURVIVES THE MOVE, because it is the whole of the crash
 * doctrine:
 *
 *     RETAIN:  media uploaded and verified  ->  then state
 *     RELEASE: state written                ->  then media removed
 *
 * A crash between the two is guaranteed to leave the harmless kind of mess.
 * Retention interrupted leaves an object nothing references -- swept later,
 * never Replay truth. Release interrupted leaves an object nothing can reach --
 * because the state that would have named it already says the recording is
 * gone. What must never happen is the other order, and that is the one thing
 * neither branch below is written to allow: media is never named by state that
 * was written first, and bytes are never removed while state still points at
 * them.
 *
 * THERE IS NO ATOMIC RENAME, SO STATE IS APPEND-ONLY AND VERSIONED. A
 * filesystem gets atomicity from `rename`; an object store has no such thing,
 * and overwriting one `state.json` in place means a reader can see a half-
 * written document and a concurrent writer can silently win. So each state
 * write CREATES the next generation under its own key, conditionally, and the
 * highest generation that exists is the truth. That gives atomicity (a
 * generation either exists whole or not at all), it gives compare-and-swap (two
 * writers cannot both create generation 8), and it gives recovery something
 * unambiguous to read.
 *
 * AND THE CONDITION IS VERIFIED RATHER THAN TRUSTED, in two directions,
 * because they catch different failures.
 *
 *   BEFORE the write, the key is checked for existence. This is what catches a
 *   store that quietly IGNORES `If-None-Match` -- there, a stale writer would
 *   otherwise overwrite the winner and then read its own document back
 *   perfectly happily. A read-back can prove "my write landed"; it can never
 *   prove "I did not clobber somebody".
 *
 *   AFTER the write, the generation is read back and its token compared. Each
 *   attempt embeds one unique to itself, so "did my write win" has an
 *   unambiguous answer even where the conditional was refused silently.
 *
 * WHAT REMAINS, STATED PLAINLY. On a store that honours the conditional, the
 * protocol is exact. On one that does not, two writers landing inside the
 * window between the check and the write are indistinguishable by any means
 * available here -- an inherent limit of a store without conditional writes,
 * not something this pretends to have closed. The realistic race, two processes
 * seconds apart, is caught.
 *
 * NO PROVIDER NAME APPEARS ANYWHERE IN THIS FILE.
 */

import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type {
  ProgrammeReplayArchive,
  ReplayBeginRequest,
  ReplayRecord,
  ReplayRetentionReceipt,
} from './archive.js';
import {
  replayOk,
  replayRefused,
  type ReplayFailure,
  type ReplayFailureReason,
  type ReplayOutcome,
} from './outcome.js';
import { canTransition, isReplayStatus } from './lifecycle.js';
import { isReplayPolicy, isReplayVisibility } from './policy.js';
import type { ReplayInitialisation } from './media.js';
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
import {
  isReplayObjectKey,
  replayDeclinedKey,
  replayInitialisationKey,
  replayInitialisationPrefix,
  replayMediaPrefix,
  replayRunPrefix,
  replaySegmentKey,
  replayStateGenerationKey,
  replayStateGenerationOf,
  replayStatePrefix,
  REPLAY_DECLINED_PREFIX,
  REPLAY_RUNS_PREFIX,
} from './object-layout.js';
import {
  describeStoreError,
  ObjectStoreError,
  type ReplayObjectStore,
} from './object-store.js';
import type {
  ReplayLifecycleCandidate,
  ReplayLifecycleCandidateSource,
  ReplayLifecycleQuery,
} from './lifecycle-worker.js';
import { readyToRelease } from './lifecycle-worker.js';

/** Bumped only when a state document stops being readable by an older build. */
export const REPLAY_OBJECT_SCHEMA_VERSION = 1;

/** How much is moved per read while uploading. */
const READ_CHUNK_BYTES = 1 << 16;

/** A run whose durable state could not be trusted, and why. */
export interface CorruptObjectRun {
  readonly runPrefix: string;
  readonly runId: string | null;
  readonly reason: string;
}

export interface ObjectArchiveOpening {
  readonly archive: S3CompatibleReplayArchive;
  readonly corrupt: readonly CorruptObjectRun[];
}

/** Where the bytes to be retained are read from. */
export interface ReplaySourceReader {
  /**
   * Open the producer's media for reading.
   *
   * INJECTED, BECAUSE THE SOURCE IS NOT THE ARCHIVE'S BUSINESS. Today it is a
   * spool file on the encoder's box; the archive's job starts when it has bytes
   * in hand, and hard-coding `node:fs` here would tie an object-storage archive
   * to the machine that happened to produce the media.
   */
  open(reference: string): Promise<Readable>;
}

/* ------------------------------------------------------------ persistence */

interface PersistedEntry<T> {
  readonly offered: T;
  readonly archiveReference: string;
}

interface PersistedRun {
  readonly schemaVersion: number;
  /** Unique to the attempt that wrote it. See the read-back note above. */
  readonly writerToken: string;
  readonly generation: number;
  readonly identity: ProgrammeRunIdentity;
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

/** State, plus the bookkeeping that makes the next write a safe one. */
interface HeldRun {
  readonly state: RecordingState;
  /** The generation currently on the store. The next write is this plus one. */
  readonly generation: number;
}

function persistedOf(state: RecordingState, generation: number, writerToken: string): PersistedRun {
  return {
    schemaVersion: REPLAY_OBJECT_SCHEMA_VERSION,
    writerToken,
    generation,
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

/** What a loaded document has to prove before it is believed. */
function stateFrom(raw: unknown): { state: RecordingState; writerToken: string } | string {
  if (typeof raw !== 'object' || raw === null) return 'state is not an object';
  const candidate = raw as Partial<PersistedRun>;

  if (candidate.schemaVersion !== REPLAY_OBJECT_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${String(candidate.schemaVersion)}; this build writes ${REPLAY_OBJECT_SCHEMA_VERSION}`;
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
    writerToken: typeof candidate.writerToken === 'string' ? candidate.writerToken : '',
    state: {
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
    },
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

/* ------------------------------------------------------------- the archive */

export class S3CompatibleReplayArchive
  implements ProgrammeReplayArchive, ReplayLifecycleCandidateSource
{
  private readonly runs = new Map<string, HeldRun>();
  private readonly declined = new Set<string>();
  private readonly damaged = new Map<string, CorruptObjectRun>();
  private readonly chains = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly store: ReplayObjectStore,
    private readonly source: ReplaySourceReader,
    private readonly now: () => number,
  ) {}

  /**
   * Open an archive over a bucket, restoring whatever is already in it.
   *
   * A RESTART NEVER IMPLIES AN ENDING, exactly as on a filesystem. A run that
   * was recording comes back recording and may carry straight on. Recovery
   * reads what was written; it does not decide what it must have meant.
   */
  static async open(options: {
    readonly store: ReplayObjectStore;
    readonly source: ReplaySourceReader;
    readonly now?: () => number;
    /** A bound on how much of a very large bucket one open will read. */
    readonly maxRuns?: number;
  }): Promise<ObjectArchiveOpening> {
    const archive = new S3CompatibleReplayArchive(
      options.store,
      options.source,
      options.now ?? ((): number => Date.now()),
    );
    await archive.loadDeclined();
    await archive.loadRuns(options.maxRuns ?? 10_000);
    return { archive, corrupt: archive.corruptRuns() };
  }

  corruptRuns(): readonly CorruptObjectRun[] {
    return [...this.damaged.values()];
  }

  /* --------------------------------------------------------------- the port */

  async begin(request: ReplayBeginRequest): Promise<ReplayOutcome<ReplayRecord>> {
    const runId = request.identity.runId;
    return this.withRun(runId, async () => {
      const damaged = this.refusalIfDamaged(runId);
      if (damaged !== null) return { ok: false, failure: damaged };

      const judgement = judgeBegin(request, {
        declined: this.declined.has(runId),
        existingStatus: this.runs.get(runId)?.state.status ?? null,
      });

      if (judgement.kind === 'declined') {
        const written = await this.rememberDeclined(runId);
        if (written !== null) return { ok: false, failure: written };
        this.declined.add(runId);
        return { ok: false, failure: judgement.failure };
      }
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };

      // Generation 1 is the first state a run ever has; 0 means "none yet".
      const written = await this.persist(runId, judgement.state, 0);
      if (!written.ok) return { ok: false, failure: written.failure };
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
      const { state, generation } = found.value;

      const judgement = judgeInitialisation(state, runId, initialisation);
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
      if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

      const owned = await this.own(
        replayInitialisationKey(runId, initialisation.generation),
        initialisation.storageReference,
        initialisation.bytes,
      );
      if (!owned.ok) return { ok: false, failure: owned.failure };

      const next = cloneState(state);
      recordInitialisation(next, initialisation, owned.value);
      const written = await this.persist(runId, next, generation);
      if (!written.ok) return { ok: false, failure: written.failure };
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
      const { state, generation } = found.value;

      const judgement = judgeSegment(state, runId, segment);
      if (judgement.kind === 'refused') return { ok: false, failure: judgement.failure };
      if (judgement.kind === 'duplicate') return replayOk(receiptOf(state, false));

      /*
       * THE OBJECT IS UPLOADED AND VERIFIED BEFORE ANY STATE NAMES IT. A crash
       * between the two leaves an object nothing references, which the sweep
       * removes; the other order would leave a recording that names media
       * which is not there, and that is a replay that lies.
       */
      const owned = await this.own(
        replaySegmentKey(runId, segment.segmentId),
        segment.storageReference,
        segment.bytes,
      );
      if (!owned.ok) return { ok: false, failure: owned.failure };

      const next = cloneState(state);
      recordSegment(next, segment, owned.value);
      const written = await this.persist(runId, next, generation);
      if (!written.ok) return { ok: false, failure: written.failure };
      return replayOk(receiptOf(next, true));
    });
  }

  async finalise(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { state, generation } = found.value;

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
        const wrote = await this.persist(runId, next, generation);
        if (!wrote.ok) return { ok: false, failure: wrote.failure };
        return { ok: false, failure };
      }

      next.finalisedAtMs = this.now();
      move(next, 'available', this.now());
      const wrote = await this.persist(runId, next, generation);
      if (!wrote.ok) return { ok: false, failure: wrote.failure };
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
      const { state, generation } = found.value;

      if (!canTransition(state.status, 'failed')) {
        return replayRefused(
          'lifecycle-transition-refused',
          `a replay in status ${state.status} cannot be failed`,
        );
      }
      const next = cloneState(state);
      recordFailure(next, reason, detail, this.now());
      const written = await this.persist(runId, next, generation);
      if (!written.ok) return { ok: false, failure: written.failure };
      return replayOk(snapshotOf(next));
    });
  }

  async expire(runId: string, nowMs: number): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { state, generation } = found.value;

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
      return this.letGo(runId, state, generation, 'expired');
    });
  }

  async delete(runId: string): Promise<ReplayOutcome<ReplayRecord>> {
    return this.withRun(runId, async () => {
      const found = this.recording(runId);
      if (!found.ok) return { ok: false, failure: found.failure };
      const { state, generation } = found.value;

      if (state.status === 'deleted') return replayOk(snapshotOf(state));
      if (!canTransition(state.status, 'deleted')) {
        return replayRefused(
          'lifecycle-transition-refused',
          `a replay in status ${state.status} cannot be deleted`,
        );
      }
      return this.letGo(runId, state, generation, 'deleted');
    });
  }

  async describe(runId: string): Promise<ReplayRecord | null> {
    const held = this.runs.get(runId);
    return held === undefined ? null : snapshotOf(held.state);
  }

  /* --------------------------------------------- the caretaker's own view */

  /**
   * Runs whose retention and grace have both elapsed.
   *
   * READ FROM THE ARCHIVE'S OWN STATE, which is the point: a catalogue outage
   * must never keep expired media alive. Bounded, and it never materialises a
   * record -- the worker re-reads each candidate authoritatively before acting.
   */
  async dueForExpiry(query: ReplayLifecycleQuery): Promise<readonly ReplayLifecycleCandidate[]> {
    const due: ReplayLifecycleCandidate[] = [];
    for (const held of this.runs.values()) {
      if (due.length >= query.limit) break;
      const state = held.state;
      if (state.status !== 'available' && state.status !== 'failed') continue;
      if (state.retention.policy !== 'expire') continue;
      if (!readyToRelease(state.retention, query.nowMs, query.graceMs)) continue;
      due.push({
        runId: state.identity.runId,
        status: state.status,
        retention: state.retention,
        expiresAtMs: state.retention.expiresAtMs,
      });
    }
    return due;
  }

  /* ------------------------------------------------------------ internals */

  private withRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private refusalIfDamaged(runId: string): ReplayFailure | null {
    const damaged = this.damaged.get(replayRunPrefix(runId));
    if (damaged === undefined) return null;
    return {
      reason: 'archive-unavailable',
      detail: `the durable state for run ${runId} could not be trusted: ${damaged.reason}`,
      liveImpact: 'none',
    };
  }

  private recording(runId: string): ReplayOutcome<HeldRun> {
    const damaged = this.refusalIfDamaged(runId);
    if (damaged !== null) return { ok: false, failure: damaged };
    if (this.declined.has(runId)) {
      return replayRefused('policy-forbids-replay', `run ${runId} is configured to keep no replay`);
    }
    const held = this.runs.get(runId);
    if (held === undefined) {
      return replayRefused('unknown-replay', `no replay was begun for run ${runId}`);
    }
    return replayOk(held);
  }

  /**
   * Take ownership of some bytes, or say why not.
   *
   * UPLOAD, THEN MEASURE WHAT LANDED. The producer's metadata is authoritative
   * for what a fragment IS, so an object of a different length is not a smaller
   * segment -- it is a truncated write, a source still being written, or a
   * different file altogether. A store that accepted a short body would
   * otherwise make the archive's own byte totals a fiction, and the mismatch
   * would surface as a decode error in somebody's player months later.
   *
   * The verification is a HEAD rather than the PUT's own answer, because the
   * question is what the STORE now holds, not what this process believes it
   * sent.
   */
  private async own(
    key: string,
    sourceReference: string,
    declaredBytes: number,
  ): Promise<ReplayOutcome<string>> {
    let body: Readable;
    try {
      body = await this.source.open(sourceReference);
    } catch (error) {
      return replayRefused(
        'source-media-unavailable',
        `programme media could not be opened for retention: ${describeStoreError(error)}`,
      );
    }

    let uploaded: Buffer;
    try {
      uploaded = await drain(body, declaredBytes);
    } catch (error) {
      return replayRefused(
        'source-media-unavailable',
        `programme media could not be read for retention: ${describeStoreError(error)}`,
      );
    }

    if (uploaded.length !== declaredBytes) {
      return replayRefused(
        'source-media-unavailable',
        `programme media declared ${declaredBytes} bytes and yielded ${uploaded.length}`,
      );
    }

    try {
      await this.store.put(key, uploaded, { contentType: 'application/octet-stream' });
    } catch (error) {
      return replayRefused(
        'archive-unavailable',
        `the replay archive could not store this object: ${describeStoreError(error)}`,
      );
    }

    let head;
    try {
      head = await this.store.head(key);
    } catch (error) {
      return replayRefused(
        'archive-unavailable',
        `the replay archive could not verify this object: ${describeStoreError(error)}`,
      );
    }
    if (head === null) {
      return replayRefused(
        'archive-unavailable',
        'the replay archive stored an object that is not there afterwards',
      );
    }
    if (head.sizeBytes !== declaredBytes) {
      return replayRefused(
        'archive-unavailable',
        `the replay archive holds ${head.sizeBytes} bytes where ${declaredBytes} were retained`,
      );
    }
    // THE KEY IS THE REFERENCE. No endpoint, no bucket, no credential.
    return replayOk(key);
  }

  /**
   * Write the next state generation, refusing if somebody else already did.
   *
   * TWO GUARDS, AND THE SECOND IS NOT REDUNDANT. The conditional create is the
   * mechanism; the read-back is what makes it trustworthy on a store that
   * quietly ignores the condition, where a refused write would otherwise become
   * a lost update -- one process's view of a recording silently replacing
   * another's. The token is unique to this attempt, so "did my write win" has
   * an unambiguous answer.
   */
  private async persist(
    runId: string,
    state: RecordingState,
    expectedGeneration: number,
  ): Promise<ReplayOutcome<number>> {
    const generation = expectedGeneration + 1;
    const writerToken = randomUUID();
    const key = replayStateGenerationKey(runId, generation);
    const body = Buffer.from(
      `${JSON.stringify(persistedOf(state, generation, writerToken), null, 2)}\n`,
      'utf8',
    );

    /*
     * ASKED FIRST, BECAUSE A READ-BACK CANNOT CATCH A CLOBBER.
     *
     * The read-back below proves "my write landed". It cannot prove "I did not
     * overwrite somebody" -- a store that ignored the conditional would let a
     * stale writer replace the winner's document and then read its own token
     * back perfectly happily. So the key is checked for existence before the
     * write is attempted at all.
     *
     * AND THIS IS A CHECK, NOT A LOCK. Between the head and the put there is a
     * window, and on a store that honours `If-None-Match` the conditional
     * closes it. On a store that does not, two writers landing inside that same
     * window is not distinguishable by any means available here -- that is an
     * inherent limit of a store without conditional writes, stated plainly
     * rather than papered over. The realistic race, two processes seconds
     * apart, is caught.
     */
    try {
      if ((await this.store.head(key)) !== null) return this.staleWriter(runId, generation);
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: 'archive-unavailable',
          detail: `the replay archive could not check for a competing writer: ${describeStoreError(error)}`,
          liveImpact: 'none',
        },
      };
    }

    try {
      await this.store.put(key, body, { ifAbsent: true, contentType: 'application/json' });
    } catch (error) {
      if (error instanceof ObjectStoreError && error.kind === 'precondition') {
        return this.staleWriter(runId, generation);
      }
      return {
        ok: false,
        failure: {
          reason: 'archive-unavailable',
          detail: `the replay archive could not record the state of this run: ${describeStoreError(error)}`,
          liveImpact: 'none',
        },
      };
    }

    /*
     * READ BACK. If the store honoured the condition this confirms it cheaply;
     * if it did not, this is the only thing standing between two concurrent
     * writers and a lost update.
     */
    let landed;
    try {
      landed = await this.store.get(key);
    } catch (error) {
      return {
        ok: false,
        failure: {
          reason: 'archive-unavailable',
          detail: `the replay archive could not confirm the state it wrote: ${describeStoreError(error)}`,
          liveImpact: 'none',
        },
      };
    }
    const seen = stateFrom(JSON.parse(await text(landed.body)) as unknown);
    if (typeof seen === 'string' || seen.writerToken !== writerToken) {
      return this.staleWriter(runId, generation);
    }

    this.runs.set(runId, { state, generation });
    // Older generations are history nothing reads. Removed after the new one
    // is durable, so a crash here leaves clutter rather than a missing state.
    void this.pruneStates(runId, generation);
    return replayOk(generation);
  }

  private staleWriter(runId: string, generation: number): ReplayOutcome<number> {
    return {
      ok: false,
      failure: {
        reason: 'archive-unavailable',
        detail:
          `another writer already recorded generation ${generation} for run ${runId}; ` +
          'this process is working from a stale view and its write was refused',
        liveImpact: 'none',
      },
    };
  }

  private async pruneStates(runId: string, keep: number): Promise<void> {
    try {
      for (const found of await this.store.list(replayStatePrefix(runId), 200)) {
        const generation = replayStateGenerationOf(found.key);
        if (generation !== null && generation < keep) await this.store.delete(found.key);
      }
    } catch {
      // Old generations are inert. The next prune tries again.
    }
  }

  /**
   * Let a recording go: state first, then the bytes.
   *
   * THE ORDER IS THE WHOLE PROTECTION. Once the state says `expired` the media
   * is gone as far as anything can see, so a crash during removal leaves
   * objects nothing references -- swept later. The other order would leave a
   * window in which the state still says `available` and the bytes are already
   * gone, which is a replay that renders a playlist onto nothing.
   */
  private async letGo(
    runId: string,
    state: RecordingState,
    generation: number,
    to: 'expired' | 'deleted',
  ): Promise<ReplayOutcome<ReplayRecord>> {
    const next = cloneState(state);
    releaseMedia(next);
    move(next, to, this.now());
    const written = await this.persist(runId, next, generation);
    if (!written.ok) return { ok: false, failure: written.failure };
    await this.sweep(runId, next);
    return replayOk(snapshotOf(next));
  }

  /**
   * The first retained object this state names that is not really there, or is
   * not the object it is supposed to be.
   *
   * TWO QUESTIONS, AS ON A FILESYSTEM. Existence and size is not enough: every
   * other object of this run is also an object of some length under this run's
   * prefix, so a reference edited to name a NEIGHBOUR passes that check
   * completely and serves the wrong material. Each reference must also BE the
   * canonical key for the logical object it belongs to, derived here from ids
   * rather than read from the metadata under suspicion.
   */
  private async missingObject(state: RecordingState): Promise<string | null> {
    const runId = state.identity.runId;
    for (const entry of state.initialisations) {
      const canonical = replayInitialisationKey(runId, entry.offered.generation);
      if (entry.archiveReference !== canonical) {
        return `initialisation generation ${entry.offered.generation}: its reference is not the canonical archive object for it`;
      }
      const complaint = await this.verify(canonical, entry.offered.bytes);
      if (complaint !== null) return `initialisation generation ${entry.offered.generation}: ${complaint}`;
    }
    for (const entry of state.segments) {
      const canonical = replaySegmentKey(runId, entry.offered.segmentId);
      if (entry.archiveReference !== canonical) {
        return `segment ${entry.offered.segmentId}: its reference is not the canonical archive object for it`;
      }
      const complaint = await this.verify(canonical, entry.offered.bytes);
      if (complaint !== null) return `segment ${entry.offered.segmentId}: ${complaint}`;
    }
    return null;
  }

  private async verify(key: string, expectedBytes: number): Promise<string | null> {
    try {
      const head = await this.store.head(key);
      if (head === null) return 'the archive object is not there';
      if (head.sizeBytes !== expectedBytes) {
        return `the archive object holds ${head.sizeBytes} bytes where ${expectedBytes} were recorded`;
      }
      return null;
    } catch (error) {
      return `the archive object could not be read: ${describeStoreError(error)}`;
    }
  }

  /* ------------------------------------------------------------- recovery */

  private async rememberDeclined(runId: string): Promise<ReplayFailure | null> {
    try {
      await this.store.put(
        replayDeclinedKey(runId),
        Buffer.from(
          `${JSON.stringify({ schemaVersion: REPLAY_OBJECT_SCHEMA_VERSION, runId }, null, 2)}\n`,
          'utf8',
        ),
        { contentType: 'application/json' },
      );
      return null;
    } catch (error) {
      return {
        reason: 'archive-unavailable',
        detail: `the replay archive could not record that run ${runId} keeps no replay: ${describeStoreError(error)}`,
        liveImpact: 'none',
      };
    }
  }

  private async loadDeclined(): Promise<void> {
    let listed;
    try {
      listed = await this.store.list(`${REPLAY_DECLINED_PREFIX}/`, 10_000);
    } catch {
      return;
    }
    for (const found of listed) {
      try {
        const body = await this.store.get(found.key);
        const raw: unknown = JSON.parse(await text(body.body));
        const runId = (raw as { runId?: unknown }).runId;
        if (typeof runId === 'string') this.declined.add(runId);
      } catch {
        // A marker that will not parse is not a reason to record a broadcast
        // nobody asked for. Left alone and not applied.
      }
    }
  }

  private async loadRuns(maxRuns: number): Promise<void> {
    let listed;
    try {
      listed = await this.store.list(`${REPLAY_RUNS_PREFIX}/`, maxRuns * 64);
    } catch (error) {
      throw new ObjectStoreError(
        `the replay archive could not be listed: ${describeStoreError(error)}`,
        'unavailable',
      );
    }

    /*
     * THE HIGHEST GENERATION IS THE TRUTH. Everything else under `state/` is a
     * superseded document that a prune has not reached yet, and reading one of
     * those would restore a recording to a moment it has already moved past.
     */
    const newest = new Map<string, { key: string; generation: number }>();
    const objects = new Map<string, Set<string>>();
    for (const found of listed) {
      const prefix = found.key.split('/').slice(0, 2).join('/');
      const generation = replayStateGenerationOf(found.key);
      if (generation !== null) {
        const held = newest.get(prefix);
        if (held === undefined || generation > held.generation) {
          newest.set(prefix, { key: found.key, generation });
        }
        continue;
      }
      const bucket = objects.get(prefix) ?? new Set<string>();
      bucket.add(found.key);
      objects.set(prefix, bucket);
    }

    for (const [prefix, current] of newest) {
      let raw: unknown;
      try {
        const body = await this.store.get(current.key);
        raw = JSON.parse(await text(body.body));
      } catch (error) {
        this.damaged.set(prefix, {
          runPrefix: prefix,
          runId: null,
          reason: `state could not be read: ${describeStoreError(error)}`,
        });
        continue;
      }

      const loaded = stateFrom(raw);
      if (typeof loaded === 'string') {
        this.damaged.set(prefix, { runPrefix: prefix, runId: runIdIn(raw), reason: loaded });
        continue;
      }

      /*
       * THE DOCUMENT MUST AGREE WITH WHERE IT IS KEPT. The prefix is derived
       * from the run it holds; a document claiming a different run is a restore
       * into the wrong place or an edit, and the identity inside it is what
       * every later authorisation keys on.
       */
      const runId = loaded.state.identity.runId;
      if (replayRunPrefix(runId) !== prefix) {
        this.damaged.set(prefix, {
          runPrefix: prefix,
          runId,
          reason: 'the durable state claims a different run from the prefix holding it',
        });
        continue;
      }

      const missing = await this.missingObject(loaded.state);
      if (missing !== null) {
        this.damaged.set(prefix, {
          runPrefix: prefix,
          runId,
          reason: `durable state references media that is not intact: ${missing}`,
        });
        continue;
      }

      this.runs.set(runId, { state: loaded.state, generation: current.generation });
      await this.sweep(runId, loaded.state, objects.get(prefix));
      await this.pruneStates(runId, current.generation);
    }
  }

  /**
   * Remove what nothing references.
   *
   * A published object the state does not name is either a retention that died
   * before its metadata or a release that died after it -- and in both cases
   * the state is the authority, so the object goes. This is what makes the
   * crash ordering safe rather than merely survivable: orphans are cleaned, and
   * nothing is ever resurrected.
   *
   * ONLY EVER FOR A RUN WHOSE STATE LOADED. Sweeping against metadata that
   * could not be trusted would turn a diagnosable problem into destroyed media.
   */
  private async sweep(
    runId: string,
    state: RecordingState,
    known?: ReadonlySet<string>,
  ): Promise<void> {
    const referenced = new Set([
      ...state.segments.map((entry) => entry.archiveReference),
      ...state.initialisations.map((entry) => entry.archiveReference),
    ]);

    let candidates: readonly string[];
    if (known !== undefined) {
      candidates = [...known];
    } else {
      try {
        candidates = [
          ...(await this.store.list(replayMediaPrefix(runId), 10_000)),
          ...(await this.store.list(replayInitialisationPrefix(runId), 1_000)),
        ].map((found) => found.key);
      } catch {
        return;
      }
    }

    for (const key of candidates) {
      if (replayStateGenerationOf(key) !== null) continue;
      if (referenced.has(key)) continue;
      try {
        await this.store.delete(key);
      } catch {
        // Nothing references it; the next sweep tries again.
      }
    }
  }
}

/* ------------------------------------------------------------- plumbing */

/**
 * Read a stream, refusing to grow past what was declared.
 *
 * BOUNDED, BECAUSE A SOURCE IS NOT TRUSTED TO STOP. A spool file being written
 * while it is read, or a reference that resolves to something enormous, would
 * otherwise be buffered until the process died. One byte past the declaration
 * is enough to know the answer will be refused anyway.
 */
async function drain(stream: Readable, declaredBytes: number): Promise<Buffer> {
  const limit = declaredBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
    chunks.push(buffer);
    total += buffer.length;
    if (total > limit) break;
  }
  return Buffer.concat(chunks, Math.min(total, limit));
}

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function runIdIn(raw: unknown): string | null {
  const identity = (raw as { identity?: { runId?: unknown } } | null)?.identity;
  return typeof identity?.runId === 'string' ? identity.runId : null;
}

export { isReplayObjectKey, READ_CHUNK_BYTES };
