import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_LANGUAGE,
  selectSessionTargetLanguage,
  toggleTargetLanguage,
} from './targetLanguageSelection';

describe('target language selection', () => {
  it('defaults partner-preview sessions to Spanish', () => {
    expect(DEFAULT_TARGET_LANGUAGE).toBe('es');
  });

  it('keeps the active session target selected when changed from the media control', () => {
    expect(selectSessionTargetLanguage(['es'], 'fr')).toEqual({
      targetLanguage: 'fr',
      targetLanguages: ['es', 'fr'],
    });
  });

  it('moves the active target when its selected channel is removed', () => {
    expect(toggleTargetLanguage(['es', 'fr'], 'fr', 'fr', false)).toEqual({
      targetLanguage: 'es',
      targetLanguages: ['es'],
    });
  });

  it('does not leave a session without a target channel', () => {
    expect(toggleTargetLanguage(['es'], 'es', 'es', false)).toEqual({
      targetLanguage: 'es',
      targetLanguages: ['es'],
    });
  });
});
