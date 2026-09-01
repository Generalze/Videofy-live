/** @author masterzee001 */
/**
 * Page 07 is WIRED, not merely written.
 *
 * The ninth instance of "built, tested, reached from nowhere" is the one this
 * prevents. It reads App.tsx as text, which is blunt on purpose: it cannot be
 * satisfied by a mock, and it fails the moment the placeholder returns.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * SOURCE READ WITH LINE ENDINGS CANONICALISED.
 *
 * This checkout is Windows with core.autocrlf=true and the repository declares
 * no .gitattributes, so every file arrives with CRLF endings while these
 * assertions are written with newline escapes. Eight assertions across the
 * repository failed for that reason alone -- nothing was unwired and nothing
 * was misordered, but the release branch could not pass its own gate. A guard
 * that fails for a reason unrelated to what it guards is a guard somebody
 * switches off.
 *
 * Line endings are checkout representation, not meaning. Normalising once, on
 * the way in, keeps every assertion below about STRUCTURE and keeps them
 * failing only for the reasons they were written to catch.
 */
function readSource(text: string): string {
  return text.split('\r\n').join('\n');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readSource(readFileSync(join(HERE, '..', 'App.tsx'), 'utf8'));

function consolePage(id: string): string {
  const spaced = APP.indexOf(`<ConsolePage\n        id="${id}"`);
  const inline = APP.indexOf(`<ConsolePage id="${id}"`);
  const start = spaced > -1 ? spaced : inline;
  expect(start, `no ConsolePage with id="${id}"`).toBeGreaterThan(-1);
  return APP.slice(start, APP.indexOf('</ConsolePage>', start));
}

describe('07 Advertising is reachable through the console', () => {
  it('renders AdvertisingPage, not the placeholder', () => {
    const page = consolePage('advertising');
    expect(page).toMatch(/<AdvertisingPage/u);
    expect(page).not.toMatch(/<NotYetPage/u);
  });

  it('imports the real page and its state', () => {
    expect(APP).toMatch(/import \{ AdvertisingPage \} from '\.\/pages\/AdvertisingPage'/u);
    expect(APP).toMatch(/import \{ useAdvertising \} from '\.\/useAdvertising'/u);
  });

  it('feeds it real state rather than literals', () => {
    const page = consolePage('advertising');
    for (const prop of ['snapshot', 'unavailable', 'conflict', 'problems', 'saving', 'loading']) {
      expect(page).toMatch(new RegExp(`${prop}=\\{advertising\\.`, 'u'));
    }
  });

  it('wires both actions to the controller', () => {
    const page = consolePage('advertising');
    expect(page).toMatch(/advertising\.reload\(\)/u);
    expect(page).toMatch(/advertising\.save\(/u);
  });

  it('scopes the creative to THIS programme', () => {
    // There is no global advert in this product; a creative belongs to one
    // programme and reaches no other.
    expect(APP).toMatch(/useAdvertising\(\{[\s\S]{0,200}programmeId: ownChannelId/u);
  });
});

describe('the page takes no colour of its own', () => {
  const css = readSource(readFileSync(join(HERE, '..', 'pages', 'AdvertisingPage.module.css'), 'utf8'));

  it('uses design-system tokens rather than a private palette', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).toEqual([]);
    expect(css).toMatch(/var\(--op-/u);
    expect(css).not.toMatch(/--advertising-[a-z-]+\s*:/u);
  });

  it('gives only the on-air state the affirmative colour', () => {
    /*
     * Four of the five states mean viewers are seeing the HOUSE creative. If
     * more than one wore the "good" colour, an operator scanning the page could
     * read "saved" as "showing" -- which is the single most likely way to
     * believe an advert is running when it is not.
     */
    expect(css).toMatch(/\.active\s*\{[^}]*--op-ok-/u);
    for (const quiet of ['scheduled', 'disabled', 'ended', 'house']) {
      const block = new RegExp(`\\.${quiet}\\s*\\{[^}]*\\}`, 'u').exec(css)?.[0] ?? '';
      expect(block, `.${quiet} must not use the affirmative family`).not.toMatch(/--op-ok-/u);
    }
  });
});

describe('the control is labelled in substance', () => {
  const source = readSource(readFileSync(join(HERE, '..', 'pages', 'AdvertisingPage.tsx'), 'utf8'));
  /*
   * COMMENTS STRIPPED, AND WHITESPACE FLATTENED.
   *
   * The file explains at the top why the label is NOT "Advertising enabled" --
   * so a naive search finds the forbidden phrase inside the very comment
   * forbidding it, and the guard fails on its own documentation. That has now
   * happened twice in this console. And JSX wraps prose across lines, so the
   * copy has to be matched with runs of whitespace collapsed or a line break
   * defeats it.
   */
  const page = source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/.*/gu, ' ')
    .replace(/\s+/gu, ' ');

  it('says "Use programme creative", never "Advertising enabled"', () => {
    /*
     * Turning the toggle off does NOT give a viewer an advert-free programme:
     * the slot is reserved and falls back to the house creative. The honest
     * label is the whole point of the control.
     */
    expect(page).toMatch(/Use programme creative/u);
    expect(page).not.toMatch(/Advertising enabled/iu);
  });

  it('carries the exact conflict copy', () => {
    expect(page).toMatch(/Advertising changed since you opened this page/u);
    expect(page).toMatch(/Reload the latest revision before saving/u);
  });
});
