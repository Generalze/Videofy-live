import { describe, expect, it } from 'vitest';
import * as selection from './targetLanguageSelection';
import { selectSessionTargetLanguage, toggleTargetLanguage } from './targetLanguageSelection';

describe('target language selection', () => {
  it('exports no default target language', () => {
    expect(Object.keys(selection)).not.toContain('DEFAULT_TARGET_LANGUAGE');
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

  // Founder ruling (30 Aug 2026): no EN->ES preset anywhere. Removing the
  // last target leaves none; the start flow refuses to run without one.
  it('leaves no target when the last one is removed, instead of a Spanish preset', () => {
    expect(toggleTargetLanguage(['es'], 'es', 'es', false)).toEqual({
      targetLanguage: '',
      targetLanguages: [],
    });
  });

  it('adds the first target to an empty selection without injecting a preset', () => {
    expect(toggleTargetLanguage([], '', 'fr', true)).toEqual({
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
    });
  });
});
