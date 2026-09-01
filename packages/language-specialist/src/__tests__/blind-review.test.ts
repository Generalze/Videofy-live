/** @author masterzee001 */
/**
 * The blind, and the gate in front of it.
 *
 * The serialisation assertion is the load-bearing one. Checking that the
 * returned object has no `provider` key passes for a payload that carries the
 * engine name nested one level down, which is exactly the shape a future
 * "candidate metadata" field would take.
 */
import { describe, expect, it } from 'vitest';
import {
  DECISIVE_CRITERION,
  REVIEW_CRITERIA,
  WITHHELD_FIELDS,
  blindCandidate,
  blindPacket,
  readVerdict,
  type StoredCandidate,
} from '../blind-review.js';
import { reviewAccess, reviewLockMessage } from '../review-gate.js';

const STORED: StoredCandidate = {
  candidateId: 'cand_8f0a2d',
  assignmentId: 'asg_1',
  ordinal: 3,
  direction: 'yo->en',
  category: 'payment-not-received',
  sourceText: 'Mi ò tíì gba owó náà.',
  candidateText: 'I have received the money.',
  provider: 'opus-mt',
  model: 'Helsinki-NLP/opus-mt-yo-en',
  machineScore: 0.82,
  benchmarkRank: 1,
  expectedWinner: true,
};

describe('what a reviewer is handed', () => {
  it('carries the source, the candidate and the direction', () => {
    const blind = blindCandidate(STORED);
    expect(blind.sourceText).toBe(STORED.sourceText);
    expect(blind.candidateText).toBe(STORED.candidateText);
    // The reviewer must know which way round it is; that is not identity.
    expect(blind.direction).toBe('yo->en');
    expect(blind.candidateId).toBe('cand_8f0a2d');
  });

  it('PIN: no engine identity survives serialisation', () => {
    // Serialised, not key-checked: a nested metadata object would pass the
    // shallow assertion and ship the engine name to the reviewer's browser.
    const wire = JSON.stringify(blindPacket([STORED]));
    for (const field of WITHHELD_FIELDS) {
      expect(wire, field).not.toContain(field);
    }
    expect(wire).not.toContain('opus-mt');
    expect(wire).not.toContain('Helsinki');
  });

  it('PIN: no machine score and no expected winner reach the reviewer', () => {
    // Automatic checks have been wrong three times on Yoruba-adjacent
    // judgements. Showing one replaces the reviewer's judgement with a prior.
    const wire = JSON.stringify(blindCandidate(STORED));
    expect(wire).not.toContain('0.82');
    expect(wire).not.toContain('true');
  });

  it('PIN: the assignment id is not leaked into the candidate', () => {
    // Two candidates for the same source sit in one packet; carrying the
    // assignment on each row buys nothing and widens what a shared screenshot
    // discloses.
    expect(Object.keys(blindCandidate(STORED))).not.toContain('assignmentId');
  });
});

describe('the review criteria', () => {
  it('are the ten columns of the existing paper packet, in packet order', () => {
    expect(REVIEW_CRITERIA.map((criterion) => criterion.key)).toEqual([
      'meaningPreserved',
      'meaningReversed',
      'informationOmitted',
      'informationInvented',
      'namesNumbersCorrupted',
      'naturalness',
      'grammar',
      'trustInRealChat',
    ]);
  });

  it('PIN: reversal is the decisive question', () => {
    expect(DECISIVE_CRITERION).toBe('meaningReversed');
    const reversed = REVIEW_CRITERIA.find((c) => c.key === 'meaningReversed');
    // Which ANSWER is the bad one differs per row; "preserved: no" and
    // "reversed: yes" are both failures.
    expect(reversed?.adverse).toBe('yes');
    expect(REVIEW_CRITERIA.find((c) => c.key === 'meaningPreserved')?.adverse).toBe('no');
  });
});

describe('reading a verdict', () => {
  const COMPLETE = {
    meaningPreserved: 'no',
    meaningReversed: 'yes',
    informationOmitted: 'no',
    informationInvented: 'no',
    namesNumbersCorrupted: 'no',
    naturalness: 4,
    grammar: 4,
    trustInRealChat: 'no',
  };

  it('accepts a complete judgement', () => {
    const reading = readVerdict('cand_1', COMPLETE);
    expect(reading.ok).toBe(true);
    expect(reading.ok && reading.verdict.meaningReversed).toBe('yes');
  });

  it('PIN: an unanswered yes/no is refused, never defaulted', () => {
    // Stored as a default it would be indistinguishable from a judgement the
    // reviewer actually made.
    const { trustInRealChat, ...missing } = COMPLETE;
    void trustInRealChat;
    const reading = readVerdict('cand_1', missing);
    expect(reading.ok).toBe(false);
    expect(reading.ok === false && reading.problems).toContainEqual({
      kind: 'missing',
      field: 'trustInRealChat',
    });
  });

  it('normalises a checkbox-shaped client to the stored words', () => {
    const reading = readVerdict('cand_1', { ...COMPLETE, meaningReversed: true });
    expect(reading.ok && reading.verdict.meaningReversed).toBe('yes');
  });

  it('refuses a score outside 1-5 and a non-integer one', () => {
    expect(readVerdict('cand_1', { ...COMPLETE, naturalness: 0 }).ok).toBe(false);
    expect(readVerdict('cand_1', { ...COMPLETE, naturalness: 6 }).ok).toBe(false);
    expect(readVerdict('cand_1', { ...COMPLETE, grammar: 3.5 }).ok).toBe(false);
  });

  it('leaves the two optional fields absent rather than empty', () => {
    const reading = readVerdict('cand_1', { ...COMPLETE, note: '   ' });
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    // exactOptionalPropertyTypes is on: an absent optional must be an absent
    // PROPERTY, not a present undefined one.
    expect('note' in reading.verdict).toBe(false);
    expect('correctedTranslation' in reading.verdict).toBe(false);
  });

  it('keeps a correction when one is offered', () => {
    const reading = readVerdict('cand_1', {
      ...COMPLETE,
      correctedTranslation: 'I have NOT received the money.',
    });
    expect(reading.ok && reading.verdict.correctedTranslation).toBe(
      'I have NOT received the money.',
    );
  });
});

describe('the review gate', () => {
  const YORUBA = {
    language: 'yo',
    qualificationState: 'ASSESSMENT_IN_PROGRESS' as const,
    corpusFrozen: false,
    elicitationComplete: false,
  };

  it('PIN: review is LOCKED while the elicitation is unfinished', () => {
    expect(reviewAccess(YORUBA)).toEqual({ unlocked: false, reason: 'elicitation-incomplete' });
  });

  it('PIN: written-but-not-submitted is still locked, with its own words', () => {
    // A person who has typed all fifteen and not pressed submit must not be
    // told to do work they have already done.
    const access = reviewAccess({ ...YORUBA, elicitationComplete: true });
    expect(access).toEqual({ unlocked: false, reason: 'corpus-not-frozen' });
    expect(reviewLockMessage('corpus-not-frozen')).toContain('Submit them');
  });

  it('PIN: review is AVAILABLE once the corpus is frozen', () => {
    expect(
      reviewAccess({ ...YORUBA, elicitationComplete: true, corpusFrozen: true }),
    ).toEqual({ unlocked: true });
  });

  it('PIN: a language needing no elicitation is still gated on the track', () => {
    // Returning unlocked for anyone who happens not to need a corpus would be a
    // bypass shaped like an exemption.
    expect(
      reviewAccess({
        language: 'fr',
        qualificationState: null,
        corpusFrozen: false,
        elicitationComplete: false,
      }),
    ).toEqual({ unlocked: false, reason: 'not-applied' });
    expect(
      reviewAccess({
        language: 'fr',
        qualificationState: 'ASSESSMENT_IN_PROGRESS',
        corpusFrozen: false,
        elicitationComplete: false,
      }),
    ).toEqual({ unlocked: true });
  });

  it('PIN: a suspended track cannot review, frozen corpus or not', () => {
    expect(
      reviewAccess({
        language: 'yo',
        qualificationState: 'SUSPENDED',
        corpusFrozen: true,
        elicitationComplete: true,
      }),
    ).toEqual({ unlocked: false, reason: 'suspended' });
  });

  it('refuses a language the programme does not run', () => {
    expect(
      reviewAccess({
        language: 'de',
        qualificationState: 'QUALIFIED',
        corpusFrozen: true,
        elicitationComplete: true,
      }),
    ).toEqual({ unlocked: false, reason: 'not-a-track' });
  });
});
