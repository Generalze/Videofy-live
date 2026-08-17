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
  /**
   * The model's estimate that there was no speech, 0–1.
   *
   * PER DECODE WINDOW, not per segment. faster-whisper stamps one window's
   * score onto every segment it produced, and a call chunk is never longer than
   * one 30 s window — so every segment of a chunk carries the SAME number.
   * Measured on this repository's own call audio: five segments, all 0.5449.
   *
   * The consequence matters. A fabricated tail attached to real speech inherits
   * the real speech's confidence and is invisible here, and lowering
   * `maxNoSpeechProb` does not delete a bad sentence — it deletes the whole
   * chunk, including the real words in it.
   */
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

export type HallucinationReason =
  | 'no-speech'
  | 'no-speech-and-uncertain'
  | 'empty'
  | 'memorised-credit';

/**
 * Subtitle credits Whisper memorised from its training data.
 *
 * Observed in a real call, in French, spoken in the speaker's cloned voice:
 *
 *   "Sous-titres réalisés par la communauté d'Amara.org"
 *   "sur les communautés de l'Université de Montréal."
 *
 * The probability guard cannot catch these. They are not low-confidence
 * mumbling — the model is CERTAIN, because it saw them at the end of thousands
 * of subtitled videos, so `noSpeechProb` stays low and `avgLogProb` stays high.
 * Confidence is exactly the wrong instrument for a fabrication the model is
 * sure about.
 *
 * So they are matched by text, which is a blunt instrument and is chosen
 * deliberately. Nobody on a translated call says "Subtitles by the Amara.org
 * community", and if somebody ever does, losing that one sentence costs far
 * less than speaking an invention in their own voice to a listener who cannot
 * tell the difference.
 *
 * Matched as PHRASES, never single words: "subtitles" alone is a thing people
 * say, and dropping real speech is a different failure rather than a smaller
 * one.
 */
const MEMORISED_CREDITS: readonly RegExp[] = [
  /amara\.org/i,
  // The video-outro family. Observed repeating eight times after the speaker
  // stopped talking, and it only stopped when they muted:
  //   "We will try to catch them, and I will see you in the next video."
  //   "Nous allons essayer de les attraper, et je vous verrai dans la prochaine vidéo."
  /see you (in|on) the next (video|one)/i,
  /dans la prochaine vidéo/i,
  /like and subscribe/i,
  /n[’']oubliez pas de vous abonner/i,
  /sous-titres? (réalisés?|faits?) par/i,
  /sous-titrage (société|par)/i,
  /subtitles? (by|directed by|created by|provided by)/i,
  /subtitled by/i,
  /merci d[’']avoir regardé/i,
  /thanks? for watching/i,
  /abonnez-vous/i,
  // Narrowed to the memorised form. Bare "Montreal" is a city people mention.
  /communautés? de l[’']université de montréal/i,
  /communit(y|ies) of the university of montreal/i,
  /traduit par/i,
  /transcription (by|par)/i,
];

/** Whether this text is a subtitle credit the model memorised. */
export function isMemorisedCredit(text: string): boolean {
  return MEMORISED_CREDITS.some((pattern) => pattern.test(text));
}

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

  // Checked BEFORE the probabilities, because these are the fabrications the
  // model is most confident about and the probability rules would wave them
  // straight through.
  if (isMemorisedCredit(candidate.text)) return 'memorised-credit';

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

/**
 * Suppress a sentence the recogniser has started looping on.
 *
 * Whisper repeats. Given silence it will emit the same memorised sentence for
 * chunk after chunk, and a speaker who has simply stopped talking gets their
 * cloned voice reciting one line until they mute. Observed eight times running.
 *
 * The phrase list catches the ones we have seen. This catches the ones we have
 * not, because a loop is recognisable by its shape rather than its wording.
 *
 * Two consecutive identical sentences are ALLOWED. People repeat themselves —
 * "no, no" — and a caption system that deletes the second "no" is broken in a
 * way that is harder to notice than the loop it was preventing. The third
 * identical sentence in a row is not a person.
 */
export const MAX_CONSECUTIVE_REPEATS = 2;

export interface RepetitionFilter {
  /** True when this text should be dropped as a loop. */
  isLooping(text: string): boolean;
}

export function createRepetitionFilter(
  maxConsecutive: number = MAX_CONSECUTIVE_REPEATS,
): RepetitionFilter {
  let previous: string | null = null;
  let run = 0;
  return {
    isLooping(text: string): boolean {
      // Compared on normalised text so punctuation drift between decodes —
      // "catch them and I will" vs "catch them, and I will" — still counts as
      // the same sentence, which is exactly how the observed loop varied.
      const normalised = text
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number} ]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalised.length === 0) return false;
      if (normalised === previous) {
        run += 1;
        return run >= maxConsecutive;
      }
      previous = normalised;
      run = 0;
      return false;
    },
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
