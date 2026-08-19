/** @author masterzee001 */
/**
 * A bounded jitter buffer.
 *
 * Loss, reordering and duplication are ordinary network behaviour on a phone
 * call, not error conditions. The buffer's job is to make them *predictable*:
 * hold packets briefly so late-but-not-too-late ones can be put back in order,
 * emit a marker where audio genuinely went missing, and refuse to grow without
 * limit when the network stops cooperating.
 *
 * The eviction philosophy is deliberately the one the WebRTC bridge already
 * uses: bound by packets AND bytes, drop the OLDEST, and count what was
 * dropped. An unbounded queue does not fail — it succeeds slowly, then becomes
 * production architecture because nobody dares touch it.
 */
import { sequenceDelta, type RtpPacket } from './packet.js';

export interface JitterBufferOptions {
  /** How long a packet may wait for its predecessors. */
  targetDelayMs?: number;
  maxPackets?: number;
  maxBytes?: number;
  /** How far back a late packet is still worth taking. */
  reorderWindow?: number;
  /** Consecutive out-of-window packets before the stream is re-anchored. */
  resyncAfter?: number;
}

/**
 * What happened to every packet this buffer was given.
 *
 * `received`, `emitted` and `discarded` are not three interesting numbers —
 * they are an IDENTITY, checked by `accountingBalanced`:
 *
 *     received === emitted + discarded + depth
 *
 * Everything else here is commentary on WHY a packet was discarded. The
 * identity is what makes a buffer unable to destroy audio quietly, and it is
 * why the call above can start its own ledger at receipt rather than at
 * extraction.
 */
export interface JitterStats {
  /** Packets pushed in. */
  received: number;
  /** Packets handed out — drained, flushed, or returned at a stream reset. */
  emitted: number;
  duplicates: number;
  reordered: number;
  /**
   * Sequence gaps: packets that NEVER ARRIVED. Deliberately not the same
   * number as `discarded`. A bad network and a buffer throwing away audio it
   * was holding are different events with different owners, and folding them
   * together made the one figure an operator checks unable to tell which had
   * happened.
   */
  lost: number;
  /** Arrived so late that the timeline had already moved past them. */
  tooLate: number;
  evicted: number;
  /** Packets that DID arrive and were then thrown away by this buffer. */
  discarded: number;
  /** RFC 3550 interarrival jitter, in milliseconds. */
  jitterMs: number;
  maxDepth: number;
  /** Times the stream was re-anchored after the sender clearly moved. */
  resyncs: number;
}

export interface EmittedPacket {
  packet: RtpPacket;
  /** Sequence numbers missing immediately before this one. */
  lostBefore: number;
}

const DEFAULTS = {
  targetDelayMs: 60,
  maxPackets: 200,
  maxBytes: 512 * 1024,
  reorderWindow: 100,
  resyncAfter: 5,
};

export class JitterBuffer {
  private readonly options: Required<JitterBufferOptions>;
  private readonly queue = new Map<number, RtpPacket>();
  private queuedBytes = 0;
  /** Next sequence we expect to emit; null until the first packet lands. */
  private nextSequence: number | null = null;
  /**
   * Consecutive packets that fell outside the window. RFC 3550's probation
   * idea: a sender that genuinely re-anchored keeps arriving, while a single
   * corrupt sequence number does not. Without this, ONE bad number is
   * unrecoverable — the cursor jumps away and every real packet after it is
   * discarded as too late, for the rest of the call, silently.
   */
  private outOfWindow = 0;
  /** Sequence of the last out-of-window packet, for consecutiveness. */
  private probationAnchor: number | null = null;
  private lastArrivalMs = 0;
  private lastRtpTimestamp = 0;
  private jitter = 0;

  readonly stats: JitterStats = {
    received: 0,
    emitted: 0,
    duplicates: 0,
    reordered: 0,
    lost: 0,
    tooLate: 0,
    evicted: 0,
    discarded: 0,
    jitterMs: 0,
    maxDepth: 0,
    resyncs: 0,
  };

  constructor(options: JitterBufferOptions = {}, private clockRate = 8000) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Adopt a new codec clock without becoming a different buffer.
   *
   * A renegotiation can change what one RTP timestamp tick is WORTH. That is
   * a unit change, not a new sender: the stream, the socket and the call's
   * measured history are all the same afterwards. Replacing the buffer to
   * apply it threw away the audio it was holding AND every counter the call
   * had accumulated, which is a large price for a division.
   */
  retune(clockRate: number): void {
    if (clockRate === this.clockRate) return;
    this.clockRate = clockRate;
    // The next arrival pairing starts fresh. A gap opened in one unit and
    // closed in another is not a jitter reading, it is arithmetic on two
    // different things.
    this.newStream = true;
  }

  /**
   * Re-anchor on a sender that has clearly moved, rather than discarding it
   * forever. Returns true once the stream has been re-anchored.
   */
  /**
   * How far ahead a packet may be and still be queued. Generous enough that a
   * backpressured buffer never rejects its own sender, bounded well below the
   * half-space where a forward jump becomes indistinguishable from a backward
   * one.
   */
  private forwardWindow(): number {
    return Math.max(this.options.maxPackets * 2, this.options.reorderWindow);
  }

  private resyncIfPersistent(packet: RtpPacket): boolean {
    this.outOfWindow += 1;
    // BLOCKER: probation packets must be consecutive with EACH OTHER. Five
    // scattered datagrams from anyone who can reach the socket would otherwise
    // re-anchor the stream to a sequence of their choosing.
    // ABSOLUTE distance. A signed comparison only broke the run on a FORWARD
    // gap, so a descending scatter — 40000, 33000, 22000, 9000 — counted as
    // consecutive and re-anchored the stream to a number the sender chose.
    if (
      this.probationAnchor !== null &&
      Math.abs(sequenceDelta(this.probationAnchor, packet.sequenceNumber)) > this.options.resyncAfter * 4
    ) {
      this.outOfWindow = 1;
    }
    this.probationAnchor = packet.sequenceNumber;
    if (this.outOfWindow < this.options.resyncAfter) return false;
    // Whatever is thrown away here was real speech that ARRIVED. Counted as
    // discarded rather than lost, because those are two different events:
    // `lost` is the network failing us, `discarded` is us failing the audio.
    // The identity above needs them apart; an operator needs them apart even
    // more, since only one of the two is ours to fix.
    this.stats.discarded += this.queue.size;
    this.queue.clear();
    this.queuedBytes = 0;
    this.probationAnchor = null;
    this.nextSequence = packet.sequenceNumber;
    this.outOfWindow = 0;
    this.stats.resyncs += 1;
    this.queue.set(packet.sequenceNumber, packet);
    this.queuedBytes += packet.payload.length;
    return true;
  }

  private withinWindow(sequence: number): boolean {
    if (this.nextSequence === null) return true;
    const delta = sequenceDelta(this.nextSequence, sequence);
    return delta >= -this.options.reorderWindow && delta <= this.forwardWindow();
  }

  /** Packets currently held. */
  get depth(): number {
    return this.queue.size;
  }

  /**
   * Every packet received is in exactly one place: handed out, thrown away,
   * or still held. Checkable at any instant, which is the point — an identity
   * that only balances at the end of a call cannot show the moment it stopped
   * balancing, and by then the buffer that broke it has usually been replaced.
   */
  get accountingBalanced(): boolean {
    return this.stats.received === this.stats.emitted + this.stats.discarded + this.queue.size;
  }

  /**
   * Accept a packet. Returns nothing directly — everything leaves through
   * `drain`, so ordering is decided in exactly one place.
   */
  push(packet: RtpPacket): void {
    this.stats.received += 1;
    // Jitter is measured only from packets we actually accept: an out-of-
    // window straggler would otherwise poison the figure for the whole call.
    const accept = this.nextSequence === null || this.withinWindow(packet.sequenceNumber);
    if (accept) this.measureJitter(packet);

    if (this.nextSequence === null) {
      this.nextSequence = packet.sequenceNumber;
    } else {
      const delta = sequenceDelta(this.nextSequence, packet.sequenceNumber);
      if (delta < 0) {
        // Its slot has already passed, so it is unplayable whatever it is.
        //
        // Queuing it anyway causes two distinct faults: a network duplicate of
        // an ALREADY-EMITTED packet is no longer in the queue to be recognised
        // as a duplicate, so it would be emitted a second time and the
        // listener would hear 20 ms of speech twice; and draining it would
        // drag the play pointer BACKWARDS, so every packet after it is judged
        // against a sequence the stream has long passed.
        //
        // Near-miss and far-miss are counted apart because they mean different
        // things operationally: reordering is a network being untidy, while
        // tooLate is a buffer whose target delay is too short for this path.
        if (delta < -this.options.reorderWindow) {
          this.stats.tooLate += 1;
          // A resync QUEUES this packet, so only the other exit loses it.
          if (this.resyncIfPersistent(packet)) return;
        } else {
          this.stats.reordered += 1;
          this.outOfWindow = 0;
        }
        this.stats.discarded += 1;
        return;
      }
      // Forward acceptance is bounded by QUEUE CAPACITY, not by the reorder
      // window. The reorder window says how far BACK a straggler may be; using
      // it forwards made a deep buffer reject its own healthy stream — when a
      // slow seam applied backpressure and the queue grew past the window,
      // every further in-order packet was refused as too late and then wiped.
      if (delta > this.forwardWindow()) {
        this.stats.tooLate += 1;
        if (this.resyncIfPersistent(packet)) return;
        this.stats.discarded += 1;
        return;
      }
      this.outOfWindow = 0;
    }

    if (this.queue.has(packet.sequenceNumber)) {
      this.stats.duplicates += 1;
      this.stats.discarded += 1;
      return;
    }

    this.queue.set(packet.sequenceNumber, packet);
    this.queuedBytes += packet.payload.length;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, this.queue.size);
    this.enforceBounds();
  }

  /**
   * Emit everything now playable. A packet is playable once it is next in
   * sequence, or once the gap ahead of it has waited longer than the target
   * delay — at which point the missing audio is declared lost rather than
   * holding the whole call hostage to one dropped datagram.
   */
  drain(nowMs: number): EmittedPacket[] {
    const emitted: EmittedPacket[] = [];
    if (this.nextSequence === null) return emitted;

    for (;;) {
      const expected: number = (this.nextSequence ?? 0) & 0xffff;
      const ready = this.queue.get(expected);
      if (ready !== undefined) {
        this.take(expected, ready);
        emitted.push({ packet: ready, lostBefore: 0 });
        this.nextSequence = (expected + 1) & 0xffff;
        continue;
      }
      if (this.queue.size === 0) break;

      // Nothing at the expected slot: decide whether to keep waiting.
      const oldest = this.oldestQueued();
      if (oldest === null) break;
      const waited = nowMs - oldest.packet.arrivedAtMs;
      if (waited < this.options.targetDelayMs) break;

      const skipped = sequenceDelta(expected, oldest.sequence);
      if (skipped > 0) this.stats.lost += skipped;
      this.take(oldest.sequence, oldest.packet);
      emitted.push({ packet: oldest.packet, lostBefore: Math.max(0, skipped) });
      this.nextSequence = (oldest.sequence + 1) & 0xffff;
    }

    this.stats.jitterMs = this.jitter;
    this.stats.emitted += emitted.length;
    return emitted;
  }

  /**
   * The far end restarted its stream (a new SSRC). Everything already held was
   * still spoken and is still owed to the listener, so it is RETURNED rather
   * than dropped, and the counters carry forward — a fresh buffer would reset
   * the call's history and quietly make the measurements a lie.
   */
  resetStream(): EmittedPacket[] {
    const stranded = this.flushHeld();
    this.nextSequence = null;
    this.outOfWindow = 0;
    // The next packet begins a new arrival/media pairing; measuring against
    // the old stream's last packet would fold the gap between streams into
    // the jitter figure and keep it there for the rest of the call.
    this.lastArrivalMs = 0;
    this.lastRtpTimestamp = 0;
    this.newStream = true;
    return stranded;
  }

  /** Release everything held, in order. Used at hangup so nothing is stranded. */
  flush(): EmittedPacket[] {
    const stranded = this.flushHeld();
    this.nextSequence = null;
    return stranded;
  }

  /**
   * Release everything held WITHOUT forgetting where the stream is.
   *
   * `flush()` is for HANGUP, where the buffer is about to be dropped and the
   * play pointer is meaningless. A renegotiation is the opposite case: the
   * buffer is deliberately KEPT, because a re-INVITE does not restart RTP —
   * the SSRC and the sequence space carry on unchanged. Clearing the pointer
   * there made the next datagram to arrive the new anchor whatever its
   * sequence, so an ordinary one-packet reorder across the boundary destroyed
   * speech the buffer absorbs perfectly at every other moment of the call, a
   * reorder burst destroyed 120 ms of it, and a duplicate of audio already
   * delivered was no longer in the queue to be recognised — so it was emitted
   * a second time, with a media timestamp going backwards, while `duplicates`
   * stayed at zero.
   *
   * The pointer moves PAST what was just handed out rather than being
   * forgotten, so a straggler for a slot we have already played is still
   * refused, exactly as it would have been a moment earlier.
   */
  releaseHeld(): EmittedPacket[] {
    const released = this.flushHeld();
    for (const { packet } of released) {
      const next = (packet.sequenceNumber + 1) & 0xffff;
      if (this.nextSequence === null || sequenceDelta(this.nextSequence, next) > 0) {
        this.nextSequence = next;
      }
    }
    return released;
  }

  /**
   * Give up everything still held, counting it as thrown away rather than
   * handed out. This is what RETIRING a buffer means — replaced by a
   * renegotiation, or released at teardown — and it exists so a retired
   * buffer's depth becomes a visible discard instead of a hole nothing can
   * see. A buffer that simply stops being referenced takes its contents AND
   * its counters out of the accounting with it, which is precisely how a
   * re-INVITE could destroy held speech while every number still balanced.
   */
  abandon(): number {
    const abandoned = this.queue.size;
    this.queue.clear();
    this.queuedBytes = 0;
    this.nextSequence = null;
    this.stats.discarded += abandoned;
    return abandoned;
  }

  private flushHeld(): EmittedPacket[] {
    const base = this.nextSequence ?? 0;
    const remaining = [...this.queue.entries()].sort(
      (a, b) => sequenceDelta(base, a[0]) - sequenceDelta(base, b[0]),
    );
    this.queue.clear();
    this.queuedBytes = 0;
    this.stats.emitted += remaining.length;
    return remaining.map(([, packet]) => ({ packet, lostBefore: 0 }));
  }

  private take(sequence: number, packet: RtpPacket): void {
    this.queue.delete(sequence);
    this.queuedBytes -= packet.payload.length;
  }

  private oldestQueued(): { sequence: number; packet: RtpPacket } | null {
    let best: { sequence: number; packet: RtpPacket } | null = null;
    const base = this.nextSequence ?? 0;
    for (const [sequence, packet] of this.queue) {
      if (best === null || sequenceDelta(base, sequence) < sequenceDelta(base, best.sequence)) {
        best = { sequence, packet };
      }
    }
    return best;
  }

  /**
   * Bound the queue by packets and by bytes, dropping the oldest first. Byte
   * bounding matters independently: a peer sending large payloads can exhaust
   * memory long before it exhausts a packet count.
   */
  private enforceBounds(): void {
    while (this.queue.size > this.options.maxPackets || this.queuedBytes > this.options.maxBytes) {
      const oldest = this.oldestQueued();
      if (oldest === null) break;
      this.take(oldest.sequence, oldest.packet);
      this.stats.evicted += 1;
      this.stats.discarded += 1;
      // The timeline advances past what was dropped; otherwise every later
      // packet would be judged against a sequence that will never arrive.
      this.nextSequence = (oldest.sequence + 1) & 0xffff;
    }
  }

  /**
   * RFC 3550 interarrival jitter: the smoothed difference between how far
   * apart two packets were SENT (media clock) and how far apart they ARRIVED
   * (our clock). Reported in milliseconds rather than clock ticks so it can be
   * compared against a latency budget without a conversion in the reader's head.
   */
  private newStream = false;

  private measureJitter(packet: RtpPacket): void {
    if (this.newStream) {
      this.newStream = false;
      this.lastArrivalMs = packet.arrivedAtMs;
      this.lastRtpTimestamp = packet.rtpTimestamp;
      return;
    }
    if (this.stats.received > 1) {
      const arrivalGapMs = packet.arrivedAtMs - this.lastArrivalMs;
      const mediaGapMs = ((packet.rtpTimestamp - this.lastRtpTimestamp) / this.clockRate) * 1000;
      const difference = Math.abs(arrivalGapMs - mediaGapMs);
      // The standard's 1/16 gain: responsive to real change, immune to a
      // single odd packet.
      this.jitter += (difference - this.jitter) / 16;
    }
    this.lastArrivalMs = packet.arrivedAtMs;
    this.lastRtpTimestamp = packet.rtpTimestamp;
  }
}
