/** @author masterzee001 */
/**
 * Freezing a corpus, and why the order of these four steps is the whole point.
 *
 *     elicitation -> consent YES -> submit -> freeze -> sha256 -> review unlocks
 *
 * THE VALUE OF NATIVE SOURCE IS THAT IT WAS WRITTEN IN IGNORANCE of how the
 * engines behave. A contributor who has already read thirty machine
 * translations has learned what the benchmark hunts for and will write toward
 * it; their fifteen messages then test the failures C7 already knew about
 * rather than the ones it did not. That property cannot be restored once lost
 * and nothing about the data looks different afterwards, so it is protected
 * structurally rather than by asking people to remember the ordering.
 *
 * It is also destroyed silently by a single well-meaning edit after the first
 * results arrive -- "this one was ambiguous, let me reword it" is how a
 * benchmark stops measuring anything. So the corpus is hashed at the moment it
 * is accepted and every later result cites that hash.
 *
 * NO CONSENT, NO CORPUS. The permission is checked before the rows are read as
 * data, exactly as `scripts/freeze_native_corpus.py` does it. Contributor text
 * is not C7's to use by default.
 *
 * NO CRYPTO IN THIS FILE. The digest arrives as a function so this package
 * stays importable from a browser bundle -- the specialist portal needs these
 * types and this vocabulary, and `node:crypto` in the import graph would break
 * its build. The service passes the real implementation; a test passes a fake
 * and still exercises every rule that matters.
 */
import type { ElicitationItem } from './elicitation.js';
import { readElicitation } from './elicitation.js';

/** Turns the canonical body into a lowercase hex SHA-256. Supplied by the host. */
export type Digest = (body: string) => string;

/**
 * The bytes that get hashed.
 *
 * DELIBERATELY MATCHES `scripts/freeze_native_corpus.py`, which hashes
 * `json.dumps(items, ensure_ascii=False, sort_keys=True)`: keys sorted, no
 * escaping of non-ASCII, and Python's default `', '` / `': '` separators. A
 * corpus frozen by the script and the same corpus frozen by this service must
 * produce the same hash, or the two halves of this programme cite different
 * numbers for identical material and no result can be reconciled with another.
 *
 * `JSON.stringify` alone would not do it: it emits no spaces after separators
 * and does not sort keys. Both differences are invisible and both change the
 * hash, which is the worst combination a canonical form can have.
 */
export function canonicalCorpusBody(items: readonly ElicitationItem[]): string {
  return serialise(items.map(canonicalItem));
}

/**
 * One row, reduced to the four fields the Python script writes.
 *
 * `purpose` is included because it is the PROMPT the message answers, and a
 * message means something different under a different prompt. `category` is
 * not: it is C7's internal grouping key, it is derived from the item number,
 * and hashing it would make a rename of an internal identifier invalidate every
 * corpus ever frozen.
 */
function canonicalItem(item: ElicitationItem): Record<string, string | number> {
  return {
    english_meaning: item.englishSemanticReference,
    item: item.item,
    purpose: item.purpose,
    source: item.nativeMessage,
  };
}

/** Python's `json.dumps` with sorted keys, default separators, no ASCII escaping. */
function serialise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map(serialise).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, inner]) => `${quote(key)}: ${serialise(inner)}`).join(', ')}}`;
}

/**
 * A JSON string literal that leaves non-ASCII alone.
 *
 * `JSON.stringify` already leaves printable non-ASCII unescaped and escapes the
 * same control characters Python does, so it is correct for every character a
 * contributor can type -- including the tone marks in `Èdè Yorùbá`, which is
 * exactly the text this must not mangle.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** What a freeze produces. Every field is cited by every later result. */
export interface FrozenCorpus {
  readonly attemptId: string;
  readonly accountId: string;
  readonly language: string;
  /** 1 for the first freeze of this language; a correction makes 2, never edits 1. */
  readonly revision: number;
  readonly items: readonly ElicitationItem[];
  /** Rows carrying a message. The optional code-switch row may be absent. */
  readonly sourceCount: number;
  readonly sha256: string;
  readonly frozenAtMs: number;
  /** The acceptance this corpus was collected under. Never null. */
  readonly consentId: string;
  readonly consentVersion: string;
  /** Pinned into the record so a reader of the raw row cannot mistake the column. */
  readonly englishIsSemanticReference: true;
}

export type FreezeRefusal =
  | 'no-consent'
  | 'incomplete'
  | 'malformed'
  | 'already-frozen'
  | 'not-an-elicitation-language';

export type FreezeResult =
  | { readonly ok: true; readonly corpus: FrozenCorpus }
  | { readonly ok: false; readonly reason: FreezeRefusal; readonly detail?: string };

export interface FreezeRequest {
  readonly attemptId: string;
  readonly accountId: string;
  readonly language: string;
  readonly revision: number;
  /** The draft rows, untrusted. */
  readonly entries: unknown;
  /** Null when the person has not accepted the permission. Refused, not warned. */
  readonly consentId: string | null;
  readonly consentVersion: string | null;
  readonly nowMs: number;
  readonly digest: Digest;
  /** True when a corpus already exists at this revision. Refused, never overwritten. */
  readonly alreadyFrozen: boolean;
}

/**
 * Freeze, or refuse and say why.
 *
 * THE CONSENT CHECK IS FIRST, before the rows are read as data, because the
 * refusal has to be true even of a perfectly-formed submission. Reading the
 * messages in order to tell somebody their consent is missing means C7 has
 * already handled text it has no licence to handle.
 *
 * `alreadyFrozen` is passed in rather than discovered here so this function
 * stays pure, but the refusal is not the real guard -- the storage layer
 * refuses the write by primary key and the database refuses it again by
 * trigger. Three layers, because "never silently overwrite a frozen corpus" is
 * the rule that, if it fails, fails without a trace.
 */
export function freezeCorpus(request: FreezeRequest): FreezeResult {
  if (request.consentId === null || request.consentVersion === null) {
    return { ok: false, reason: 'no-consent' };
  }
  if (request.alreadyFrozen) {
    return { ok: false, reason: 'already-frozen' };
  }

  const reading = readElicitation(request.entries);
  const malformed = reading.problems.filter(
    (problem) => problem.kind === 'unknown-item' || problem.kind === 'duplicate-item' || problem.kind === 'too-long',
  );
  if (malformed.length > 0) {
    return { ok: false, reason: 'malformed', detail: malformed.map((p) => `${p.kind}:${p.item}`).join(',') };
  }
  if (!reading.complete) {
    const missing = reading.problems
      .filter((problem) => problem.kind === 'missing-message' || problem.kind === 'missing-english')
      .map((problem) => problem.item);
    return { ok: false, reason: 'incomplete', detail: missing.join(',') };
  }

  /*
   * Only ANSWERED rows are frozen. The optional code-switch row left blank is a
   * legitimate skip -- forcing it would collect a sentence the contributor
   * would never send -- and a blank row in the corpus is a source message with
   * no source in it, which every downstream consumer would have to special-case
   * forever.
   */
  const items = reading.items.filter((item) => item.nativeMessage.length > 0);
  const sha256 = request.digest(canonicalCorpusBody(items));

  return {
    ok: true,
    corpus: {
      attemptId: request.attemptId,
      accountId: request.accountId,
      language: request.language,
      revision: request.revision,
      items,
      sourceCount: items.length,
      sha256,
      frozenAtMs: request.nowMs,
      consentId: request.consentId,
      consentVersion: request.consentVersion,
      englishIsSemanticReference: true,
    },
  };
}
