/** @author masterzee001 */
/**
 * Deciding whether anybody is actually talking.
 *
 * WHY THIS IS A PACKAGE. Two consumers need the same answer for different
 * reasons, and if each kept its own copy they would drift within one release:
 *
 *   the gateway chunker  assembles a WAV segment for the batch/upload path,
 *                        and must not hand the recogniser eight seconds of
 *                        keyboard taps
 *   media-ingest         runs the live path, where no segment is assembled at
 *                        all -- the STT provider gets a continuous stream and
 *                        the coordinator decides boundaries. All it needs is
 *                        "speech started" and "speech ended"
 *
 * Those are genuinely different jobs on top of one identical judgement. The
 * judgement lives here; the jobs stay where they are.
 *
 * The thresholds are the ones the chunker arrived at by measurement, not by
 * taste. `scripts/measure-voiced-duration.mjs` produced them:
 *
 *     "Non."  290 ms voiced in a ~1 s segment   = 29%
 *     "Oui."  320 ms                            = 32%
 *     sparse noise: ~160 ms voiced in 8000 ms   =  2%
 *
 * A duration threshold low enough to keep "Non." also admits eight seconds of
 * intermittent taps. The FRACTION separates them, and it is the rule that
 * actually kills the fabrications: a stretch that is 2% voice is not a person
 * speaking, however long it ran.
 */

export const SPEECH_SAMPLE_RATE = 16000;

/**
 * Root-mean-square amplitude, normalised to 0..1.
 *
 * Deliberately not peak: a single loud click has a large peak and no speech in
 * it, and gating on peaks is how a door closing opens a segment.
 */
export function frameEnergy(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    total += normalized * normalized;
  }
  return Math.sqrt(total / samples.length);
}

export const SPEECH_DEFAULTS = {
  speechThreshold: 0.012,
  endSilenceMs: 700,
  minSpeechMs: 150,
  maxSegmentMs: 8_000,
} as const;

/**
 * The least voice a stretch may be made of and still be somebody talking.
 * See the measurements in this file's header.
 */
export const VAD_MIN_VOICED_FRACTION = 0.1;

/**
 * Silence kept after the last voiced frame, so a word's final consonant is not
 * clipped. Everything past this is below the speech gate by definition.
 */
export const VAD_POST_ROLL_SAMPLES = Math.round(0.2 * SPEECH_SAMPLE_RATE);

export interface SpeechActivityOptions {
  readonly speechThreshold?: number;
  readonly endSilenceMs?: number;
  readonly minSpeechMs?: number;
  readonly maxSegmentMs?: number;
}

/**
 * What a frame did to the conversation.
 *
 * `speech-start` and `speech-end` are the only two things the live path cares
 * about. `too-quiet-to-be-speech` is reported rather than folded into
 * `speech-end` because they mean opposite things downstream: one is an
 * utterance that finished, the other is an utterance that was never there and
 * must not open a segment at all.
 */
export type SpeechActivityEvent =
  | { readonly kind: 'speech-start'; readonly platformTimestampMs: number }
  | {
      readonly kind: 'speech-end';
      readonly platformTimestampMs: number;
      readonly reason: 'end-silence' | 'max-duration';
      readonly voicedMs: number;
    }
  | {
      readonly kind: 'too-quiet-to-be-speech';
      readonly platformTimestampMs: number;
      readonly voicedFraction: number;
    };

/**
 * Frame in, speech boundaries out. No audio is retained.
 *
 * That last point is the whole difference from the chunker: this holds counters
 * and nothing else, so running it on the live path costs no memory that grows
 * with how long somebody talks.
 */
export class SpeechActivityGate {
  private readonly speechThreshold: number;
  private readonly endSilenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxSegmentMs: number;

  private open = false;
  private startedAtMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private spanMs = 0;
  /** Suppressed until the next genuine start, so one tap is not reported twice. */
  private reportedTooQuiet = false;

  constructor(options: SpeechActivityOptions = {}) {
    this.speechThreshold = options.speechThreshold ?? SPEECH_DEFAULTS.speechThreshold;
    this.endSilenceMs = options.endSilenceMs ?? SPEECH_DEFAULTS.endSilenceMs;
    this.minSpeechMs = options.minSpeechMs ?? SPEECH_DEFAULTS.minSpeechMs;
    this.maxSegmentMs = options.maxSegmentMs ?? SPEECH_DEFAULTS.maxSegmentMs;
  }

  get isSpeaking(): boolean {
    return this.open;
  }

  /**
   * One frame of audio at its platform media time.
   *
   * `platformTimestampMs` is the START of this frame on the platform timeline.
   * Boundaries are reported on that clock and never on arrival time, because
   * the two diverge exactly where it matters -- when the network delays or the
   * sender batches.
   */
  push(samples: Int16Array, platformTimestampMs: number): SpeechActivityEvent[] {
    const events: SpeechActivityEvent[] = [];
    const frameMs = (samples.length / SPEECH_SAMPLE_RATE) * 1000;
    const voiced = frameEnergy(samples) >= this.speechThreshold;

    if (voiced) {
      if (!this.open) {
        this.open = true;
        this.startedAtMs = platformTimestampMs;
        this.voicedMs = 0;
        this.silenceMs = 0;
        this.spanMs = 0;
        this.reportedTooQuiet = false;
        events.push({ kind: 'speech-start', platformTimestampMs });
      }
      this.voicedMs += frameMs;
      // A pause inside speech counts toward the span but never toward the
      // voiced total. Promoting silence into the voiced counter is what once
      // let 500 ms of quiet plus two blips satisfy a 500 ms speech minimum.
      this.silenceMs = 0;
      this.spanMs += frameMs;
      return events;
    }

    if (!this.open) return events;
    this.silenceMs += frameMs;
    this.spanMs += frameMs;

    const endedBySilence = this.silenceMs >= this.endSilenceMs;
    const endedByLength = this.spanMs >= this.maxSegmentMs;
    if (!endedBySilence && !endedByLength) return events;

    const voicedFraction = this.spanMs > 0 ? this.voicedMs / this.spanMs : 0;
    const enough = this.voicedMs >= this.minSpeechMs && voicedFraction >= VAD_MIN_VOICED_FRACTION;
    const endAt = platformTimestampMs + frameMs;
    if (enough) {
      events.push({
        kind: 'speech-end',
        platformTimestampMs: endAt,
        reason: endedBySilence ? 'end-silence' : 'max-duration',
        voicedMs: Math.round(this.voicedMs),
      });
    } else if (!this.reportedTooQuiet) {
      // Never a speech-end: there was no speech to end. Reporting one would
      // open and close a segment around a chair creaking, and the recogniser
      // would answer it with the highest-prior sentence it knows.
      this.reportedTooQuiet = true;
      events.push({
        kind: 'too-quiet-to-be-speech',
        platformTimestampMs: endAt,
        voicedFraction: Number(voicedFraction.toFixed(3)),
      });
    }
    this.open = false;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.spanMs = 0;
    return events;
  }

  /**
   * The stream ended. Reports a final boundary if one was genuinely open.
   *
   * Uses the same "was anybody talking" test as an ordinary close, so a stream
   * that ends mid-tap does not manufacture an utterance out of it.
   */
  finish(platformTimestampMs: number): SpeechActivityEvent[] {
    if (!this.open) return [];
    const voicedFraction = this.spanMs > 0 ? this.voicedMs / this.spanMs : 0;
    const enough = this.voicedMs >= this.minSpeechMs && voicedFraction >= VAD_MIN_VOICED_FRACTION;
    this.open = false;
    const voicedMs = Math.round(this.voicedMs);
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.spanMs = 0;
    return enough
      ? [{ kind: 'speech-end', platformTimestampMs, reason: 'end-silence', voicedMs }]
      : [{ kind: 'too-quiet-to-be-speech', platformTimestampMs, voicedFraction }];
  }

  /** Audio was lost. Whatever was open cannot be continued across the hole. */
  reset(): void {
    this.open = false;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.spanMs = 0;
  }
}
