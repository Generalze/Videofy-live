/** @author masterzee001 */
/**
 * Vocabulary that actually reaches a consumer — or says plainly that it does not.
 *
 * The rule this package exists to obey: no decorative form. "We saved your
 * vocabulary" and "your vocabulary changed the output" are different promises,
 * and only the second is worth making. So every test below is about whether a
 * stored field reached something, or was honestly reported as unconsumed.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCanonicalRenderings,
  resolveConsumption,
  type VocabularyEntry,
} from './index.js';

function entry(over: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id: 'v1', term: 'Adebayo', canonicalRendering: '', language: '*',
    pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'person', notes: '', enabled: true, ...over,
  };
}

describe('a disabled term reaches nothing', () => {
  it('is absent from every consumer', () => {
    const c = resolveConsumption(
      [entry({ enabled: false, doNotTranslate: true, sttKeyterm: true,
               canonicalRendering: 'Adebayo', pronunciationHint: 'ah-day-BAH-yo' })],
      'yo',
      { sttKeyterms: true, pronunciationHints: true },
    );
    expect(c.doNotTranslate).toEqual([]);
    expect(c.sttKeyterms).toEqual([]);
    expect(c.canonical.size).toBe(0);
    expect(c.pronunciation.size).toBe(0);
  });
});

describe('language selection', () => {
  it('includes terms tagged for this language and the * terms', () => {
    const c = resolveConsumption([
      entry({ id: 'a', term: 'Lagos', language: '*', doNotTranslate: true }),
      entry({ id: 'b', term: 'Abeokuta', language: 'yo', doNotTranslate: true }),
      entry({ id: 'c', term: 'Bonjour', language: 'fr', doNotTranslate: true }),
    ], 'yo');
    expect(c.doNotTranslate).toEqual(['Lagos', 'Abeokuta']);
  });

  it('matches on the base tag, so pt-BR gets the pt terms', () => {
    const c = resolveConsumption(
      [entry({ term: 'Consummate 7', language: 'pt', doNotTranslate: true })],
      'pt-BR',
    );
    expect(c.doNotTranslate).toEqual(['Consummate 7']);
  });
});

describe('unconsumed fields are REPORTED, not silently stored', () => {
  it('says so when the recogniser does not accept keyterms', () => {
    const c = resolveConsumption(
      [entry({ sttKeyterm: true })],
      'en',
      { sttKeyterms: false, pronunciationHints: true },
    );
    expect(c.sttKeyterms).toEqual([]);
    expect(c.unconsumed).toContain('sttKeyterm');
  });

  it('says so when the voice route accepts no pronunciation hint', () => {
    const c = resolveConsumption(
      [entry({ pronunciationHint: 'ah-day-BAH-yo' })],
      'en',
      { sttKeyterms: true, pronunciationHints: false },
    );
    expect(c.pronunciation.size).toBe(0);
    expect(c.unconsumed).toContain('pronunciationHint');
  });

  it('reports nothing unconsumed when every capability is present', () => {
    const c = resolveConsumption(
      [entry({ sttKeyterm: true, pronunciationHint: 'ah-day-BAH-yo' })],
      'en',
      { sttKeyterms: true, pronunciationHints: true },
    );
    expect(c.unconsumed).toEqual([]);
  });

  it('does not call an operator note unconsumed', () => {
    // `notes` and `kind` are for the humans maintaining the list. An operator's
    // own memo is not a broken promise, and flagging it would train people to
    // ignore the warning that matters.
    const c = resolveConsumption([entry({ notes: 'checked with the producer' })], 'en');
    expect(c.unconsumed).toEqual([]);
  });
});

describe('canonical renderings', () => {
  it('substitutes the agreed spelling for the rendering it was given', () => {
    // The operator lists the rendering they SAW, and the spelling they want.
    // An earlier version of this test listed `Zoe -> Zoe` and expected `Zoé` to
    // be corrected, which no substitution could do: you cannot match a string
    // you were not given. That is a real limit of this mechanism and it is
    // documented rather than papered over -- see the note in index.ts.
    const c = resolveConsumption(
      [entry({ term: 'Zoé', canonicalRendering: 'Zoe' })], 'fr');
    expect(applyCanonicalRenderings('Je m’appelle Zoé.', c.canonical))
      .toBe('Je m’appelle Zoe.');
  });

  it('cannot fix a rendering nobody listed, and does not pretend to', () => {
    const c = resolveConsumption(
      [entry({ term: 'Zoe', canonicalRendering: 'Zoe' })], 'fr');
    // Unchanged: `Zoé` was never listed. The console must therefore not claim
    // that adding a term guarantees the spelling -- it guarantees it for the
    // renderings the operator has actually seen and entered.
    expect(applyCanonicalRenderings('Je m’appelle Zoé.', c.canonical))
      .toBe('Je m’appelle Zoé.');
  });

  it('matches ACCENTED and Nigerian-script terms, which \b cannot', () => {
    // The bug this pins: JavaScript's \b is ASCII-based even under /u, so
    // `\bEkun\b` with the dotted E never matches and the substitution silently
    // does nothing. It would have failed for exactly the languages this product
    // exists to serve, and an operator would have seen the term saved and no
    // effect. Yoruba, Igbo and an accented Latin name, all in one assertion.
    const canonical = new Map([
      ['Ẹkun', 'Ekun'],
      ['ụtụtụ', 'ututu'],
      ['Abéòkúta', 'Abeokuta'],
    ]);
    expect(applyCanonicalRenderings('Ẹkun and ụtụtụ near Abéòkúta.', canonical))
      .toBe('Ekun and ututu near Abeokuta.');
  });

  it('prefers the LONGEST term, so a longer name is not chopped in half', () => {
    const canonical = new Map([['Lagos', 'Eko'], ['First Bank of Lagos', 'FBL']]);
    expect(applyCanonicalRenderings('Go to First Bank of Lagos today.', canonical))
      .toBe('Go to FBL today.');
  });

  it('matches whole words only', () => {
    const canonical = new Map([['Ada', 'Adaeze']]);
    expect(applyCanonicalRenderings('Adamawa is not Ada.', canonical))
      .toBe('Adamawa is not Adaeze.');
  });

  it('leaves text alone when nothing is configured', () => {
    expect(applyCanonicalRenderings('Nothing to do here.', new Map()))
      .toBe('Nothing to do here.');
  });
});

describe('do-not-translate feeds the same protection identifiers use', () => {
  it('collects the terms the gate must protect', () => {
    const c = resolveConsumption([
      entry({ id: 'a', term: 'Adebayo', doNotTranslate: true }),
      entry({ id: 'b', term: 'Consummate 7', doNotTranslate: true }),
      entry({ id: 'c', term: 'welcome', doNotTranslate: false }),
    ], 'fr');
    expect(c.doNotTranslate).toEqual(['Adebayo', 'Consummate 7']);
    expect(c.doNotTranslate).not.toContain('welcome');
  });

  it('ignores a blank term rather than protecting the empty string', () => {
    // Protecting '' would mask every position in the message.
    const c = resolveConsumption([entry({ term: '   ', doNotTranslate: true })], 'fr');
    expect(c.doNotTranslate).toEqual([]);
  });
});
