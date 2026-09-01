/** @author masterzee001 */
/**
 * Page 05 is WIRED, not merely written.
 *
 * This project's most expensive recurring defect is a component that exists,
 * passes its own tests, and is reached from nowhere -- six instances and
 * counting. The Vocabulary page was the seventh: fully built, fully tested, and
 * App.tsx still rendered the placeholder.
 *
 * So this asserts the composition rather than the component. It reads App.tsx
 * as text, which is blunt, and blunt is the point: it fails the moment somebody
 * puts the placeholder back, and it cannot be satisfied by a mock.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'),
  'utf8',
);

/** The JSX inside one ConsolePage, by id. */
function consolePage(id: string): string {
  // Pages carrying a lede are written across several lines; older ones are
  // inline. Both are the same element, so the helper accepts either.
  const spaced = APP.indexOf(`<ConsolePage
        id="${id}"`);
  const inline = APP.indexOf(`<ConsolePage id="${id}"`);
  const open = spaced > -1 ? spaced : inline;
  expect(open, `no ConsolePage with id="${id}"`).toBeGreaterThan(-1);
  return APP.slice(open, APP.indexOf('</ConsolePage>', open));
}

describe('05 Programme Vocabulary is reachable through the console', () => {
  it('renders VocabularyPage, not the placeholder', () => {
    const page = consolePage('vocabulary');
    expect(page).toMatch(/<VocabularyPage/u);
    // The assertion that fails while the placeholder is still there.
    expect(page).not.toMatch(/<NotYetPage/u);
  });

  it('imports the real page and its state', () => {
    expect(APP).toMatch(/import \{ VocabularyPage \} from '\.\/pages\/VocabularyPage'/u);
    expect(APP).toMatch(/import \{ useVocabulary \} from '\.\/useVocabulary'/u);
  });

  it('feeds it real state rather than literals', () => {
    const page = consolePage('vocabulary');
    for (const prop of ['snapshot', 'unavailable', 'conflict', 'saving']) {
      expect(page).toMatch(new RegExp(`${prop}=\\{vocabulary\\.`, 'u'));
    }
  });

  it('wires every action to the controller', () => {
    const page = consolePage('vocabulary');
    expect(page).toMatch(/vocabulary\.reload\(\)/u);
    expect(page).toMatch(/vocabulary\.save\(/u);
    expect(page).toMatch(/vocabulary\.remove\(/u);
  });

  it('scopes the state to a programme, from the console identity', () => {
    expect(APP).toMatch(/useVocabulary\(\{[\s\S]{0,240}programmeId:/u);
  });
});

describe('every console page is now a real page', () => {
  // 06 and 07 have both been built and wired since this file was written;
  // their own reachability is asserted in page06-wired and page07-wired.
  it.each(['vocabulary', 'quality', 'advertising'])('%s is not a placeholder', (id) => {
    expect(consolePage(id)).not.toMatch(/<NotYetPage/u);
  });
});

describe('the page takes no colour of its own', () => {
  it('uses design-system tokens rather than a private palette', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'VocabularyPage.module.css'),
      'utf8',
    );
    // A second navy palette in hex is how a console ends up with two answers to
    // "what is a panel".
    const hexColours = css.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
    expect(hexColours).toEqual([]);
    expect(css).toMatch(/var\(--op-/u);
    // And no new token family invented for this one page. Matches a
    // DEFINITION, not a mention: the file's own comment says it defines none,
    // and a test that cannot tell those apart fails on its own documentation.
    expect(css).not.toMatch(/--vocabulary-[a-z-]+\s*:/u);
  });
});
