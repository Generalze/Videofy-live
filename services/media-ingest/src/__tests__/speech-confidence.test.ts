/** @owner masterzee001 */
/**
 * Whisper does not say "I heard nothing" — it guesses what silence would have
 * been, fluently. On a call that guess is translated and then spoken in the
 * speaker's own voice, so a fabrication is indistinguishable from something
 * they said. These tests pin the rule that refuses it.
 */
import { describe, expect, it } from 'vitest';
import {
  createRepetitionFilter,
  DEFAULT_HALLUCINATION_THRESHOLDS,
  hallucinationReason,
  isMemorisedCredit,
  readHallucinationThresholds,
  rejectHallucinatedSpeech,
} from '../speech-confidence.js';

const REAL = { text: 'Good morning, can you hear me?', noSpeechProb: 0.02, avgLogProb: -0.2 };

describe('real speech is kept', () => {
  it('keeps a confident segment', () => {
    expect(hallucinationReason(REAL)).toBeNull();
  });

  it('keeps quiet-but-real speech the model is still fairly sure about', () => {
    // Somebody speaking softly must not be deleted. Dropping real words is a
    // different failure, not a smaller one.
    expect(hallucinationReason({ text: 'yes, exactly', noSpeechProb: 0.5, avgLogProb: -0.9 })).toBeNull();
  });

  it('keeps a segment from a provider that reports no probabilities at all', () => {
    // Failing open here is deliberate: the alternative is a transcription
    // engine that appears to have gone deaf after a dependency upgrade.
    expect(hallucinationReason({ text: 'hello there' })).toBeNull();
    expect(hallucinationReason({ text: 'hello there', noSpeechProb: null, avgLogProb: null })).toBeNull();
  });
});

describe('invented speech is refused', () => {
  it('refuses the classic pairing: probably silence, and unsure of the words', () => {
    expect(
      hallucinationReason({ text: 'Thank you.', noSpeechProb: 0.8, avgLogProb: -1.4 }),
    ).toBe('no-speech-and-uncertain');
  });

  it('refuses a CONFIDENT fabrication when no-speech evidence is overwhelming', () => {
    // Deliberately ordinary text, so this exercises the PROBABILITY rule alone.
    // A subtitle credit here would be caught by the phrase rule first and this
    // test would pass without proving anything about the numbers.
    expect(
      hallucinationReason({
        text: 'And that is really the whole point of it.',
        noSpeechProb: 0.97,
        avgLogProb: -0.1,
      }),
    ).toBe('no-speech');
  });

  it('refuses empty and whitespace-only text', () => {
    expect(hallucinationReason({ text: '' })).toBe('empty');
    expect(hallucinationReason({ text: '   ' })).toBe('empty');
  });

  it('does not refuse on high no-speech alone when confidence is unknown', () => {
    // Below the certain threshold the pairing is the rule, and half a rule is
    // not a reason to delete somebody's sentence.
    expect(hallucinationReason({ text: 'maybe', noSpeechProb: 0.7 })).toBeNull();
  });
});

describe('memorised subtitle credits', () => {
  it('refuses the exact fabrications observed in a real call', () => {
    // Both were spoken aloud in the speaker's own cloned voice, in French, to
    // somebody with no way to know they were invented.
    for (const text of [
      "Sous-titres réalisés par la communauté d'Amara.org",
      'Subtitles directed by the community of Amara.org',
      "sur les communautés de l'Université de Montréal.",
      'on the communities of the University of Montreal.',
      'And I will see you in the next video.',
      'et je vous verrai dans la prochaine vidéo.',
    ]) {
      expect(hallucinationReason({ text, noSpeechProb: 0.05, avgLogProb: -0.15 })).toBe(
        'memorised-credit',
      );
    }
  });

  it('catches them even when the model is CERTAIN they are speech', () => {
    // The whole reason this rule exists. The probability guard waves these
    // through: the model is not mumbling, it is confidently reciting something
    // it saw at the end of thousands of subtitled videos.
    const confident = { text: 'Thanks for watching!', noSpeechProb: 0.01, avgLogProb: -0.05 };

    expect(hallucinationReason(confident)).toBe('memorised-credit');
  });

  it('matches phrases, never bare words', () => {
    // Dropping real speech is a different failure, not a smaller one. Somebody
    // discussing subtitles or Montreal must still be heard.
    for (const text of [
      'Can you turn the subtitles on please?',
      'I am flying to Montreal on Tuesday.',
      'Thanks, I appreciate it.',
      'We watched it together.',
    ]) {
      expect(isMemorisedCredit(text), text).toBe(false);
      expect(hallucinationReason({ text, noSpeechProb: 0.05, avgLogProb: -0.2 })).toBeNull();
    }
  });
});

describe('the recogniser looping on one sentence', () => {
  it('stops the exact loop observed after a speaker went quiet', () => {
    // Eight identical sentences in the speaker's own cloned voice, ending only
    // when they muted.
    const filter = createRepetitionFilter();
    const looped = 'We will try to catch them, and I will see you in the next video.';

    const kept = Array.from({ length: 8 }, () => looped).filter((t) => !filter.isLooping(t));

    expect(kept).toHaveLength(2);
  });

  it('allows a person repeating themselves', () => {
    // "no, no" is speech. A caption system that deletes the second one is
    // broken in a way that is harder to notice than the loop it prevents.
    const filter = createRepetitionFilter();

    expect(filter.isLooping('No.')).toBe(false);
    expect(filter.isLooping('No.')).toBe(false);
  });

  it('treats punctuation drift between decodes as the same sentence', () => {
    // The observed loop alternated "catch them and I will" with
    // "catch them, and I will" — the same sentence, differently punctuated.
    const filter = createRepetitionFilter();

    expect(filter.isLooping('We will try to catch them and I will see you')).toBe(false);
    expect(filter.isLooping('We will try to catch them, and I will see you.')).toBe(false);
    expect(filter.isLooping('We will try to catch them and I will see you!')).toBe(true);
  });

  it('resets when the speaker says something else', () => {
    const filter = createRepetitionFilter();
    filter.isLooping('Same sentence.');
    filter.isLooping('Same sentence.');

    expect(filter.isLooping('Something different.')).toBe(false);
    expect(filter.isLooping('Same sentence.')).toBe(false);
  });
});

describe('rejectHallucinatedSpeech', () => {
  it('keeps the real utterance and counts what it dropped', () => {
    const { kept, rejected } = rejectHallucinatedSpeech([
      REAL,
      { text: 'Thank you.', noSpeechProb: 0.95, avgLogProb: -0.1 },
      { text: '', noSpeechProb: 0.01, avgLogProb: -0.1 },
    ]);

    expect(kept).toEqual([REAL]);
    // Reported rather than silent: fewer captions than utterances is something
    // somebody will eventually have to explain.
    expect(rejected).toBe(2);
  });

  it('leaves an ordinary conversation completely alone', () => {
    const conversation = [
      REAL,
      { text: 'I would like to book a table.', noSpeechProb: 0.05, avgLogProb: -0.3 },
      { text: 'Thank you very much.', noSpeechProb: 0.11, avgLogProb: -0.45 },
    ];

    expect(rejectHallucinatedSpeech(conversation).kept).toHaveLength(3);
  });
});

describe('thresholds are configurable', () => {
  it('falls back to the defaults when unset or unparseable', () => {
    expect(readHallucinationThresholds({})).toEqual(DEFAULT_HALLUCINATION_THRESHOLDS);
    expect(readHallucinationThresholds({ TRANSCRIPTION_MAX_NO_SPEECH_PROB: 'loud' })).toEqual(
      DEFAULT_HALLUCINATION_THRESHOLDS,
    );
  });

  it('can be tightened or disabled without a code change', () => {
    const strict = readHallucinationThresholds({ TRANSCRIPTION_CERTAIN_NO_SPEECH_PROB: '0.5' });
    expect(hallucinationReason({ text: 'Thank you.', noSpeechProb: 0.55 }, strict)).toBe('no-speech');

    // A microphone this rule is wrong for must be recoverable in the field.
    const disabled = readHallucinationThresholds({
      TRANSCRIPTION_CERTAIN_NO_SPEECH_PROB: '1',
      TRANSCRIPTION_MAX_NO_SPEECH_PROB: '1',
    });
    expect(hallucinationReason({ text: 'Thank you.', noSpeechProb: 0.99, avgLogProb: -3 }, disabled)).toBeNull();
  });
});
