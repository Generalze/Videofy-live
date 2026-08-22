/** @author masterzee001 */
/**
 * Ordered, bounded, cancellable delivery of translated audio.
 *
 * THE ASYMMETRY THIS EXISTS FOR: spoken audio is irreversible. A caption can be
 * replaced silently when a transcript revises; a sentence a listener has
 * already heard cannot be unheard. So the platform gets exactly one useful
 * lever -- discard what has NOT yet been delivered -- and it has to use it
 * correctly and account for the rest honestly.
 *
 *     Caller: "I want Tuesday..."      -> synthesis begins, frames start moving
 *     Caller: "...sorry, Wednesday."   -> the segment is superseded
 *
 * Frames already delivered are gone. Frames still queued can be dropped, and
 * dropping them is the difference between a listener hearing "Tuesday Wednesday"
 * and hearing "Wednesday".
 *
 * CALL AND PROGRAMME DIFFER, and the difference is policy rather than
 * mechanism. A conversation wants the stale words gone even mid-utterance; a
 * one-way programme prefers a clean sentence boundary over a truncation the
 * audience cannot ask about. Both use this queue.
 */
import {
  framesToMs,
  generationKey,
  type TranslatedAudioAccounting,
  type TranslatedAudioFrame,
} from './translated-audio.js';

/**
 * How aggressively a service abandons audio it has not yet delivered.
 *
 * `immediate`      drop everything queued the moment a segment is superseded.
 *                  Calls: the listener is mid-conversation and stale words are
 *                  actively confusing.
 * `after-current`  deliver the frame in hand, then stop. Programmes: a clean
 *                  cut at a frame boundary rather than a mid-word truncation an
 *                  audience has no way to query.
 */
export type CancellationPolicy = 'immediate' | 'after-current';

export function cancellationPolicyForService(
  serviceCategory: 'call' | 'programme',
): CancellationPolicy {
  return serviceCategory === 'call' ? 'immediate' : 'after-current';
}

export interface TranslatedAudioDeliveryDeps {
  /**
   * Hand one frame onward. Returning false means the sink is full, which is
   * backpressure rather than an error.
   */
  readonly deliver: (frame: TranslatedAudioFrame) => boolean;
  readonly cancellationPolicy: CancellationPolicy;
  /** Bounded queue. Beyond this, the OLDEST undelivered audio is dropped. */
  readonly maxQueuedFrames?: number;
  readonly onAccounting?: (record: TranslatedAudioAccounting) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

interface SegmentState {
  generation: number;
  /** Highest sequence handed to the sink; ordering is checked against it. */
  lastDelivered: number;
  cancelled: boolean;
  deliveredSamples: number;
  seen: Set<number>;
  /**
   * Sequences the platform DELIBERATELY threw away (overflow), as opposed to
   * sequences that simply have not arrived yet. Ordering must be able to tell
   * those apart -- see `pump`.
   */
  abandoned: Set<number>;
}

export class TranslatedAudioDelivery {
  private readonly segments = new Map<string, SegmentState>();
  private readonly queue: TranslatedAudioFrame[] = [];
  private readonly maxQueued: number;
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;
  readonly accounting: TranslatedAudioAccounting[] = [];

  constructor(private readonly deps: TranslatedAudioDeliveryDeps) {
    this.maxQueued = deps.maxQueuedFrames ?? 64;
    this.log = deps.log ?? (() => {});
  }

  get queuedFrames(): number {
    return this.queue.length;
  }

  /** Milliseconds of audio a listener has actually heard for this segment. */
  deliveredMsFor(segmentId: string): number {
    return framesToMs(this.segments.get(segmentId)?.deliveredSamples ?? 0);
  }

  /**
   * A new synthesis attempt for a segment.
   *
   * Bumping the generation is what makes the previous attempt's in-flight
   * frames identifiable as stale. Without it, a failover would interleave two
   * renderings of the same sentence.
   */
  beginGeneration(segmentId: string, generation: number): void {
    const existing = this.segments.get(segmentId);
    if (existing !== undefined && generation <= existing.generation) {
      // Never move backwards. A late "retry" claiming an older generation would
      // otherwise reopen a segment the platform had already moved past.
      this.log('ignored non-advancing generation', { segmentId, generation });
      return;
    }
    if (existing !== undefined) {
      this.dropQueued(segmentId, 'discarded-superseded', existing.generation);
    }
    this.segments.set(segmentId, {
      generation,
      lastDelivered: -1,
      cancelled: false,
      deliveredSamples: existing?.deliveredSamples ?? 0,
      seen: new Set(),
      abandoned: new Set(),
    });
  }

  /** Offer one frame. Every frame ends in exactly one accounted disposition. */
  offer(frame: TranslatedAudioFrame): void {
    const state = this.segments.get(frame.segmentId);
    if (state === undefined) {
      // Audio for a segment nobody opened. It cannot create one: that would let
      // a provider's output invent platform state.
      this.account('discarded-stale-generation', frame);
      return;
    }
    if (frame.generation < state.generation) {
      // A slow earlier attempt catching up after a newer one started.
      this.account('discarded-stale-generation', frame);
      return;
    }
    if (state.cancelled) {
      this.account('discarded-cancelled', frame);
      return;
    }
    const key = `${generationKey(frame.segmentId, frame.generation)}:${frame.sequence}`;
    if (state.seen.has(frame.sequence)) {
      // A retransmitted frame would otherwise be spoken twice.
      this.account('discarded-duplicate', frame);
      return;
    }
    state.seen.add(frame.sequence);
    void key;

    this.queue.push(frame);
    if (this.queue.length > this.maxQueued) {
      // Bounded. Dropping the OLDEST undelivered frame is the right end for
      // live speech: the newest audio is the part still worth hearing, and an
      // unbounded queue would grow into latency nobody can recover from.
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        // Record the gap. A dropped frame is audio the platform chose to
        // abandon, which is a different thing from a frame still in flight, and
        // ordering has to know the difference or it waits forever.
        this.segments.get(dropped.segmentId)?.abandoned.add(dropped.sequence);
        this.account('discarded-overflow', dropped);
      }
    }
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      const state = this.segments.get(next.segmentId);
      if (state === undefined || next.generation < state.generation || state.cancelled) {
        this.queue.shift();
        this.account(state?.cancelled === true ? 'discarded-cancelled' : 'discarded-stale-generation', next);
        continue;
      }
      // Step over sequences that were deliberately abandoned. Without this the
      // queue bound is a trap: overflow drops sequence N, ordering waits for N
      // forever, and a bound meant to cost a little audio costs every frame
      // that comes after it instead. Waiting is only correct for audio that
      // might still arrive.
      while (state.abandoned.has(state.lastDelivered + 1)) {
        state.abandoned.delete(state.lastDelivered + 1);
        state.lastDelivered += 1;
      }
      // Ordering is enforced HERE rather than trusted from arrival: a frame
      // that would jump ahead of a gap waits for the missing one.
      if (next.sequence !== state.lastDelivered + 1) {
        const waiting = this.queue.find((frame) => frame.sequence === state.lastDelivered + 1);
        if (waiting === undefined) return;
        this.queue.splice(this.queue.indexOf(waiting), 1);
        this.queue.unshift(waiting);
        continue;
      }
      if (!this.deps.deliver(next)) return; // backpressure; try again later
      this.queue.shift();
      state.lastDelivered = next.sequence;
      state.deliveredSamples += next.samples.length;
      this.account('delivered', next);
    }
  }

  /** The sink has room again. */
  resume(): void {
    this.pump();
  }

  /**
   * Stop speaking this segment.
   *
   * Returns what was actually achieved, because the two numbers mean different
   * things: discarded audio is a success, and delivered audio is a fact that
   * has to be lived with. Reporting only "cancelled" would imply a control the
   * platform does not have over sound already in someone's ear.
   */
  cancel(segmentId: string, reason: string): { discardedFrames: number; deliveredMs: number } {
    const state = this.segments.get(segmentId);
    if (state === undefined) return { discardedFrames: 0, deliveredMs: 0 };
    state.cancelled = true;

    let keepOne: TranslatedAudioFrame | null = null;
    if (this.deps.cancellationPolicy === 'after-current') {
      // Finish the frame in hand so the cut lands on a frame boundary rather
      // than mid-word.
      const index = this.queue.findIndex(
        (frame) => frame.segmentId === segmentId && frame.sequence === state.lastDelivered + 1,
      );
      if (index >= 0) keepOne = this.queue.splice(index, 1)[0] ?? null;
    }

    const discarded = this.dropQueued(segmentId, 'discarded-cancelled', state.generation);

    if (keepOne !== null && this.deps.deliver(keepOne)) {
      state.lastDelivered = keepOne.sequence;
      state.deliveredSamples += keepOne.samples.length;
      this.account('delivered', keepOne);
    }

    this.log('translated audio cancelled', {
      segmentId,
      reason,
      discardedFrames: discarded,
      deliveredMs: framesToMs(state.deliveredSamples),
      policy: this.deps.cancellationPolicy,
    });
    return { discardedFrames: discarded, deliveredMs: framesToMs(state.deliveredSamples) };
  }

  private dropQueued(
    segmentId: string,
    disposition: TranslatedAudioAccounting['disposition'],
    generation: number,
  ): number {
    let dropped = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const frame = this.queue[index]!;
      if (frame.segmentId !== segmentId) continue;
      if (disposition === 'discarded-superseded' && frame.generation > generation) continue;
      this.queue.splice(index, 1);
      this.account(disposition, frame);
      dropped += 1;
    }
    return dropped;
  }

  private account(
    disposition: TranslatedAudioAccounting['disposition'],
    frame: TranslatedAudioFrame,
  ): void {
    const record: TranslatedAudioAccounting = {
      disposition,
      segmentId: frame.segmentId,
      generation: frame.generation,
      sequence: frame.sequence,
      samples: frame.samples.length,
    };
    this.accounting.push(record);
    this.deps.onAccounting?.(record);
  }
}
