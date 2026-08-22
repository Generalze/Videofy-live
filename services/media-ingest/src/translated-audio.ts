/** @author masterzee001 */
/**
 * Translated audio as PLATFORM frames, not vendor chunks.
 *
 * The audit that opened C-AI1.1C found the honest limit of streaming TTS: audio
 * reaches a listener as a URL served with `Content-Length` from a FINISHED
 * file, so generating progressively lowered time-to-complete-file and changed
 * nothing a caller could hear. Fixing that means audio has to move before it is
 * complete, and the moment it does, four questions arrive at once:
 *
 *     what order do these go in?
 *     how much may we hold?
 *     is this a duplicate?
 *     is this still wanted?
 *
 * WebSocket arrival order answers none of them. Treating a vendor's chunk
 * sequence as the audio protocol would make ElevenLabs' framing into Videofy's
 * framing, and the next TTS provider would arrive with different framing and no
 * way to express the same guarantees.
 *
 * So chunks normalize here, exactly as transcripts normalize into
 * `TranscriptEvent`. Nothing downstream of this file learns which vendor spoke.
 */

/**
 * One frame of translated speech, owned by the platform.
 *
 * `segmentId` is the SAME identity the coordinator minted for the transcript,
 * so a spoken frame can always be traced back to the utterance it translates.
 * Audio that invented its own identity could not be cancelled when the
 * transcript it came from was superseded.
 */
export interface TranslatedAudioFrame {
  readonly segmentId: string;
  /**
   * Which attempt at speaking this segment produced this frame.
   *
   * A segment can be synthesised more than once -- a revision arrives, a
   * provider fails over, a retry runs. Without a generation, frames from an
   * abandoned attempt are indistinguishable from the live one and would
   * interleave into a stutter. Higher supersedes lower.
   */
  readonly generation: number;
  /** Order within (segmentId, generation). Starts at 0 and never repeats. */
  readonly sequence: number;
  readonly samples: Int16Array;
  readonly sampleRate: 16000;
  readonly channelCount: 1;
  /** The last frame of this generation. Nothing further may follow it. */
  readonly final: boolean;
  /** Media time of the transcript segment, for alignment and measurement. */
  readonly segmentStartMs: number;
}

/** Stable key for per-attempt bookkeeping. */
export function generationKey(segmentId: string, generation: number): string {
  return `${segmentId}#${generation}`;
}

/**
 * Whether a frame belongs to a newer attempt than the one in flight.
 *
 * Deliberately compares GENERATION and not arrival time. A slow first attempt
 * whose frames arrive after a faster second attempt's must not be treated as
 * current merely because it turned up last.
 */
export function isNewerGeneration(candidate: TranslatedAudioFrame, currentGeneration: number): boolean {
  return candidate.generation > currentGeneration;
}

/** 16 kHz mono: bytes to milliseconds of audio. */
export function framesToMs(samples: number): number {
  return Math.round((samples / 16000) * 1000);
}

/**
 * What happened to audio the platform generated.
 *
 * Every frame ends in exactly one of these, and the distinction between the
 * last two is the point: audio a listener has already heard cannot be recalled,
 * so an honest system counts it separately from audio it managed to discard
 * before anyone heard it. Reporting both as "cancelled" would overstate how
 * much control the platform actually has.
 */
export type TranslatedAudioDisposition =
  | 'delivered'
  | 'discarded-superseded'
  | 'discarded-cancelled'
  | 'discarded-overflow'
  | 'discarded-duplicate'
  | 'discarded-stale-generation';

export interface TranslatedAudioAccounting {
  readonly disposition: TranslatedAudioDisposition;
  readonly segmentId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly samples: number;
}
