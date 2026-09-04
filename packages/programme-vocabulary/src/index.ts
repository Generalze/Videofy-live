/** @author masterzee001 */
/**
 * Programme vocabulary: the words a programme must not get wrong.
 *
 * WHAT THIS IS FOR. A broadcast is full of terms a general model has never
 * seen and will cheerfully mangle: a presenter's name, a town, a sponsor, a
 * scheme with an acronym. The Phase-1 screen watched an engine turn `Adebayo`
 * into `Adebaya` and `Lagos` into something else again, and those are the
 * cases an audience notices first because they are the ones they know.
 *
 * WHAT IT IS NOT. Not a form that stores rows nobody reads. Every field here
 * has exactly one consumer and the consumer is named:
 *
 *   doNotTranslate     -> the translation gate protects it like an identifier
 *   canonicalRendering -> the agreed spelling, substituted after translation
 *   sttKeyterm         -> sent to the recogniser as a keyterm
 *   pronunciationHint  -> handed to synthesis where the voice supports it
 *
 * A term with `enabled: false` reaches none of them. A field with no consumer
 * on a given deployment is reported as unconsumed rather than silently stored,
 * because "we saved your vocabulary" and "your vocabulary changed the output"
 * are different promises and only the second one is worth making.
 */

export type VocabularyKind =
  | 'person'
  | 'place'
  | 'organisation'
  | 'programme-term'
  | 'code';

export interface VocabularyEntry {
  readonly id: string;
  /** As an operator typed it. The lookup key against transcript text. */
  readonly term: string;
  /**
   * The spelling everyone agreed on.
   *
   * Empty means "however the engine renders it". Set, it is substituted after
   * translation, so `Zoe` does not come back as `Zoé` in French output.
   */
  readonly canonicalRendering: string;
  /** BCP-47-ish tag, or '*' for every language on the programme. */
  readonly language: string;
  /** For a voice that supports it. Never invented; empty when unknown. */
  readonly pronunciationHint: string;
  /** Protected through translation exactly like a phone number. */
  readonly doNotTranslate: boolean;
  /** Offered to the recogniser so it hears the word at all. */
  readonly sttKeyterm: boolean;
  readonly kind: VocabularyKind;
  readonly notes: string;
  readonly enabled: boolean;
}

export interface VocabularyConsumption {
  /** Terms the translation gate must protect. */
  readonly doNotTranslate: readonly string[];
  /** term -> agreed spelling, applied after translation. */
  readonly canonical: ReadonlyMap<string, string>;
  /** Terms offered to the recogniser. */
  readonly sttKeyterms: readonly string[];
  /** term -> hint, for synthesis engines that accept one. */
  readonly pronunciation: ReadonlyMap<string, string>;
  /**
   * Fields that were set and have NO consumer on this deployment.
   *
   * Surfaced so the console can say "stored, not used" rather than implying an
   * effect that does not exist. An operator who believes a pronunciation hint
   * is being applied, when nothing reads it, has been misled by the software.
   */
  readonly unconsumed: readonly string[];
}

export interface ConsumptionCapabilities {
  /** The recogniser accepts keyterms (Deepgram nova-3 does). */
  readonly sttKeyterms: boolean;
  /** The synthesis route accepts a pronunciation hint. */
  readonly pronunciationHints: boolean;
}

/**
 * Turn the stored rows into exactly what each consumer needs, for one language.
 *
 * `language` selects entries tagged for it plus the `*` entries. A Yoruba
 * programme does not want a French-only spelling, and a term marked `*` is the
 * operator saying it never changes.
 */
export function resolveConsumption(
  entries: readonly VocabularyEntry[],
  language: string,
  capabilities: ConsumptionCapabilities = { sttKeyterms: true, pronunciationHints: false },
): VocabularyConsumption {
  const active = entries.filter(
    (e) =>
      e.enabled &&
      e.term.trim() !== '' &&
      (e.language === '*' || sameLanguage(e.language, language)),
  );

  const canonical = new Map<string, string>();
  const pronunciation = new Map<string, string>();
  const doNotTranslate: string[] = [];
  const sttKeyterms: string[] = [];
  const unconsumed = new Set<string>();

  for (const entry of active) {
    if (entry.doNotTranslate) doNotTranslate.push(entry.term);
    if (entry.canonicalRendering.trim() !== '') {
      canonical.set(entry.term, entry.canonicalRendering);
    }
    if (entry.sttKeyterm) {
      if (capabilities.sttKeyterms) sttKeyterms.push(entry.term);
      else unconsumed.add('sttKeyterm');
    }
    if (entry.pronunciationHint.trim() !== '') {
      if (capabilities.pronunciationHints) pronunciation.set(entry.term, entry.pronunciationHint);
      else unconsumed.add('pronunciationHint');
    }
    // `notes` and `kind` are for the humans who maintain the list. They are
    // deliberately not consumed and deliberately not reported as unconsumed:
    // an operator's own memo is not a broken promise.
  }

  return {
    doNotTranslate,
    canonical,
    sttKeyterms,
    pronunciation,
    unconsumed: [...unconsumed],
  };
}

/**
 * Apply the agreed spellings to a finished translation.
 *
 * Case-insensitive, whole-word, longest term first -- so `First Bank of Lagos`
 * wins over `Lagos` and a substitution cannot chop a longer agreed name in
 * half.
 *
 * WHAT IT CANNOT DO, and the console must not imply otherwise: it can only fix
 * a rendering somebody LISTED. If an engine emits `Zoe` with an accent and the
 * operator entered only the unaccented form, nothing matches and nothing is
 * corrected. This substitutes known spellings; it does not detect unknown ones.
 * An operator told "add the term and the spelling is guaranteed" would be
 * misled the first time a model invented a new variant.
 */
export function applyCanonicalRenderings(
  text: string,
  canonical: ReadonlyMap<string, string>,
): string {
  let out = text;
  const terms = [...canonical.keys()].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const replacement = canonical.get(term);
    if (replacement === undefined || term.trim() === '') continue;
    /*
     * UNICODE-AWARE BOUNDARIES, not `\b`.
     *
     * JavaScript's `\b` is ASCII-based even under the `u` flag, so there is no
     * boundary after the `e` in `Zoé` and `\bZoé\b` never matches at all. That
     * would have failed SILENTLY for every accented term -- which for this
     * product means Yoruba and Igbo: `Ẹkun`, `ụtụtụ`, `Abéòkúta`. An operator
     * would have entered the term, seen it saved, and watched it do nothing.
     * The lookarounds treat any letter or digit as "inside a word", in any
     * script.
     */
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu'),
      replacement,
    );
  }
  return out;
}

function sameLanguage(a: string, b: string): boolean {
  return base(a) === base(b);
}

function base(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Provider-safe bounds for the list handed to a recogniser.
 *
 * A recogniser will not accept an unbounded keyterm list, and a programme's
 * vocabulary is operator-entered, so it can grow without anyone deciding it
 * should. Bounding it here -- once, centrally -- means no consumer invents its
 * own ceiling and no request is refused wholesale because one term was absurd.
 */
export interface KeytermLimits {
  readonly maxCount: number;
  readonly maxTermLength: number;
}

export const KEYTERM_LIMITS: KeytermLimits = { maxCount: 100, maxTermLength: 80 };

/**
 * The one place a keyterm list is made fit to send.
 *
 * Trimmed, emptied entries dropped, duplicates removed without regard to case,
 * and cut to the provider's ceiling. Order is preserved rather than sorted:
 * the store reads `ORDER BY term`, so the input is already deterministic, and
 * preserving it means the cap keeps a stable, explicable set rather than
 * whichever terms a second sort happened to favour.
 *
 * An over-long term is DROPPED, never truncated. Half a name is a different
 * word, and teaching a recogniser to expect it is worse than not asking.
 */
export function normaliseKeyterms(
  terms: readonly string[],
  limits: KeytermLimits = KEYTERM_LIMITS,
): readonly string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term === '' || term.length > limits.maxTermLength) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(term);
    if (kept.length >= limits.maxCount) break;
  }
  return kept;
}
