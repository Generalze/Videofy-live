/** @author masterzee001 */
/**
 * Blind translation review: the ten questions, and the identity the reviewer
 * must never be handed.
 *
 * WHY BLIND. Automatic checks have already been run on this material and they
 * were wrong three times on Yoruba-adjacent judgements. Showing a reviewer what
 * a machine thought -- or which engine produced which line, or which one is
 * expected to win -- replaces their judgement with a prior. The reviewer is the
 * instrument; a biased instrument is worse than none, because its output still
 * looks like evidence.
 *
 * SO THE REDACTION IS STRUCTURAL, NOT EDITORIAL. `blindCandidate` builds the
 * reviewer's payload by CONSTRUCTION -- naming each field it copies -- rather
 * than by deleting `provider` and `model` from the stored record. A delete-list
 * is correct until somebody adds `engineFamily` or `benchmarkRank` to the
 * stored shape, at which point it ships silently. A build-list fails to compile
 * instead, or at worst omits something harmless.
 *
 * QUESTION 2 IS THE ONE THAT MATTERS. "Meaning REVERSED" outranks the other
 * nine: a translation that turns "I have received the money" into "I have NOT
 * received the money" is somebody losing money or missing a warning, and
 * beautiful-but-reversed is worse than awkward-but-correct. The order below is
 * the order on the existing paper packet, and it is not alphabetical or
 * grouped by type for that reason.
 */

/**
 * The stored candidate, server-side. Carries the identity.
 *
 * This shape must never be serialised to a reviewer. Nothing in this module
 * returns it, and the only function that accepts it returns something else.
 */
export interface StoredCandidate {
  /** Opaque. The only id the reviewer ever sees. */
  readonly candidateId: string;
  readonly assignmentId: string;
  /** Position in the packet, 1-based. */
  readonly ordinal: number;
  /** e.g. `en->yo`. Shown: the reviewer must know which way round it is. */
  readonly direction: string;
  /** Grouping key for repeated source sentences. Shown; carries no identity. */
  readonly category: string;
  readonly sourceText: string;
  readonly candidateText: string;
  /* ---- everything below is withheld from the reviewer ---- */
  readonly provider: string;
  readonly model: string;
  /** What a machine check thought. Withheld: it has been wrong. */
  readonly machineScore?: number;
  /** Where this engine sits on the current benchmark. Withheld. */
  readonly benchmarkRank?: number;
  /** Whether C7 expects this one to win. Withheld, obviously. */
  readonly expectedWinner?: boolean;
}

/** What the reviewer's browser receives. No identity, by construction. */
export interface BlindCandidate {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly direction: string;
  readonly category: string;
  readonly sourceText: string;
  readonly candidateText: string;
}

/**
 * Build the reviewer's view of one candidate.
 *
 * Field by field. See the module note on why this is not a delete.
 */
export function blindCandidate(stored: StoredCandidate): BlindCandidate {
  return {
    candidateId: stored.candidateId,
    ordinal: stored.ordinal,
    direction: stored.direction,
    category: stored.category,
    sourceText: stored.sourceText,
    candidateText: stored.candidateText,
  };
}

export function blindPacket(stored: readonly StoredCandidate[]): readonly BlindCandidate[] {
  return stored.map(blindCandidate);
}

/**
 * The field names that identify an engine.
 *
 * Exported so a test can assert they appear nowhere in a serialised reviewer
 * payload -- including nested inside one, which a shape-by-shape assertion
 * would miss. It is a belt beside the braces of `blindCandidate`.
 */
export const WITHHELD_FIELDS = [
  'provider',
  'model',
  'machineScore',
  'benchmarkRank',
  'expectedWinner',
] as const;

/* -------------------------------------------------------------------------- */
/*  The ten questions                                                          */
/* -------------------------------------------------------------------------- */

/** A yes/no judgement. `null` is "not answered yet", never "no". */
export type YesNo = 'yes' | 'no';

/** 1-5. Not a percentage, not a star rating; the packet asks for a number. */
export type Score = 1 | 2 | 3 | 4 | 5;

/**
 * The criteria, in packet order, with the exact question text.
 *
 * `adverse` records which ANSWER is the bad one, because it is not the same for
 * every row: "meaning preserved: no" and "meaning reversed: yes" are both
 * failures. Without it, any code summarising a packet has to carry its own
 * table of which way each question points, and the first such table to drift
 * turns a passing engine into a failing one.
 */
export interface ReviewCriterion {
  readonly key: string;
  readonly question: string;
  readonly kind: 'yes-no' | 'score';
  /** For yes/no rows: the answer that indicates a defect. */
  readonly adverse?: YesNo;
}

export const REVIEW_CRITERIA: readonly ReviewCriterion[] = [
  { key: 'meaningPreserved', question: 'Meaning preserved?', kind: 'yes-no', adverse: 'no' },
  { key: 'meaningReversed', question: 'Meaning REVERSED?', kind: 'yes-no', adverse: 'yes' },
  { key: 'informationOmitted', question: 'Information omitted?', kind: 'yes-no', adverse: 'yes' },
  { key: 'informationInvented', question: 'Information invented?', kind: 'yes-no', adverse: 'yes' },
  {
    key: 'namesNumbersCorrupted',
    question: 'Names/numbers corrupted?',
    kind: 'yes-no',
    adverse: 'yes',
  },
  { key: 'naturalness', question: 'Natural for a native speaker? 1-5', kind: 'score' },
  { key: 'grammar', question: 'Grammar? 1-5', kind: 'score' },
  {
    key: 'trustInRealChat',
    question: 'Would you trust this in a real private chat?',
    kind: 'yes-no',
    adverse: 'no',
  },
];

/**
 * The question whose answer outranks the rest. Named, not implied by position.
 */
export const DECISIVE_CRITERION = 'meaningReversed';

/* -------------------------------------------------------------------------- */
/*  Observed language                                                          */
/* -------------------------------------------------------------------------- */

/**
 * "What language is this output actually written in?"
 *
 * A STRUCTURED, REQUIRED OBSERVATION -- not a note. C7 has already watched an
 * engine answer Portuguese in Italian. That is a distinct failure class from a
 * bad translation: every other question on the packet assumes the output is in
 * the target language at all, so a reviewer meeting Italian has nowhere honest
 * to put it except the free-text note, where it becomes unqueryable prose that
 * no result ever counts.
 *
 * PER TARGET LANGUAGE, AND OPT-IN. The confusable set differs by language --
 * Portuguese is confused with Italian and Spanish; another target would have
 * its own neighbours -- so this is a table keyed by language rather than one
 * global list, and a language that has shown no such failure is not asked. The
 * shape is deliberately general enough that adding a language is one entry.
 *
 * `Unsure` is a real option. A reviewer who cannot tell Spanish from Portuguese
 * in a short sentence should be able to say so; forcing a guess would put a
 * guess into evidence indistinguishable from a judgement.
 */
export interface ObservedLanguageQuestion {
  readonly question: string;
  /** Ordered as shown. The target language first, then its confusables. */
  readonly options: readonly string[];
}

const OBSERVED_LANGUAGE_QUESTIONS: Readonly<Record<string, ObservedLanguageQuestion>> = {
  pt: {
    question: 'What language is this output actually written in?',
    options: ['Portuguese', 'Italian', 'Spanish', 'Other', 'Unsure'],
  },
};

/**
 * The observed-language question for a target language, or null if it does not
 * ask one.
 *
 * Null rather than an empty question, so a caller has to decide what to do
 * about its absence instead of rendering an empty control.
 */
export function observedLanguageQuestion(language: string): ObservedLanguageQuestion | null {
  return OBSERVED_LANGUAGE_QUESTIONS[language] ?? null;
}

/** Languages that ask it. Exported so the operator console can say which. */
export const OBSERVED_LANGUAGE_LANGUAGES: readonly string[] =
  Object.keys(OBSERVED_LANGUAGE_QUESTIONS);

/** A completed judgement of one candidate. */
export interface ReviewVerdict {
  readonly candidateId: string;
  readonly meaningPreserved: YesNo;
  readonly meaningReversed: YesNo;
  readonly informationOmitted: YesNo;
  readonly informationInvented: YesNo;
  readonly namesNumbersCorrupted: YesNo;
  readonly naturalness: Score;
  readonly grammar: Score;
  readonly trustInRealChat: YesNo;
  /**
   * Which language the output is actually IN.
   *
   * Present exactly when the target language asks the question, and required
   * then. It is not optional-with-a-default: "Portuguese" recorded because
   * nobody answered is a claim the reviewer never made.
   */
  readonly observedLanguage?: string;
  /** Optional. Genuinely useful on the rows marked reversed. */
  readonly correctedTranslation?: string;
  readonly note?: string;
}

const YES_NO_KEYS = [
  'meaningPreserved',
  'meaningReversed',
  'informationOmitted',
  'informationInvented',
  'namesNumbersCorrupted',
  'trustInRealChat',
] as const;

const SCORE_KEYS = ['naturalness', 'grammar'] as const;

/** A generous ceiling on the free-text fields; see `elicitation.ts`. */
export const MAX_NOTE_LENGTH = 2000;

export type VerdictProblem =
  | { readonly kind: 'missing'; readonly field: string }
  | { readonly kind: 'not-yes-no'; readonly field: string }
  | { readonly kind: 'not-a-score'; readonly field: string }
  | { readonly kind: 'not-an-option'; readonly field: string }
  | { readonly kind: 'too-long'; readonly field: string };

export type VerdictReading =
  | { readonly ok: true; readonly verdict: ReviewVerdict }
  | { readonly ok: false; readonly problems: readonly VerdictProblem[] };

function yesNo(value: unknown): YesNo | null {
  if (value === 'yes' || value === 'no') return value;
  /*
   * Booleans are accepted because a checkbox-shaped client is the obvious thing
   * somebody builds next, and silently reading `true` as "not a yes/no" would
   * be a validation error nobody could interpret. They are NORMALISED to the
   * words, so storage never holds two representations of one answer.
   */
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return null;
}

function score(value: unknown): Score | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 5 ? (value as Score) : null;
}

/**
 * Read an untrusted verdict body.
 *
 * EVERY YES/NO IS REQUIRED. The paper instructions say "please answer every
 * yes/no question", and an unanswered one stored as a default would be
 * indistinguishable from a judgement the reviewer actually made. The two free
 * text fields are the only optional ones.
 *
 * `language` decides whether the observed-language question is asked, and it is
 * REQUIRED where it is asked. Passing no language reads a verdict with no such
 * question, which is right for the languages that do not ask one and is why the
 * parameter is optional rather than the answer being optional.
 */
export function readVerdict(
  candidateId: string,
  input: unknown,
  options: { readonly language?: string } = {},
): VerdictReading {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const problems: VerdictProblem[] = [];
  const answers: Record<string, YesNo | Score> = {};

  for (const key of YES_NO_KEYS) {
    const value = yesNo(body[key]);
    if (value === null) {
      problems.push(
        body[key] === undefined
          ? { kind: 'missing', field: key }
          : { kind: 'not-yes-no', field: key },
      );
      continue;
    }
    answers[key] = value;
  }
  for (const key of SCORE_KEYS) {
    const value = score(body[key]);
    if (value === null) {
      problems.push(
        body[key] === undefined
          ? { kind: 'missing', field: key }
          : { kind: 'not-a-score', field: key },
      );
      continue;
    }
    answers[key] = value;
  }

  const text = (key: 'correctedTranslation' | 'note'): string | null => {
    const raw = body[key];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_NOTE_LENGTH) {
      problems.push({ kind: 'too-long', field: key });
      return null;
    }
    return trimmed;
  };
  const correctedTranslation = text('correctedTranslation');
  const note = text('note');

  /*
   * The observed language, where the target asks for it. Validated against the
   * OFFERED options rather than accepted as free text: the whole reason this is
   * a structured field is that a note cannot be counted, and a field that
   * accepts anything is a note with a different name.
   */
  const asks =
    options.language === undefined ? null : observedLanguageQuestion(options.language);
  let observedLanguage: string | null = null;
  if (asks !== null) {
    const raw = body['observedLanguage'];
    if (raw === undefined) {
      problems.push({ kind: 'missing', field: 'observedLanguage' });
    } else if (typeof raw !== 'string' || !asks.options.includes(raw)) {
      problems.push({ kind: 'not-an-option', field: 'observedLanguage' });
    } else {
      observedLanguage = raw;
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  /*
   * `exactOptionalPropertyTypes` is on across this repository, so an absent
   * optional must be an absent PROPERTY rather than a present undefined one.
   */
  return {
    ok: true,
    verdict: {
      candidateId,
      meaningPreserved: answers['meaningPreserved'] as YesNo,
      meaningReversed: answers['meaningReversed'] as YesNo,
      informationOmitted: answers['informationOmitted'] as YesNo,
      informationInvented: answers['informationInvented'] as YesNo,
      namesNumbersCorrupted: answers['namesNumbersCorrupted'] as YesNo,
      naturalness: answers['naturalness'] as Score,
      grammar: answers['grammar'] as Score,
      trustInRealChat: answers['trustInRealChat'] as YesNo,
      ...(observedLanguage === null ? {} : { observedLanguage }),
      ...(correctedTranslation === null ? {} : { correctedTranslation }),
      ...(note === null ? {} : { note }),
    },
  };
}
