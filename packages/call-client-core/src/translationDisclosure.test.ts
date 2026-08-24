/**
 * The translation disclosure.
 *
 * This is an anti-deception control, so the tests are written against the ways
 * it could quietly stop protecting anybody: a warning in a language the reader
 * does not speak, a missing language falling through to nothing, or a spoken
 * announcement whose failure takes the call down with it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  disclosedLanguages,
  speakDisclosure,
  translationDisclosureFor,
} from './translationDisclosure';

describe('the text', () => {
  it('is written for every language the call app offers', () => {
    expect([...disclosedLanguages()].sort()).toEqual(['en', 'es', 'fr']);
  });

  /*
   * A warning in a language the listener does not read is decoration. Each
   * one names its own language in its own words.
   */
  it('is in the listener language, not the speaker language', () => {
    expect(translationDisclosureFor('fr').banner).toContain('français');
    expect(translationDisclosureFor('es').banner).toContain('español');
    expect(translationDisclosureFor('en').banner).toContain('English');
  });

  it('carries a locale so a screen reader does not read French with an English voice', () => {
    expect(translationDisclosureFor('fr').locale).toBe('fr');
    expect(translationDisclosureFor('es').locale).toBe('es');
  });

  /*
   * Somebody on a phone held to their ear is not reading anything, so the
   * spoken form has to carry the whole point on its own.
   */
  it('says plainly, when spoken, that the voice is machine-generated', () => {
    expect(translationDisclosureFor('en').spoken).toMatch(/computer/i);
    expect(translationDisclosureFor('fr').spoken).toMatch(/ordinateur/i);
    expect(translationDisclosureFor('es').spoken).toMatch(/ordenador/i);
  });

  it('is longer spoken than shown, because the banner must survive a small screen', () => {
    for (const language of disclosedLanguages()) {
      const disclosure = translationDisclosureFor(language);
      expect(disclosure.spoken.length).toBeGreaterThan(disclosure.banner.length);
    }
  });

  /*
   * An unrecognised language means somebody added one and did not write the
   * warning. Showing a warning they may not read is bad; showing none is worse.
   */
  it('falls back to a real warning rather than to nothing', () => {
    const unknown = translationDisclosureFor('yo');
    expect(unknown.banner).toBe(translationDisclosureFor('en').banner);
    expect(unknown.banner.length).toBeGreaterThan(0);
  });
});

/** Stands in for the browser globals, which do not exist under vitest. */
const utterance = (text: string) => ({ text, lang: '', rate: 1 });

describe('speaking it', () => {
  it('dispatches an utterance in the listener locale', () => {
    const speak = vi.fn();
    const spoken = speakDisclosure(
      translationDisclosureFor('fr'),
      { speak } as unknown as SpeechSynthesis,
      utterance,
    );

    expect(spoken).toBe(true);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]?.[0]?.lang).toBe('fr');
  });

  /*
   * Two separate globals. Checking only the synthesiser made a missing
   * utterance constructor look like a browser that cannot speak.
   */
  it('reports failure when the utterance constructor is missing', () => {
    const speak = vi.fn();
    const spoken = speakDisclosure(
      translationDisclosureFor('en'),
      { speak } as unknown as SpeechSynthesis,
      undefined,
    );

    expect(spoken).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  /*
   * Speech synthesis is missing, blocked or voiceless often enough that this
   * has to be a non-event. The banner is the guarantee; this is reinforcement.
   */
  it('reports failure rather than throwing when synthesis is unavailable', () => {
    expect(speakDisclosure(translationDisclosureFor('en'), undefined, utterance)).toBe(false);
    expect(
      speakDisclosure(translationDisclosureFor('en'), {} as unknown as SpeechSynthesis, utterance),
    ).toBe(false);
  });

  it('survives a synthesis engine that throws', () => {
    const throwing = {
      speak: () => {
        throw new Error('no voice for locale');
      },
    } as unknown as SpeechSynthesis;

    expect(() =>
      speakDisclosure(translationDisclosureFor('es'), throwing, utterance),
    ).not.toThrow();
    expect(speakDisclosure(translationDisclosureFor('es'), throwing, utterance)).toBe(false);
  });
});
