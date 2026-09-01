/** @author masterzee001 */
/**
 * Source validation: a fluent speaker checks C7's source BEFORE anything is
 * translated, and never sees a candidate translation while doing it.
 *
 * THE CHECKPOINT-B RULING, and the reason for it. For French, Spanish and
 * Portuguese, C7 can obtain source. It cannot know the source is any good. A
 * reviewer handed a translation of a malformed sentence is being asked two
 * questions at once -- "is this sentence right" and "is this translation of it
 * right" -- and their answer will be filed as an answer to the second. Every
 * engine then scores badly on a row that was never a fair test, or scores well
 * on a row nobody should have been testing with.
 *
 * SO THE ORDER IS:
 *
 *     source only -> validate/correct -> freeze -> sha256
 *       -> run BOTH engines on the FROZEN source -> blind review
 *
 * THE VALIDATOR MUST NOT SEE CANDIDATE OUTPUT. That is not a UI preference: a
 * person who has read two translations of a sentence has an opinion about the
 * sentence that came from the translations. `validationItem()` builds the
 * validator's payload by naming the fields it copies, the same construction
 * `blindCandidate()` uses and for a related reason -- see `blind-review.ts`.
 *
 * IF A SOURCE IS CORRECTED, BOTH ENGINES ARE RERUN. Scoring engine A on the
 * original and engine B on the correction is not a comparison; it is two
 * measurements of different things reported as one. The frozen source carries a
 * sha256 and every candidate cites it, so a packet built against a superseded
 * source is refusable rather than merely regrettable.
 */

/** What a validator decides about one supplied sentence. */
export const SOURCE_VERDICTS = ['ACCEPT', 'CORRECT', 'REJECT'] as const;
export type SourceVerdict = (typeof SOURCE_VERDICTS)[number];

/** One sentence C7 supplied, as stored. */
export interface SourceItem {
  readonly ordinal: number;
  /** Grouping key, e.g. `money`. Carried through to results. */
  readonly category: string;
  /** The sentence as C7 supplied it. Never altered in place. */
  readonly suppliedText: string;
}

/** One sentence as the validator judged it. */
export interface SourceJudgement {
  readonly ordinal: number;
  readonly verdict: SourceVerdict;
  /**
   * The corrected sentence. Required on CORRECT, absent otherwise.
   *
   * A correction with no text is a verdict that says something changed and
   * cannot say what, which is worse than no verdict at all.
   */
  readonly correctedText?: string;
  readonly note?: string;
}

/** What a validator's browser receives. No candidate translation, by construction. */
export interface ValidationItemView {
  readonly ordinal: number;
  readonly category: string;
  readonly suppliedText: string;
}

/**
 * Build the validator's view of one supplied sentence.
 *
 * Field by field. A delete-list would be correct until somebody added a
 * `candidates` array to the stored shape, at which point it would ship.
 */
export function validationItem(item: SourceItem): ValidationItemView {
  return {
    ordinal: item.ordinal,
    category: item.category,
    suppliedText: item.suppliedText,
  };
}

export function validationPacket(items: readonly SourceItem[]): readonly ValidationItemView[] {
  return items.map(validationItem);
}

export const MAX_SOURCE_LENGTH = 2000;

export type SourceJudgementProblem =
  | { readonly kind: 'unknown-ordinal'; readonly ordinal: number }
  | { readonly kind: 'duplicate-ordinal'; readonly ordinal: number }
  | { readonly kind: 'unknown-verdict'; readonly ordinal: number }
  | { readonly kind: 'correction-missing'; readonly ordinal: number }
  | { readonly kind: 'too-long'; readonly ordinal: number };

export interface SourceJudgementReading {
  readonly judgements: readonly SourceJudgement[];
  readonly problems: readonly SourceJudgementProblem[];
  /** Every supplied sentence judged. Only then may the source be frozen. */
  readonly complete: boolean;
  readonly judged: number;
}

/** Read untrusted judgements against the sentences that were actually supplied. */
export function readSourceJudgements(
  items: readonly SourceItem[],
  input: unknown,
): SourceJudgementReading {
  const rows = Array.isArray(input) ? input : [];
  const problems: SourceJudgementProblem[] = [];
  const byOrdinal = new Map<number, SourceJudgement>();
  const supplied = new Set(items.map((item) => item.ordinal));

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const ordinal = typeof row['ordinal'] === 'number' ? row['ordinal'] : Number.NaN;
    if (!supplied.has(ordinal)) {
      problems.push({ kind: 'unknown-ordinal', ordinal });
      continue;
    }
    if (byOrdinal.has(ordinal)) {
      problems.push({ kind: 'duplicate-ordinal', ordinal });
      continue;
    }
    const verdict = row['verdict'];
    if (typeof verdict !== 'string' || !(SOURCE_VERDICTS as readonly string[]).includes(verdict)) {
      problems.push({ kind: 'unknown-verdict', ordinal });
      continue;
    }
    const corrected =
      typeof row['correctedText'] === 'string' ? row['correctedText'].trim() : '';
    const note = typeof row['note'] === 'string' ? row['note'].trim() : '';
    if (corrected.length > MAX_SOURCE_LENGTH || note.length > MAX_SOURCE_LENGTH) {
      problems.push({ kind: 'too-long', ordinal });
      continue;
    }
    if (verdict === 'CORRECT' && corrected.length === 0) {
      problems.push({ kind: 'correction-missing', ordinal });
      continue;
    }
    byOrdinal.set(ordinal, {
      ordinal,
      verdict: verdict as SourceVerdict,
      ...(corrected.length === 0 ? {} : { correctedText: corrected }),
      ...(note.length === 0 ? {} : { note }),
    });
  }

  const judgements = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  return {
    judgements,
    problems,
    complete: problems.length === 0 && judgements.length === items.length,
    judged: judgements.length,
  };
}

/**
 * The source as it stands after validation.
 *
 * ACCEPT keeps the supplied sentence; CORRECT takes the correction; REJECT
 * drops the sentence entirely -- a sentence a fluent speaker says is not a
 * sentence in their language should not be translated by anybody, and keeping
 * it "for completeness" would put a known-bad row into a benchmark.
 */
export interface ValidatedSourceItem {
  readonly ordinal: number;
  readonly category: string;
  readonly text: string;
  /** How this row got its text. Carried so a result can be read years later. */
  readonly verdict: SourceVerdict;
  /** Present only where the validator changed the sentence. */
  readonly suppliedText?: string;
}

export function applyJudgements(
  items: readonly SourceItem[],
  judgements: readonly SourceJudgement[],
): readonly ValidatedSourceItem[] {
  const byOrdinal = new Map(judgements.map((entry) => [entry.ordinal, entry]));
  const out: ValidatedSourceItem[] = [];
  for (const item of items) {
    const judgement = byOrdinal.get(item.ordinal);
    if (judgement === undefined || judgement.verdict === 'REJECT') continue;
    const corrected = judgement.verdict === 'CORRECT' ? (judgement.correctedText ?? '') : '';
    out.push({
      ordinal: item.ordinal,
      category: item.category,
      text: corrected.length > 0 ? corrected : item.suppliedText,
      verdict: judgement.verdict,
      ...(corrected.length > 0 ? { suppliedText: item.suppliedText } : {}),
    });
  }
  return out;
}

/**
 * The bytes hashed when a validated source is frozen.
 *
 * The SAME canonical form the elicitation corpus uses -- sorted keys, Python's
 * `json.dumps` separators, non-ASCII left alone -- so one hashing rule covers
 * both kinds of frozen source and a reader comparing two fingerprints is
 * comparing like with like. See `freeze.ts` for why that form and not
 * `JSON.stringify`.
 */
export function canonicalSourceBody(items: readonly ValidatedSourceItem[]): string {
  return serialise(
    items.map((item) => ({
      category: item.category,
      ordinal: item.ordinal,
      text: item.text,
      verdict: item.verdict,
    })),
  );
}

function serialise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialise).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}: ${serialise(inner)}`).join(', ')}}`;
}

export type SourceFreezeRefusal = 'incomplete' | 'malformed' | 'already-frozen' | 'nothing-usable';

export type SourceFreezeResult =
  | { readonly ok: true; readonly items: readonly ValidatedSourceItem[]; readonly sha256: string }
  | { readonly ok: false; readonly reason: SourceFreezeRefusal; readonly detail?: string };

/**
 * Freeze a validated source, or refuse and say why.
 *
 * `nothing-usable` is its own refusal rather than an empty success: a validator
 * who rejected every sentence has told C7 something important about the source
 * it supplied, and silently freezing an empty set would file that as a finished
 * assessment.
 */
export function freezeValidatedSource(request: {
  readonly items: readonly SourceItem[];
  readonly judgements: unknown;
  readonly alreadyFrozen: boolean;
  readonly digest: (body: string) => string;
}): SourceFreezeResult {
  if (request.alreadyFrozen) return { ok: false, reason: 'already-frozen' };

  const reading = readSourceJudgements(request.items, request.judgements);
  const malformed = reading.problems.filter((problem) => problem.kind !== 'correction-missing');
  if (malformed.length > 0) {
    return {
      ok: false,
      reason: 'malformed',
      detail: malformed.map((problem) => `${problem.kind}:${problem.ordinal}`).join(','),
    };
  }
  if (!reading.complete) {
    const missing = request.items
      .map((item) => item.ordinal)
      .filter((ordinal) => !reading.judgements.some((entry) => entry.ordinal === ordinal))
      .concat(
        reading.problems
          .filter((problem) => problem.kind === 'correction-missing')
          .map((problem) => problem.ordinal),
      );
    return { ok: false, reason: 'incomplete', detail: [...new Set(missing)].join(',') };
  }

  const items = applyJudgements(request.items, reading.judgements);
  if (items.length === 0) return { ok: false, reason: 'nothing-usable' };
  return { ok: true, items, sha256: request.digest(canonicalSourceBody(items)) };
}

/** Whether any sentence was changed, which is what makes a rerun necessary. */
export function wasCorrected(items: readonly ValidatedSourceItem[]): boolean {
  return items.some((item) => item.verdict === 'CORRECT');
}
