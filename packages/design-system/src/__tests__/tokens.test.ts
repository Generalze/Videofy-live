/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS } from '../breakpoints.js';
import { CAPTION_ARRIVAL_MS, DURATIONS_MS, EASINGS } from '../motion.js';
import {
  BASE_CSS,
  darkTokens,
  declarations,
  lightThemeBody,
  TOKENS_CSS,
  varReferences,
} from './css-source.js';

/** The only groups allowed to contain a literal colour. */
const PRIMITIVE_PREFIXES = [
  '--vf-ink-',
  '--vf-violet-',
  '--vf-success-',
  '--vf-warn-',
  '--vf-danger-',
  '--vf-info-',
];

function isPrimitive(name: string): boolean {
  return PRIMITIVE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const HEX_LITERAL = /#[0-9a-f]{3,8}\b/i;

describe('naming', () => {
  it('prefixes every declared custom property with --vf-', () => {
    // Incremental adoption means these tokens live alongside each app's own
    // variables for a while. An unprefixed name here would silently overwrite
    // an app-local one.
    const anyCustomProperty = /(^|[\s;{])(--[a-z][a-z0-9-]*)\s*:/gi;
    for (const css of [TOKENS_CSS, BASE_CSS]) {
      for (const match of css.matchAll(anyCustomProperty)) {
        expect(match[2]).toMatch(/^--vf-/);
      }
    }
  });

  it('keeps colour and size in separate namespaces', () => {
    // `--vf-text-*` is colour and `--vf-font-size-*` is size. Collapsing them
    // into one `--vf-text-*` group (as the first draft did) makes
    // `--vf-text-lg` and `--vf-text-primary` look like the same family.
    const tokens = darkTokens();
    for (const [name, value] of tokens) {
      if (name.startsWith('--vf-text-')) {
        expect(value, name).not.toMatch(/\d+(rem|px|em)/);
      }
    }
  });
});

describe('token layering', () => {
  it('resolves every var() reference to a declared token', () => {
    // A dangling `var(--vf-typo)` is not an error in CSS: the property is
    // dropped and the element silently falls back to an inherited or initial
    // value. Nothing else in the toolchain catches this.
    const declared = new Set(declarations(TOKENS_CSS).map(({ name }) => name));
    for (const [label, css] of [
      ['tokens.css', TOKENS_CSS],
      ['base.css', BASE_CSS],
    ] as const) {
      for (const reference of varReferences(css)) {
        expect(declared, `${label} references ${reference}`).toContain(reference);
      }
    }
  });

  it('never lets a primitive depend on a semantic', () => {
    // The ramps are the bottom of the stack. A primitive that reaches back up
    // into the semantic layer makes the theme swap circular.
    for (const { name, value } of declarations(TOKENS_CSS)) {
      if (isPrimitive(name)) {
        expect(value, name).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('confines colour literals to the primitive ramps', () => {
    // This is the invariant that makes a theme a re-point rather than a
    // rewrite: if a semantic, a caption or a status token could carry its own
    // hex, the light theme would have to chase it.
    for (const { name, value } of declarations(TOKENS_CSS)) {
      if (!isPrimitive(name)) {
        expect(value, name).not.toMatch(HEX_LITERAL);
      }
    }
  });

  it('lets base.css re-point tokens but never invent them', () => {
    // base.css legitimately overrides tokens under reduced-motion and
    // increased-contrast. Declaring a NEW token there would put part of the
    // design language outside the file that is supposed to be its home.
    const declared = new Set(declarations(TOKENS_CSS).map(({ name }) => name));
    for (const { name } of declarations(BASE_CSS)) {
      expect(declared, `base.css declares ${name}`).toContain(name);
    }
  });

  it('only re-points existing tokens in the light theme', () => {
    // A light theme that introduces its own tokens is not a theme, it is a
    // second design system.
    const darkDeclared = new Set(declarations(TOKENS_CSS).map(({ name }) => name));
    for (const { name } of declarations(lightThemeBody())) {
      expect(darkDeclared, `light theme declares ${name}`).toContain(name);
    }
  });
});

describe('CSS and TypeScript agree', () => {
  it('mirrors the breakpoint scale', () => {
    // Two sources of truth that nobody checks are one source of truth and one
    // bug. CSS needs the literals for media queries; JS needs the numbers for
    // matchMedia.
    const tokens = darkTokens();
    for (const [name, width] of Object.entries(BREAKPOINTS)) {
      expect(tokens.get(`--vf-breakpoint-${name}`), name).toBe(`${width}px`);
    }
  });

  it('mirrors the duration scale', () => {
    const tokens = darkTokens();
    for (const [name, ms] of Object.entries(DURATIONS_MS)) {
      expect(tokens.get(`--vf-duration-${name}`), name).toBe(`${ms}ms`);
    }
    expect(tokens.get('--vf-duration-caption')).toBe(`${CAPTION_ARRIVAL_MS}ms`);
  });

  it('mirrors the easing curves', () => {
    const tokens = darkTokens();
    for (const [name, curve] of Object.entries(EASINGS)) {
      expect(tokens.get(`--vf-ease-${name}`), name).toBe(curve);
    }
  });

  it('collapses the same duration tokens under reduced motion', () => {
    // base.css re-points the tokens themselves, which is what neutralises the
    // whole product from one block. A duration that exists in tokens.css but
    // is missed here keeps animating for users who asked it not to.
    const reduced = new Set(declarations(BASE_CSS).map(({ name }) => name));
    for (const name of Object.keys(DURATIONS_MS)) {
      expect(reduced, `--vf-duration-${name}`).toContain(`--vf-duration-${name}`);
    }
    expect(reduced).toContain('--vf-duration-caption');
  });
});

describe('captions', () => {
  const tokens = darkTokens();

  it('distinguishes interim from final on a non-colour channel', () => {
    // §5.1.13 and §12: the call runtime marks partial captions, and a user who
    // cannot perceive the colour step still has to be able to tell a caption
    // that is still being spoken from one that has settled.
    expect(tokens.get('--vf-caption-final-decoration')).toBe('none');
    expect(tokens.get('--vf-caption-interim-decoration')).toBe('underline dotted');
    expect(tokens.get('--vf-caption-interim-caret')).toBeDefined();
  });

  it('does not italicise interim captions', () => {
    // Italic body text is measurably harder for dyslexic readers, and a live
    // partial caption is the worst place in the product to spend legibility.
    expect(tokens.get('--vf-caption-interim-font-style')).toBe('normal');
    expect(tokens.get('--vf-caption-final-font-style')).toBe('normal');
  });

  it('offers a caption size scale that starts at readable', () => {
    // Caption size is a user-facing accessibility control, not a layout
    // constant. Below 16px captions fail for a large fraction of users
    // regardless of contrast.
    const sizesRem = ['sm', 'md', 'lg', 'xl'].map((step) => {
      const raw = tokens.get(`--vf-caption-size-${step}`);
      return Number(/^([\d.]+)rem$/.exec(raw ?? '')?.[1]);
    });
    expect(sizesRem[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < sizesRem.length; i += 1) {
      expect(sizesRem[i]).toBeGreaterThan(sizesRem[i - 1] as number);
    }
  });

  it('keeps the caption measure shorter than the prose measure', () => {
    // Broadcast subtitle practice is ~32-42 characters per line: the eye has
    // to find the line start again while also watching the speaker.
    const caption = Number(/^(\d+)ch$/.exec(tokens.get('--vf-caption-max-width') ?? '')?.[1]);
    const prose = Number(/^(\d+)ch$/.exec(tokens.get('--vf-container-prose') ?? '')?.[1]);
    expect(caption).toBeLessThan(prose);
  });
});

describe('status semantics', () => {
  const tokens = darkTokens();
  const families = ['success', 'warn', 'danger', 'info'] as const;

  it('gives every family a non-colour glyph', () => {
    // §5.1.13: status is never communicated by colour alone. The glyph is the
    // mechanism a surface uses to comply without inventing one.
    for (const family of families) {
      expect(tokens.get(`--vf-status-glyph-${family}`), family).toMatch(/^'.+'$/);
    }
    expect(tokens.get('--vf-status-glyph-live')).toBeDefined();
    expect(tokens.get('--vf-status-glyph-pending')).toBeDefined();
  });

  it('gives every family a full text/solid/surface/border set', () => {
    // Partial families are how a surface ends up inventing its own "warning
    // background" one shade off everyone else's.
    for (const family of families) {
      for (const role of ['text', 'solid', 'surface', 'border']) {
        expect(tokens.get(`--vf-status-${family}-${role}`), `${family}-${role}`).toBeDefined();
      }
    }
  });

  it('uses distinguishable dot shapes for the four families', () => {
    // The supplementary non-colour channel for compact dots where no glyph
    // fits. Two families sharing a shape would defeat the point.
    const shapes = families.map(
      (family) =>
        `${tokens.get(`--vf-status-dot-radius-${family}`)}|${
          tokens.get(`--vf-status-dot-rotate-${family}`) ?? 'none'
        }`,
    );
    expect(new Set(shapes).size).toBe(families.length);
  });
});
