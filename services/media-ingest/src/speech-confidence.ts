/** @owner masterzee001 */
/**
 * Refusing words nobody said.
 *
 * Whisper does not return "I heard nothing". Given near-silence it returns its
 * best guess at what silence would have been, fluently and with punctuation —
 * "Thank you.", "Merci d'avoir regardé cette vidéo.", a subtitle credit it saw
 * a million times in training. On a call that guess is then TRANSLATED and
 * SPOKEN IN THE SPEAKER'S OWN VOICE to somebody who has no way to know it was
 * invented. That is worse than a missing caption by a wide margin: a gap is
 * obviously a gap, and a fabricated sentence is indistinguishable from speech.
 *
 * The model already computes the two numbers that identify this, and the worker
 * was throwing both away:
 *
 *   noSpeechProb — the model's own estimate that the audio contained no speech
 *   avgLogProb   — how confident it is in the tokens it nonetheless emitted
 *
 * The widely used rule is "silence when noSpeechProb is high AND avgLogProb is
 * low". It is kept here as the primary test, with one addition: overwhelming
 * no-speech evidence rejects on its own, because the characteristic silence
 * hallucination is a memorised phrase the model is very CONFIDENT about, and a
 * confident wrong answer sails through a rule that requires low confidence.
 *
 * Both thresholds are configurable, because they are a starting point rather
 * than a measurement, and the right values depend on microphones we do not have
 * in front of us.
 */

export interface SpeechCandidate {
  readonly text: string;
  /** The model's estimate that this segment contained no speech, 0–1. */
  readonly noSpeechProb?: number | null;
  /** Mean token log-probability. Closer to 0 is more confident. */
  readonly avgLogProb?: number | null;
}

export interface HallucinationThresholds {
  /** Paired with `minAvgLogProb`; both must indicate silence to reject. */
  readonly maxNoSpeechProb: number;
  readonly minAvgLogProb: number;
  /** Rejects alone. Set to 1 to disable, which makes this rule unreachable. */
  readonly certainNoSpeechProb: number;
}

export const DEFAULT_HALLUCINATION_THRESHOLDS: HallucinationThresholds = {
  // The established pairing, unchanged.
  maxNoSpeechProb: 0.6,
  minAvgLogProb: -1,
  // The addition. At this point the model is telling us plainly that it heard
  // nothing, and how sure it is about the words is beside the point.
  certainNoSpeechProb: 0.9,
};

export function readHallucinationThresholds(
  env: Record<string, string | undefined>,
): HallucinationThresholds {
  const read = (name: string, fallback: number): number => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxNoSpeechProb: read('TRANSCRIPTION_MAX_NO_SPEECH_PROB', DEFAULT_HALLUCINATION_THRESHOLDS.maxNoSpeechProb),
    minAvgLogProb: read('TRANSCRIPTION_MIN_AVG_LOGPROB', DEFAULT_HALLUCINATION_THRESHOLDS.minAvgLogProb),
    certainNoSpeechProb: read(
      'TRANSCRIPTION_CERTAIN_NO_SPEECH_PROB',
      DEFAULT_HALLUCINATION_THRESHOLDS.certainNoSpeechProb,
    ),
  };
}

export type HallucinationReason = 'no-speech' | 'no-speech-and-uncertain' | 'empty';

/**
 * Why this segment should not be spoken, or null to keep it.
 *
 * Absent probabilities KEEP the segment. A provider that does not report them
 * must not have everything it says silently discarded — failing open here is
 * correct, because the alternative is a transcription engine that appears to
 * have gone deaf after a dependency upgrade.
 */
export function hallucinationReason(
  candidate: SpeechCandidate,
  thresholds: HallucinationThresholds = DEFAULT_HALLUCINATION_THRESHOLDS,
): HallucinationReason | null {
  if (candidate.text.trim().length === 0) return 'empty';

  const noSpeech = numberOrNull(candidate.noSpeechProb);
  const avgLogProb = numberOrNull(candidate.avgLogProb);
  if (noSpeech === null) return null;

  if (noSpeech >= thresholds.certainNoSpeechProb) return 'no-speech';
  if (noSpeech >= thresholds.maxNoSpeechProb) {
    // Without a confidence figure the pairing cannot be evaluated, and the
    // no-speech estimate alone is below the certain threshold — so it stays.
    if (avgLogProb === null) return null;
    if (avgLogProb <= thresholds.minAvgLogProb) return 'no-speech-and-uncertain';
  }
  return null;
}

/**
 * Drop what the model itself believes was not speech.
 *
 * Returns the survivors and a count, so a caller can report that something was
 * discarded rather than quietly producing fewer captions than utterances.
 */
export function rejectHallucinatedSpeech<T extends SpeechCandidate>(
  candidates: readonly T[],
  thresholds: HallucinationThresholds = DEFAULT_HALLUCINATION_THRESHOLDS,
): { readonly kept: T[]; readonly rejected: number } {
  const kept: T[] = [];
  let rejected = 0;
  for (const candidate of candidates) {
    if (hallucinationReason(candidate, thresholds) === null) kept.push(candidate);
    else rejected += 1;
  }
  return { kept, rejected };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
