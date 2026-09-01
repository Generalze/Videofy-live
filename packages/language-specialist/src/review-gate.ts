/** @author masterzee001 */
/**
 * Whether blind review is unlocked, decided by the application.
 *
 * THE ORDERING IS NOT AN OPERATOR'S RESPONSIBILITY. "Get the source settled
 * first, then send the review pack" is a procedure, and a procedure is followed
 * until the week somebody is in a hurry. What it protects -- a judgement formed
 * without knowledge of how the engines behave -- cannot be restored once lost
 * and leaves no trace when it is. So the gate is code, on the read path of the
 * review endpoint, and there is no operator action that opens it early.
 *
 * THE GATE IS SCOPED TO ONE ATTEMPT, and that is the correction this file
 * exists in its current form for. It used to ask "does a corpus exist for this
 * account and language", which is true forever once one does. After an operator
 * allowed a reassessment, attempt 2 opened for review on attempt 1's frozen
 * source: the person would have judged translations of sentences from the
 * assessment they had already failed, and the result would have been filed
 * against the new attempt. The field is now named `sourceFrozenForAttempt` so
 * that a caller passing "any corpus ever" has to lie about what it means.
 *
 * BOTH SOURCE REQUIREMENTS ARE GATED. An elicitation track needs the
 * contributor's own fifteen messages frozen; a validation track needs
 * C7-supplied source that a fluent speaker has validated or corrected, frozen.
 * Neither is "no source work", and returning `unlocked` for a track that merely
 * does not need the fifteen-item form was a bypass shaped like an exemption.
 */
import type { QualificationState } from './qualification.js';
import { trackFor, type SourceRequirement } from './tracks.js';

export type ReviewLock =
  | 'not-a-track'
  | 'not-applied'
  | 'suspended'
  /** Elicitation track: the fifteen messages are not all written. */
  | 'elicitation-incomplete'
  /** Elicitation track: written, not submitted. */
  | 'corpus-not-frozen'
  /** Validation track: the supplied source has not been validated through. */
  | 'source-validation-incomplete'
  /** Validation track: validated, not frozen. */
  | 'source-not-frozen';

export type ReviewAccess =
  | { readonly unlocked: true }
  | { readonly unlocked: false; readonly reason: ReviewLock };

export interface ReviewGateInput {
  readonly language: string;
  /** Null when the person has no record for this language at all. */
  readonly qualificationState: QualificationState | null;
  /**
   * The attempt this question is being asked about. Present so a caller cannot
   * answer it without having decided which attempt it concerns.
   */
  readonly attempt: number;
  /**
   * A frozen source EXISTS AT `attempt`. Not "a corpus exists"; not "the latest
   * corpus". See the module note.
   */
  readonly sourceFrozenForAttempt: boolean;
  /**
   * The source work for THIS attempt is finished but not yet submitted.
   * Reported so the lock can say which of two different things to do next.
   */
  readonly sourceCompleteForAttempt: boolean;
}

/**
 * The one place this question is answered.
 *
 * The assignment list, the packet read and the verdict write all call it, so a
 * route that checks the list cannot be walked around by requesting a packet
 * directly, and a session that opened a packet legitimately cannot keep writing
 * into it after its track changes.
 */
export function reviewAccess(input: ReviewGateInput): ReviewAccess {
  const track = trackFor(input.language);
  if (track === null) return { unlocked: false, reason: 'not-a-track' };
  if (input.qualificationState === null) return { unlocked: false, reason: 'not-applied' };
  if (input.qualificationState === 'SUSPENDED') {
    return { unlocked: false, reason: 'suspended' };
  }
  if (input.sourceFrozenForAttempt) return { unlocked: true };

  /*
   * Two locked reasons per requirement rather than one, because they need
   * different words on screen: "finish the work" and "submit it" are different
   * instructions, and somebody who has finished would otherwise be told to do
   * work they have already done.
   */
  return {
    unlocked: false,
    reason: lockFor(track.sourceRequirement, input.sourceCompleteForAttempt),
  };
}

function lockFor(requirement: SourceRequirement, complete: boolean): ReviewLock {
  if (requirement === 'ELICITATION') {
    return complete ? 'corpus-not-frozen' : 'elicitation-incomplete';
  }
  return complete ? 'source-not-frozen' : 'source-validation-incomplete';
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
    case 'source-validation-incomplete':
      return 'Check the source sentences for this language first. Review opens once they are submitted.';
    case 'source-not-frozen':
      return 'You have checked every source sentence but not submitted them. Submit them to open review.';
    case 'suspended':
      return 'This language track is suspended. Contact languages@consummate7.com.';
  }
}
