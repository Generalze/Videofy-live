/** @author masterzee001 */
/**
 * Whether blind review is unlocked, decided by the application.
 *
 * THE ORDERING IS NOT AN OPERATOR'S RESPONSIBILITY. "Send the elicitation
 * first, then the review pack" is a procedure, and a procedure is followed
 * until the week somebody is in a hurry. What it protects -- source written
 * without knowledge of how the engines behave -- cannot be restored once lost
 * and leaves no trace when it is. So the gate is code, on the read path of the
 * review endpoint, and there is no operator action that opens it early.
 *
 * A LANGUAGE THAT NEEDS NO ELICITATION IS NOT THEREBY UNGATED. French, Spanish
 * and Portuguese have honest source available without asking a contributor to
 * write it, so there is no corpus to freeze -- but review still requires that
 * the person be on the track and not suspended. Returning `unlocked` for any
 * caller who happens not to need a corpus would be a bypass shaped like an
 * exemption.
 */
import type { QualificationState } from './qualification.js';
import { trackFor } from './tracks.js';

export type ReviewLock =
  | 'not-a-track'
  | 'not-applied'
  | 'elicitation-incomplete'
  | 'corpus-not-frozen'
  | 'suspended';

export type ReviewAccess =
  | { readonly unlocked: true }
  | { readonly unlocked: false; readonly reason: ReviewLock };

export interface ReviewGateInput {
  readonly language: string;
  /** Null when the person has no record for this language at all. */
  readonly qualificationState: QualificationState | null;
  /** True once a corpus has been frozen for this language. */
  readonly corpusFrozen: boolean;
  /** Every required prompt answered. Reported so the UI can say which step is next. */
  readonly elicitationComplete: boolean;
}

/**
 * The one place this question is answered.
 *
 * Both the assignment list and the individual packet call it, so a route that
 * checks the list cannot be walked around by requesting a packet directly.
 */
export function reviewAccess(input: ReviewGateInput): ReviewAccess {
  const track = trackFor(input.language);
  if (track === null) return { unlocked: false, reason: 'not-a-track' };
  if (input.qualificationState === null) return { unlocked: false, reason: 'not-applied' };
  if (input.qualificationState === 'SUSPENDED') {
    return { unlocked: false, reason: 'suspended' };
  }
  if (!track.requiresSourceElicitation) return { unlocked: true };
  if (input.corpusFrozen) return { unlocked: true };
  /*
   * Two locked reasons rather than one, because they need different words on
   * screen: "finish your fifteen messages" and "submit them" are different
   * instructions, and a person who has typed all fifteen and not pressed submit
   * would otherwise be told to do work they have already done.
   */
  return {
    unlocked: false,
    reason: input.elicitationComplete ? 'corpus-not-frozen' : 'elicitation-incomplete',
  };
}

/** The sentence shown to somebody whose review is locked. */
export function reviewLockMessage(reason: ReviewLock): string {
  switch (reason) {
    case 'not-a-track':
      return 'This language is not open for specialist qualification.';
    case 'not-applied':
      return 'Apply for this language before reviewing translations in it.';
    case 'elicitation-incomplete':
      return 'Write and submit your fifteen source messages first. Review opens once they are submitted.';
    case 'corpus-not-frozen':
      return 'Your fifteen messages are written but not submitted. Submit them to open review.';
    case 'suspended':
      return 'This language track is suspended. Contact languages@consummate7.com.';
  }
}
