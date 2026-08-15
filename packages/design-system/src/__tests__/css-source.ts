/** @owner masterzee001 */
/**
 * Test support: a deliberately small CSS reader.
 *
 * The token layer is the canonical source of truth for the whole product, and
 * a stylesheet has no type system to catch a dangling `var()`, a token that
 * drifted out of the light theme, or a text/surface pairing that quietly
 * stopped meeting AA. These helpers exist so the test suite can assert those
 * invariants against the real file rather than against a hand-maintained copy
 * of it.
 *
 * This is not a CSS parser and must not grow into one. It relies on two
 * properties that tokens.css and base.css genuinely have: no semicolons inside
 * declaration values, and no braces inside strings.
 */
import { readFileSync } from 'node:fs';

function read(fileName: string): string {
  return readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8');
}

/** Comments carry prose that would otherwise be mistaken for declarations. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export const TOKENS_CSS = stripComments(read('tokens.css'));
export const BASE_CSS = stripComments(read('base.css'));
/** Comments kept, for the few assertions that are about documentation. */
export const TOKENS_CSS_RAW = read('tokens.css');

export interface Declaration {
  readonly name: string;
  readonly value: string;
}

const DECLARATION = /(--vf-[a-z0-9-]+)\s*:\s*([^;]+);/g;
const VAR_REFERENCE = /var\(\s*(--vf-[a-z0-9-]+)/g;

/** Every `--vf-*` declaration, in source order. */
export function declarations(css: string): Declaration[] {
  const found: Declaration[] = [];
  for (const match of css.matchAll(DECLARATION)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) {
      found.push({ name, value: value.trim().replace(/\s+/g, ' ') });
    }
  }
  return found;
}

/** Every `--vf-*` name referenced through `var()`. */
export function varReferences(css: string): string[] {
  return [...css.matchAll(VAR_REFERENCE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The body of the first rule whose selector contains `selectorFragment`,
 * located by brace matching. Comments must already be stripped.
 */
export function ruleBody(css: string, selectorFragment: string): string {
  const selectorAt = css.indexOf(selectorFragment);
  if (selectorAt < 0) {
    throw new Error(`No rule found for selector fragment: ${selectorFragment}`);
  }
  const open = css.indexOf('{', selectorAt);
  if (open < 0) {
    throw new Error(`Selector ${selectorFragment} has no block`);
  }
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  throw new Error(`Unbalanced braces after selector ${selectorFragment}`);
}

const LIGHT_THEME_SELECTOR = "[data-vf-theme='light']";

/** The light theme rule body. */
export function lightThemeBody(): string {
  return ruleBody(TOKENS_CSS, LIGHT_THEME_SELECTOR);
}

/** tokens.css with the light theme rule removed, i.e. what a dark root sees. */
export function tokensWithoutLightTheme(): string {
  const body = lightThemeBody();
  const at = TOKENS_CSS.indexOf(body);
  return TOKENS_CSS.slice(0, at) + TOKENS_CSS.slice(at + body.length);
}

/**
 * Flatten declarations into a name → value map. Later declarations win, which
 * is how the cascade resolves duplicate `--vf-*` names on the same element.
 */
export function declarationMap(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { name, value } of declarations(css)) {
    map.set(name, value);
  }
  return map;
}

/** Tokens as they compute on a default (dark) `:root`. */
export function darkTokens(): Map<string, string> {
  return declarationMap(tokensWithoutLightTheme());
}

/** Tokens as they compute on `<html data-vf-theme="light">`. */
export function lightTokens(): Map<string, string> {
  const map = darkTokens();
  for (const { name, value } of declarations(lightThemeBody())) {
    map.set(name, value);
  }
  return map;
}

const HEX = /^#[0-9a-f]{6}$/i;
const SOLE_VAR = /^var\(\s*(--vf-[a-z0-9-]+)\s*\)$/;

/**
 * Follow a token through the semantic layer down to the hex primitive it
 * ultimately points at. Returns null for anything that is not a plain
 * indirection to a hex (gradients, `color-mix`, alpha colours) — those are
 * composited against unknown content and cannot be contrast-rated statically.
 */
export function resolveHex(tokens: Map<string, string>, name: string): string | null {
  let value = tokens.get(name);
  // Bounded so a cyclic definition fails the test instead of hanging it.
  for (let hop = 0; hop < 16; hop += 1) {
    if (value === undefined) {
      return null;
    }
    if (HEX.test(value)) {
      return value.toLowerCase();
    }
    const indirection = SOLE_VAR.exec(value);
    if (indirection?.[1] === undefined) {
      return null;
    }
    value = tokens.get(indirection[1]);
  }
  return null;
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** WCAG 2.x relative luminance. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Composite a black scrim at `alpha` over an opaque colour.
 *
 * Captions are laid over video whose content we do not control, so the only
 * contrast figure that means anything is the one measured against the worst
 * case the scrim has to survive — a pure white frame.
 */
export function compositeBlackOver(alpha: number, backgroundHex: string): string {
  const composited = channels(backgroundHex).map((channel) => Math.round(channel * (1 - alpha)));
  return `#${composited.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The alpha of a `rgb(0 0 0 / A)` token value, or null if it is not one. */
export function blackAlpha(value: string): number | null {
  const match = /^rgb\(\s*0\s+0\s+0\s*\/\s*([\d.]+)\s*\)$/.exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
