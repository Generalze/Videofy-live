/** @author masterzee001 */
/**
 * The picker's questions, pinned as pure functions.
 *
 * Written after the console refused languages it could perfectly well deliver:
 * every list gated on the CONSERVATIVE capability word, which is the weakest of
 * recognition, translation and synthesis. A viewer asking to hear Igbo does not
 * care that no recogniser transcribes Igbo. Each test below names the direction
 * it is asking about, because that is the whole bug.
 */
import { describe, expect, it } from 'vitest';
import {
  DEGRADED_WORD,
  filterLanguages,
  isAddableTarget,
  isSelectableSource,
  languageTag,
  type LanguageRow,
} from './languageRows';

function row(partial: Partial<LanguageRow> & { code: string }): LanguageRow {
  return {
    label: partial.code.toUpperCase(),
    state: 'available',
    ...partial,
  };
}

describe('isAddableTarget', () => {
  it('offers a language with a voice', () => {
    expect(isAddableTarget(row({ code: 'es', targetState: 'available' }))).toBe(true);
  });

  it('offers a language nothing can transcribe, because a target is not a source', () => {
    const igbo = row({ code: 'ig', state: 'unavailable', sourceState: 'unavailable', targetState: 'limited' });
    expect(isAddableTarget(igbo)).toBe(true);
    expect(isSelectableSource(igbo)).toBe(false);
  });

  it('offers a captions-only language, and refuses one nothing translates', () => {
    expect(isAddableTarget(row({ code: 'wo', state: 'unavailable', targetState: 'unavailable', captionsOnly: true }))).toBe(true);
    expect(isAddableTarget(row({ code: 've', state: 'unavailable', targetState: 'unavailable' }))).toBe(false);
  });

  it('falls back to the conservative word when an older ingest sends no direction', () => {
    expect(isAddableTarget(row({ code: 'fr', state: 'available' }))).toBe(true);
    expect(isAddableTarget(row({ code: 'xx', state: 'unavailable' }))).toBe(false);
    expect(isSelectableSource(row({ code: 'xx', state: 'unavailable' }))).toBe(false);
  });

  it('still offers a degraded row, because refusing it is not the warning', () => {
    // Hiding Yoruba would not tell anybody why. The row is selectable and
    // carries the word, which is what the operator can act on.
    const yoruba = row({ code: 'yo', state: 'limited', targetState: 'limited', degraded: true });
    expect(isAddableTarget(yoruba)).toBe(true);
    expect(DEGRADED_WORD).toMatch(/degraded/i);
  });
});

describe('filterLanguages and languageTag, unchanged by the new fields', () => {
  const rows: LanguageRow[] = [
    row({ code: 'yo', label: 'Yoruba', nativeName: 'Èdè Yorùbá' }),
    row({ code: 'pcm', label: 'Nigerian Pidgin', nativeName: 'Naijá' }),
    row({ code: 'fr', label: 'French', nativeName: 'Français' }),
  ];

  it('matches label, native name and code prefix, diacritics folded', () => {
    expect(filterLanguages(rows, 'francais').map((r) => r.code)).toEqual(['fr']);
    expect(filterLanguages(rows, 'naija').map((r) => r.code)).toEqual(['pcm']);
    expect(filterLanguages(rows, 'yo').map((r) => r.code)).toEqual(['yo']);
    expect(filterLanguages(rows, '').length).toBe(3);
  });

  it('keeps the tag to two letters of the base subtag', () => {
    expect(languageTag('pt-BR')).toBe('PT');
    expect(languageTag('pcm')).toBe('PC');
  });
});
