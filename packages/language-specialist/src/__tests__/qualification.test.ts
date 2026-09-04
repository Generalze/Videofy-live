/** @author masterzee001 */
/**
 * The state machine, and the two edges that are product decisions rather than
 * bookkeeping.
 */
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_SETTABLE_STATES,
  QUALIFICATION_STATES,
  allowedNextStates,
  canTransition,
  isOperatorSettable,
  isQualificationState,
} from '../qualification.js';

describe('qualification states', () => {
  it('carries the nine states the programme is specified in', () => {
    expect([...QUALIFICATION_STATES]).toEqual([
      'APPLIED',
      'ASSESSMENT_PENDING',
      'ASSESSMENT_IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'QUALIFIED',
      'NOT_QUALIFIED',
      'REASSESSMENT_ALLOWED',
      'SUSPENDED',
    ]);
  });

  it('PIN: NOT_ASSESSED is not a stored state', () => {
    // It is the absence of a record. A tenth state would mean the same thing
    // twice and the two would eventually disagree.
    expect(isQualificationState('NOT_ASSESSED')).toBe(false);
  });

  it('refuses a state that is merely a plausible string', () => {
    expect(isQualificationState('QUALIFED')).toBe(false);
    expect(isQualificationState('qualified')).toBe(false);
    expect(isQualificationState(undefined)).toBe(false);
  });

  it('every state has an explicit transition list', () => {
    for (const state of QUALIFICATION_STATES) {
      expect(Array.isArray(allowedNextStates(state)), state).toBe(true);
    }
  });

  it('PIN: a qualification is withdrawn by SUSPENDED, never by NOT_QUALIFIED', () => {
    // Withdrawing a qualification already used to review real material is not
    // the same act as failing an assessment, and recording it as the latter
    // would rewrite what the reviewer's past verdicts were made under.
    expect(canTransition('QUALIFIED', 'SUSPENDED')).toBe(true);
    expect(canTransition('QUALIFIED', 'NOT_QUALIFIED')).toBe(false);
  });

  it('PIN: the only way back from NOT_QUALIFIED is an operator permitting it', () => {
    expect(allowedNextStates('NOT_QUALIFIED')).toEqual(['REASSESSMENT_ALLOWED']);
    expect(canTransition('NOT_QUALIFIED', 'ASSESSMENT_PENDING')).toBe(false);
  });

  it('PIN: an operator cannot hand-write a SUBMITTED track', () => {
    // SUBMITTED means a corpus was frozen. An operator who can write it by hand
    // can produce a state for which no evidence exists, and the state is the
    // part people read.
    expect(isOperatorSettable('SUBMITTED')).toBe(false);
    expect(isOperatorSettable('APPLIED')).toBe(false);
    expect(isOperatorSettable('ASSESSMENT_IN_PROGRESS')).toBe(false);
    for (const state of OPERATOR_SETTABLE_STATES) {
      expect(isOperatorSettable(state), state).toBe(true);
    }
  });
});
