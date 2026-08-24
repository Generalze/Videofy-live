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

import { SILERO_SPEECH_THRESHOLD, type SpeechProbabilityDetector } from './silero.js';
export {
  SILERO_SPEECH_THRESHOLD,
  SILERO_WINDOW_SAMPLES,
  SileroSpeechDetector,
  type SpeechProbabilityDetector,
} from './silero.js';

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

/**
 * Is this frame PERIODIC at a human pitch?
 *
 * Energy alone cannot tell a voice from a door. Speech is voiced: the vocal
 * folds repeat at roughly 80-350 Hz, which at 16 kHz is a lag of 45-200
 * samples. A cough, a keyboard, a chair and broadband room noise carry plenty
 * of energy and no such period, so a gate built on loudness alone opens for
 * all of them -- and the recogniser downstream, handed noise, obligingly
 * returns WORDS for it.
 *
 * Normalised autocorrelation, which is the cheapest honest test: no FFT, no
 * model, no dependency, a few thousand multiply-adds per frame.
 *
 * WHAT THIS DOES NOT CATCH. A steady tone is periodic and will pass; so will
 * music. Unvoiced consonants (s, f, sh) are aperiodic and fail on their own,
 * which is why the caller requires a voiced FRACTION over a span rather than
 * every frame -- nobody says "sss" alone for 150 ms. A learned detector
 * (Silero) is better than this at both ends; this is what can be had without
 * shipping a model.
 */
export function voicingStrength(samples: Int16Array): number {
  const minLag = 45;
  const maxLag = 200;
  if (samples.length <= maxLag + 1) return 0;

  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  if (energy === 0) return 0;

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let index = 0; index + lag < samples.length; index += 1) {
      correlation += samples[index]! * samples[index + lag]!;
    }
    // Normalised by the frame's own energy, so the answer is "how periodic",
    // not "how loud" -- the whole point of testing this separately.
    const normalized = correlation / energy;
    if (normalized > best) best = normalized;
  }
  return best;
}

/**
 * The least periodicity a frame may have and still count as voice.
 *
 * Measured against the alternative rather than chosen in the abstract: room
 * noise and keyboards sit near zero, a spoken vowel sits well above 0.4. The
 * value is deliberately nearer the noise floor than the speech floor, because
 * clipping the start of somebody's sentence is a worse failure than admitting
 * an occasional bump -- the voiced-fraction rule above still has to be met.
 */
export const VOICING_THRESHOLD = 0.3;

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
  /**
   * Least periodicity a frame may have and still count as voice. 0 disables
   * the test and restores the pure energy gate.
   */
  readonly voicingThreshold?: number;
  /**
   * A learned speech detector, when one is available.
   *
   * Given one, it DECIDES: it answers the question the energy and periodicity
   * tests only approximate, and it is the only one of the three that rejects a
   * steady tone or music. Absent, the gate keeps those two.
   */
  readonly detector?: SpeechProbabilityDetector | undefined;
  /**
   * Builds this gate's OWN detector.
   *
   * Preferred over passing an instance: a detector carries recurrent state for
   * one stream, and sharing one across concurrent speakers judges each against
   * the other's audio.
   */
  readonly createDetector?: (() => SpeechProbabilityDetector) | undefined;
  /** Probability at or above which the detector calls a frame speech. */
  readonly detectorThreshold?: number;
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
  private readonly voicingThreshold: number;
  private readonly detector: SpeechProbabilityDetector | undefined;
  private readonly detectorThreshold: number;

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
    // Zero disables the periodicity test, restoring the pure energy gate for
    // anyone who needs the previous behaviour exactly.
    this.voicingThreshold = options.voicingThreshold ?? VOICING_THRESHOLD;
    this.detector = options.detector ?? options.createDetector?.();
    this.detectorThreshold = options.detectorThreshold ?? SILERO_SPEECH_THRESHOLD;
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
    /*
     * A learned detector answers this outright; without one, the frame must be
     * loud AND periodic. Either of those alone opens a segment for something
     * that is not speech -- loudness for a door, periodicity for a hum -- and
     * neither rejects music, which is why the detector wins when present.
     *
     * Energy is still required alongside it. Silero is scored on speech, not
     * on level, and a whisper of leakage from another room can score highly
     * while being nobody in this call talking.
     */
    let voiced: boolean;
    if (this.detector !== undefined) {
      this.detector.push(samples);
      voiced =
        frameEnergy(samples) >= this.speechThreshold &&
        this.detector.probability >= this.detectorThreshold;
    } else {
      voiced =
        frameEnergy(samples) >= this.speechThreshold &&
        (this.voicingThreshold <= 0 || voicingStrength(samples) >= this.voicingThreshold);
    }

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
