/** @owner masterzee001 */

/**
 * Rejects speech-recognition output that describes silence rather than speech.
 *
 * Whisper is trained largely on subtitled video, so when it is handed audio with
 * no real speech in it — a pause, breathing, keyboard noise, room tone — it does
 * not return nothing. It returns the most likely subtitle text, which is often a
 * credit line from its training data, or an invented conversational reply that
 * plausibly continues whatever came before.
 *
 * In a live call that reads as two distinct faults, both reported from real use:
 * captions appearing "by themselves" while nobody is speaking, and the system
 * apparently "answering the question" instead of translating it — the second
 * being an invented continuation, not a translation error.
 *
 * The filter is deliberately conservative. Dropping a caption the speaker
 * actually said is worse than letting an occasional invention through, so each
 * rule needs a clear signal: Whisper's own non-speech probability, its own
 * confidence, or a credit line no participant would ever utter.
 */
export interface RecognisedSegment {
  text: string;
  startMs: number;
  endMs: number;
  /** Whisper's probability that this window contains no speech at all. */
  noSpeechProb?: number | null;
  /** Whisper's average token log-probability; very low means it was guessing. */
  avgLogProb?: number | null;
}

export interface HallucinationFilterOptions {
  /** Above this non-speech probability the window is treated as silence. */
  noSpeechProbability: number;
  /** Below this average log-probability the text is treated as a guess. */
  minAverageLogProbability: number;
}

/**
 * The bar an INTERIM caption must clear, which is higher than for a final.
 *
 * A partial is a preview of a sentence that is still being spoken, so the
 * recogniser is handed a truncated clause and completes it with whatever is
 * most likely — observed in real calls as previews that are not refinements of
 * the final at all but different sentences ("It's nice to talk." previewing
 * "This is good."). To a participant that reads as the system answering rather
 * than translating.
 *
 * A preview is worth only the head start it gives, and the final follows within
 * about a second and a half. So when the recogniser is unsure, showing nothing
 * and waiting is strictly better than showing an invention.
 */
export const INTERIM_HALLUCINATION_FILTER: HallucinationFilterOptions = {
  // Stricter than a final, but only moderately. A first attempt at 0.3/-0.7 was
  // set without field data and is easily met by ordinary call audio, which
  // would thin previews out until the feature stopped being worth having.
  noSpeechProbability: 0.4,
  minAverageLogProbability: -0.85,
};

export const DEFAULT_HALLUCINATION_FILTER: HallucinationFilterOptions = {
  // 0.6 rather than 0.5: Whisper is routinely uncertain about short real
  // utterances ("oui", "ok"), and those are exactly the words a call depends
  // on. The aim is to catch confident silence, not to second-guess brevity.
  noSpeechProbability: 0.6,
  // Real speech in a noisy call sits well above -1.0; sustained values below it
  // are the signature of invented text.
  minAverageLogProbability: -1.0,
};

/**
 * Credit lines Whisper emits on silence, from subtitle files in its training
 * data. These are matched as substrings on normalised text because no
 * participant says them, in any of our languages. Kept specific — matching a
 * bare "subtitles" or "sous-titres" would censor a real conversation about
 * captions, which is a plausible thing to discuss in this product of all things.
 */
const CREDIT_LINE_MARKERS = [
  'amara.org',
  'subtitles by',
  'subtitled by',
  'subtitles created by',
  'sous-titres realises par',
  'sous-titrage par',
  'subtitulos realizados por',
  'subtitulado por',
  'untertitel von',
  'untertitelung im auftrag',
];

/**
 * Sign-off lines, which vary too much for fixed strings: a plain substring for
 * "thank you for watching" missed the real "Thank you very much for watching."
 * because two words were inserted mid-phrase. The gap between the thanks and
 * the watching is bounded so an ordinary sentence that happens to contain both
 * ideas is not swept up.
 */
const SIGN_OFF_PATTERNS = [
  /\bthank(?:s| you)\b[^.!?]{0,24}\bfor watching\b/,
  /\bthank(?:s| you)\b[^.!?]{0,24}\bfor listening\b/,
  /\bmerci\b[^.!?]{0,24}\bd(?:e|'avoir) regard/,
  /\bgracias por (?:ver|mirar|escuchar)\b/,
  /\bdon(?:'|)t forget to (?:like|subscribe)\b/,
  /\bsee you (?:in the )?next (?:video|time)\b/,
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    // Strip accents so "réalisés" matches "realises" without listing variants.
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the text is a subtitle credit rather than something anyone said. */
export function isCreditLineHallucination(text: string): boolean {
  const normalised = normalise(text);
  return (
    CREDIT_LINE_MARKERS.some((marker) => normalised.includes(marker)) ||
    SIGN_OFF_PATTERNS.some((pattern) => pattern.test(normalised))
  );
}

export interface FilterResult {
  kept: RecognisedSegment[];
  /** Why each dropped segment was dropped, for diagnostics. */
  dropped: { text: string; reason: 'credit-line' | 'no-speech' | 'low-confidence' }[];
}

export function filterHallucinatedSegments(
  segments: readonly RecognisedSegment[],
  options: HallucinationFilterOptions = DEFAULT_HALLUCINATION_FILTER,
): FilterResult {
  const kept: RecognisedSegment[] = [];
  const dropped: FilterResult['dropped'] = [];

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;

    if (isCreditLineHallucination(text)) {
      dropped.push({ text, reason: 'credit-line' });
      continue;
    }
    if (
      typeof segment.noSpeechProb === 'number' &&
      segment.noSpeechProb > options.noSpeechProbability
    ) {
      dropped.push({ text, reason: 'no-speech' });
      continue;
    }
    if (
      typeof segment.avgLogProb === 'number' &&
      segment.avgLogProb < options.minAverageLogProbability
    ) {
      dropped.push({ text, reason: 'low-confidence' });
      continue;
    }
    kept.push({ ...segment, text });
  }

  return { kept, dropped };
}
