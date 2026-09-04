/** @author masterzee001 */
/**
 * The contributor permission, and the fact that it is not a voice permission.
 *
 * THE WORDS ARE THE ASSET. What a person agreed to is the exact sentence they
 * read, not a summary of it, so the sentence lives here as a constant and is
 * stored by hash alongside every acceptance. If the wording is ever revised,
 * the version goes up, the old text stays in this file, and every acceptance
 * already recorded still points at the words it was given. A consent system
 * that keeps only "accepted: true" cannot answer the one question it exists to
 * answer.
 *
 * IT IS A LICENCE, NOT AN ASSIGNMENT. An earlier draft of this project's own
 * documentation called the resulting corpus "C7-owned" and that was corrected
 * on 31 Aug 2026: writing a sentence transfers no copyright. The text below
 * says so in the contributor's favour, and `LICENCE_IS_ASSIGNMENT` is false and
 * exists so a test can pin it.
 *
 * VOICE IS NOT IN HERE AND MUST NOT BE PUT IN HERE. See `voice.ts`. The grant
 * list below is closed: `GRANTED_USES` enumerates everything this permission
 * covers, `WITHHELD_USES` enumerates what it explicitly does not, and both are
 * asserted by tests. Adding "voice" to the first list is a legal act, not a
 * refactor, and it must be impossible to perform by accident while editing
 * copy.
 */

/**
 * Bumped when the WORDS change. Stored with every acceptance.
 *
 * `2026-08-31` rather than `1`: a date says when this text was settled, which
 * is the thing a person reconstructing an old acceptance actually needs, and it
 * cannot be confused with a schema version.
 */
export const CONSENT_VERSION = '2026-08-31.language-text.v1';

/**
 * The scope of this permission, stored on every consent row.
 *
 * A single value today. It exists because the alternative -- an untyped consent
 * table -- is how a future voice agreement gets written into the same rows as
 * this one and becomes indistinguishable from it six months later.
 */
export const CONSENT_SCOPE = 'language-text' as const;
export type ConsentScope = typeof CONSENT_SCOPE;

/**
 * The permission, word for word, as it appears in
 * docs/certification/review-packets-v2/SOURCE-ELICITATION.md and in the CSV
 * forms already sent to contributors. Transcribed, not rewritten: the web form
 * must ask for the same thing the paper form asked for, or C7 holds two
 * different licences and does not know which contributor gave which.
 */
export const CONSENT_TEXT =
  'By submitting these messages and English meanings, I confirm they are my ' +
  'original writing and grant C7 / Tech Advance Concept a perpetual, worldwide, ' +
  'irrevocable, royalty-free licence to use, reproduce, modify, evaluate, ' +
  'publish internally, and use them for training, testing, benchmarking and ' +
  'improving translation systems and related C7 services.';

/**
 * The plain-language note shown beneath the licence.
 *
 * Not decoration. The licence sentence is dense and a contributor reading it
 * cold cannot tell whether they have just given away their work. This says
 * they have not, in the words a person would use.
 */
export const CONSENT_RETAINED_RIGHTS =
  'You keep the copyright in what you write. This is permission to use it, not ' +
  'a transfer of ownership.';

/** False, and pinned by a test. See the module note. */
export const LICENCE_IS_ASSIGNMENT = false;

/** Everything this permission covers. Closed list. */
export const GRANTED_USES = [
  'use',
  'reproduce',
  'modify',
  'evaluate',
  'publish-internally',
  'training',
  'testing',
  'benchmarking',
  'product-improvement',
] as const;

/**
 * Everything it does NOT cover, named rather than merely absent.
 *
 * An absence is invisible; a list is reviewable. Somebody proposing to use a
 * contributor's material for one of these has to delete a line from this array
 * to make the tests pass, and deleting it is the moment the question gets
 * asked.
 */
export const WITHHELD_USES = [
  'voice-recording',
  'voice-cloning',
  'synthetic-voice-training',
  'commercial-use-of-voice',
  'voice-programme-enrolment',
  'copyright-assignment',
] as const;

export type GrantedUse = (typeof GRANTED_USES)[number];
export type WithheldUse = (typeof WITHHELD_USES)[number];

/** What a browser is handed before the elicitation form renders. */
export interface ConsentOffer {
  readonly consentVersion: string;
  readonly scope: ConsentScope;
  readonly text: string;
  readonly retainedRights: string;
  readonly grantedUses: readonly GrantedUse[];
  readonly withheldUses: readonly WithheldUse[];
  /** The exact string the person must type. Not a checkbox alone. */
  readonly affirmation: string;
}

/**
 * An explicit affirmative action, and what counts as one.
 *
 * A ticked box that arrives pre-ticked is not consent, and a request body is
 * free to claim anything, so the form asks the person to TYPE the word as well.
 * That is the same thing the CSV form asked for ("I agree (type YES here)"),
 * and the freeze script already refuses a form where it is absent.
 */
export const CONSENT_AFFIRMATION = 'YES';

export function consentOffer(): ConsentOffer {
  return {
    consentVersion: CONSENT_VERSION,
    scope: CONSENT_SCOPE,
    text: CONSENT_TEXT,
    retainedRights: CONSENT_RETAINED_RIGHTS,
    grantedUses: GRANTED_USES,
    withheldUses: WITHHELD_USES,
    affirmation: CONSENT_AFFIRMATION,
  };
}

export type ConsentRefusal =
  | 'not-affirmed'
  | 'permission-not-accepted'
  | 'unknown-consent-version'
  | 'wrong-scope';

export type ConsentCheck =
  | { readonly ok: true; readonly consentVersion: string; readonly scope: ConsentScope }
  | { readonly ok: false; readonly reason: ConsentRefusal };

/**
 * Whether what arrived is an acceptance of THIS permission.
 *
 * Every clause is a refusal somebody could otherwise have walked past:
 *
 *   `accepted` false with `typed` YES -- the box was never ticked. Reading the
 *   typed word alone would let a client that forgot to render the checkbox
 *   collect consent nobody gave.
 *
 *   A version that is not the current one -- the browser is running an old
 *   bundle and is showing words this deployment no longer offers. Storing it
 *   as if it were current would attach today's version number to yesterday's
 *   sentence, which is exactly the record this system exists to keep straight.
 *
 * Consent is never inferred from anything else: not from having applied, not
 * from having started the form, not from a previous language's acceptance.
 */
export function checkConsent(input: {
  readonly accepted: unknown;
  readonly typed: unknown;
  readonly consentVersion: unknown;
  readonly scope?: unknown;
}): ConsentCheck {
  if (input.accepted !== true) return { ok: false, reason: 'permission-not-accepted' };
  const typed = typeof input.typed === 'string' ? input.typed.trim().toUpperCase() : '';
  if (typed !== CONSENT_AFFIRMATION) return { ok: false, reason: 'not-affirmed' };
  if (input.consentVersion !== CONSENT_VERSION) {
    return { ok: false, reason: 'unknown-consent-version' };
  }
  if (input.scope !== undefined && input.scope !== CONSENT_SCOPE) {
    return { ok: false, reason: 'wrong-scope' };
  }
  return { ok: true, consentVersion: CONSENT_VERSION, scope: CONSENT_SCOPE };
}
