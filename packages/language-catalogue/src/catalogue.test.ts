/**
 * @owner masterzee001
 *
 * The catalogue is data, so the tests are invariants over the data: every key
 * is gateway-shaped, nothing is listed twice, ranks are a strict ordering, and
 * the search folds the way a human typing a name expects.
 */
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_CATALOGUE,
  LANGUAGE_TAG_PATTERN,
  baseSubtag,
  isCatalogueLanguage,
  lookupLanguage,
  searchLanguages,
} from './catalogue.js';

const REQUIRED = (
  'en es fr de pt it nl ru uk pl cs sk ro hu el tr ar fa ur hi bn pa gu mr ta te kn ml or si ne ' +
  'zh ja ko vi th id ms fil sw am ha yo ig zu xh af so rw ln mg sn st tn ts ve nso wo ff om ti he ' +
  'az kk uz ky tg mn my km lo ka hy sq bs hr sr sl mk lt lv et fi sv no da is ga cy eu ca gl ht ps sd ku pcm'
).split(' ');

describe('LANGUAGE_CATALOGUE', () => {
  it('holds roughly eighty languages and every required one', () => {
    expect(LANGUAGE_CATALOGUE.length).toBeGreaterThanOrEqual(80);
    const codes = new Set(LANGUAGE_CATALOGUE.map((l) => l.code));
    for (const code of REQUIRED) expect(codes.has(code), code).toBe(true);
  });

  it('keys every entry by a gateway-shaped base subtag with no script part', () => {
    for (const language of LANGUAGE_CATALOGUE) {
      expect(language.code).toMatch(LANGUAGE_TAG_PATTERN);
      expect(language.code).toMatch(/^[a-z]{2,3}$/);
    }
  });

  it('has no duplicate codes and no duplicate ranks', () => {
    const codes = LANGUAGE_CATALOGUE.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    const ranks = LANGUAGE_CATALOGUE.map((l) => l.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('is ordered by rank with English first', () => {
    for (let i = 1; i < LANGUAGE_CATALOGUE.length; i += 1) {
      expect(LANGUAGE_CATALOGUE[i]!.rank).toBeGreaterThan(LANGUAGE_CATALOGUE[i - 1]!.rank);
    }
    expect(LANGUAGE_CATALOGUE[0]?.code).toBe('en');
    expect(LANGUAGE_CATALOGUE[0]?.rank).toBe(1);
  });

  it('keeps regions to ISO alpha-2, at most four', () => {
    for (const language of LANGUAGE_CATALOGUE) {
      expect(language.regions.length).toBeGreaterThan(0);
      expect(language.regions.length).toBeLessThanOrEqual(4);
      for (const region of language.regions) expect(region).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('marks the Arabic-script and Hebrew entries right-to-left and nothing else', () => {
    for (const language of LANGUAGE_CATALOGUE) {
      const expected = language.script === 'Arab' || language.script === 'Hebr';
      expect(language.rtl, language.code).toBe(expected);
    }
  });

  it('carries Nigerian Pidgin as its own language, keyed pcm', () => {
    // The 9jaLingo specialist synthesises ha, ig, yo AND pcm. A catalogue
    // without pcm can never show the fourth, and Naija is a language tens of
    // millions speak daily, not a dialect of English.
    const pidgin = lookupLanguage('pcm');
    expect(pidgin?.englishName).toBe('Nigerian Pidgin');
    expect(pidgin?.regions).toContain('NG');
    expect(pidgin?.note).toBeDefined();
    expect(searchLanguages('naij')[0]?.code).toBe('pcm');
  });

  it('expresses Chinese as one entry with a note', () => {
    const zh = LANGUAGE_CATALOGUE.filter((l) => l.code === 'zh');
    expect(zh).toHaveLength(1);
    expect(zh[0]?.note).toBeDefined();
  });
});

describe('baseSubtag', () => {
  it('reduces a regional tag to its base', () => {
    expect(baseSubtag('en-US')).toBe('en');
    expect(baseSubtag('fil-PH')).toBe('fil');
    expect(baseSubtag('EN')).toBe('en');
    expect(baseSubtag('pt_BR')).toBe('pt');
  });

  it('refuses garbage rather than inventing a base', () => {
    expect(baseSubtag('')).toBeNull();
    expect(baseSubtag('english')).toBeNull();
    expect(baseSubtag('-US')).toBeNull();
  });
});

describe('lookupLanguage / isCatalogueLanguage', () => {
  it('resolves bare, regional and aliased codes', () => {
    expect(lookupLanguage('yo')?.englishName).toBe('Yoruba');
    expect(lookupLanguage('en-GB')?.code).toBe('en');
    expect(lookupLanguage('tl')?.code).toBe('fil');
    expect(isCatalogueLanguage('ha')).toBe(true);
    expect(isCatalogueLanguage('xx')).toBe(false);
    expect(lookupLanguage('zh-Hans')).not.toBeNull();
  });
});

describe('searchLanguages', () => {
  it("finds Yoruba for 'yor'", () => {
    expect(searchLanguages('yor')[0]?.code).toBe('yo');
  });

  it("finds French for 'français' regardless of case and diacritics", () => {
    expect(searchLanguages('français')[0]?.code).toBe('fr');
    expect(searchLanguages('FRANCAIS')[0]?.code).toBe('fr');
  });

  it('matches the code itself and prefers the exact hit', () => {
    expect(searchLanguages('ha')[0]?.code).toBe('ha');
    expect(searchLanguages('tl')[0]?.code).toBe('fil');
  });

  it('breaks ties by rank and honours the limit', () => {
    const results = searchLanguages('ma', 3);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]!.rank).toBeGreaterThan(results[i - 1]!.rank);
    }
    expect(searchLanguages('')).toEqual([]);
    expect(searchLanguages('zzzz')).toEqual([]);
  });
});
