/** @author masterzee001 */
/**
 * One timeline and one output buffer per broadcast, held by run.
 *
 * The same partition rule as the performance registry, for the same reason: a
 * channel can air the same programme twice, and the second airing's timeline
 * is not a continuation of the first. Keying on the programme would splice two
 * broadcasts together; keying on the transport session would start a new
 * broadcast every time a stream reconnected.
 *
 * A RECONNECT MUST NOT BEGIN A SECOND BROADCAST. `open` returns the existing
 * timeline when one is already held for that run, so a dropped stream that
 * comes back keeps writing to the account it was already writing to, and the
 * audience's cursor does not reset to the beginning of a broadcast they are
 * already halfway through.
 */

import {
  METADATA_PLANE_ONLY,
  ProgrammeOutputBuffer,
  ProgrammeTimeline,
  type BufferPolicy,
  type BufferStatus,
  type GovernedPlanes,
} from '@videofy-live/programme-timeline';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import type { ProgrammeTimelineStore } from '@videofy-live/programme-timeline';

/** How many concurrent broadcasts this process holds an account for. */
export const MAX_TRACKED_TIMELINES = 32;

/**
 * The vocabulary a recogniser session pinned, and how sure we are of it.
 *
 * `unavailable` is not `none`: one means the authority could not be reached,
 * the other that this programme has no terms. They produce identical
 * recognition and mean opposite things.
 */
export interface RunVocabulary {
  readonly state: 'active' | 'none' | 'unavailable';
  readonly revision: number | null;
  readonly termCount: number | null;
}

interface TrackedRun {
  readonly identity: ProgrammeRunIdentity;
  readonly timeline: ProgrammeTimeline;
  readonly buffer: ProgrammeOutputBuffer;
}

export class ProgrammeTimelineRegistry {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly vocabularies = new Map<string, RunVocabulary>();

  constructor(
    private readonly maxRuns: number = MAX_TRACKED_TIMELINES,
    private readonly defaultDelayMs = 0,
    private readonly policy?: BufferPolicy,
    /**
     * Where broadcasts survive this process. Absent means they do not, and a
     * programme that promised a safety delay cannot keep that promise across a
     * restart -- which `durable()` reports so nobody has to guess.
     */
    private readonly store?: ProgrammeTimelineStore,
    /**
     * Which delivery planes this deployment actually holds to the cursor.
     *
     * Metadata only, today: original media is forwarded live from the
     * broadcaster's tracks to each listener and there is nowhere to hold it.
     * A protective delay is therefore refused rather than half applied, and
     * this is the parameter a deployment changes when that stops being true.
     */
    private readonly planes: GovernedPlanes = METADATA_PLANE_ONLY,
  ) {}

  /**
   * Can a safety promise made now outlive this process?
   *
   * Asked BEFORE going on air. An unwritable spool discovered during a
   * broadcast is a broadcast that has already promised something it cannot
   * deliver.
   */
  async durable(): Promise<{ readonly durable: boolean; readonly reason: string | null }> {
    if (this.store === undefined) {
      return { durable: false, reason: 'no durable timeline store is configured' };
    }
    const health = await this.store.health();
    return { durable: health.writable, reason: health.reason };
  }

  /**
   * Bring a broadcast back after the process that was running it went away.
   *
   * Replay, not reconstruction: what was written is read back in order and the
   * cursor is put where it was, so an audience forty seconds into a protected
   * programme is still forty seconds into it. A run with nothing stored
   * returns false, and the caller starts a new broadcast rather than pretending
   * to continue one it cannot account for.
   */
  async recover(identity: ProgrammeRunIdentity): Promise<boolean> {
    if (this.store === undefined) return false;
    const persisted = await this.store.load(identity.runId);
    if (persisted === null || persisted.events.length === 0) return false;

    const timeline = new ProgrammeTimeline(identity);
    for (const event of persisted.events) {
      timeline.append({
        programmeTimeMs: event.programmeTimeMs,
        kind: event.kind,
        reference: event.reference,
        durationMs: event.durationMs,
        attributes: event.attributes,
      });
    }
    const buffer = new ProgrammeOutputBuffer(
      timeline,
      this.defaultDelayMs,
      this.policy,
      this.planes,
    );
    buffer.restoreReleasedThrough(persisted.releasedThroughMs);
    this.runs.set(identity.runId, { identity, timeline, buffer });
    this.evictOldest();
    return true;
  }

  /**
   * The timeline for this run, resumed if it already exists.
   *
   * Resumed rather than replaced: the identity is what says whether this is
   * the same broadcast, and a stream that dropped and returned is the same
   * broadcast by definition.
   */
  open(identity: ProgrammeRunIdentity): ProgrammeTimeline {
    const existing = this.runs.get(identity.runId);
    if (existing !== undefined) return existing.timeline;

    /*
     * PERSISTED AS IT IS WRITTEN, or the journal recovery reads is empty.
     *
     * A store that is only consulted on restart is not a store; it is a file
     * nobody wrote to. The sink is fire-and-forget because a live broadcast
     * cannot wait on a disk -- and when a write fails, the buffer fails
     * CLOSED, because a safety delay whose record is not being kept is a
     * delay that will not survive the next restart, and the audience was
     * promised one that would.
     */
    const tracked: { buffer: ProgrammeOutputBuffer | null } = { buffer: null };
    const store = this.store;
    const timeline = new ProgrammeTimeline(
      identity,
      store === undefined
        ? undefined
        : (event) => {
            void store.append(event).then((stored) => {
              if (!stored) tracked.buffer?.fail('the programme timeline could not be persisted');
            });
          },
    );
    const buffer = new ProgrammeOutputBuffer(
      timeline,
      this.defaultDelayMs,
      this.policy,
      this.planes,
    );
    tracked.buffer = buffer;
    this.runs.set(identity.runId, { identity, timeline, buffer });
    this.evictOldest();
    return timeline;
  }

  /**
   * What vocabulary a run's recogniser is actually running on.
   *
   * Recorded when the session pinned it, so a console can report the version
   * IN USE rather than the version most recently saved. Those differ the
   * moment an operator edits mid-programme, and saying otherwise would show a
   * revision number nothing was using.
   */
  noteVocabulary(runId: string, vocabulary: RunVocabulary): void {
    const run = this.runs.get(runId);
    if (run !== undefined) this.vocabularies.set(runId, vocabulary);
  }

  vocabulary(runId: string): RunVocabulary | null {
    return this.vocabularies.get(runId) ?? null;
  }

  timeline(runId: string): ProgrammeTimeline | null {
    return this.runs.get(runId)?.timeline ?? null;
  }

  buffer(runId: string): ProgrammeOutputBuffer | null {
    return this.runs.get(runId)?.buffer ?? null;
  }

  /**
   * What the buffer for this run is doing, or null when nothing is tracked.
   *
   * Null rather than an idle-looking status: a console must be able to tell
   * "this process is not running that broadcast" from "that broadcast is
   * holding no delay", which look identical if both answer with zeroes.
   */
  status(runId: string): BufferStatus | null {
    return this.runs.get(runId)?.buffer.status() ?? null;
  }

  tracks(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * The channel a run belongs to, or null when this process is not running it.
   *
   * Needed by anything that must ask a question about the CHANNEL -- who may
   * watch, most of all -- from a request that only ever names the run. Null is
   * the same answer as "no such broadcast", which is what keeps an access
   * decision from having to distinguish the two.
   */
  channelOf(runId: string): string | null {
    return this.runs.get(runId)?.identity.channelId ?? null;
  }

  /** The broadcast is over. Its account and its cursor go with it. */
  release(runId: string): void {
    this.runs.delete(runId);
    this.vocabularies.delete(runId);
    // The journal is settled and removed after; a delete that raced its own
    // writes would leave a broadcast half-remembered.
    void this.store?.release(runId);
  }

  private evictOldest(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next();
      if (oldest.done === true) return;
      this.runs.delete(oldest.value);
    }
  }
}
