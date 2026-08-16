// Videofy Live — C-AI1.0 bake-off corpus.
//
// Ordinary conversational sentences, plus the two things an official
// conversation cannot afford to have approximated: names and numbers. Each
// utterance declares what it is testing, so a provider's weakness is legible in
// the report rather than buried in an average.
//
// Synthesised audio is a floor, not a ceiling. It is clean, evenly paced and
// accent-free, so every provider will score better here than on a real call —
// which is exactly why the corpus is only half the test and the live-microphone
// pass matters. Accent coverage in particular CANNOT be synthesised honestly:
// see NIGERIAN_ACCENT_GAP below.

export const CORPUS = [
  {
    id: 'en-greeting',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Good morning. Can you hear me clearly?',
    tests: 'baseline conversational opening',
  },
  {
    id: 'en-names',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Mister Chux will join the meeting with Doctor Adeyemi.',
    protectedTokens: ['Chux', 'Adeyemi'],
    tests: 'proper names, which must survive verbatim',
  },
  {
    id: 'en-numbers',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'The train leaves at eight fifteen from platform nine.',
    protectedTokens: ['eight', 'fifteen', 'nine'],
    tests: 'numbers, where an approximation is a wrong answer',
  },
  {
    id: 'en-long',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text:
      'I wanted to walk you through the quarterly numbers before we open the floor to questions, ' +
      'because there is a lot of detail here and I would rather cover it carefully than rush.',
    tests: 'long sentence — where a batch ceiling cuts mid-clause',
  },
  {
    id: 'en-short-answer',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'No, not yet.',
    tests: 'short answer — where fragment handling invents filler',
  },
  {
    id: 'es-greeting',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text: 'Hola, buenos días. ¿Me escuchas bien?',
    tests: 'baseline conversational opening, reverse direction',
  },
  {
    id: 'es-numbers',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text: 'La reunión empieza a las nueve y treinta en la sala cuatro.',
    protectedTokens: ['nueve', 'treinta', 'cuatro'],
    tests: 'numbers, reverse direction',
  },
  {
    id: 'es-long',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text:
      'Quiero confirmar que la traducción funciona en ambas direcciones, porque necesitamos ' +
      'estar seguros antes de presentar esto a la dirección la semana que viene.',
    tests: 'long sentence, reverse direction',
  },
];

/**
 * Accent coverage the corpus deliberately does NOT fake.
 *
 * Nigerian-accented English is on the owner's measurement list and is precisely
 * the case where an American synthetic voice would produce a flattering,
 * meaningless score: every provider would do well on audio that sounds nothing
 * like the speaker it is meant to represent. Recorded speech is the only honest
 * source, so the harness reports this dimension as UNMEASURED until real
 * recordings are supplied, rather than quietly scoring without it.
 */
export const NIGERIAN_ACCENT_GAP = Object.freeze({
  dimension: 'nigerian-accented-english',
  status: 'unmeasured',
  reason:
    'Requires recorded speech. Synthesising it with a US voice would score every provider ' +
    'well on audio that does not represent the speaker, which is worse than no measurement.',
  howToSupply:
    'Drop 16 kHz mono WAV recordings into the corpus directory as accent-*.wav with a ' +
    'matching accent-*.txt transcript, and rerun; they are scored exactly like the rest.',
});

export function corpusFor(pair) {
  if (!pair) return CORPUS;
  const [source, target] = pair.split('-');
  return CORPUS.filter((u) => u.sourceLanguage === source && u.targetLanguage === target);
}
