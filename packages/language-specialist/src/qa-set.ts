/** @author masterzee001 */
/**
 * A route QA set: the sentences a language's translation routes are judged on,
 * as one immutable, content-addressed thing.
 *
 * WHY IT HAS TO BE CONTENT-ADDRESSED. `RouteReviewEvidence` in
 * `@videofy-live/translation-routes` carries `corpusHash` and `corpusVersion`
 * so that a score can be tied to exactly the sentences that produced it. A
 * score with no corpus behind it is a number somebody typed. So a QA set is
 * hashed over its content the moment it is published, the hash is its identity
 * for every later result, and there is no edit path: a changed sentence is a
 * NEW set with a new hash, and evidence citing the old hash still describes the
 * old set. That is the same rule the frozen corpus follows, for the same reason
 * (`freeze.ts`).
 *
 * THE ENGINE IS IN THE SET AND NEVER IN THE REVIEWER'S VIEW. Every item names
 * the provider and model that produced its candidate, because aggregation has
 * to score per (direction, model) -- the Yoruba packet is a blind head-to-head
 * of two engines, and one score across both would be half about a model nobody
 * is approving. The reviewer sees none of it: items become `StoredCandidate`s
 * when a specialist picks the set up, and `blindCandidate` builds the payload
 * from there by naming the fields it copies. The engine table is also kept
 * separately as `engines`, with the model VERSION, so the evidence can say
 * which build of the model was read without carrying a version on every row.
 *
 * NO CRYPTO IN THIS FILE. The digest arrives as a function, exactly as
 * `freezeCorpus` takes it, so this module stays importable from the portal.
 */
import { canonicalJson, type Digest } from './freeze.js';
import { trackFor } from './tracks.js';

/** One engine represented in a set. `modelVersion` is what the evidence cites. */
export interface QaSetEngine {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
}

/**
 * One sentence and one engine's rendering of it.
 *
 * `direction` is `source->target` in BCP-47 base subtags, as the route registry
 * writes it. One side must be the set's language and the other side must be
 * `QA_SET_REFERENCE_LANGUAGE`; see the note on that constant.
 */
export interface QaSetItem {
  /** Position in the set, 1-based, unique. Withheld from the reviewer. */
  readonly ordinal: number;
  readonly direction: string;
  readonly category: string;
  readonly sourceText: string;
  readonly candidateText: string;
  /* ---- withheld from the reviewer ---- */
  readonly provider: string;
  readonly model: string;
}

/** What an operator publishes. Untrusted until `readQaSetDefinition` has read it. */
export interface QaSetDefinition {
  readonly language: string;
  /**
   * A human label for this version of the set, e.g. `review-packets/2026-09-25`.
   * It becomes `corpusVersion`; the hash becomes `corpusHash`. Both are cited,
   * because a label can be reused by mistake and a hash cannot.
   */
  readonly version: string;
  readonly engines: readonly QaSetEngine[];
  readonly items: readonly QaSetItem[];
  /** Where the sentences came from: a packet path, a script run, a ticket. */
  readonly sourceReference: string;
}

/** A generous ceiling per text field. Chat lines are short; a runaway is not one. */
export const MAX_QA_TEXT_LENGTH = 4000;

/**
 * A set has to be big enough to say something. Ten is the paper packet's floor.
 * This floors the SET; `ROUTE_QA_MIN_JUDGED_PER_GROUP` in `route-review.ts`
 * floors each (direction, engine) group a score is computed over, and it is
 * the larger number.
 */
export const MIN_QA_SET_ITEMS = 10;

/**
 * THE OTHER SIDE OF EVERY DIRECTION IN A SET IS ENGLISH.
 *
 * A reviewer must not be asked to judge a language they were not assessed in,
 * and the rule has to come from what the programme actually assesses. Every
 * track -- elicitation (yo, ha, ig) and validation (fr, es, pt) alike --
 * assesses a person in exactly two languages: their own, and English. The
 * elicitation form demands an English semantic reference beside every native
 * message (`ENGLISH_IS_SEMANTIC_REFERENCE`); the validation track hands a
 * fluent speaker C7's source with its English meaning; the eight review
 * criteria are put to every specialist in English. Nothing in the Yoruba
 * track has measured whether its specialist reads German, or French, or
 * Hausa. So a `yo` set may carry `en->yo` and `yo->en` and nothing else: a
 * `yo->de` item would have a Yoruba specialist's name on a judgement of German
 * output, and a `yo->yo` item is not a translation.
 *
 * This is also every route the registry ships: all fourteen are `en<->X`.
 * The day the programme assesses a second reference language, that is a
 * second track requirement here, not a loosening of this constant.
 *
 * Refused at publication, not at review: a set that reaches a specialist
 * is one they can be expected to read, whole.
 */
export const QA_SET_REFERENCE_LANGUAGE = 'en';

export type QaSetProblem =
  | { readonly kind: 'not-a-track' }
  | { readonly kind: 'no-version' }
  | { readonly kind: 'no-source-reference' }
  | { readonly kind: 'no-engines' }
  | { readonly kind: 'engine-malformed'; readonly index: number }
  | { readonly kind: 'engine-duplicated'; readonly index: number }
  | { readonly kind: 'too-few-items'; readonly count: number }
  | { readonly kind: 'item-malformed'; readonly index: number; readonly field: string }
  | { readonly kind: 'ordinal-duplicated'; readonly index: number }
  | { readonly kind: 'direction-not-this-language'; readonly index: number }
  /** One side is this language; the other is not `QA_SET_REFERENCE_LANGUAGE`. */
  | { readonly kind: 'direction-other-side-not-assessed'; readonly index: number; readonly other: string }
  | { readonly kind: 'engine-not-declared'; readonly index: number }
  | { readonly kind: 'too-long'; readonly index: number; readonly field: string };

export type QaSetReading =
  | { readonly ok: true; readonly definition: QaSetDefinition; readonly sha256: string }
  | { readonly ok: false; readonly problems: readonly QaSetProblem[] };

const DIRECTION = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)->([a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/u;

/** The two sides of `a->b`, or null when it is not a direction. */
export function splitDirection(direction: string): { source: string; target: string } | null {
  const match = DIRECTION.exec(direction);
  if (match === null) return null;
  return { source: match[1] as string, target: match[2] as string };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The bytes that get hashed: language, engines and items, keys sorted, in the
 * same canonical form the corpus uses.
 *
 * THE VERSION LABEL IS NOT HASHED, AND NEITHER IS THE SOURCE REFERENCE. The
 * registry's own words on `corpusHash`: "a renamed corpus is not a new one".
 * The label is the set's name and the reference is where it came from;
 * neither changes what a reviewer judged or which model the score is about.
 * Everything that does -- the sentences, the candidates, the engine each came
 * from and its version -- is in. So the same content under two labels is ONE
 * set and is refused as a duplicate, and one changed sentence is a different
 * hash under any label.
 */
export function canonicalQaSetBody(definition: QaSetDefinition): string {
  return canonicalJson({
    engines: definition.engines.map((engine) => ({
      model: engine.model,
      model_version: engine.modelVersion,
      provider: engine.provider,
    })),
    items: definition.items.map((item) => ({
      candidate: item.candidateText,
      category: item.category,
      direction: item.direction,
      model: item.model,
      ordinal: item.ordinal,
      provider: item.provider,
      source: item.sourceText,
    })),
    language: definition.language,
  });
}

/**
 * Read an untrusted definition, or say everything that is wrong with it.
 *
 * EVERYTHING, not the first thing: a set is assembled from a packet by a script
 * and the refusal is how the script's author finds out what the shape is.
 * Items are re-emitted field by field so a stray key -- `expectedWinner`, say,
 * pasted from an answer key -- cannot ride into storage and out to a reviewer.
 */
export function readQaSetDefinition(input: unknown, digest: Digest): QaSetReading {
  const problems: QaSetProblem[] = [];
  const body = isRecord(input) ? input : {};

  const language = trackFor(body['language'])?.language ?? null;
  if (language === null) problems.push({ kind: 'not-a-track' });
  const version = text(body['version']);
  if (version === null) problems.push({ kind: 'no-version' });
  const sourceReference = text(body['sourceReference']);
  if (sourceReference === null) problems.push({ kind: 'no-source-reference' });

  const engines: QaSetEngine[] = [];
  const declared = new Set<string>();
  const rawEngines = Array.isArray(body['engines']) ? body['engines'] : [];
  if (rawEngines.length === 0) problems.push({ kind: 'no-engines' });
  rawEngines.forEach((raw, index) => {
    const row = isRecord(raw) ? raw : {};
    const provider = text(row['provider']);
    const model = text(row['model']);
    const modelVersion = text(row['modelVersion']);
    if (provider === null || model === null || modelVersion === null) {
      problems.push({ kind: 'engine-malformed', index });
      return;
    }
    const key = `${provider}::${model}`;
    if (declared.has(key)) {
      problems.push({ kind: 'engine-duplicated', index });
      return;
    }
    declared.add(key);
    engines.push({ provider, model, modelVersion });
  });

  const items: QaSetItem[] = [];
  const ordinals = new Set<number>();
  const rawItems = Array.isArray(body['items']) ? body['items'] : [];
  if (rawItems.length < MIN_QA_SET_ITEMS) {
    problems.push({ kind: 'too-few-items', count: rawItems.length });
  }
  rawItems.forEach((raw, index) => {
    const row = isRecord(raw) ? raw : {};
    const ordinal = row['ordinal'];
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1) {
      problems.push({ kind: 'item-malformed', index, field: 'ordinal' });
      return;
    }
    if (ordinals.has(ordinal)) {
      problems.push({ kind: 'ordinal-duplicated', index });
      return;
    }
    /*
     * THE TEXTS MAY BE EMPTY; THEY MUST BE PRESENT. The packets carry blank
     * and emoji-only probe rows on purpose -- whitespace-only input is where
     * every engine here hallucinates -- and an engine that returns nothing for
     * a sentence has produced a result a reviewer should judge. So an empty
     * string is a real value; a missing field or a non-string is not.
     */
    const asText = (value: unknown): string | null =>
      typeof value === 'string' ? value.trim() : null;
    const fields: Record<string, string | null> = {
      direction: text(row['direction']),
      sourceText: asText(row['sourceText']),
      candidateText: asText(row['candidateText']),
      provider: text(row['provider']),
      model: text(row['model']),
    };
    let sound = true;
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        problems.push({ kind: 'item-malformed', index, field });
        sound = false;
      } else if (value.length > MAX_QA_TEXT_LENGTH) {
        problems.push({ kind: 'too-long', index, field });
        sound = false;
      }
    }
    if (!sound) return;
    const direction = fields['direction'] as string;
    const sides = splitDirection(direction);
    if (sides === null || (language !== null && sides.source !== language && sides.target !== language)) {
      problems.push({ kind: 'direction-not-this-language', index });
      return;
    }
    /*
     * THE OTHER SIDE MUST BE THE REFERENCE LANGUAGE. Checked after the
     * this-language test so each item gets the one problem that names its
     * fault. `language` is null only when the set's language was already
     * refused; the direction is still checked against the reference so the
     * refusal lists everything wrong with the set.
     */
    const other = sides.source === language ? sides.target : sides.source;
    if (other !== QA_SET_REFERENCE_LANGUAGE) {
      problems.push({ kind: 'direction-other-side-not-assessed', index, other });
      return;
    }
    const provider = fields['provider'] as string;
    const model = fields['model'] as string;
    if (!declared.has(`${provider}::${model}`)) {
      problems.push({ kind: 'engine-not-declared', index });
      return;
    }
    ordinals.add(ordinal);
    items.push({
      ordinal,
      direction,
      category: typeof row['category'] === 'string' ? row['category'].trim() : '',
      sourceText: fields['sourceText'] as string,
      candidateText: fields['candidateText'] as string,
      provider,
      model,
    });
  });

  if (problems.length > 0) return { ok: false, problems };

  const definition: QaSetDefinition = {
    language: language as string,
    version: version as string,
    engines,
    items: [...items].sort((a, b) => a.ordinal - b.ordinal),
    sourceReference: sourceReference as string,
  };
  return { ok: true, definition, sha256: digest(canonicalQaSetBody(definition)) };
}

/** The words a refusal is explained with, for the operator's screen. */
export function qaSetProblemMessage(problem: QaSetProblem): string {
  switch (problem.kind) {
    case 'not-a-track':
      return 'The language is not one the programme recruits for.';
    case 'no-version':
      return 'Give the set a version label; it becomes corpusVersion in the evidence.';
    case 'no-source-reference':
      return 'Say where the sentences came from (a packet path, a script run).';
    case 'no-engines':
      return 'Declare every engine in the set, with its model version.';
    case 'engine-malformed':
      return `engines[${problem.index}] needs provider, model and modelVersion.`;
    case 'engine-duplicated':
      return `engines[${problem.index}] repeats a provider and model already declared.`;
    case 'too-few-items':
      return `A set needs at least ${MIN_QA_SET_ITEMS} items; this one has ${problem.count}.`;
    case 'item-malformed':
      return `items[${problem.index}].${problem.field} is missing or not text.`;
    case 'ordinal-duplicated':
      return `items[${problem.index}] repeats an ordinal.`;
    case 'direction-not-this-language':
      return `items[${problem.index}].direction is not a direction into or out of this language.`;
    case 'direction-other-side-not-assessed':
      return (
        `items[${problem.index}].direction runs between this language and "${problem.other}"; ` +
        `the programme assesses a specialist in their language and ${QA_SET_REFERENCE_LANGUAGE} only, ` +
        `so the other side must be ${QA_SET_REFERENCE_LANGUAGE}.`
      );
    case 'engine-not-declared':
      return `items[${problem.index}] names an engine that is not in engines[].`;
    case 'too-long':
      return `items[${problem.index}].${problem.field} is longer than ${MAX_QA_TEXT_LENGTH} characters.`;
  }
}
