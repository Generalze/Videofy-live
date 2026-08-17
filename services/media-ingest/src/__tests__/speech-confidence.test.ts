/** @owner masterzee001 */
/**
 * Whisper does not say "I heard nothing" — it guesses what silence would have
 * been, fluently. On a call that guess is translated and then spoken in the
 * speaker's own voice, so a fabrication is indistinguishable from something
 * they said. These tests pin the rule that refuses it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HALLUCINATION_THRESHOLDS,
  hallucinationReason,
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
    // The characteristic silence hallucination is a memorised subtitle credit
    // the model is very confident about, so a rule requiring low confidence
    // lets exactly the worst case through.
    expect(
      hallucinationReason({
        text: 'Merci d’avoir regardé cette vidéo.',
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
