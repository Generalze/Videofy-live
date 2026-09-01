/** @author masterzee001 */
/**
 * Whether a person is qualified is a question about ONE LANGUAGE.
 *
 * The tempting model is a boolean on the account -- `isSpecialist` -- and it is
 * wrong in a way that only shows up once somebody real uses the system. The
 * first contributor this programme was designed around writes Yoruba and
 * English fluently, has never been assessed in French, and applied for Hausa
 * last week. A single flag answers "may this person review?" with one word for
 * four different situations, and the first time it is consulted by the review
 * router it will hand them a French packet.
 *
 * So the record is per (account, language), and there is no global flag
 * anywhere in this package to fall back on.
 *
 * THE STATES ARE A LIST, NOT A STRING. Every state below appears in a database
 * CHECK constraint as well, so a typo in a route handler is refused twice: once
 * here when the transition is validated, once by Postgres if it somehow gets
 * that far. A free-text status column is how "QUALIFED" ends up in production
 * meaning nothing to any reader and matching no query.
 */

/**
 * The nine states a language track can be in.
 *
 * Order is the ordinary forward path, which makes the table readable, but it is
 * NOT a ladder: `SUSPENDED` and `NOT_QUALIFIED` are reachable from most places
 * and `REASSESSMENT_ALLOWED` deliberately points backwards.
 */
export const QUALIFICATION_STATES = [
  'APPLIED',
  'ASSESSMENT_PENDING',
  'ASSESSMENT_IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUALIFIED',
  'NOT_QUALIFIED',
  'REASSESSMENT_ALLOWED',
  'SUSPENDED',
] as const;

export type QualificationState = (typeof QUALIFICATION_STATES)[number];

/**
 * "Not assessed" is the ABSENCE of a record, not a tenth state.
 *
 * A row saying NOT_ASSESSED and no row at all would mean the same thing while
 * being two different things to every query, and the day they disagree is the
 * day somebody appears to have applied for a language they never opened. The
 * dashboard still needs a word for it, so the word lives here and the storage
 * layer never writes it.
 */
export const NOT_ASSESSED = 'NOT_ASSESSED' as const;
export type DisplayState = QualificationState | typeof NOT_ASSESSED;

export function isQualificationState(value: unknown): value is QualificationState {
  return typeof value === 'string' && (QUALIFICATION_STATES as readonly string[]).includes(value);
}

/**
 * What each state may become.
 *
 * WRITTEN OUT RATHER THAN COMPUTED, because every edge here is a product
 * decision somebody should have to change on purpose. Two in particular:
 *
 *   QUALIFIED -> SUSPENDED is allowed and QUALIFIED -> NOT_QUALIFIED is not.
 *   Withdrawing a qualification that has already been used to review real
 *   material is not the same act as failing an assessment, and recording it as
 *   the latter would rewrite what the reviewer's past verdicts were made under.
 *
 *   NOT_QUALIFIED -> REASSESSMENT_ALLOWED is the ONLY way back. A person who
 *   did not qualify cannot simply re-apply into ASSESSMENT_PENDING and try
 *   again against the same corpus; an operator has to permit it, which is what
 *   makes "you may try again" a decision with a name attached rather than a
 *   loop.
 */
const TRANSITIONS: Readonly<Record<QualificationState, readonly QualificationState[]>> = {
  /*
   * APPLIED -> ASSESSMENT_IN_PROGRESS is direct, and deliberately so. For the
   * languages whose qualification IS the elicitation form, accepting the
   * permission and starting to type is the assessment beginning; there is
   * nothing for an operator to schedule in between. ASSESSMENT_PENDING remains
   * for the tracks where somebody has to prepare material first, which is why
   * both edges exist rather than one.
   */
  APPLIED: ['ASSESSMENT_PENDING', 'ASSESSMENT_IN_PROGRESS', 'NOT_QUALIFIED', 'SUSPENDED'],
  ASSESSMENT_PENDING: ['ASSESSMENT_IN_PROGRESS', 'NOT_QUALIFIED', 'SUSPENDED'],
  ASSESSMENT_IN_PROGRESS: ['SUBMITTED', 'NOT_QUALIFIED', 'SUSPENDED'],
  SUBMITTED: ['UNDER_REVIEW', 'SUSPENDED'],
  UNDER_REVIEW: ['QUALIFIED', 'NOT_QUALIFIED', 'REASSESSMENT_ALLOWED', 'SUSPENDED'],
  QUALIFIED: ['SUSPENDED'],
  NOT_QUALIFIED: ['REASSESSMENT_ALLOWED'],
  REASSESSMENT_ALLOWED: ['ASSESSMENT_PENDING', 'SUSPENDED'],
  SUSPENDED: ['REASSESSMENT_ALLOWED', 'NOT_QUALIFIED'],
};

export function allowedNextStates(from: QualificationState): readonly QualificationState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: QualificationState, to: QualificationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The states an OPERATOR may set directly.
 *
 * The rest are reached by the applicant doing something -- applying, starting,
 * submitting -- and an operator who can write them by hand can manufacture a
 * SUBMITTED track for which no corpus was ever frozen. The evidence and the
 * state would then disagree, and the state is the one people read.
 */
export const OPERATOR_SETTABLE_STATES = [
  'QUALIFIED',
  'NOT_QUALIFIED',
  'REASSESSMENT_ALLOWED',
  'SUSPENDED',
  'UNDER_REVIEW',
] as const satisfies readonly QualificationState[];

export function isOperatorSettable(state: QualificationState): boolean {
  return (OPERATOR_SETTABLE_STATES as readonly QualificationState[]).includes(state);
}

/**
 * Whether a track is finished with, for the purpose of showing a person where
 * they stand. Not an authorization answer -- see `capabilities.ts` for that.
 */
export function isTerminal(state: QualificationState): boolean {
  return state === 'QUALIFIED' || state === 'NOT_QUALIFIED';
}
