/** @owner masterzee001 */

/**
 * Recognises utterances that carry feeling rather than words — laughter, sighs,
 * hesitation, and bare interjections.
 *
 * These must never be translated or re-voiced. Laughter is already universal:
 * translating "haha" into another language gains nothing, and synthesising it
 * in a standard voice produces a flat, uncanny "Ha ha ha." where a person
 * actually laughed. The human moment is destroyed precisely by processing it.
 *
 * The original audio already carries these perfectly, so the correct behaviour
 * is to let them through untouched and generate nothing.
 *
 * Deliberately narrow: it must never swallow a real word. "No" and "yes" are
 * decisions, "ok" is an answer, and a short utterance is not the same thing as
 * a wordless one — so only tokens with no lexical content qualify, and anything
 * mixed with real words is treated as speech.
 */

/**
 * Bracketed sound events the recogniser emits directly, e.g. "[LAUGHTER]",
 * "(laughs)", "*sighs*", and the musical note it uses for singing.
 */
const SOUND_EVENT = /^[\[\(\*♪♫]|[\]\)\*♪♫]$/;

/**
 * Wordless vocalisations across the languages in the registry. Each is a sound
 * a person makes, not a word they choose: laughter, hesitation, thinking noises
 * and reflex interjections. Written without punctuation or accents, which are
 * stripped before matching.
 */
const NON_LEXICAL_TOKENS = new Set([
  // Laughter, in the spellings recognisers produce.
  'ha', 'haha', 'hahaha', 'hahahaha', 'heh', 'hehe', 'hehehe', 'hah',
  'jaja', 'jajaja', 'jajajaja', // Spanish laughter
  'hihi', 'hihihi', 'lol',
  // Hesitation and thinking.
  'uh', 'uhh', 'um', 'umm', 'hmm', 'hm', 'hmmm', 'mm', 'mmm', 'mhm', 'mmhmm',
  'er', 'erm', 'eh', 'euh', 'heu', 'ehm',
  // Reflex interjections.
  'ah', 'aah', 'aha', 'oh', 'ooh', 'ohh', 'ay', 'aie', 'ouch', 'oops', 'ups',
  'wow', 'whoa', 'woah', 'phew', 'ugh', 'argh', 'huh', 'hey',
  'oi', 'oye', 'olé', 'ole',
  // Sound events written as words.
  'laughs', 'laughter', 'laughing', 'sighs', 'sigh', 'coughs', 'cough',
  'applause', 'clapping', 'music', 'silence', 'inaudible', 'rires', 'risas',
]);

/**
 * Laughter written as a run of syllables: "haha", "hohoho", "jajaja", "hehe".
 *
 * A fixed list cannot keep up here — a recogniser transcribed one synthesised
 * laugh as "Ho, ho, ho, ho.", a spelling the list did not have — so the shape
 * is matched instead of the spelling. Two or more syllables are required
 * precisely because several single ones are real words: "hi" is a greeting and
 * "ho" on its own is not worth the risk of swallowing.
 */
const LAUGHTER_RUN = /^(?:ha|he|hi|ho|hu|ja|je|ji|jo){2,}$/;

/** Strips punctuation and accents so "Ha-ha!" and "héhé" match their tokens. */
function normaliseToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * True when the utterance is made entirely of wordless sound.
 *
 * Requires EVERY token to be non-lexical: "haha yes exactly" is a real reply
 * that happens to start with laughter, and translating it still matters.
 */
export function isNonLexicalUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // A bracketed sound event is the recogniser telling us directly.
  if (SOUND_EVENT.test(trimmed)) {
    const inner = trimmed.replace(/[\[\]\(\)\*♪♫]/g, '').trim();
    // Only when the brackets contain a sound, not a transcript aside.
    return inner === '' || inner.split(/\s+/).every((t) => NON_LEXICAL_TOKENS.has(normaliseToken(t)));
  }

  const tokens = trimmed.split(/\s+/).map(normaliseToken).filter(Boolean);
  if (tokens.length === 0) {
    // Punctuation only — "?!", "...". Nothing was said.
    return true;
  }
  // A repeated syllable spread across separate tokens is still one laugh:
  // "Ho, ho, ho, ho." arrives as four tokens, not one run.
  const collapsed = tokens.join('');
  if (tokens.length > 1 && LAUGHTER_RUN.test(collapsed)) return true;

  return tokens.every((token) => NON_LEXICAL_TOKENS.has(token) || LAUGHTER_RUN.test(token));
}
