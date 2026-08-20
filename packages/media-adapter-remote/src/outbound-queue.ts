/** @author masterzee001 */
/**
 * The bounded outbound queue, and the only place a wire sequence is allocated.
 *
 * Two jobs, and the second is the reason they are the same object.
 *
 * BOUNDED. An unbounded send queue does not fail: it succeeds slowly, and then
 * the adapter is an accidental RAM benchmark whenever the gateway is slow. P6.8
 * shipped exactly that defect in its own delivery chain — ~50 tasks appended a
 * second while one completed — and the ledger balanced perfectly the whole time
 * the process was running out of memory. Bounded by bytes, by frames, and by
 * age, because a queue can become useless in three different ways.
 *
 * SEQUENCE ALLOCATION HAPPENS HERE, at dequeue. `wireSequence` numbers what
 * went onto the wire, not every frame the adapter once contemplated sending.
 * Allocating it on enqueue would mean every local eviction manufactured a gap
 * the network never caused, and the gateway would dutifully report missing
 * ranges for frames that were never sent — a whole class of false diagnostics
 * avoided by one ordering decision.
 */

export interface QueuedFrame {
  readonly streamId: number;
  readonly samples: Int16Array;
  readonly platformTimestampMs: number;
  /** Wall clock at enqueue, for the age bound. */
  readonly enqueuedAtMs: number;
  /** Set when a gap precedes this frame — see `OutboundQueue.take`. */
  discontinuity: boolean;
}

/** A frame committed to transmission, with its sequence finally assigned. */
export interface CommittedFrame extends QueuedFrame {
  readonly wireSequence: number;
}

export interface OutboundQueueLimits {
  readonly maxBytes: number;
  readonly maxFrames: number;
  readonly maxAgeMs: number;
}

export interface OutboundQueueDeps {
  readonly limits: OutboundQueueLimits;
  readonly now: () => number;
  /**
   * Called for every frame the queue itself discards, so the caller can count
   * it against the one category that describes it: our queue, our choice.
   */
  readonly onEvicted: (frame: QueuedFrame, reason: 'capacity' | 'stale') => void;
}

/**
 * One queue per stream. Per-stream rather than per-connection because eviction
 * is a decision about ONE conversation: a busy call must not push another
 * call's speech out, and a wire sequence is per-stream by definition.
 */
export class OutboundQueue {
  private readonly frames: QueuedFrame[] = [];
  private queuedBytes = 0;
  private nextSequence = 0;
  /**
   * Whether the next frame taken must be marked discontinuous.
   *
   * Set when anything at all breaks the run — eviction, a stale drop, a
   * reconnect. The flag rides forward until a frame actually leaves, because
   * the gateway needs to know the stream is not continuous with what it last
   * received, and the frame that carries that news is whichever one goes next.
   */
  private pendingDiscontinuity = false;

  constructor(private readonly deps: OutboundQueueDeps) {}

  get depth(): number {
    return this.frames.length;
  }

  get bytes(): number {
    return this.queuedBytes;
  }

  /** Frames still held, for the ledger's "not yet disposed of" bucket. */
  get pending(): number {
    return this.frames.length;
  }

  /**
   * Take custody of a frame, evicting older ones if it does not fit.
   *
   * Returns the frames evicted to make room, so the caller counts them rather
   * than discovering later that its totals disagree.
   */
  offer(frame: Omit<QueuedFrame, 'discontinuity'>): void {
    this.frames.push({ ...frame, discontinuity: false });
    this.queuedBytes += frame.samples.byteLength;
    this.enforceBounds();
  }

  /** Drop frames older than the age bound. Stale speech is worth less than none. */
  expire(): void {
    const deadline = this.deps.now() - this.deps.limits.maxAgeMs;
    while (this.frames.length > 0 && this.frames[0]!.enqueuedAtMs < deadline) {
      this.discard(this.frames.shift()!, 'stale');
    }
  }

  /**
   * Commit the next frame to transmission and assign its sequence.
   *
   * This is the moment a frame becomes part of the wire's numbering. Nothing
   * before this point has a sequence, so nothing discarded before it can leave
   * a hole in one.
   */
  take(): CommittedFrame | null {
    this.expire();
    const frame = this.frames.shift();
    if (frame === undefined) return null;
    this.queuedBytes -= frame.samples.byteLength;
    const discontinuity = frame.discontinuity || this.pendingDiscontinuity;
    this.pendingDiscontinuity = false;
    const wireSequence = this.nextSequence;
    // Unsigned 32-bit, wrapping. At fifty frames a second a wrap is 2.7 years
    // away, but "unreachable" is not a specification.
    this.nextSequence = (this.nextSequence + 1) >>> 0;
    return { ...frame, discontinuity, wireSequence };
  }

  /**
   * Mark the stream discontinuous from here. Used on reconnect and whenever
   * the caller knows the run is broken for a reason the queue cannot see.
   */
  markDiscontinuity(): void {
    this.pendingDiscontinuity = true;
  }

  /**
   * Start a new stream: a reconnect gets a NEW streamId and therefore a fresh
   * numbering. Restarting the sequence is not cosmetic — the gateway's new
   * stream has never seen a frame, so beginning anywhere else would look like
   * a gap of whatever the old count happened to be.
   */
  resetForNewStream(): void {
    this.nextSequence = 0;
    this.pendingDiscontinuity = true;
  }

  /** Give up everything held, counting each frame. Used when a stream dies. */
  drain(reason: 'capacity' | 'stale' = 'capacity'): void {
    while (this.frames.length > 0) this.discard(this.frames.shift()!, reason);
  }

  private enforceBounds(): void {
    const { maxBytes, maxFrames } = this.deps.limits;
    while (
      this.frames.length > 0 &&
      (this.frames.length > maxFrames || this.queuedBytes > maxBytes)
    ) {
      // OLDEST first. On a live conversation the newest speech is what the
      // other person is waiting to hear; a stale backlog is worth less than
      // the sentence just spoken. Same policy the chunker already applies
      // downstream, for the same reason.
      this.discard(this.frames.shift()!, 'capacity');
    }
  }

  private discard(frame: QueuedFrame, reason: 'capacity' | 'stale'): void {
    this.queuedBytes -= frame.samples.byteLength;
    // Whatever leaves this way breaks the run, so the next frame that does go
    // carries the news.
    this.pendingDiscontinuity = true;
    this.deps.onEvicted(frame, reason);
  }
}
