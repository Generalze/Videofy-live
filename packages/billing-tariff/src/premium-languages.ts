/** @author masterzee001 */
/**
 * Languages that only the premium vendor will attempt.
 *
 * WHY A LANGUAGE CAN FORCE A GRADE. Grades are normally the customer's choice:
 * standard is cheaper, premium sounds better, and either will serve any
 * language. For a small set of languages that is not true -- the standard
 * vendor's output was judged unusable by a speaker of the language, so offering
 * it at the standard price would be selling something that does not work.
 * Those languages resolve to premium whatever was asked for.
 *
 * THIS IS A COMMERCIAL DECISION WITH A REAL COST TO THE CUSTOMER, and it should
 * be read as one rather than as a technical detail. A Nigerian caller speaking
 * Yoruba pays twice what a French caller pays, for audio that a listening test
 * on 2026-08-26 found imperfect in BOTH vendors -- premium is the better of two
 * poor options here, not a good one. The list exists so that this is stated in
 * one place, visible, and easy to shorten the moment a better provider is
 * found. It is expected to shrink.
 *
 * IT MUST BE DISCLOSED BEFORE THE CHARGE, NOT AFTER. Anything that silently
 * doubles a price is indistinguishable from a billing fault at the moment the
 * customer notices. `requiresPremium` is what a pre-call disclosure should ask,
 * and no surface should upgrade a grade without saying so first.
 */
import type { Grade } from './tariff.js';

/**
 * Base subtags, lower case.
 *
 * `pcm` is Nigerian Pidgin, and it is here for a different reason from the
 * other three: no vendor has been heard speaking it at all, because the
 * specialist trial ran out of quota before reaching it. Listed on the same
 * precautionary footing until somebody has actually listened.
 */
export const PREMIUM_ONLY_LANGUAGES: readonly string[] = ['yo', 'ha', 'ig', 'pcm'];

function base(tag: string): string {
  return tag.toLowerCase().split(/[-_]/u)[0] ?? '';
}

/** Whether this language can only be served at premium. */
export function requiresPremium(targetLanguage: string): boolean {
  return PREMIUM_ONLY_LANGUAGES.includes(base(targetLanguage));
}

/**
 * The grade that will actually be charged.
 *
 * Only ever upgrades. A language that needs premium gets it; a customer who
 * chose premium for a language that does not need it is not quietly moved down
 * to standard, because they asked for the better voice and are entitled to it.
 */
export function effectiveGrade(requested: Grade, targetLanguage: string): Grade {
  return requiresPremium(targetLanguage) ? 'premium' : requested;
}

/**
 * Whether charging this language at this grade is a forced upgrade.
 *
 * Exactly the condition a disclosure should fire on: the customer asked for
 * standard, and the language will bill at premium regardless.
 */
export function isForcedUpgrade(requested: Grade, targetLanguage: string): boolean {
  return requested !== 'premium' && requiresPremium(targetLanguage);
}
