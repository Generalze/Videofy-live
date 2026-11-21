/** @author masterzee001 */
/**
 * The voice preference, parsed and worded as a voice.
 */
import { describe, expect, it } from 'vitest';
import { TRANSLATED_VOICE_WORDS, parseTranslatedVoice, translatedVoiceSubtitle } from '../call/translatedVoice';

describe('parsing the account service word', () => {
  it('takes exactly the two values', () => {
    expect(parseTranslatedVoice('male')).toBe('male');
    expect(parseTranslatedVoice('female')).toBe('female');
  });

  it('reads anything else as not known, never as a default', () => {
    expect(parseTranslatedVoice('robot')).toBeNull();
    expect(parseTranslatedVoice('MALE')).toBeNull();
    expect(parseTranslatedVoice('')).toBeNull();
    expect(parseTranslatedVoice(undefined)).toBeNull();
    expect(parseTranslatedVoice(null)).toBeNull();
    expect(parseTranslatedVoice(1)).toBeNull();
  });
});

describe('the words', () => {
  it('names each choice as a voice, not as the person', () => {
    expect(TRANSLATED_VOICE_WORDS.male).toBe('Male voice');
    expect(TRANSLATED_VOICE_WORDS.female).toBe('Female voice');
    for (const words of Object.values(TRANSLATED_VOICE_WORDS)) expect(words).not.toMatch(/gender|I am|you are/iu);
  });

  it('says which voice is used when none was chosen, rather than showing nothing', () => {
    expect(translatedVoiceSubtitle(null)).toBe('Not chosen yet · a female voice is used');
    expect(translatedVoiceSubtitle('male')).toBe('Your translated words are spoken in a male voice');
    expect(translatedVoiceSubtitle('female')).toBe('Your translated words are spoken in a female voice');
  });
});
