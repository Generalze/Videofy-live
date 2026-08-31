/** @author masterzee001 */
/**
 * The one place that decides whether a sentence may be translated, and what
 * must be true of the result.
 *
 * WHY IT IS ONE PLACE. Every rule below was written after something got past a
 * scattered version of it. The directional registry existed and media-ingest
 * declared the dependency without importing it, so uploaded and live programmes
 * translated whatever they liked. The screen then found identifiers being
 * rewritten -- `08031234567` came back as `08031,32367`, an OTP lost a digit,
 * an account number was rendered as prose -- which is somebody's money going to
 * a stranger. And a mock provider once wrote 44-byte audio files that every
 * signal downstream read as success.
 *
 * So the gate answers one question, and the caller cannot skip it:
 *
 *     translate this? -> TRANSLATE | BYPASS | UNAVAILABLE
 *
 * THE ORIGINAL IS NEVER LOST. Not on refusal, not on timeout, not on provider
 * failure, not on an unapproved route. A message that arrives in the wrong
 * language is a translation problem; a message that does not arrive is a
 * messaging problem, and the second is worse. Every outcome below carries the
 * text to deliver.
 *
 * NOTHING IS BILLED EXCEPT A SUCCESSFUL TRANSLATION. Not failures, not
 * timeouts, not the same-language bypass, not emoji. And a retry of the same
 * segment carries the same billing key, so recovering from a timeout cannot
 * charge twice for one sentence.
 */

import { createHash } from 'node:crypto';

/** The scopes the registry knows. A caller may not invent one. */
export type TranslationScope = 'messaging' | 'programme-live' | 'call-live';

/**
 * The registry gate, structurally. Declared rather than imported so this module
 * compiles and tests without the registry package's build -- the same choice
 * the account service made, and for the same reason.
 */
export interface RouteGate {
  mayTranslate(
    sourceLanguage: string,
    targetLanguage: string,
    scope: TranslationScope,
  ):
    | { readonly allowed: true; readonly route: { readonly provider?: string | undefined } }
    | { readonly allowed: false; readonly reason?: string; readonly explanation?: string };
}

export type BypassReason =
  | 'empty'
  | 'same-language'
  | 'non-linguistic'
  | 'identifier-only';

export type UnavailableReason =
  | 'route-not-approved'
  | 'too-long'
  | 'provider-failed'
  | 'timeout';

export interface GateTranslate {
  readonly action: 'translate';
  /** What to send to the engine: identifiers masked. */
  readonly textForEngine: string;
  /** Put the identifiers back, and say whether they survived. */
  readonly restore: (engineOutput: string) => RestoreResult;
  readonly provider: string | undefined;
  /** Stable across retries of the same segment: charge once, not per attempt. */
  readonly billingKey: string;
  readonly billable: true;
}

export interface GateBypass {
  readonly action: 'bypass';
  readonly reason: BypassReason;
  /** Delivered unchanged. Never counted as a translation. */
  readonly deliver: string;
  readonly billable: false;
}

export interface GateUnavailable {
  readonly action: 'unavailable';
  readonly reason: UnavailableReason;
  readonly explanation: string;
  /** The original. It still goes out. */
  readonly deliver: string;
  readonly billable: false;
}

export type GateDecision = GateTranslate | GateBypass | GateUnavailable;

export interface RestoreResult {
  readonly text: string;
  /** Identifiers the engine dropped or altered. Empty is the only good value. */
  readonly corrupted: readonly string[];
}

export interface TranslationGateOptions {
  readonly gate: RouteGate;
  readonly scope: TranslationScope;
  /**
   * Programme vocabulary marked do-not-translate.
   *
   * Protected by the SAME mechanism as a phone number, because the requirement
   * is identical: come back byte-for-byte or the message has not been
   * translated. A presenter's name mangled into a near-miss is the error an
   * audience notices first, since it is the word they already know.
   *
   * Supplied per programme. The gate never reads a store: whoever builds it
   * has already resolved the right programme's terms, so one programme's
   * vocabulary cannot leak into another's translation through this path.
   */
  readonly protectedTerms?: readonly string[];
  /**
   * The certified input limit. Beyond it the gate refuses.
   *
   * NEVER TRUNCATES. A silently shortened message is the worst outcome
   * available here: the recipient gets something that reads as complete and is
   * missing the half that said "do not send the payment". Refusing is visible;
   * truncating is not.
   */
  readonly maxCharacters?: number;
}

/**
 * Things that mean nothing except as an exact string, and must come back
 * byte-for-byte.
 *
 * ORDER MATTERS: URLs and emails first, because a URL contains digits that the
 * phone-number pattern would otherwise claim, and half a masked URL is worse
 * than none.
 */
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s<>"']+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Nigerian and international phone shapes, and anything long enough to be an
  // account number. Grouping and separators are allowed; the digits are what
  // must survive.
  /\+?\d[\d\s().-]{7,}\d/g,
  // OTP-ish and reference codes: letters and digits with a separator, or a bare
  // run of 4+ digits that survived the patterns above.
  /\b[A-Z]{2,}[-_]?\d{3,}\b/g,
  /\b\d{4,}\b/g,
];

/**
 * Billing-key field delimiter.
 *
 * A named constant, and a printable one. An earlier revision joined the fields
 * with an empty string, which lets ("ab","c") and ("a","bc") hash identically --
 * for a billing key that means two different segments sharing one charge, one
 * silently free and the other silently double-counted. It cannot occur in a
 * session id, segment id or language tag.
 */
const FIELD_DELIMITER = '|';

const PLACEHOLDER = (i: number) => `⟦ID${i}⟧`;

/** Text with every identifier replaced by an opaque marker. */
export function protectIdentifiers(
  text: string,
  protectedTerms: readonly string[] = [],
): {
  masked: string;
  identifiers: readonly string[];
} {
  const identifiers: string[] = [];
  let masked = text;

  /*
   * VOCABULARY FIRST, and longest first within it.
   *
   * Before the generic patterns, so a configured term containing digits is
   * protected as the operator wrote it rather than being split by the phone
   * pattern. Longest first so `First Bank of Lagos` is not eaten by `Lagos`.
   *
   * Unicode-aware boundaries, never the word-boundary escape: it is ASCII-based
   * even under `u`, so it cannot bound `Adéyẹmí` or `ụtụtụ` -- the terms this
   * feature exists for -- and the protection would silently do nothing.
   */
  for (const term of [...protectedTerms].sort((a, b) => b.length - a.length)) {
    if (term.trim() === '') continue;
    const pattern = new RegExp(
      `(?<![\p{L}\p{N}])${escapeRegExp(term)}(?![\p{L}\p{N}])`,
      'giu',
    );
    masked = masked.replace(pattern, (match) => {
      const index = identifiers.length;
      identifiers.push(match);
      return PLACEHOLDER(index);
    });
  }

  for (const pattern of IDENTIFIER_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), (match) => {
      const index = identifiers.length;
      identifiers.push(match);
      return PLACEHOLDER(index);
    });
  }
  return { masked, identifiers };
}

/**
 * Put the identifiers back where the engine left the markers.
 *
 * An engine that dropped or mangled a marker is REPORTED, not silently
 * papered over: the caller decides whether to deliver a translation missing a
 * phone number, and the honest answer is usually no.
 */
export function restoreIdentifiers(
  engineOutput: string,
  identifiers: readonly string[],
): RestoreResult {
  let text = engineOutput;
  const corrupted: string[] = [];
  identifiers.forEach((value, index) => {
    const marker = PLACEHOLDER(index);
    if (text.includes(marker)) {
      text = text.split(marker).join(value);
    } else {
      corrupted.push(value);
    }
  });
  return { text, corrupted };
}

/**
 * Is there anything here for a translator to do?
 *
 * `45000`, `OTP-483920`, `👍👍` and `???` have no translation. Sending them
 * costs money, invites a model to invent prose from nothing, and -- when the
 * model correctly returns them unchanged -- produces output indistinguishable
 * from a failure. Bypassing is both cheaper and more honest.
 */
export function isNonLinguistic(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;

  // Identifiers are masked out FIRST, then the question is asked of what is
  // left. A bare letter-run test called `OTP-483920` linguistic because "OTP"
  // is three letters -- and an OTP is the payload most in need of bypassing,
  // since sending it to a model risks the one thing that must not change.
  const { masked } = protectIdentifiers(trimmed);
  const withoutMarkers = masked.replace(/⟦ID\d+⟧/gu, ' ');

  // Any run of two or more letters in the REMAINDER is a word; one stray letter
  // beside a number (`5pm`, `N50`) is not.
  return !/\p{L}{2,}/u.test(withoutMarkers);
}

export function createTranslationGate(options: TranslationGateOptions) {
  const maxCharacters = options.maxCharacters ?? 5_000;

  return {
    /**
     * @param identity what makes a retry the SAME work: same session, same
     * segment, same revision. Two attempts at one sentence share a billing key.
     */
    decide(input: {
      readonly sourceLanguage: string;
      readonly targetLanguage: string;
      readonly text: string;
      readonly identity: { sessionId: string; segmentId: string; revision: number | string };
    }): GateDecision {
      const { sourceLanguage, targetLanguage, text } = input;

      // A. EMPTY / WHITESPACE -- never reaches a model.
      if (text.trim() === '') {
        return { action: 'bypass', reason: 'empty', deliver: text, billable: false };
      }

      // Same language is not a translation, and must never be charged for.
      if (normalise(sourceLanguage) === normalise(targetLanguage)) {
        return { action: 'bypass', reason: 'same-language', deliver: text, billable: false };
      }

      // B. NON-LINGUISTIC -- emoji, punctuation, bare numbers, codes.
      if (isNonLinguistic(text)) {
        return {
          action: 'bypass',
          reason: /\d/.test(text) ? 'identifier-only' : 'non-linguistic',
          deliver: text,
          billable: false,
        };
      }

      // D. LONG INPUT -- refuse, never truncate.
      if (text.length > maxCharacters) {
        return {
          action: 'unavailable',
          reason: 'too-long',
          explanation:
            `Message is ${text.length} characters; the certified limit is ${maxCharacters}. ` +
            'It was delivered untranslated rather than shortened.',
          deliver: text,
          billable: false,
        };
      }

      // THE DIRECTIONAL REGISTRY. Asked for this exact direction and scope --
      // never for the language pair in general, and never bypassed by a global
      // provider setting.
      const decision = options.gate.mayTranslate(sourceLanguage, targetLanguage, options.scope);
      if (!decision.allowed) {
        return {
          action: 'unavailable',
          reason: 'route-not-approved',
          explanation:
            decision.explanation ??
            `No approved ${options.scope} route for ${sourceLanguage} to ${targetLanguage}.`,
          deliver: text,
          billable: false,
        };
      }

      // C. IDENTIFIER PROTECTION, plus the programme's do-not-translate terms.
      const { masked, identifiers } = protectIdentifiers(text, options.protectedTerms ?? []);

      return {
        action: 'translate',
        textForEngine: masked,
        restore: (engineOutput: string) => restoreIdentifiers(engineOutput, identifiers),
        provider: decision.route.provider,
        billingKey: billingKey(input.identity, sourceLanguage, targetLanguage),
        billable: true,
      };
    },

    /**
     * What to do when the engine failed, timed out, or corrupted an identifier
     * after the gate said yes. The original always goes out, and nothing is
     * charged.
     */
    failed(original: string, reason: UnavailableReason, detail: string): GateUnavailable {
      return {
        action: 'unavailable',
        reason,
        explanation: detail,
        deliver: original,
        billable: false,
      };
    },
  };
}

function normalise(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
}

/**
 * Identical for every attempt at one sentence in one direction.
 *
 * A timeout followed by a successful retry is ONE translation. Keying on the
 * attempt instead of the work is how a recovering system bills a user twice for
 * the sentence they saw once.
 */
function billingKey(
  identity: { sessionId: string; segmentId: string; revision: number | string },
  sourceLanguage: string,
  targetLanguage: string,
): string {
  return createHash('sha256')
    .update(
      // A REAL separator. Joining with nothing lets ("ab","c") and ("a","bc")
      // hash identically, which for a billing key means two different segments
      // sharing one charge -- and the one that collides is silently free while
      // the other is silently double-counted. The delimiter cannot appear in a
      // session id, segment id or language tag.
      [
        identity.sessionId,
        identity.segmentId,
        String(identity.revision),
        normalise(sourceLanguage),
        normalise(targetLanguage),
      ].join(FIELD_DELIMITER),
    )
    .digest('hex')
    .slice(0, 32);
}


/** So a term containing regex metacharacters is matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
