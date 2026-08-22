/** @author masterzee001 */
/**
 * Videofy owns segment identity and lifecycle. Provider endpointing is an INPUT.
 *
 * The two obvious designs are both wrong, and it is worth recording why, because
 * each is locally reasonable:
 *
 *   IF THE CHUNKER STAYS AUTHORITATIVE, local VAD decides everything and the
 *   provider's endpointing is ignored. We would pay a vendor for realtime
 *   intelligence and then politely decline to use it.
 *
 *   IF THE PROVIDER IS AUTHORITATIVE, "the vendor says this utterance ended"
 *   becomes "a Videofy segment boundary exists". Swap vendors and the platform's
 *   segmentation semantics change with them -- the exact vendor coupling P6.9
 *   spent a wave removing from the session layer.
 *
 * So neither. This coordinator collects SIGNALS -- local VAD, provider partials
 * and finals, provider endpoint hints, discontinuity, stream finish, a maximum
 * utterance duration -- and applies PLATFORM POLICY to them. A future Azure or
 * Google adapter emits the same normalized signals and gets the same behaviour.
 *
 * IDENTITY IS MINTED WHEN SPEECH STARTS, not when the first provider result
 * arrives. The provider can be late, can reconnect, or can return nothing at
 * all; platform identity must already exist independently of it. That is also
 * what makes reconnect safe: `seg_42` survives a dropped socket, because
 * nothing about it came from the socket.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not consume the chunker's growing
 * "audio-so-far" interim chunks. That mechanism exists so a BATCH model can
 * imitate streaming, and it re-transcribes from the segment start every time --
 * roughly quadratic in utterance length. Feeding it to a provider that already
 * streams would pay twice for one capability. The chunker remains authoritative
 * for the batch/upload path, which is what it is good at.
 */
import type { TranscriptEvent } from './transcript-event.js';
import type { StreamingTranscriptionSignal } from './streaming-transcription-provider.js';

/**
 * How eagerly a service commits a segment once a boundary is suggested.
 *
 * `aggressive`   commit as soon as a boundary signal arrives. Calls: a listener
 *                is waiting mid-conversation and stabilisation is latency they
 *                can hear.
 * `stabilized`   wait a short window in case speech resumes. Live programmes:
 *                one-way delivery tolerates a little more delay in exchange for
 *                fewer clauses split across segments.
 */
export type SegmentCommitPolicy = 'aggressive' | 'stabilized';

export interface SegmentTimers {
  setTimer(handler: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const SYSTEM_TIMERS: SegmentTimers = {
  setTimer: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Why a segment was committed. Recorded so certification can compare sources. */
export type CommitTrigger =
  | 'provider-final'
  | 'provider-endpoint'
  | 'local-vad-speech-end'
  | 'max-utterance'
  | 'stream-finish'
  | 'discontinuity';

export interface SegmentCommitRecord {
  readonly segmentId: string;
  readonly trigger: CommitTrigger;
  readonly startMs: number;
  readonly endMs: number;
  readonly revisions: number;
  readonly hadText: boolean;
}

export interface StreamingSegmentCoordinatorDeps {
  readonly sessionId: string;
  readonly streamId: string;
  readonly providerName: string;
  /** Platform-owned id minting. Never a vendor value. */
  readonly mintSegmentId: () => string;
  readonly commitPolicy: SegmentCommitPolicy;
  /** Window for `stabilized`; ignored by `aggressive`. */
  readonly stabilizationMs?: number;
  /** Backstop so a speaker who never pauses still produces segments. */
  readonly maxUtteranceMs?: number;
  readonly onEvent: (event: TranscriptEvent) => void;
  readonly now?: () => number;
  readonly timers?: SegmentTimers;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

interface OpenSegment {
  readonly segmentId: string;
  readonly startMs: number;
  endMs: number;
  revision: number;
  text: string;
  detectedLanguage?: string | undefined;
  confidence?: number | null;
  providerStartMs?: number | null;
  providerEndMs?: number | null;
  discontinuity: boolean;
  /** A provider `final` already arrived; used by the stabilization window. */
  providerFinalSeen: boolean;
}

export class StreamingSegmentCoordinator {
  private open: OpenSegment | null = null;
  private stabilizeHandle: unknown = null;
  private maxHandle: unknown = null;
  private closed = false;
  private readonly timers: SegmentTimers;
  private readonly now: () => number;
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;
  readonly commits: SegmentCommitRecord[] = [];

  constructor(private readonly deps: StreamingSegmentCoordinatorDeps) {
    this.timers = deps.timers ?? SYSTEM_TIMERS;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  get openSegmentId(): string | null {
    return this.open?.segmentId ?? null;
  }

  /**
   * Videofy has accepted the first speech frame of an utterance.
   *
   * This is where identity is created -- before any provider has said anything,
   * and independently of whether it ever will.
   */
  noteSpeechStart(platformTimestampMs: number): string {
    if (this.closed) return '';
    if (this.open !== null) {
      // Speech restarted inside an open segment: same reasoning as a partial.
      this.cancelStaleBoundary();
      return this.open.segmentId;
    }
    const segmentId = this.deps.mintSegmentId();
    this.open = {
      segmentId,
      startMs: platformTimestampMs,
      endMs: platformTimestampMs,
      revision: 0,
      text: '',
      discontinuity: false,
      providerFinalSeen: false,
    };
    this.armMaxUtterance();
    this.log('segment opened', { segmentId, startMs: platformTimestampMs });
    return segmentId;
  }

  /** Local VAD believes speech ended. A candidate boundary, weighed like any other. */
  noteSpeechEnd(platformTimestampMs: number): void {
    if (this.open === null) return;
    this.open.endMs = Math.max(this.open.endMs, platformTimestampMs);
    this.considerBoundary('local-vad-speech-end');
  }

  /** Advance the platform end time as audio flows, without implying a boundary. */
  noteAudio(platformTimestampMs: number, discontinuity = false): void {
    if (this.open === null) return;
    this.open.endMs = Math.max(this.open.endMs, platformTimestampMs);
    if (discontinuity) this.open.discontinuity = true;
  }

  /**
   * A normalized provider observation.
   *
   * A provider `final` does NOT automatically mean the Videofy segment is
   * final. It is recorded, then `considerBoundary` applies policy. In practice
   * the two usually coincide; the separation exists so that authority is
   * explicit rather than implied by call order.
   */
  noteProviderSignal(signal: StreamingTranscriptionSignal): void {
    if (this.closed) return;
    if (this.open === null) {
      // A late observation for a segment already committed, or output before
      // any speech was accepted. It cannot open a segment -- that would let the
      // provider mint identity through the side door.
      this.log('provider signal with no open segment; ignored', { kind: signal.kind });
      return;
    }
    const segment = this.open;

    if (signal.kind === 'endpoint') {
      if (signal.providerEndMs !== undefined && signal.providerEndMs !== null) {
        segment.providerEndMs = signal.providerEndMs;
      }
      this.considerBoundary('provider-endpoint');
      return;
    }

    // Text is cumulative for the utterance; the adapter normalises deltas.
    segment.text = signal.text;
    if (signal.detectedLanguage !== undefined) segment.detectedLanguage = signal.detectedLanguage;
    if (signal.confidence !== undefined) segment.confidence = signal.confidence;
    if (signal.providerStartMs !== undefined) segment.providerStartMs = signal.providerStartMs;
    if (signal.providerEndMs !== undefined) segment.providerEndMs = signal.providerEndMs;

    if (signal.kind === 'partial') {
      // SPEECH HAS RESUMED, so any boundary we were waiting to confirm is
      // stale. Cancel the stabilization window rather than letting a timer
      // armed before this text commit a segment that is still being spoken.
      //
      // Found by mutation testing: without this, a `stabilized` segment
      // committed a fixed interval after the provider's final regardless of
      // what happened next. The test looked correct because text is cumulative
      // and the late commit still carried the newest words -- it passed for a
      // coincidence rather than for the property it names. A real boundary
      // signal re-arms the window; the max-utterance backstop stops a
      // continuous speaker holding a segment open forever.
      this.cancelStaleBoundary();
      // Reversible. Emitted for captions; never enters MT/TTS in this wave.
      this.emit('partial', segment);
      return;
    }

    segment.providerFinalSeen = true;
    this.considerBoundary('provider-final');
  }

  /** Contiguous audio was lost. Policy decides whether the segment survives it. */
  noteDiscontinuity(reason: string): void {
    if (this.open === null) return;
    this.open.discontinuity = true;
    this.log('discontinuity during open segment', { segmentId: this.open.segmentId, reason });
    // Finalise what was genuinely heard rather than stitching across the gap.
    // The identity is ours, so it survives a provider reconnect; what does not
    // survive is the claim that the audio was continuous.
    this.commit('discontinuity');
  }

  /** The stream is ending. Commit whatever is open rather than losing it. */
  finishStream(): void {
    if (this.open !== null) this.commit('stream-finish');
  }

  close(): void {
    if (this.closed) return;
    this.finishStream();
    this.clearTimers();
    this.closed = true;
  }

  // --- policy ------------------------------------------------------------

  private considerBoundary(trigger: CommitTrigger): void {
    const segment = this.open;
    if (segment === null) return;

    if (this.deps.commitPolicy === 'aggressive') {
      this.commit(trigger);
      return;
    }

    // `stabilized`: a boundary signal starts a window. Speech resuming inside
    // it keeps the segment open, so a mid-sentence pause does not split a
    // clause in two and translate the halves separately.
    //
    // A SECOND BOUNDARY SIGNAL DOES NOT RESTART THE WINDOW. When the provider
    // reports a final and local VAD then agrees, those are CORROBORATING
    // observations of one boundary, not a later one. Restarting would let
    // agreement between two signals delay the commit -- the more evidence the
    // platform had that speech ended, the longer it would wait. Only resumed
    // speech cancels a window, via `cancelStaleBoundary`.
    if (this.stabilizeHandle !== null) return;
    const windowMs = this.deps.stabilizationMs ?? 300;
    this.stabilizeHandle = this.timers.setTimer(() => {
      this.stabilizeHandle = null;
      this.commit(trigger);
    }, windowMs);
  }

  private commit(trigger: CommitTrigger): void {
    const segment = this.open;
    if (segment === null) return;
    this.clearTimers();
    this.open = null;

    const hadText = segment.text.trim() !== '';
    this.commits.push({
      segmentId: segment.segmentId,
      trigger,
      startMs: segment.startMs,
      endMs: segment.endMs,
      revisions: segment.revision,
      hadText,
    });

    if (!hadText) {
      // A segment the provider never returned words for is ABANDONED, not
      // finalised. Emitting an empty final would send nothing to translation
      // and then synthesise silence into the call, which is worse than the
      // silence it came from.
      this.log('segment abandoned with no text', {
        segmentId: segment.segmentId,
        trigger,
      });
      return;
    }
    this.emit('final', segment);
    this.log('segment committed', { segmentId: segment.segmentId, trigger });
  }

  private emit(kind: 'partial' | 'final', segment: OpenSegment): void {
    segment.revision += 1;
    const event: TranscriptEvent = {
      kind,
      sessionId: this.deps.sessionId,
      streamId: this.deps.streamId,
      segmentId: segment.segmentId,
      revision: segment.revision,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      ...(segment.detectedLanguage === undefined
        ? {}
        : { detectedLanguage: segment.detectedLanguage }),
      ...(segment.discontinuity ? { discontinuity: true } : {}),
      provider: {
        name: this.deps.providerName,
        ...(segment.providerStartMs === undefined ? {} : { startMs: segment.providerStartMs }),
        ...(segment.providerEndMs === undefined ? {} : { endMs: segment.providerEndMs }),
        ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
      },
    };
    this.deps.onEvent(event);
  }

  private armMaxUtterance(): void {
    const limit = this.deps.maxUtteranceMs;
    if (limit === undefined || limit <= 0) return;
    this.maxHandle = this.timers.setTimer(() => {
      this.maxHandle = null;
      // A speaker who never pauses would otherwise hold one segment open
      // forever, and nothing would reach translation at all.
      this.commit('max-utterance');
    }, limit);
  }

  /**
   * A pending boundary was superseded by continuing speech.
   *
   * Distinct from `clearStabilizeTimer` so the call sites read as intent
   * ("this boundary is stale") rather than as timer bookkeeping.
   */
  private cancelStaleBoundary(): void {
    if (this.stabilizeHandle === null) return;
    this.clearStabilizeTimer();
    this.log('boundary superseded by continuing speech', {
      segmentId: this.open?.segmentId ?? null,
    });
  }

  private clearStabilizeTimer(): void {
    if (this.stabilizeHandle !== null) {
      this.timers.clearTimer(this.stabilizeHandle);
      this.stabilizeHandle = null;
    }
  }

  private clearTimers(): void {
    this.clearStabilizeTimer();
    if (this.maxHandle !== null) {
      this.timers.clearTimer(this.maxHandle);
      this.maxHandle = null;
    }
  }
}

/** The platform's commit policy per service category. */
export function commitPolicyForService(serviceCategory: 'call' | 'programme'): SegmentCommitPolicy {
  return serviceCategory === 'call' ? 'aggressive' : 'stabilized';
}
