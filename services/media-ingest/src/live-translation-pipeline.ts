/** @author masterzee001 */
/**
 * Videofy-final transcript in, translated speech out, progressively.
 *
 * The second half of the live path, and the half where irreversibility starts.
 * Up to here everything can be revised silently: a partial caption is replaced
 * and nobody notices. The moment a frame of synthesised speech leaves this
 * file, somebody has heard it.
 *
 *     TranscriptEvent(final)
 *       -> translate                  request/response, once per segment
 *       -> speakSegment               streaming synthesis, platform-framed
 *       -> TranslatedAudioDelivery    ordered, bounded, cancellable
 *       -> the listener's transport
 *
 * ONLY VIDEOFY FINALS ARRIVE HERE. A provider partial must never reach
 * synthesis: partials are revised constantly, and revising a sentence somebody
 * has already been spoken is not possible. `partial` events are for captions,
 * which can be rewritten in place.
 *
 * GENERATIONS ARE THE PLATFORM'S. A segment can be spoken more than once -- a
 * revised final arrives, a provider fails over, a retry runs -- and each
 * attempt gets the next generation for that segment. Nothing about a vendor's
 * retry semantics is visible in the number, so a failover cannot be mistaken
 * for a new sentence.
 */
import { speakSegment, type SpeakSegmentOutcome } from './speak-segment.js';
import { TranslatedAudioDelivery, cancellationPolicyForService } from './translated-audio-delivery.js';
import type { StreamingSpeechSynthesisProvider } from './streaming-speech-synthesis-provider.js';
import type { TimestampedTranslationProvider } from './translation-provider.js';
import type { TranscriptEvent } from './transcript-event.js';
import type { TranslatedAudioFrame } from './translated-audio.js';

export interface LiveTranslationPipelineDeps {
  readonly sessionId: string;
  readonly streamId: string;
  readonly serviceCategory: 'call' | 'programme';
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly voiceId: string;
  /**
   * Below this recogniser confidence a segment is captioned but never SPOKEN.
   *
   * A floor, not a filter: the words still reach the transcript. What is
   * withheld is the synthesised voice, because a spoken sentence carries no
   * hedge and a listener cannot tell an invented one from a heard one.
   */
  readonly minSpokenConfidence: number;
  readonly translation: TimestampedTranslationProvider;
  readonly synthesis: StreamingSpeechSynthesisProvider;
  /** Where a frame goes once it is ordered and still wanted. */
  readonly deliver: (frame: TranslatedAudioFrame) => boolean;
  readonly maxQueuedFrames?: number;
  readonly frameSamples?: number;
  readonly now?: () => number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface SpokenSegmentRecord {
  readonly segmentId: string;
  readonly generation: number;
  readonly revision: number;
  readonly translatedText: string;
  readonly outcome: SpeakSegmentOutcome;
}

export class LiveTranslationPipeline {
  private readonly delivery: TranslatedAudioDelivery;
  /** Next generation per segment. Platform-owned, never a vendor value. */
  private readonly generations = new Map<string, number>();
  /** Highest revision spoken per segment, so a stale final cannot re-speak. */
  private readonly spokenRevision = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  readonly spoken: SpokenSegmentRecord[] = [];

  constructor(private readonly deps: LiveTranslationPipelineDeps) {
    this.delivery = new TranslatedAudioDelivery({
      cancellationPolicy: cancellationPolicyForService(deps.serviceCategory),
      deliver: deps.deliver,
      ...(deps.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: deps.maxQueuedFrames }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  /** The sink has room again. */
  resume(): void {
    this.delivery.resume();
  }

  get queuedFrames(): number {
    return this.delivery.queuedFrames;
  }

  deliveredMsFor(segmentId: string): number {
    return this.delivery.deliveredMsFor(segmentId);
  }

  /**
   * One transcript event.
   *
   * Partials are ignored here rather than filtered by the caller, so a future
   * caller cannot forget: the rule that partials never synthesise belongs with
   * the thing that would otherwise speak them.
   */
  async onTranscriptEvent(event: TranscriptEvent): Promise<SpokenSegmentRecord | null> {
    if (event.kind !== 'final') return null;

    /**
     * A RECOGNISER THAT IS NOT SURE MUST NOT BE GIVEN A VOICE.
     *
     * Deepgram scores every result, and that score was carried all the way
     * here and never once consulted: a transcript the recogniser itself rated
     * 0.3 was translated and spoken with exactly the authority of one it rated
     * 0.98. With an energy-gate VAD upstream — which passes a cough, a door or
     * a keyboard as "speech" — that is a machine that manufactures sentences
     * out of noise and puts them in somebody's mouth.
     *
     * Captions survive this because text can be marked uncertain. SPEECH
     * cannot: a synthesised voice carries no hedge, and on a business call the
     * listener has no way to know a sentence was invented. So the floor
     * governs SYNTHESIS only. The words still reach the transcript, where they
     * can be read, doubted and corrected.
     *
     * Absent confidence is NOT treated as low: some providers omit it, and
     * silently muting every one of them would be a worse failure than the one
     * this prevents.
     */
    const confidence = event.provider?.confidence;
    if (typeof confidence === 'number' && confidence < this.deps.minSpokenConfidence) {
      this.deps.log?.('below the confidence floor; captioned but NOT spoken', {
        segmentId: event.segmentId,
        targetLanguage: this.deps.targetLanguage,
        confidence,
        floor: this.deps.minSpokenConfidence,
      });
      return null;
    }

    if (event.text.trim() === '') {
      // A final with no words is a segment the recogniser heard nothing in.
      // Synthesising it would produce a pause the speaker never took.
      return null;
    }
    const alreadySpoken = this.spokenRevision.get(event.segmentId);
    if (alreadySpoken !== undefined && event.revision <= alreadySpoken) {
      // A stale or duplicated final. Re-speaking it would say the sentence
      // twice; arrival order is not authority, revision is.
      this.deps.log?.('ignored non-advancing final', {
        segmentId: event.segmentId,
        revision: event.revision,
      });
      return null;
    }
    this.spokenRevision.set(event.segmentId, event.revision);

    // A revised final supersedes the attempt still speaking the old one.
    this.cancelInFlight(event.segmentId, 'superseded by a newer final');

    const generation = (this.generations.get(event.segmentId) ?? 0) + 1;
    this.generations.set(event.segmentId, generation);

    let translatedText: string;
    try {
      const result = await this.deps.translation.translate({
        sessionId: this.deps.sessionId,
        streamId: this.deps.streamId,
        segmentId: event.segmentId,
        sequence: event.revision,
        sourceLanguage: event.detectedLanguage ?? this.deps.sourceLanguage,
        targetLanguage: this.deps.targetLanguage,
        sourceText: event.text,
        startMs: event.startMs,
        endMs: event.endMs,
      });
      translatedText = result.translatedText;
    } catch (error) {
      // One sentence untranslated on a call that is still running. The caption
      // stands on its own; taking the session down would be worse.
      this.deps.log?.('translation failed', {
        segmentId: event.segmentId,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
    if (translatedText.trim() === '') return null;

    const controller = new AbortController();
    this.inFlight.set(event.segmentId, controller);
    try {
      const outcome = await speakSegment({
        provider: this.deps.synthesis,
        delivery: this.delivery,
        segmentId: event.segmentId,
        generation,
        segmentStartMs: event.startMs,
        text: translatedText,
        targetLanguage: this.deps.targetLanguage,
        voiceId: this.deps.voiceId,
        signal: controller.signal,
        ...(this.deps.frameSamples === undefined ? {} : { frameSamples: this.deps.frameSamples }),
        ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
        ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
      });
      const record: SpokenSegmentRecord = {
        segmentId: event.segmentId,
        generation,
        revision: event.revision,
        translatedText,
        outcome,
      };
      this.spoken.push(record);
      return record;
    } finally {
      if (this.inFlight.get(event.segmentId) === controller) {
        this.inFlight.delete(event.segmentId);
      }
    }
  }

  /**
   * Stop speaking a segment.
   *
   * Returns what was actually achieved, because the two halves are different
   * kinds of fact: discarded audio is a success, and audio already delivered is
   * something to live with.
   */
  cancelSegment(segmentId: string, reason: string): { discardedFrames: number; deliveredMs: number } {
    this.cancelInFlight(segmentId, reason);
    return this.delivery.cancel(segmentId, reason);
  }

  /** The stream ended. Nothing further may be spoken for it. */
  cancelAll(reason: string): void {
    for (const segmentId of [...this.inFlight.keys()]) {
      this.cancelSegment(segmentId, reason);
    }
    for (const segmentId of this.generations.keys()) {
      this.delivery.cancel(segmentId, reason);
    }
  }

  private cancelInFlight(segmentId: string, reason: string): void {
    const controller = this.inFlight.get(segmentId);
    if (controller === undefined) return;
    // Aborting stops the vendor mid-sentence: paid-for audio nobody will hear,
    // competing for the same bounded queue as the sentence that replaced it.
    controller.abort();
    this.inFlight.delete(segmentId);
    this.deps.log?.('synthesis aborted', { segmentId, reason });
  }
}
