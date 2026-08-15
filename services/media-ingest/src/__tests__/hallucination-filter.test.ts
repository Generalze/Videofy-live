import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HALLUCINATION_FILTER,
  filterHallucinatedSegments,
  INTERIM_HALLUCINATION_FILTER,
  isCreditLineHallucination,
} from '../hallucination-filter.js';

/**
 * Every case here comes from a real call log. The credit lines and invented
 * replies are transcriptions of silence that reached participants as captions.
 */

function segment(text: string, extra: Record<string, unknown> = {}) {
  return { text, startMs: 0, endMs: 1_000, ...extra };
}

describe('filterHallucinatedSegments', () => {
  it('drops the subtitle credit lines Whisper emits on silence', () => {
    // Both observed in one call: the French form appeared eight times.
    const result = filterHallucinatedSegments([
      segment("Sous-titres réalisés par la communauté d'Amara.org"),
      segment('Subtitles by the Amara.org community'),
      segment('Bonjour.'),
    ]);

    expect(result.kept.map((s) => s.text)).toEqual(['Bonjour.']);
    expect(result.dropped.every((d) => d.reason === 'credit-line')).toBe(true);
  });

  it('matches sign-offs with words inserted mid-phrase', () => {
    // Seen in a real call: a plain substring for "thank you for watching"
    // missed "Thank you very much for watching." because two words split it.
    expect(isCreditLineHallucination('Thank you very much for watching.')).toBe(true);
    expect(isCreditLineHallucination('Thanks so much for listening!')).toBe(true);
    expect(isCreditLineHallucination('See you in the next video')).toBe(true);
  });

  it('does not treat ordinary gratitude as a sign-off', () => {
    // "Thank you" is one of the most common things said on a call.
    expect(isCreditLineHallucination('Thank you.')).toBe(false);
    expect(isCreditLineHallucination('Thank you very much for your help.')).toBe(false);
    expect(isCreditLineHallucination('Thanks for sending the file.')).toBe(false);
  });

  it('matches credit lines regardless of accents or spacing', () => {
    expect(isCreditLineHallucination('SOUS-TITRES  REALISES PAR la communauté')).toBe(true);
    expect(isCreditLineHallucination('Subtítulos realizados por la comunidad')).toBe(true);
  });

  it('does not censor a real conversation about subtitles', () => {
    // This product is about captions, so people will discuss them out loud.
    const result = filterHallucinatedSegments([
      segment('Can you turn the subtitles on?'),
      segment('Les sous-titres sont trop petits.'),
    ]);

    expect(result.kept).toHaveLength(2);
  });

  it('drops text the recogniser itself says is not speech', () => {
    const result = filterHallucinatedSegments([
      segment('It’s like the boots are talking, right?', { noSpeechProb: 0.94 }),
      segment('Bonjour.', { noSpeechProb: 0.1 }),
    ]);

    // An invented conversational reply is what reads as "answering my question"
    // rather than translating it.
    expect(result.kept.map((s) => s.text)).toEqual(['Bonjour.']);
    expect(result.dropped[0]?.reason).toBe('no-speech');
  });

  it('drops text the recogniser was clearly guessing at', () => {
    const result = filterHallucinatedSegments([
      segment('Whisper.', { avgLogProb: -2.4 }),
      segment('This is good.', { avgLogProb: -0.3 }),
    ]);

    expect(result.kept.map((s) => s.text)).toEqual(['This is good.']);
    expect(result.dropped[0]?.reason).toBe('low-confidence');
  });

  it('keeps short real utterances, which a call depends on', () => {
    // "oui" and "ok" carry a conversation and often score poorly. Losing them
    // would be a worse failure than the one being fixed.
    const result = filterHallucinatedSegments([
      segment('Oui.', { noSpeechProb: 0.45, avgLogProb: -0.9 }),
      segment('ok', { noSpeechProb: 0.5, avgLogProb: -0.95 }),
    ]);

    expect(result.kept).toHaveLength(2);
  });

  it('keeps segments the recogniser reported nothing about', () => {
    // A provider that omits the probabilities must not have everything dropped.
    const result = filterHallucinatedSegments([segment('Bonjour.')]);
    expect(result.kept).toHaveLength(1);
  });

  it('ignores empty text without reporting it as a drop', () => {
    const result = filterHallucinatedSegments([segment('   '), segment('Bonjour.')]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('holds interim captions to a higher bar than finals', () => {
    // Observed in a real call: the preview was a different sentence from the
    // final, not a prefix of it, because the recogniser completed a truncated
    // clause. A preview is worth only its head start, and the final is about a
    // second and a half behind, so waiting beats guessing.
    const marginal = [segment("It's nice to talk.", { noSpeechProb: 0.45, avgLogProb: -0.8 })];

    expect(filterHallucinatedSegments(marginal).kept).toHaveLength(1);
    expect(filterHallucinatedSegments(marginal, INTERIM_HALLUCINATION_FILTER).kept).toHaveLength(0);
  });

  it('still lets a confident interim caption through', () => {
    const confident = [segment('This is good.', { noSpeechProb: 0.05, avgLogProb: -0.2 })];
    expect(filterHallucinatedSegments(confident, INTERIM_HALLUCINATION_FILTER).kept).toHaveLength(1);
  });

  it('uses thresholds that let ordinary speech through', () => {
    expect(DEFAULT_HALLUCINATION_FILTER.noSpeechProbability).toBeGreaterThan(0.5);
    expect(DEFAULT_HALLUCINATION_FILTER.minAverageLogProbability).toBeLessThan(-0.5);
  });
});
