// Videofy Live — C-AI1.0 bake-off scoring.
//
// Vendor-neutral by construction: every provider returns the same shape and is
// scored by this module alone, so a result can only differ because the provider
// differed. Nothing here talks to a network or a vendor SDK.
//
// The quality measures exist because of what real calls actually produced:
// invented words (the recogniser writing dialogue on silence), dropped words,
// and damage at sentence boundaries where a chunk was cut mid-clause. Names and
// numbers are counted separately because "Mr Chux" and "eight o'clock" are the
// parts of an official conversation that must not be approximated.

/** Words that carry no meaning on their own; excluded from content scoring. */
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'so',
  'i', 'you', 'it', 'that', 'this', 'we', 'they', 'he', 'she',
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'o', 'en', 'que',
  'le', 'les', 'des', 'du', 'et', 'à', 'au', 'aux', 'ce', 'qui',
]);

/**
 * Number words to digits, so "eight fifteen" and "8.15" compare equal.
 *
 * Without this the bake-off would be rigged. Commercial recognisers normalise
 * numbers to digits by default while the local baseline spells them out, so a
 * correct "9" would have scored as a miss against "nine" and every cloud
 * candidate would have looked worse at exactly the measure — numbers — that an
 * official conversation cares most about.
 */
const NUMBER_WORDS = new Map(Object.entries({
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40',
  fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
  seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10', once: '11',
  doce: '12', trece: '13', catorce: '14', quince: '15', veinte: '20',
  treinta: '30', cuarenta: '40', cincuenta: '50',
  un: '1', deux: '2', trois: '3', quatre: '4', cinq: '5', six_fr: '6',
  sept: '7', huit: '8', neuf: '9', dix: '10', quinze: '15', vingt: '20',
  trente: '30', quarante: '40', cinquante: '50',
}));

/** Digits with separators become bare digit runs: "8.15" -> "8" "15". */
function normalizeNumeric(token) {
  if (NUMBER_WORDS.has(token)) return NUMBER_WORDS.get(token);
  return token;
}

/** Lowercase, strip punctuation, keep letters/digits across our languages. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    // Separators inside numbers become boundaries, so "8.15" reads as 8 and 15.
    .replace(/(?<=\d)[.,:](?=\d)/g, ' ')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeNumeric);
}

/**
 * Levenshtein distance over WORDS, plus the aligned operation counts.
 *
 * Word error rate alone hides which way a provider fails. A recogniser that
 * invents text and one that drops it can score the same and are not the same
 * problem, so insertions and deletions are reported separately.
 */
export function alignWords(expected, actual) {
  const a = tokenize(expected);
  const b = tokenize(actual);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dist[i][0] = i;
  for (let j = 0; j < cols; j += 1) dist[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  // Walk back to separate substitutions, insertions and deletions.
  let i = a.length;
  let j = b.length;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && dist[i][j] === dist[i - 1][j - 1] + 1) {
      substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (j > 0 && dist[i][j] === dist[i][j - 1] + 1) {
      insertions += 1;
      j -= 1;
    } else {
      deletions += 1;
      i -= 1;
    }
  }
  const referenceWords = a.length;
  return {
    referenceWords,
    substitutions,
    /** Words the provider produced that were never said. */
    insertions,
    /** Words that were said and never came back. */
    deletions,
    wordErrorRate: referenceWords === 0 ? 0 : (substitutions + insertions + deletions) / referenceWords,
  };
}

/** Content words present in the reference that survived, ignoring filler. */
export function contentRecall(expected, actual) {
  // Digits count as content however short: "9" is the whole point of a
  // sentence about platform nine, and dropping it for being one character
  // would hide exactly the failure this measure exists to catch.
  const wanted = tokenize(expected).filter(
    (w) => !FILLER.has(w) && (w.length > 2 || /^\d+$/.test(w)),
  );
  if (wanted.length === 0) return 1;
  const heard = new Set(tokenize(actual));
  return wanted.filter((w) => heard.has(w)).length / wanted.length;
}

/**
 * Whether each protected token survived verbatim.
 *
 * Names and numbers are scored strictly and separately: an approximated name or
 * a wrong figure is a different class of failure from a clumsy paraphrase, and
 * it is the class that matters in an official conversation.
 */
export function protectedTokenAccuracy(protectedTokens, actual) {
  if (!protectedTokens || protectedTokens.length === 0) return null;
  const heard = tokenize(actual);
  const heardText = heard.join(' ');
  let survived = 0;
  for (const token of protectedTokens) {
    const needle = tokenize(token).join(' ');
    if (needle && heardText.includes(needle)) survived += 1;
  }
  return { total: protectedTokens.length, survived, rate: survived / protectedTokens.length };
}

/**
 * Did the utterance come back as one thought, or in pieces?
 *
 * Boundary damage is the batch pipeline's signature failure — a clause cut at a
 * chunk ceiling arrives as an orphan fragment that the recogniser completes by
 * inventing. Counted as extra segments beyond the one utterance that was said.
 */
export function boundaryDamage(segmentCount) {
  return Math.max(0, (segmentCount ?? 1) - 1);
}

/** P50/P90/P95 for a set of samples; null when nothing was measured. */
export function percentiles(samples) {
  const values = (samples ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/**
 * Effective cost per translated participant-minute.
 *
 * The point of the measure: a provider is not billed per call minute, it is
 * billed for what the chain consumes. One speaker translated into two languages
 * pays speech input once but translation and synthesis twice, so a nominally
 * cheap rate can land in a different band once the call has more than two
 * people in it.
 */
export function effectiveCostPerParticipantMinute(usage) {
  const {
    speechInputMinutes = 0,
    speechInputRate = 0,
    translationUnits = 0,
    translationRate = 0,
    synthesizedMinutes = 0,
    synthesizedRate = 0,
    sessionCharge = 0,
    targetLanguages = 1,
    conversationMinutes = 0,
  } = usage ?? {};
  if (conversationMinutes <= 0) return null;
  const cost =
    speechInputMinutes * speechInputRate +
    translationUnits * translationRate * targetLanguages +
    synthesizedMinutes * synthesizedRate * targetLanguages +
    sessionCharge;
  return cost / conversationMinutes;
}

/** Owner-set decision bands for C-AI1.0. */
export const COST_BANDS = [
  { limit: 0.05, verdict: 'target' },
  { limit: 0.08, verdict: 'acceptable-for-premium-quality' },
  { limit: 0.1, verdict: 'requires-business-justification' },
  { limit: Infinity, verdict: 'red-flag' },
];

export function costVerdict(costPerParticipantMinute) {
  if (costPerParticipantMinute === null || costPerParticipantMinute === undefined) return 'unmeasured';
  return COST_BANDS.find((band) => costPerParticipantMinute <= band.limit).verdict;
}

/** Scores one utterance from a provider run against what was actually said. */
export function scoreUtterance(expected, result) {
  const alignment = alignWords(expected.text, result.transcript ?? '');
  return {
    id: expected.id,
    sourceLanguage: expected.sourceLanguage,
    targetLanguage: expected.targetLanguage ?? null,
    expected: expected.text,
    transcript: result.transcript ?? '',
    translation: result.translation ?? null,
    ...alignment,
    contentRecall: contentRecall(expected.text, result.transcript ?? ''),
    protectedTokens: protectedTokenAccuracy(expected.protectedTokens, result.transcript ?? ''),
    boundaryDamage: boundaryDamage(result.segmentCount),
    timings: result.timings ?? {},
  };
}

/** Rolls per-utterance scores into the comparable summary for one provider. */
export function summarize(providerName, scored, usage) {
  const stage = (key) => percentiles(scored.map((s) => s.timings?.[key]));
  const totalReference = scored.reduce((sum, s) => sum + s.referenceWords, 0);
  const sum = (key) => scored.reduce((total, s) => total + (s[key] ?? 0), 0);
  const protectedTotals = scored.reduce(
    (acc, s) => {
      if (!s.protectedTokens) return acc;
      return { total: acc.total + s.protectedTokens.total, survived: acc.survived + s.protectedTokens.survived };
    },
    { total: 0, survived: 0 },
  );
  const cost = effectiveCostPerParticipantMinute(usage);
  return {
    provider: providerName,
    utterances: scored.length,
    latency: {
      firstPartialTranscriptMs: stage('firstPartialTranscriptMs'),
      stableTranscriptMs: stage('stableTranscriptMs'),
      firstTranslatedTextMs: stage('firstTranslatedTextMs'),
      firstTranslatedAudioMs: stage('firstTranslatedAudioMs'),
      utteranceCompleteMs: stage('utteranceCompleteMs'),
    },
    quality: {
      wordErrorRate: totalReference === 0 ? null : (sum('substitutions') + sum('insertions') + sum('deletions')) / totalReference,
      inventedWords: sum('insertions'),
      droppedWords: sum('deletions'),
      substitutions: sum('substitutions'),
      sentenceBoundaryDamage: sum('boundaryDamage'),
      contentRecall: scored.length === 0 ? null : scored.reduce((t, s) => t + s.contentRecall, 0) / scored.length,
      protectedTokenAccuracy: protectedTotals.total === 0 ? null : protectedTotals.survived / protectedTotals.total,
    },
    economics: {
      ...(usage ?? {}),
      effectiveCostPerParticipantMinute: cost,
      verdict: costVerdict(cost),
    },
  };
}
