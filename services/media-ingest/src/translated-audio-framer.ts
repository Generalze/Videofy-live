/** @author masterzee001 */
/**
 * Vendor chunks in, platform frames out.
 *
 * A synthesis provider emits audio in whatever sizes its transport happened to
 * produce: HTTP chunk boundaries, TLS record sizes, a buffer flush. Those are
 * facts about somebody's network stack, not about speech. If they became
 * Videofy's frame boundaries then the wire would carry a different framing per
 * vendor, sequence numbers would mean something different per vendor, and the
 * ordering guarantee in `TranslatedAudioDelivery` would be measured in units
 * only the vendor understood.
 *
 * So identity is applied HERE, on the platform side of the seam:
 *
 *     provider  ->  SynthesisChunk (audio, nothing else)
 *     framer    ->  TranslatedAudioFrame (segmentId, generation, sequence, final)
 *     delivery  ->  ordered, bounded, cancellable
 *
 * The framer is the only thing in the pipeline allowed to say a segment has
 * finished being spoken, and it says it exactly once.
 */
import type { SynthesisChunk } from './streaming-speech-synthesis-provider.js';
import type { TranslatedAudioFrame } from './translated-audio.js';

/**
 * 20 ms at 16 kHz.
 *
 * Chosen to match the packetisation the RTP path already uses, so translated
 * audio entering a call needs no re-framing on the way out -- re-framing being
 * exactly where the P6.8 clocks got confused the first time.
 */
export const PLATFORM_FRAME_SAMPLES = 320;

export interface TranslatedAudioFramerDeps {
  readonly segmentId: string;
  readonly generation: number;
  readonly segmentStartMs: number;
  readonly emit: (frame: TranslatedAudioFrame) => void;
  readonly frameSamples?: number;
}

export class TranslatedAudioFramer {
  private pending: number[] = [];
  private sequence = 0;
  private finished = false;
  private readonly frameSamples: number;

  constructor(private readonly deps: TranslatedAudioFramerDeps) {
    this.frameSamples = deps.frameSamples ?? PLATFORM_FRAME_SAMPLES;
  }

  get framesEmitted(): number {
    return this.sequence;
  }

  push(chunk: SynthesisChunk): void {
    if (this.finished) {
      // `final` means nothing may follow it. Audio arriving afterwards is a
      // provider still talking after the platform stopped listening, and
      // admitting it would make `final` a suggestion.
      throw new Error('push after finish');
    }
    for (const sample of chunk.samples) this.pending.push(sample);
    // STRICTLY greater, so at least one sample always stays behind. That is
    // what guarantees `finish` has a tail to mark final: if this drained to
    // empty, audio whose length happened to divide evenly into frames would
    // end with no final marker at all, and downstream could not tell a
    // completed sentence from a stream that simply stopped arriving. The cost
    // is that the last full frame waits for `finish`, which the provider calls
    // the moment its stream ends.
    while (this.pending.length > this.frameSamples) {
      this.emit(this.pending.splice(0, this.frameSamples), false);
    }
  }

  /**
   * No more audio is coming. Flush the tail and mark the last frame final.
   *
   * The tail is emitted SHORT rather than padded to a full frame. Padding would
   * append silence the speaker did not produce, which on a call is a pause the
   * listener reads as the other person having finished talking. A short final
   * frame is honest about how much speech there was.
   */
  finish(): number {
    if (this.finished) return this.sequence;
    this.finished = true;
    if (this.pending.length > 0) {
      this.emit(this.pending.splice(0, this.pending.length), true);
    }
    // Silence produces NO frame. A zero-sample final frame would be the
    // pipeline accounting for speech that never happened, and a listener would
    // be told a segment was spoken when nothing was.
    return this.sequence;
  }

  /**
   * Stop without finishing.
   *
   * Used when synthesis was aborted or failed. Deliberately emits NO final
   * frame: a segment that was cut short did not finish being spoken, and
   * claiming otherwise would tell downstream that a truncated sentence is a
   * complete one.
   */
  abandon(): void {
    this.finished = true;
    this.pending = [];
  }

  private emit(samples: number[], final: boolean): void {
    const frame: TranslatedAudioFrame = {
      segmentId: this.deps.segmentId,
      generation: this.deps.generation,
      sequence: this.sequence,
      samples: Int16Array.from(samples),
      sampleRate: 16000,
      channelCount: 1,
      final,
      segmentStartMs: this.deps.segmentStartMs,
    };
    this.sequence += 1;
    this.deps.emit(frame);
  }
}
