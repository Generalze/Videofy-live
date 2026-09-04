/** @author masterzee001 */
/**
 * What the public recruitment page may and may not say.
 *
 * COPY IS EDITED FAR MORE OFTEN THAN IT IS REVIEWED, which is the whole reason
 * this is a test rather than a note in a document. A sentence promising
 * royalties, or hinting at paid voice work, would be a promise C7 has not made
 * to people who are volunteering their knowledge — and it is exactly the kind
 * of line that arrives in a well-meaning edit to make the page more appealing.
 *
 * Rendered to static markup rather than driven in a DOM: what matters is the
 * WORDS the page ships with, and that needs no browser.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { forbiddenTermsIn } from '@videofy-live/language-specialist';
import { LanguageSpecialists } from './LanguageSpecialists';

const noop = (): void => undefined;

function render(): string {
  return renderToStaticMarkup(<LanguageSpecialists navigate={noop} />);
}

/** The words with their markup removed, which is what a person actually reads. */
function words(markup: string): string {
  return markup.replace(/<[^>]*>/gu, ' ').replace(/&[a-z]+;/gu, ' ');
}

beforeEach(() => {
  /*
   * The page fetches the public programme list on mount. Static rendering never
   * runs effects, so this is belt and braces -- but an unstubbed global fetch
   * that a future change DOES reach would fail as a network error rather than
   * as an assertion, and that is a confusing way to learn about a regression.
   */
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('not used'))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the recruitment page promises', () => {
  it('PIN: promises no royalties, rewards or compensation', () => {
    // The domain guard, not a second list here. "royalty-free" is exempt
    // because it is the operative term of the licence and says C7 owes nothing.
    expect(forbiddenTermsIn(words(render()))).toEqual([]);
  });

  it('PIN: promises no employment', () => {
    const copy = words(render()).toLowerCase();
    for (const term of ['job', 'salary', 'hire', 'hiring', 'employment', 'vacancy', 'career']) {
      expect(copy, term).not.toMatch(new RegExp(`\\b${term}\\b`, 'u'));
    }
  });

  it('PIN: does not recruit for a voice programme', () => {
    const copy = words(render()).toLowerCase();
    // "voice" appears exactly once, in the boundary paragraph that says this is
    // NOT a voice programme. Any other use would be recruiting for something
    // that does not exist under terms nobody has drafted.
    expect(copy).toContain('this is');
    expect(copy).toContain('not a voice programme');
    for (const term of ['voice clone', 'voice recording', 'record your voice', 'voice talent']) {
      expect(copy, term).not.toContain(term);
    }
  });

  it('states the voice boundary to the people it protects', () => {
    const copy = words(render());
    expect(copy).toMatch(/separate invitation with its own agreement/u);
  });
});

describe('what the recruitment page says', () => {
  it('names the programme as the directive titles it', () => {
    expect(words(render())).toContain('Become a C7 Language Specialist');
  });

  it('names the five things a specialist may help evaluate', () => {
    const copy = words(render()).toLowerCase();
    for (const facet of [
      'translation quality',
      'natural wording',
      'terminology',
      'pronunciation',
      'cultural accuracy',
    ]) {
      expect(copy, facet).toContain(facet);
    }
  });

  it('names the eligibility the directive lists', () => {
    const copy = words(render()).toLowerCase();
    expect(copy).toContain('native or highly fluent');
    expect(copy).toContain('reading and writing');
    expect(copy).toContain('meaning in english');
    expect(copy).toContain('blind review');
  });

  it('carries the apply call to action', () => {
    expect(words(render())).toContain('Apply as a Language Specialist');
  });

  it('PIN: signed out, apply goes to the ONE existing join surface', () => {
    // There is no second registration form on this page. A second form would be
    // a second place the registration rules live, and the two would drift.
    const markup = render();
    expect(markup).toContain('href="/#join"');
    // And nothing on the page collects a credential itself.
    expect(markup).not.toContain('type="password"');
  });

  it('gives the contact address the programme is run from', () => {
    expect(render()).toContain('mailto:languages@consummate7.com');
  });
});
