import { describe, expect, it } from 'vitest';
import { isNonLexicalUtterance } from '../non-lexical-speech.js';

describe('isNonLexicalUtterance', () => {
  it('recognises laughter in the spellings recognisers produce', () => {
    for (const text of ['Haha', 'ha ha ha', 'Hehehe!', 'Jajaja', 'HAHAHA!!!']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('recognises laughter by shape, not by a list of spellings', () => {
    // A recogniser transcribed one synthesised laugh as "Ho, ho, ho, ho." — a
    // spelling no fixed list had. The run arrives as separate tokens too.
    for (const text of ['Ho, ho, ho, ho.', 'hoho', 'Hahahaha', 'je je je', 'Hu hu hu']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('does not mistake a single laugh syllable for laughter', () => {
    // "Hi" is a greeting and "ho" alone is not worth the risk, so a run of at
    // least two syllables is required.
    expect(isNonLexicalUtterance('Hi')).toBe(false);
    expect(isNonLexicalUtterance('He')).toBe(false);
  });

  it('recognises hesitation and thinking sounds', () => {
    for (const text of ['Hmm.', 'uh...', 'Mmm', 'Euh', 'erm']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('recognises reflex interjections across the registry languages', () => {
    for (const text of ['Oh!', 'Ah.', 'Wow!', 'Ouch!', 'Aïe !', 'Olé']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('recognises the bracketed sound events the recogniser emits', () => {
    for (const text of ['[LAUGHTER]', '(laughs)', '*sighs*', '♪', '[Applause]', '(inaudible)']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('treats punctuation-only output as nothing said', () => {
    for (const text of ['...', '?!', '—']) {
      expect(isNonLexicalUtterance(text), text).toBe(true);
    }
  });

  it('never swallows a real word, however short', () => {
    // These are decisions and answers. Losing one would be far worse than
    // voicing an occasional "hmm".
    for (const text of ['No', 'Yes', 'ok', 'Oui', 'Non', 'Sí', 'Stop', 'Now', 'Me', 'Go']) {
      expect(isNonLexicalUtterance(text), text).toBe(false);
    }
  });

  it('treats laughter mixed with words as speech', () => {
    // "haha yes exactly" is a reply that happens to start with laughter, and
    // translating it still matters.
    for (const text of ['haha yes exactly', 'Oh, I see what you mean.', 'Wow, that is expensive.']) {
      expect(isNonLexicalUtterance(text), text).toBe(false);
    }
  });

  it('treats a bracketed transcript aside as speech, not a sound', () => {
    expect(isNonLexicalUtterance('(I think that is right)')).toBe(false);
  });

  it('ignores empty input', () => {
    expect(isNonLexicalUtterance('   ')).toBe(false);
  });
});
