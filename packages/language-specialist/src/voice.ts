/** @author masterzee001 */
/**
 * Voice participation: modelled, and deliberately not open.
 *
 * THE LEGAL BOUNDARY THIS FILE EXISTS TO HOLD. The permission a contributor
 * gives in the elicitation form is a licence over TEXT they wrote. It does not
 * grant voice rights, does not grant voice-cloning rights, does not authorise
 * synthetic voice training, does not authorise commercial use of anyone's
 * voice, and does not enrol anybody in a voice programme. Those are separate
 * grants requiring a separate opt-in, a separate agreement, separate consent,
 * separate permitted-use terms and separate compensation terms.
 *
 * WHY THE STATES EXIST AT ALL IF NOTHING MAY USE THEM. Because the alternative
 * is that the day a voice programme opens, somebody adds a boolean to the
 * specialist record and the whole boundary depends on that person having read
 * this paragraph. Here the shape is present, its default is `NOT_INVITED`, and
 * `voiceRightsGranted` is a field that the text-consent path has no way to
 * write. The database carries the same rule as a CHECK constraint, so lifting
 * it is a migration somebody has to author on purpose.
 *
 * WHAT MUST NOT APPEAR IN THE PRODUCT WHILE THIS IS CLOSED: any mention of
 * rewards, royalties, payment, compensation or paid voice work, anywhere a
 * contributor can read it. A recruitment page that hints at future payment is
 * making a promise C7 has not made, to people who are volunteering. The public
 * copy is checked against `FORBIDDEN_PUBLIC_TERMS` by a test rather than by
 * review, because copy is edited far more often than it is reviewed.
 */

/**
 * The states a future voice programme would move somebody through.
 *
 * Present so the schema can hold them. Nothing in the current product writes
 * anything but the default.
 */
export const VOICE_PARTICIPATION_STATES = [
  'NOT_INVITED',
  'INVITED',
  'AUDITION_PENDING',
  'VOICE_APPROVED',
  'VOICE_AGREEMENT_REQUIRED',
  'ACTIVE',
  'WITHDRAWN',
] as const;

export type VoiceParticipationState = (typeof VOICE_PARTICIPATION_STATES)[number];

/** Everybody, today. The only state this deployment ever writes. */
export const DEFAULT_VOICE_STATE: VoiceParticipationState = 'NOT_INVITED';

export interface VoiceParticipation {
  readonly accountId: string;
  readonly state: VoiceParticipationState;
  /**
   * FALSE, always, under the current text licence.
   *
   * Not derived from the state: `VOICE_APPROVED` would still be false until a
   * signed voice agreement exists, and collapsing the two into one field is
   * how "approved to audition" becomes "we may train on their voice".
   */
  readonly voiceRightsGranted: false;
  /** Null until a voice agreement exists. There is no such document today. */
  readonly voiceAgreementVersion: null;
}

/** The record every specialist starts with, and the only one this build writes. */
export function initialVoiceParticipation(accountId: string): VoiceParticipation {
  return {
    accountId,
    state: DEFAULT_VOICE_STATE,
    voiceRightsGranted: false,
    voiceAgreementVersion: null,
  };
}

/**
 * Whether the current text permission grants a voice right. Always false.
 *
 * A function rather than a constant so that the call site reads as a question
 * being asked, and so a test can assert the answer for every use in
 * `WITHHELD_USES` at once.
 */
export function textLicenceGrantsVoiceRight(): false {
  return false;
}

/**
 * Words the public and contributor-facing surfaces must not contain.
 *
 * Matched case-insensitively as whole words against rendered copy by a test.
 * `paid` and `pay` are deliberately absent -- "payment" is one of the fifteen
 * elicitation categories and appears legitimately all over the form -- so this
 * list names the promise words rather than every word about money.
 */
export const FORBIDDEN_PUBLIC_TERMS = [
  'royalty',
  'royalties',
  'reward',
  'rewards',
  'compensation',
  'remuneration',
  'stipend',
  'honorarium',
  'salary',
  'earnings',
] as const;

/**
 * Phrases in which a forbidden word is the OPPOSITE of a promise.
 *
 * "royalty-free" is the operative term of the contributor licence itself: it
 * says C7 owes nothing for the use of this material, which is exactly the thing
 * this guard exists to keep the product from implying otherwise. Matching it
 * would make the licence text fail its own check, and a guard that cries wolf
 * on the one paragraph it most needs to allow is a guard somebody switches off.
 */
const EXEMPT_PHRASES: readonly RegExp[] = [/royalty-free/giu];

/**
 * Any forbidden term present in a block of copy.
 *
 * Whole-word, case-insensitive. Returns every hit rather than the first, so a
 * failing test names all of them and the copy is fixed once.
 */
export function forbiddenTermsIn(copy: string): readonly string[] {
  let scanned = copy;
  for (const phrase of EXEMPT_PHRASES) scanned = scanned.replace(phrase, ' ');
  const found = new Set<string>();
  for (const term of FORBIDDEN_PUBLIC_TERMS) {
    if (new RegExp(`\\b${term}\\b`, 'iu').test(scanned)) found.add(term);
  }
  return [...found];
}
