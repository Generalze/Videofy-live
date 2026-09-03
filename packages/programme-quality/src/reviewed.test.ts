/** @author masterzee001 */
/**
 * Reviewed quality, and the sentence a console is allowed to say.
 *
 * The failure this guards against is not a wrong score. It is a route with no
 * judgement at all being rendered as though it had passed one, because
 * "assessed: false" came out of a template as an empty cell.
 */
import { describe, expect, it } from 'vitest';
import {
  NOT_ASSESSED,
  reviewedQualityFor,
  reviewedQualityWords,
  type ReviewEvidence,
} from './reviewed.js';

const evidence: ReviewEvidence = {
  sourceLanguage: 'en',
  targetLanguage: 'yo',
  scope: 'programme-live',
  engine: 'naijalingo',
  model: 'yo-general',
  modelVersion: '2026.08',
  corpusHash: 'c0ffee',
  corpusVersion: 'ng-business-v3',
  evaluator: 'A. Adeyemi',
  assessedAt: '2026-08-20T10:00:00.000Z',
  method: 'human-review',
  score: 4.4,
  scale: '1-5 adequacy',
  evidenceReference: 'QUAL-114',
};

const running = { modelVersion: '2026.08', corpusHash: 'c0ffee' };

describe('the default is that nobody has looked', () => {
  it('is not assessed when there is no evidence', () => {
    expect(reviewedQualityFor(null, running)).toEqual(NOT_ASSESSED);
  });

  it('says so in words, rather than leaving a blank that reads like a pass', () => {
    expect(reviewedQualityWords(NOT_ASSESSED)).toBe('Not assessed.');
  });
});

describe('an assessment is about one model and one corpus', () => {
  it('stands while both are what is running', () => {
    const quality = reviewedQualityFor(evidence, running);
    expect(quality.assessed).toBe(true);
    expect(reviewedQualityWords(quality)).toContain('A. Adeyemi');
    expect(reviewedQualityWords(quality)).toContain('4.4');
  });

  it('goes stale when the model moves on', () => {
    // A new model version is a new thing to judge. Inheriting the old verdict
    // is how a qualified route quietly becomes an unqualified one.
    const quality = reviewedQualityFor(evidence, { ...running, modelVersion: '2026.09' });
    expect(quality.assessed).toBe(false);
    expect(quality).toMatchObject({ reason: 'stale' });
  });

  it('goes stale when the corpus changes under it', () => {
    // "The Nigerian corpus" is not a fixed thing; the hash is what makes a
    // stale qualification visible rather than assumed.
    const quality = reviewedQualityFor(evidence, { ...running, corpusHash: 'deadbeef' });
    expect(quality).toMatchObject({ assessed: false, reason: 'stale' });
  });

  it('says plainly that a stale review is not a review of what is running', () => {
    const quality = reviewedQualityFor(evidence, { ...running, modelVersion: '2026.09' });
    const words = reviewedQualityWords(quality);
    expect(words).toContain('Not assessed for what is running now');
    // And never reads as an endorsement.
    expect(words).not.toMatch(/^Reviewed \d/u);
  });

  it('keeps the old evidence, because it is still evidence about something', () => {
    const quality = reviewedQualityFor(evidence, { ...running, modelVersion: '2026.09' });
    expect(quality).toMatchObject({ evidence: { evidenceReference: 'QUAL-114' } });
  });
});
