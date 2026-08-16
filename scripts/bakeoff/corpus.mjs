// Videofy Live — C-AI1.0 bake-off corpus.
//
// Three tiers, kept apart in the report because they answer different
// questions. Collapsing them into one score would let a clean synthetic result
// stand in for deployment relevance, which is the most flattering and least
// honest thing this harness could do:
//
//   synthetic  — provider floor and repeatability. Clean, evenly paced,
//                accent-free. Every provider scores better here than on a real
//                call, so a good synthetic score proves only that nothing is
//                fundamentally broken.
//   accent     — actual deployment relevance. Real recorded speech. CANNOT be
//                synthesised: see ACCENT_TIER.
//   live       — conversational behaviour: interruptions, pauses, streaming
//                latency. Driven by the call harness, not this file.

/** @type {'synthetic'|'accent'|'live'} */
export const TIERS = Object.freeze({
  synthetic: 'provider floor and repeatability',
  accent: 'actual deployment relevance',
  live: 'conversational behaviour, interruptions, pauses, streaming latency',
});

/**
 * Names the vendor's phrase-hint configuration must NEVER be given.
 *
 * A recogniser handed a vocabulary list will recognise the words on it. That
 * measures the list, not the recogniser. Half the names are held out so the
 * tuned pass cannot congratulate itself for passing an exam it was given the
 * answers to, and the two passes stay separately reported either way.
 */
export const HELD_OUT_FROM_HINTS = Object.freeze([
  'Okonkwo', 'Adebayo', 'Nwachukwu', 'Balogun',
  'Sørensen', 'Nguyen', 'Kowalski',
  'Enugu', 'Kaduna',
]);

export const CORPUS = [
  // ---------- conversational baseline ----------
  {
    id: 'en-greeting',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Good morning. Can you hear me clearly?',
    tests: 'baseline conversational opening',
  },
  {
    id: 'en-short-answer',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'No, not yet.',
    tests: 'short answer — where fragment handling invents filler',
  },
  {
    id: 'en-long',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text:
      'I wanted to walk you through the quarterly numbers before we open the floor to questions, ' +
      'because there is a lot of detail here and I would rather cover it carefully than rush.',
    tests: 'long sentence — where a batch ceiling cuts mid-clause',
  },

  // ---------- names: Nigerian ----------
  {
    id: 'en-names-ng-1',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Pastor Adeyemi and Chuks Okafor will join us from Abuja.',
    protectedTokens: ['Adeyemi', 'Chuks', 'Okafor', 'Abuja'],
    tests: 'Nigerian personal and place names',
  },
  {
    id: 'en-names-ng-2',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Doctor Okonkwo travelled to Enugu with Mrs Adebayo on Thursday.',
    protectedTokens: ['Okonkwo', 'Enugu', 'Adebayo'],
    tests: 'Nigerian names held out of any phrase hint',
  },
  {
    id: 'en-names-ng-3',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Mister Nwachukwu asked whether Balogun had signed the agreement in Kaduna.',
    protectedTokens: ['Nwachukwu', 'Balogun', 'Kaduna'],
    tests: 'Nigerian names held out of any phrase hint',
  },

  // ---------- names: international ----------
  {
    id: 'en-names-intl',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'Missus Nguyen and Doctor Kowalski met Miss Sørensen in Copenhagen.',
    protectedTokens: ['Nguyen', 'Kowalski', 'Sørensen', 'Copenhagen'],
    tests: 'international names, held out of any phrase hint',
  },
  {
    id: 'en-names-orgs',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'The Federal Ministry of Health approved the request from Zenith Bank.',
    protectedTokens: ['Federal Ministry of Health', 'Zenith Bank'],
    tests: 'organisation names, which must survive as whole phrases',
  },

  // ---------- numbers ----------
  {
    id: 'en-numbers',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'The train leaves at eight fifteen from platform nine.',
    protectedTokens: ['eight', 'fifteen', 'nine'],
    tests: 'times, where an approximation is a wrong answer',
  },
  {
    id: 'en-numbers-large',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'The payment of two hundred and fifty thousand naira was approved on Friday.',
    protectedTokens: ['250000'],
    tests: 'large money amounts spoken in full',
  },
  {
    id: 'en-numbers-reference',
    tier: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    text: 'The reference number is seven four nine two six one.',
    protectedTokens: ['7', '4', '9', '2', '6', '1'],
    tests: 'digit strings read aloud, where one wrong digit is a wrong answer',
  },

  // ---------- reverse direction ----------
  {
    id: 'es-greeting',
    tier: 'synthetic',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text: 'Hola, buenos días. ¿Me escuchas bien?',
    tests: 'baseline conversational opening, reverse direction',
  },
  {
    id: 'es-numbers',
    tier: 'synthetic',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text: 'La reunión empieza a las nueve y treinta en la sala cuatro.',
    protectedTokens: ['nueve', 'treinta', 'cuatro'],
    tests: 'numbers, reverse direction',
  },
  {
    id: 'es-names',
    tier: 'synthetic',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text: 'La señora Nguyen habló con el doctor Okonkwo sobre el informe.',
    protectedTokens: ['Nguyen', 'Okonkwo'],
    tests: 'names surviving a different source language',
  },
  {
    id: 'es-long',
    tier: 'synthetic',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    text:
      'Quiero confirmar que la traducción funciona en ambas direcciones, porque necesitamos ' +
      'estar seguros antes de presentar esto a la dirección la semana que viene.',
    tests: 'long sentence, reverse direction',
  },
];

/**
 * The accent tier: real speech only.
 *
 * Synthesising Nigerian-accented English with a US voice would have every
 * provider score well on audio that does not represent the speaker — a
 * measurement that flatters everyone and predicts nothing. Until recordings
 * exist this tier reports UNMEASURED and no vendor verdict may be issued on it.
 *
 * Delivery should be natural conversational speech, not slow dictation: the
 * point is how a provider handles a real speaker, and dictation quietly removes
 * the very difficulty being measured.
 */
export const ACCENT_TIER = Object.freeze({
  dimension: 'nigerian-accented-english',
  status: 'unmeasured',
  blocksVendorVerdict: true,
  reason:
    'Requires recorded speech. A synthetic US voice would score every provider well on audio ' +
    'that does not represent the speaker, which is worse than no measurement.',
  howToSupply:
    'Record each line below as 16 kHz mono WAV into .videofy-bakeoff/corpus-audio/ named ' +
    'accent-1.wav … accent-8.wav. Speak naturally, at conversational pace. They are then scored ' +
    'exactly like every other utterance, against the transcripts below.',
  /** Scored automatically once the matching recordings appear. */
  utterances: [
    { id: 'accent-1', text: 'Good morning. I sent the revised document to Pastor Adeyemi yesterday.', protectedTokens: ['Adeyemi'] },
    { id: 'accent-2', text: 'Please schedule the meeting for eight fifteen tomorrow morning.', protectedTokens: ['eight', 'fifteen'] },
    { id: 'accent-3', text: 'The payment of two hundred and fifty thousand naira was approved on Friday.', protectedTokens: ['250000'] },
    { id: 'accent-4', text: 'Chuks Okafor will join us from Abuja before the presentation begins.', protectedTokens: ['Chuks', 'Okafor', 'Abuja'] },
    { id: 'accent-5', text: 'I need you to confirm the figures before we send the report to the ministry.' },
    { id: 'accent-6', text: 'The reference number is seven four nine two six one.', protectedTokens: ['7', '4', '9', '2', '6', '1'] },
    { id: 'accent-7', text: 'We have not approved the proposal yet, so please don’t send the final copy.' },
    { id: 'accent-8', text: 'Can everyone hear me clearly? I want to explain the next part before we continue.' },
  ].map((u) => ({ ...u, tier: 'accent', sourceLanguage: 'en', targetLanguage: 'es', tests: 'Nigerian-accented English, recorded' })),
});

/** Accent utterances whose recordings are actually present, so they can be scored. */
export function availableAccentUtterances(exists) {
  return ACCENT_TIER.utterances.filter((u) => exists(`${u.id}.wav`));
}

export function corpusFor(pair) {
  if (!pair) return CORPUS;
  const [source, target] = pair.split('-');
  return CORPUS.filter((u) => u.sourceLanguage === source && u.targetLanguage === target);
}
