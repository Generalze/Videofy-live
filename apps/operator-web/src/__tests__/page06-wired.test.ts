/** @author masterzee001 */
/**
 * Page 06 is WIRED, not merely written.
 *
 * Eight times in this project a component has been built, tested, and reached
 * from nowhere -- twice on Page 05 alone, once at App level and once inside the
 * component itself. So the wire gets its own assertion before the page gets its
 * features, and the assertion reads App.tsx as text: blunt, unmockable, and it
 * fails the instant somebody puts the placeholder back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');

function consolePage(id: string): string {
  const open = APP.indexOf(`<ConsolePage\n        id="${id}"`);
  const fallback = APP.indexOf(`<ConsolePage id="${id}"`);
  const start = open > -1 ? open : fallback;
  expect(start, `no ConsolePage with id="${id}"`).toBeGreaterThan(-1);
  return APP.slice(start, APP.indexOf('</ConsolePage>', start));
}

describe('06 Quality / Delay is reachable through the console', () => {
  it('renders QualityPage, not the placeholder', () => {
    const page = consolePage('quality');
    expect(page).toMatch(/<QualityPage/u);
    // The assertion that fails if the placeholder comes back.
    expect(page).not.toMatch(/<NotYetPage/u);
  });

  it('imports the real page and its state', () => {
    expect(APP).toMatch(/import \{ QualityPage \} from '\.\/pages\/QualityPage'/u);
    expect(APP).toMatch(/import \{ useQuality \} from '\.\/useQuality'/u);
  });

  it('feeds it real state rather than literals', () => {
    const page = consolePage('quality');
    for (const prop of ['rows', 'unavailable', 'loading']) {
      expect(page).toMatch(new RegExp(`${prop}=\\{quality\\.`, 'u'));
    }
    expect(page).toMatch(/quality\.reload\(\)/u);
  });

  it('scopes the rows to THIS programme’s configured directions', () => {
    /*
     * Not the deployment's whole catalogue. A provider being installed
     * somewhere is not this programme being set up to use it, and a page that
     * blurred the two would answer a question nobody asked.
     */
    expect(APP).toMatch(/useQuality\(\{[\s\S]{0,200}sourceLanguage,/u);
    expect(APP).toMatch(/useQuality\(\{[\s\S]{0,200}targetLanguages,/u);
  });
});

describe('the page takes no colour of its own', () => {
  it('uses design-system tokens rather than a private palette', () => {
    const css = readFileSync(join(HERE, '..', 'pages', 'QualityPage.module.css'), 'utf8');
    const hexColours = css.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
    expect(hexColours).toEqual([]);
    expect(css).toMatch(/var\(--op-/u);
    // No new token family invented for this one page.
    expect(css).not.toMatch(/--quality-[a-z-]+\s*:/u);
  });

  it('gives the four states four DIFFERENT existing families', () => {
    const css = readFileSync(join(HERE, '..', 'pages', 'QualityPage.module.css'), 'utf8');
    /*
     * Pending must not share a hue with degraded. They are not degrees of one
     * thing -- degraded is "worse than we want", pending is "nobody qualified
     * has looked" -- and a shared colour invites reading the second as a milder
     * first, which is how unreviewed output reaches air.
     */
    expect(css).toMatch(/\.ready\s*\{[^}]*--op-ok-/u);
    expect(css).toMatch(/\.degraded\s*\{[^}]*--op-warn-/u);
    expect(css).toMatch(/\.pending\s*\{[^}]*--op-violet-/u);
    expect(css).toMatch(/\.unavailable\s*\{[^}]*--op-danger-/u);
  });
});
