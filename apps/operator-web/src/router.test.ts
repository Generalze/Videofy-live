/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { OPERATOR_PAGES, PAGE_TITLES, hashForPage, pageFromHash } from './router';

describe('operator console routes', () => {
  it('names exactly the ten pages of the founder ruling, in order', () => {
    expect([...OPERATOR_PAGES]).toEqual([
      'overview', 'source', 'languages', 'audio', 'vocabulary', 'quality', 'advertising', 'access', 'preflight', 'live',
    ]);
    for (const page of OPERATOR_PAGES) expect(PAGE_TITLES[page].length).toBeGreaterThan(0);
  });

  it('reads a page from the hash and falls back to overview for anything else', () => {
    expect(pageFromHash('#/languages')).toBe('languages');
    expect(pageFromHash('#languages')).toBe('languages');
    expect(pageFromHash('#/LIVE')).toBe('live');
    expect(pageFromHash('#/languages/extra?x=1')).toBe('languages');
    expect(pageFromHash('')).toBe('overview');
    expect(pageFromHash('#/nowhere')).toBe('overview');
  });

  it('round-trips every page through its hash', () => {
    for (const page of OPERATOR_PAGES) expect(pageFromHash(hashForPage(page))).toBe(page);
  });
});
