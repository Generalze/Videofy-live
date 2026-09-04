/** @author masterzee001 */
/**
 * The streaming speech-synthesis contract.
 *
 * ADDITIVE, exactly as `StreamingTranscriptionProvider` was. `TextToSpeechProvider`
 * is unchanged and remains the contract for uploaded programmes, personal-voice
 * synthesis and lip-fit pacing, where a finished file is genuinely what the
 * pipeline needs. This is the second execution strategy, not a replacement.
 *
 * WHAT A SYNTHESIS ADAPTER MAY NOT DO -- the mirror image of the STT list, and
 * for the same reason: each entry is a way vendor semantics would leak into the
 * platform.
 *
 *   - it may not choose a segment id
 *   - it may not choose a generation
 *   - it may not number frames
 *   - it may not declare that a segment has finished being spoken
 *   - it may not decide its own chunk boundaries are frame boundaries
 *
 * `SynthesisChunk` carries none of those fields, so an adapter cannot express
 * them even by mistake. It reports audio; `TranslatedAudioFramer` decides what
 * that audio is called and where it sits in an order somebody can be held to.
 *
 * WHY CHUNKS ARE SAMPLES AND NOT BYTES. A vendor that streams 16-bit PCM will
 * eventually split a chunk in the middle of a sample, and a platform that
 * accepted bytes would have to re-solve that carry in every adapter -- once
 * correctly and then again, differently, next time. Adapters convert to the
 * engine's units at the edge, and a half-sample never crosses this seam.
 */

/**
 * Audio from a provider, in platform units and nothing else.
 *
 * 16 kHz mono signed 16-bit: the engine's own format. No vendor sample rate,
 * container, or codec name appears here, because nothing downstream should be
 * able to branch on which vendor spoke.
 */
export interface SynthesisChunk {
  readonly samples: Int16Array;
}

export interface StreamingSynthesisOptions {
  readonly text: string;
  readonly targetLanguage: string;
  /** Videofy's voice identity. The adapter maps it; the platform owns it. */
  readonly voiceId: string;
  readonly onChunk: (chunk: SynthesisChunk) => void;
  readonly onError: (error: Error) => void;
  /**
   * Abort in-flight synthesis.
   *
   * Cancelling matters more here than anywhere else in the pipeline: a
   * superseded sentence that keeps synthesising is paid-for audio nobody will
   * ever hear, and on a call it competes for the same bounded queue as the
   * sentence that replaced it.
   */
  readonly signal?: AbortSignal;
}

/**
 * This sentence was spoken, but not by the vendor that should have spoken it.
 *
 * THE ONE FAILURE NO SERVER SIGNAL CAN SEE. A listening test on 2026-08-26
 * established that the general vendors return HTTP 200 and fluent-sounding
 * audio for Yoruba, Hausa and Igbo, and that the audio is wrong -- a
 * multilingual voice reading unfamiliar orthography with the phonology it
 * already has. Status, byte count and latency are all normal. Only a speaker of
 * the language can tell, and by then it is in front of whoever was listening.
 *
 * So the fall-through has to leave a mark. Without one, a specialist that has
 * quietly stopped answering is INDISTINGUISHABLE from a specialist that is
 * working: audio plays either way. This field is that mark, and the surfaces
 * that report synthesis are required to show it rather than to average it away.
 *
 * ABSENT MEANS NOT DEGRADED. It is optional so that the ninety languages this
 * does not concern say nothing, rather than every provider having to assert a
 * negative it cannot know.
 */
export interface SynthesisDegradation {
  /** Base subtag actually requested, e.g. `yo`. */
  readonly language: string;
  /** The provider that SHOULD have served it, by name. */
  readonly expectedProvider: string;
  /** The provider that did. */
  readonly servedBy: string;
  /** Why, in words an operator can act on. Never a credential or a value. */
  readonly reason: string;
}

export interface StreamingSynthesisResult {
  /** Total samples produced. Zero is a failure, not a silent success. */
  readonly samples: number;
  /**
   * Time to the first audible chunk.
   *
   * The number this whole wave is about. Time-to-COMPLETE was already good;
   * time-to-FIRST is what a listener actually experiences as latency.
   */
  readonly timeToFirstChunkMs: number | null;
  readonly totalMs: number;
  /** True when synthesis stopped early because the caller aborted. */
  readonly aborted: boolean;
  /**
   * Set ONLY when a specialist language was served by its fallback.
   *
   * Undefined is the ordinary case and means nothing is known to be wrong; it
   * is not a claim that the rendering is good. Nothing infers quality from a
   * status code here or anywhere else.
   */
  readonly degraded?: SynthesisDegradation | undefined;
}

export interface StreamingSpeechSynthesisProvider {
  readonly name: string;
  synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult>;
}

/**
 * Scripted synthesis provider for platform-side proofs.
 *
 * Mirrors `MockStreamingTranscriptionProvider`: the framer's and delivery's
 * behaviour is proved without a vendor, so the guarantees belong to the
 * platform rather than to whoever happens to be synthesising this month.
 */
export class MockStreamingSynthesisProvider implements StreamingSpeechSynthesisProvider {
  readonly name = 'mock-streaming-synthesis';
  readonly requests: StreamingSynthesisOptions[] = [];

  /** Chunk sizes, in samples, to emit per call. Deliberately uneven. */
  constructor(private readonly script: readonly number[] = [100, 700, 33]) {}

  async synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
    this.requests.push(options);
    let samples = 0;
    let aborted = false;
    for (const size of this.script) {
      if (options.signal?.aborted === true) {
        aborted = true;
        break;
      }
      const chunk = new Int16Array(size);
      // A recognisable ramp, so a reordered or duplicated frame is visible in
      // a proof rather than being indistinguishable silence.
      for (let i = 0; i < size; i += 1) chunk[i] = ((samples + i) % 1000) + 1;
      options.onChunk({ samples: chunk });
      samples += size;
    }
    return { samples, timeToFirstChunkMs: samples > 0 ? 0 : null, totalMs: 0, aborted };
  }
}
