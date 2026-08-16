import { describe, expect, it } from 'vitest';
import {
  alignWords,
  boundaryDamage,
  contentRecall,
  costVerdict,
  effectiveCostPerParticipantMinute,
  percentiles,
  protectedTokenAccuracy,
  summarize,
} from './metrics.mjs';

describe('number normalisation', () => {
  it('scores digits and words as the same fact', () => {
    // Commercial recognisers write "8.15"; the local baseline writes "eight
    // fifteen". Without this the bake-off would penalise every cloud candidate
    // on the measure an official conversation cares most about.
    expect(alignWords('the train leaves at eight fifteen', 'the train leaves at 8.15').wordErrorRate).toBe(0);
    expect(protectedTokenAccuracy(['nine'], 'platform 9').rate).toBe(1);
    expect(protectedTokenAccuracy(['treinta'], 'a las 30').rate).toBe(1);
  });
});

describe('alignWords', () => {
  it('separates invention from omission, which are different faults', () => {
    // A provider that writes words nobody said and one that loses words can
    // score the same word error rate and are not the same problem.
    const invented = alignWords('hello there', 'hello there thank you for watching');
    expect(invented.insertions).toBe(4);
    expect(invented.deletions).toBe(0);

    const dropped = alignWords('the train leaves at eight', 'the train leaves');
    expect(dropped.deletions).toBe(2);
    expect(dropped.insertions).toBe(0);
  });

  it('scores a perfect transcript as zero error', () => {
    const result = alignWords('Good morning. Can you hear me?', 'good morning can you hear me');
    expect(result.wordErrorRate).toBe(0);
  });

  it('counts a wrong word as a substitution, not both an add and a drop', () => {
    const result = alignWords('the weather is cold', 'the weather is warm');
    expect(result.substitutions).toBe(1);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });
});

describe('contentRecall', () => {
  it('ignores filler so a paraphrase is not punished as a miss', () => {
    expect(contentRecall('the meeting is in the morning', 'meeting morning')).toBe(1);
  });

  it('falls when real content is lost', () => {
    expect(contentRecall('reserve a table for four people', 'reserve a table')).toBeLessThan(0.7);
  });

  it('treats a number as content however short it is written', () => {
    // "nine" and "9" are the same fact, and losing it is a real miss.
    expect(contentRecall('platform nine', 'platform 9')).toBe(1);
    expect(contentRecall('platform nine', 'platform')).toBeLessThan(1);
  });
});

describe('protectedTokenAccuracy', () => {
  it('scores names and numbers strictly, because approximating them is failure', () => {
    const kept = protectedTokenAccuracy(['Chux', 'eight'], 'mister chux arrives at eight');
    expect(kept.rate).toBe(1);

    const lost = protectedTokenAccuracy(['Chux', 'eight'], 'mister chukes arrives at nine');
    expect(lost.survived).toBe(0);
  });

  it('is null when an utterance has nothing protected in it', () => {
    expect(protectedTokenAccuracy([], 'hello')).toBeNull();
  });
});

describe('boundaryDamage', () => {
  it('counts fragments beyond the one thought that was spoken', () => {
    // One utterance returned as three pieces is the batch pipeline's signature
    // failure: the extra pieces are where invention happens.
    expect(boundaryDamage(1)).toBe(0);
    expect(boundaryDamage(3)).toBe(2);
    expect(boundaryDamage(undefined)).toBe(0);
  });
});

describe('percentiles', () => {
  it('reports the spread, not just the middle', () => {
    const result = percentiles([100, 200, 300, 400, 1000]);
    expect(result.n).toBe(5);
    expect(result.p50).toBe(300);
    expect(result.max).toBe(1000);
  });

  it('is null when a stage was never measured', () => {
    // A provider with no streaming stage must read as unmeasured, not as zero.
    expect(percentiles([])).toBeNull();
    expect(percentiles([undefined, null])).toBeNull();
  });
});

describe('effectiveCostPerParticipantMinute', () => {
  it('charges translation and synthesis once per target language', () => {
    // The whole point of the measure: a second listener language doubles the
    // chain's output work while the call is still the same length.
    const one = effectiveCostPerParticipantMinute({
      speechInputMinutes: 10, speechInputRate: 0.01,
      translationUnits: 10, translationRate: 0.002,
      synthesizedMinutes: 10, synthesizedRate: 0.01,
      targetLanguages: 1, conversationMinutes: 10,
    });
    const two = effectiveCostPerParticipantMinute({
      speechInputMinutes: 10, speechInputRate: 0.01,
      translationUnits: 10, translationRate: 0.002,
      synthesizedMinutes: 10, synthesizedRate: 0.01,
      targetLanguages: 2, conversationMinutes: 10,
    });
    expect(two).toBeGreaterThan(one);
    // Speech input is paid once regardless, so it is not simply doubled.
    expect(two).toBeLessThan(one * 2);
  });

  it('is null when nothing was actually run', () => {
    expect(effectiveCostPerParticipantMinute({ conversationMinutes: 0 })).toBeNull();
  });
});

describe('costVerdict', () => {
  it('applies the owner bands', () => {
    expect(costVerdict(0.04)).toBe('target');
    expect(costVerdict(0.05)).toBe('target');
    expect(costVerdict(0.07)).toBe('acceptable-for-premium-quality');
    expect(costVerdict(0.09)).toBe('requires-business-justification');
    expect(costVerdict(0.2)).toBe('red-flag');
  });

  it('says unmeasured rather than guessing when there is no figure', () => {
    expect(costVerdict(null)).toBe('unmeasured');
  });
});

describe('summarize', () => {
  it('rolls utterances into one comparable row per provider', () => {
    const scored = [
      {
        referenceWords: 5, substitutions: 1, insertions: 2, deletions: 0,
        contentRecall: 0.8, boundaryDamage: 1,
        protectedTokens: { total: 2, survived: 1 },
        timings: { firstPartialTranscriptMs: 300, utteranceCompleteMs: 1200 },
      },
      {
        referenceWords: 5, substitutions: 0, insertions: 0, deletions: 1,
        contentRecall: 1, boundaryDamage: 0,
        protectedTokens: { total: 2, survived: 2 },
        timings: { firstPartialTranscriptMs: 400, utteranceCompleteMs: 1400 },
      },
    ];
    const summary = summarize('baseline-batch', scored, {
      speechInputMinutes: 1, speechInputRate: 0.02, conversationMinutes: 1,
    });

    expect(summary.provider).toBe('baseline-batch');
    expect(summary.quality.inventedWords).toBe(2);
    expect(summary.quality.droppedWords).toBe(1);
    expect(summary.quality.sentenceBoundaryDamage).toBe(1);
    expect(summary.quality.protectedTokenAccuracy).toBe(0.75);
    expect(summary.latency.firstPartialTranscriptMs.p50).toBe(400);
    // A stage nobody measured stays null instead of implying it was instant.
    expect(summary.latency.firstTranslatedAudioMs).toBeNull();
    expect(summary.economics.verdict).toBe('target');
  });
});
