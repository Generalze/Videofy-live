/**
 * Languages that can only be served at premium, and the disclosure they owe.
 *
 * This list costs customers money, so the tests are as much about the promise
 * that a forced upgrade is VISIBLE as about which languages are on it.
 */
import { describe, expect, it } from 'vitest';
import {
  PREMIUM_ONLY_LANGUAGES,
  effectiveGrade,
  isForcedUpgrade,
  requiresPremium,
} from '../premium-languages.js';

describe('which languages force premium', () => {
  it('covers the Nigerian languages', () => {
    for (const language of ['yo', 'ha', 'ig', 'pcm']) {
      expect(requiresPremium(language)).toBe(true);
    }
  });

  it('leaves every other language free to choose', () => {
    for (const language of ['fr', 'es', 'pt', 'ar', 'de', 'zh', 'en']) {
      expect(requiresPremium(language)).toBe(false);
    }
  });

  /* A region does not change which vendor can speak a language. */
  it('recognises regional and cased tags', () => {
    expect(requiresPremium('yo-NG')).toBe(true);
    expect(requiresPremium('HA_ng')).toBe(true);
    expect(requiresPremium('IG')).toBe(true);
  });

  it('treats an empty tag as unrestricted', () => {
    expect(requiresPremium('')).toBe(false);
  });
});

describe('resolving the grade that is charged', () => {
  it('upgrades a standard request for a premium-only language', () => {
    expect(effectiveGrade('standard', 'yo')).toBe('premium');
  });

  it('leaves other languages at the grade that was asked for', () => {
    expect(effectiveGrade('standard', 'fr')).toBe('standard');
    expect(effectiveGrade('premium', 'fr')).toBe('premium');
  });

  /*
   * Only ever upwards. Somebody who paid for the better voice keeps it, even
   * on a language where standard would have been allowed.
   */
  it('never downgrades a premium request', () => {
    expect(effectiveGrade('premium', 'fr')).toBe('premium');
    expect(effectiveGrade('premium', 'yo')).toBe('premium');
  });
});

describe('telling the customer first', () => {
  /*
   * Anything that silently doubles a price is indistinguishable from a billing
   * fault at the moment somebody notices. This is the condition a pre-call
   * disclosure fires on.
   */
  it('flags a standard request that will bill at premium', () => {
    expect(isForcedUpgrade('standard', 'yo')).toBe(true);
  });

  it('does not flag a customer who already chose premium', () => {
    expect(isForcedUpgrade('premium', 'yo')).toBe(false);
  });

  it('does not flag an ordinary language', () => {
    expect(isForcedUpgrade('standard', 'fr')).toBe(false);
  });
});

describe('the list itself', () => {
  /* Expected to shrink. A better provider is the point of keeping it in one place. */
  it('is exactly the four languages, so shortening it is one edit', () => {
    expect([...PREMIUM_ONLY_LANGUAGES].sort()).toEqual(['ha', 'ig', 'pcm', 'yo']);
  });
});
