/** @author masterzee001 */
/**
 * The normalization boundary between transcription and everything after it.
 *
 * Batch and streaming are two EXECUTION STRATEGIES FOR TRANSCRIPTION, not two
 * pipelines. Both end here, and translation and speech synthesis see only this
 * type. Whether faster-whisper returned one completed result for a file, or a
 * streaming vendor emitted eleven interim hypotheses and a final, the platform
 * gets its own event shape either way.
 *
 * PROVIDER VOCABULARY ENDS AT THE ADAPTER. Nothing downstream of this file may
 * learn which vendor produced a transcript, and nothing in this type carries a
 * vendor identifier that could be branched on.
 *
 * WHO OWNS WHAT
 *
 *     Videofy owns   segmentId, revision, startMs/endMs on the platform
 *                    timeline, and the decision that a segment is final
 *
 *     Provider owns  the recognised text, its own confidence, and its own
 *                    timing observations -- all of which are EVIDENCE
 *
 * The split is not decorative. If a vendor minted segment identity, swapping
 * vendors would change the platform's segmentation semantics, and a reconnect
 * could produce `seg_42`, `seg_deepgram_9812` and `seg_42_again` for one
 * utterance. P6.9 spent a wave removing exactly that class of coupling from the
 * session layer; it must not re-enter through transcription.
 */

/** Units a provider reports consuming. Recorded, never priced here. */
export interface ProviderUsage {
  readonly audioSeconds?: number;
  readonly characters?: number;
  readonly tokens?: number;
}

/**
 * What the provider observed, kept separate from what the platform decided.
 *
 * These timings are deliberately NOT the platform timeline. A vendor's clock
 * starts when its socket opened and drifts with its own buffering; treating it
 * as authoritative would make every provider swap a re-timing exercise. They
 * are retained because they are useful certification evidence -- comparing
 * provider-reported boundaries against platform VAD boundaries is one of the
 * things C-AI1.2 has to measure.
 */
export interface ProviderObservation {
  readonly name: string;
  readonly startMs?: number | null;
  readonly endMs?: number | null;
  readonly confidence?: number | null;
  /** The model's own estimate that this contained no speech, 0-1. */
  readonly noSpeechProb?: number | null;
  readonly avgLogProb?: number | null;
  readonly latencyMs?: number | null;
  readonly usage?: ProviderUsage;
}

/**
 * One transcript observation about one platform-owned segment.
 *
 * `partial` is REVERSIBLE: it updates caption/UI state and may be superseded by
 * any later revision of the same segment. In this wave it must not enter the
 * MT->TTS path, because that path is irreversible -- audio, once spoken, cannot
 * be recalled, and revising a partial after synthesis would produce an audible
 * stutter rather than a correction.
 *
 * `final` is CANONICAL. Exactly one per segment, and only the platform issues
 * it. A provider saying "final" is an observation that the platform weighs.
 */
export interface TranscriptEvent {
  readonly kind: 'partial' | 'final';
  readonly sessionId: string;
  readonly streamId: string;
  /** Platform-owned. Minted when Videofy decides an utterance began. */
  readonly segmentId: string;
  /** Platform-owned. Monotonic within a segment; higher supersedes lower. */
  readonly revision: number;
  readonly text: string;
  /** Platform timeline, not the provider's. */
  readonly startMs: number;
  readonly endMs: number;
  readonly detectedLanguage?: string | undefined;
  /**
   * True when contiguous audio was lost before or during this segment, so
   * downstream can decline to treat it as continuous speech.
   */
  readonly discontinuity?: boolean | undefined;
  readonly provider: ProviderObservation;
}

/** Only these reach translation and synthesis in this wave. */
export function isCanonicalFinal(event: TranscriptEvent): boolean {
  return event.kind === 'final';
}

/**
 * Order two events for the same segment.
 *
 * Revision alone decides. Arrival order does not: a partial delayed behind a
 * final would otherwise overwrite it, which is the caption equivalent of the
 * out-of-order media the jitter buffer already exists to prevent.
 */
export function supersedes(candidate: TranscriptEvent, existing: TranscriptEvent): boolean {
  if (candidate.segmentId !== existing.segmentId) return false;
  return candidate.revision > existing.revision;
}
