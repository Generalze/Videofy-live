/** @author masterzee001 */
/**
 * Translated speech arriving from Videofy, on its way to an RTP endpoint.
 *
 * TWO STATE MACHINES THAT MUST NOT BE CONFUSED, which is the whole reason this
 * file exists rather than a few lines inside the wire handler:
 *
 *   TRANSLATION state   segmentId, generation, sequence. Owned by Videofy.
 *                       A generation supersedes; a sequence orders a sentence;
 *                       both survive a reconnect because the platform minted
 *                       them.
 *   RTP TRANSPORT state sequence number, timestamp, SSRC. Owned by `SipCall`.
 *                       Continuous for the life of the call, and meaningful to
 *                       the far end's jitter buffer.
 *
 * A generation change is a fact about a sentence. Resetting the RTP sequence
 * or timestamp because of one would tell the remote endpoint that the media
 * stream restarted -- which is how a jitter buffer decides to flush, and the
 * listener hears a gap in the middle of a corrected sentence. So this class
 * stops FEEDING `sendToEndpoint` and never reaches into what `sendToEndpoint`
 * counts.
 *
 * NOTHING ABOUT LANGUAGE LIVES HERE. Not the target language, not the voice,
 * not whether this listener wanted translation. Videofy decided all of that
 * before the frame was sent, and an adapter that could re-decide any of it
 * would be a SIP integration holding product policy.
 */
import type { TranslatedMediaPayload } from '@videofy-live/adapter-wire';

/** What `SipCall` offers. Narrow on purpose: egress may do this and no more. */
export interface TranslatedEgressEndpoint {
  /** Accepts any frame length; repacketises to 20 ms and converts at the boundary. */
  sendToEndpoint(samples: Int16Array): void;
}

export type TranslatedEgressDisposition =
  | 'sent'
  | 'dropped-superseded'
  | 'dropped-out-of-order'
  | 'dropped-duplicate'
  | 'dropped-cancelled'
  | 'dropped-stopped'
  | 'dropped-empty';

export interface TranslatedEgressStats {
  readonly framesSent: number;
  readonly samplesSent: number;
  readonly framesDropped: number;
  readonly stopped: boolean;
}

interface SegmentState {
  generation: number;
  lastSent: number;
  seen: Set<number>;
  cancelled: boolean;
}

/**
 * The key a stream is ordered under.
 *
 * (targetLanguage, segmentId), NOT segmentId alone. One utterance produces an
 * independent stream per language, and keying on the segment alone would make
 * the Spanish and French renderings of one sentence supersede each other --
 * each arriving frame looking like an out-of-order duplicate of the other.
 *
 * NUL separator, written as an escape: neither a language tag nor a segment id
 * can contain one, so the split is unambiguous by construction.
 */
function streamKey(targetLanguage: string, segmentId: string): string {
  return `${targetLanguage}\u0000${segmentId}`;
}

export interface TranslatedEgressDeps {
  readonly endpoint: TranslatedEgressEndpoint;
  readonly onDisposition?: (
    disposition: TranslatedEgressDisposition,
    payload: TranslatedMediaPayload,
  ) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class TranslatedAudioEgress {
  private readonly segments = new Map<string, SegmentState>();
  private framesSent = 0;
  private samplesSent = 0;
  private framesDropped = 0;
  private stopped = false;

  constructor(private readonly deps: TranslatedEgressDeps) {}

  get stats(): TranslatedEgressStats {
    return {
      framesSent: this.framesSent,
      samplesSent: this.samplesSent,
      framesDropped: this.framesDropped,
      stopped: this.stopped,
    };
  }

  accept(payload: TranslatedMediaPayload): TranslatedEgressDisposition {
    if (this.stopped) {
      // The call is gone. Late frames are ordinary -- synthesis keeps producing
      // for a moment after a hangup -- and feeding them to a torn-down call is
      // how a runaway sender happens.
      return this.settle('dropped-stopped', payload);
    }
    if (payload.samples.length === 0) return this.settle('dropped-empty', payload);

    const key = streamKey(payload.targetLanguage, payload.segmentId);
    const existing = this.segments.get(key);
    if (existing !== undefined && payload.generation < existing.generation) {
      // "Tuesday" arriving after "Wednesday" started. RTP is NOT touched: the
      // transport is fine, this sentence is not.
      return this.settle('dropped-superseded', payload);
    }
    if (existing === undefined || payload.generation > existing.generation) {
      this.segments.set(key, {
        generation: payload.generation,
        lastSent: -1,
        seen: new Set(),
        cancelled: false,
      });
    }
    const state = this.segments.get(key)!;
    if (state.cancelled) return this.settle('dropped-cancelled', payload);
    if (state.seen.has(payload.sequence)) return this.settle('dropped-duplicate', payload);

    // Ordering is enforced here, not assumed from arrival. A frame that would
    // jump a gap is dropped rather than held: on a live call, audio that
    // arrives after the moment it belonged in is worth less than silence.
    if (payload.sequence !== state.lastSent + 1) {
      state.seen.add(payload.sequence);
      return this.settle('dropped-out-of-order', payload);
    }

    state.seen.add(payload.sequence);
    state.lastSent = payload.sequence;
    // The ONE call into transport. `sendToEndpoint` owns repacketisation, the
    // codec conversion and the RTP counters; none of them appear above.
    this.deps.endpoint.sendToEndpoint(payload.samples);
    this.framesSent += 1;
    this.samplesSent += payload.samples.length;
    this.deps.onDisposition?.('sent', payload);
    return 'sent';
  }

  /**
   * Stop one segment. Used when the platform supersedes or withdraws it.
   *
   * Deliberately does NOT stop the call: other segments continue, and RTP keeps
   * counting. Cancelling a sentence is not hanging up.
   */
  cancelSegment(segmentId: string, reason: string, targetLanguage?: string): void {
    // Without a language this cancels the segment in EVERY language, which is
    // what a withdrawn utterance means. With one it cancels a single
    // rendering, which is what a failed synthesis in one language means.
    let cancelled = 0;
    for (const [key, state] of this.segments) {
      const matches =
        targetLanguage === undefined
          ? key.endsWith(`\u0000${segmentId}`)
          : key === streamKey(targetLanguage, segmentId);
      if (!matches) continue;
      state.cancelled = true;
      cancelled += 1;
    }
    if (cancelled > 0) {
      this.deps.log?.('translated egress segment cancelled', {
        segmentId,
        reason,
        streams: cancelled,
      });
    }
  }

  /**
   * Stop everything: the participant left, or the call ended.
   *
   * Idempotent, because teardown races are ordinary and a second stop must not
   * be an error on the path that is already tearing down.
   */
  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const state of this.segments.values()) state.cancelled = true;
    this.deps.log?.('translated egress stopped', { reason });
  }

  private settle(
    disposition: TranslatedEgressDisposition,
    payload: TranslatedMediaPayload,
  ): TranslatedEgressDisposition {
    this.framesDropped += 1;
    this.deps.onDisposition?.(disposition, payload);
    return disposition;
  }
}
