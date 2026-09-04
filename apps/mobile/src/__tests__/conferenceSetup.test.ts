/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  COMMON_LANGUAGE_COUNT,
  CONFERENCE_TARGET_LANGUAGE_MAX,
  CONFERENCE_TITLE_MAX,
  buildConferenceSetup,
  commonLanguages,
  languageLabel,
  moreLanguages,
  normaliseTitle,
  privacyExplanation,
  toggleLanguage,
} from '../conference/conferenceSetup';

describe('conference setup', () => {
  it('trims the title, cuts it at the wire limit, and omits it when empty', () => {
    expect(normaliseTitle('  Global Townhall ')).toBe('Global Townhall');
    expect(normaliseTitle('   ')).toBeUndefined();
    expect(normaliseTitle('x'.repeat(CONFERENCE_TITLE_MAX + 20))).toHaveLength(CONFERENCE_TITLE_MAX);
    expect(buildConferenceSetup({ title: '', privacy: 'private', targetLanguages: [] })).toEqual({
      privacy: 'private',
      targetLanguages: [],
    });
  });

  it('toggles a language and refuses a ninth', () => {
    let selected: readonly string[] = [];
    for (const code of ['en', 'fr', 'sw', 'yo', 'ha', 'ig', 'pt', 'ar']) selected = toggleLanguage(selected, code);
    expect(selected).toHaveLength(CONFERENCE_TARGET_LANGUAGE_MAX);
    expect(toggleLanguage(selected, 'zh')).toEqual(selected);
    expect(toggleLanguage(selected, 'fr')).not.toContain('fr');
  });

  it('deduplicates and caps the languages sent', () => {
    const setup = buildConferenceSetup({
      title: 'T',
      privacy: 'restricted',
      targetLanguages: ['en', 'en', 'fr', 'sw', 'yo', 'ha', 'ig', 'pt', 'ar', 'zh'],
    });
    expect(setup.targetLanguages).toEqual(['en', 'fr', 'sw', 'yo', 'ha', 'ig', 'pt', 'ar']);
  });

  it('shows the most common languages first, English at the head', () => {
    const common = commonLanguages();
    expect(common).toHaveLength(COMMON_LANGUAGE_COUNT);
    expect(common[0]?.code).toBe('en');
  });

  it('More searches by name or code and leaves out what is already selected', () => {
    expect(moreLanguages('yoruba', []).map((l) => l.code)).toContain('yo');
    expect(moreLanguages('yo', ['yo']).map((l) => l.code)).not.toContain('yo');
    const rest = moreLanguages('', ['en']);
    expect(rest.every((l) => l.code !== 'en')).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
  });

  it('labels a known code by name and an unknown one by itself', () => {
    expect(languageLabel('sw')).toBe('Swahili');
    expect(languageLabel('pt-BR')).toBe('Portuguese');
    expect(languageLabel('zzz')).toBe('zzz');
  });

  it('explains every privacy tier in one line', () => {
    expect(privacyExplanation('public')).toBe('Listed for anyone to join.');
    expect(privacyExplanation('private')).toBe('Only with the code.');
    expect(privacyExplanation('restricted')).toBe('You admit each person.');
  });
});
