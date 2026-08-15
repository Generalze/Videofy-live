<!-- @owner masterzee001 -->

# @videofy-live/design-system

The shared Videofy visual language. Master architecture **§5.1.11**.

Videofy has to look like a premium communications platform rather than a
collection of engineering controls (§5.1.1), and it has to do that consistently
across three Vite React apps today (`call-web`, `listener-web`, `operator-web`)
and the admin and public surfaces still to come. Styling each of them
independently guarantees five slightly different violets and five slightly
different definitions of "muted". This package is the single place those
decisions live.

It ships **CSS custom properties, not components.** No React dependency, no
widget library, nothing to import into a component tree. Every consuming app
builds its own components; they all draw from the same language.

---

## Install and use

```jsonc
// apps/<app>/package.json
"dependencies": {
  "@videofy-live/design-system": "*"
}
```

```ts
// apps/<app>/src/main.tsx — once, at the entry point, before app CSS
import '@videofy-live/design-system/base.css';
```

`base.css` pulls in `tokens.css` itself, so one import is enough. Import
`@videofy-live/design-system/tokens.css` on its own if you want the language
without the reset — for example a Videofy surface embedded in a host page whose
reset you must not fight.

For the handful of values JavaScript genuinely needs:

```ts
import { BREAKPOINTS, mediaQueryUp, durationMs } from '@videofy-live/design-system';

const wide = window.matchMedia(mediaQueryUp('lg')); // "(min-width: 1024px)"
setTimeout(focusFirstControl, durationMs('slow')); // 1ms under reduced motion
```

---

## The adoption rule

> **Apps consume tokens. Apps never define them.**

Concretely:

1. **No app declares a `--vf-*` property.** The prefix exists so this package's
   variables cannot collide with an app's own during incremental adoption. An
   app-local `--vf-*` declaration defeats that and makes the design system
   unauditable.
2. **No app hard-codes a value the system already names.** No literal hex, no
   `120ms`, no `@media (min-width: 1024px)`. If you are typing a number that
   looks like a design decision, it belongs to a token.
3. **No app reaches past a semantic into a primitive.** Use
   `var(--vf-surface-2)`, never `var(--vf-ink-800)`. A primitive in app code
   hard-codes "dark" into a component and the light theme silently stops
   working there.
4. **A missing value is a change here, not a workaround there.** If a surface
   needs something the system does not have, add it to `tokens.css` — or the
   surface is doing something the product should not be doing.

Migrating `call-web` is mostly a rename: the existing palette
(`#0b0b10`, `#15151d`, `#1d1d28`, `#2a2a3a`, `#eceaf6`) is preserved at its
exact stops in the ink ramp, so `--color-surface` becomes `--vf-surface-1` with
no visual diff.

---

## Token groups

| Group              | Prefix                                                                                                        | What it is for                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ink ramp           | `--vf-ink-*`                                                                                                  | The one neutral scale. Primitive — semantics only.                                                                            |
| Brand ramp         | `--vf-violet-*`                                                                                               | Brand accent at every weight. Primitive.                                                                                      |
| Status ramps       | `--vf-success/warn/danger/info-*`                                                                             | Primitive status hues.                                                                                                        |
| Surfaces           | `--vf-surface-*`                                                                                              | Depth hierarchy: `void`, `canvas`, `sunken`, `1`–`4`, accent tints, scrim, canvas wash.                                       |
| Text               | `--vf-text-*`                                                                                                 | Text **colour** roles.                                                                                                        |
| Borders            | `--vf-border-*`                                                                                               | Boundary roles, plus widths.                                                                                                  |
| Focus              | `--vf-focus-*`                                                                                                | Ring colour, width, offset, and the dual over-media ring.                                                                     |
| Status semantics   | `--vf-status-*`, `--vf-state-*`                                                                               | Text/solid/surface/border per family, glyphs, dot shapes, and product states (`connecting`, `live`, `recovering`, `failed`…). |
| Elevation          | `--vf-elevation-*`                                                                                            | Composite shadows, 0–5 plus `media`.                                                                                          |
| Z-index            | `--vf-z-*`                                                                                                    | Named stacking layers, 100 apart.                                                                                             |
| Typography         | `--vf-font-family-*`, `--vf-font-size-*`, `--vf-line-height-*`, `--vf-font-weight-*`, `--vf-letter-spacing-*` | Token names mirror the CSS property they feed.                                                                                |
| Spacing            | `--vf-space-*`                                                                                                | 4px-based ramp, linear then opening up.                                                                                       |
| Layout             | `--vf-grid-*`, `--vf-container-*`, `--vf-page-gutter`                                                         | 12-column grid, container widths, fluid page gutter.                                                                          |
| Breakpoints        | `--vf-breakpoint-*`                                                                                           | Documentation and container queries only — see the caveat below.                                                              |
| Radius             | `--vf-radius-*`                                                                                               | `xs`–`2xl`, `pill`, `circle`.                                                                                                 |
| Motion             | `--vf-duration-*`, `--vf-ease-*`, `--vf-transition-*`                                                         | Durations, curves, composite shorthands.                                                                                      |
| Media framing      | `--vf-media-*`, `--vf-aspect-*`                                                                               | Aspect ratios, letterbox, frame hairline, speaking ring, scrims, PiP sizing.                                                  |
| Iconography        | `--vf-icon-*`                                                                                                 | Sizes and stroke geometry. No glyphs — see "Deliberately not included".                                                       |
| Controls           | `--vf-control-*`, `--vf-tap-target-min`                                                                       | Heights, padding, radius, 44px minimum hit area.                                                                              |
| Captions           | `--vf-caption-*`                                                                                              | A first-class group. See below.                                                                                               |
| Loading & recovery | `--vf-skeleton-*`, `--vf-spinner-*`, `--vf-progress-*`, `--vf-recovery-*`, `--vf-empty-*`                     | Designed empty/loading/error states (§5.1.14).                                                                                |

Every non-obvious value in `tokens.css` carries a comment explaining **why it is
that value**. Read the file; it is the specification.

### Breakpoints: the one CSS caveat

A custom property is **not valid inside a media-query prelude**.
`@media (min-width: var(--vf-breakpoint-md))` does not error — it silently never
matches. The `--vf-breakpoint-*` tokens exist for `getComputedStyle` reads and
documentation. Write media queries against the literal pixel value, or import
`BREAKPOINTS` / `mediaQueryUp()` in JS so the number lives in one place.

---

## Captions (§12, §5.1.6)

Captions are a product output and the safety fallback when translated audio is
delayed or unavailable, so they get their own token group rather than being
"text with a background".

**Size is a user preference.** `--vf-caption-size-sm|md|lg|xl` (16 / 18 / 22 /
28px) exist so an app can render a caption-size control and re-point
`--vf-caption-font-size` on its caption container. The scale starts at 16px
because captions are read at speed and often at viewing distance.

**Interim vs final is a required distinction.** The call runtime marks partial
captions (`isFinal: false` on the transcription contract) and the UI must render
that difference without inventing its own styling:

```css
.caption {
  max-width: var(--vf-caption-max-width);
  font-size: var(--vf-caption-font-size);
  line-height: var(--vf-caption-line-height);
  font-weight: var(--vf-caption-font-weight);
  letter-spacing: var(--vf-caption-letter-spacing);
  transition: var(--vf-caption-transition);
}

.caption[data-final='true'] {
  color: var(--vf-caption-final-color);
  text-decoration: var(--vf-caption-final-decoration);
}

.caption[data-final='false'] {
  color: var(--vf-caption-interim-color);
  text-decoration: var(--vf-caption-interim-decoration);
  text-decoration-color: var(--vf-caption-interim-decoration-color);
  text-decoration-thickness: var(--vf-caption-interim-decoration-thickness);
  text-underline-offset: var(--vf-caption-interim-underline-offset);
}

.caption[data-final='false']::after {
  content: var(--vf-caption-interim-caret);
  color: var(--vf-caption-interim-caret-color);
}
```

Three decisions worth knowing about:

- **The colour step is deliberately small** (15.3:1 → 12.8:1 on `surface-1`).
  Dimming a partial caption hard is tempting and wrong: it is the caption most
  likely to be read under time pressure, and it is the user's only access to
  what is being said right now. Both stops clear AA everywhere.
- **The semantic weight is carried by a non-colour channel** — a dotted
  underline (the same "provisional" convention as spellcheck) plus a trailing
  caret. Both survive greyscale, colour-blindness and a heavy scrim.
- **The caret does not blink and interim text is not italic.** A blinking
  element beside live video is a distraction that reduced-motion would have to
  disable, taking the signal with it; italic body text is measurably harder for
  dyslexic readers, and captions are the wrong place to spend legibility.

Over video, add `--vf-caption-background` (a 0.65 black scrim) and swap the
speaker label to `--vf-caption-overlay-speaker-color`.

---

## Status is never colour alone (§5.1.13)

Colour is the fastest channel and the least reliable one. Every status in
Videofy carries a second, non-colour signal:

```css
.status::before {
  content: var(--vf-status-glyph-warn); /* the non-colour channel */
  color: var(--vf-status-warn-text);
}
```

```html
<span class="status">
  Reconnecting
  <span class="vf-sr-only">warning</span>
</span>
```

- **Primary mechanism: a glyph plus a real label.**
  `--vf-status-glyph-{success,warn,danger,info,live,pending}` are ready for
  `content:`. A visible label is always better than `.vf-sr-only`.
- **Secondary mechanism: dot shape.** For compact indicators where no glyph
  fits, `--vf-status-dot-radius-*` (+ `--vf-status-dot-rotate-warn`) give four
  distinguishable shapes: circle, diamond, square, pill. A dot on its own is
  still not sufficient status communication.
- **`live` shares the danger hue on purpose.** Red-for-live is broadcast
  convention and fighting it confuses more people than it helps — which is
  exactly why the accompanying "LIVE" wording is mandatory, not optional.
  Colour alone cannot distinguish "on air" from "failed".

Use `--vf-state-*` to map a product state onto a family, so no surface decides
for itself that "recovering" is orange.

---

## Contrast decisions

Every figure below is measured (WCAG 2.x, sRGB) and asserted in
`src/__tests__/contrast.test.ts` against the real token graph, so the numbers in
this file cannot quietly stop being true.

### Dark theme — text on surfaces

Ranges run from `--vf-surface-canvas` (darkest) to `--vf-surface-4` (lightest).

| Token                 | Range               | Verdict                             |
| --------------------- | ------------------- | ----------------------------------- |
| `--vf-text-primary`   | 16.5 : 1 → 11.9 : 1 | AAA everywhere                      |
| `--vf-text-secondary` | 10.1 : 1 → 7.3 : 1  | AAA everywhere                      |
| `--vf-text-muted`     | 7.2 : 1 → 5.1 : 1   | AA everywhere                       |
| `--vf-text-accent`    | 7.2 : 1 → 5.2 : 1   | AA everywhere                       |
| `--vf-status-*-text`  | 12.8 : 1 → 5.1 : 1  | AA everywhere (danger is the floor) |
| `--vf-text-disabled`  | ≈ 2.8 : 1           | **below AA, deliberately**          |

Three decisions behind that table:

- **`--vf-text-muted` moved.** `call-web` used `#8d8daa`, which measures
  4.38:1 on `surface-4` and therefore failed AA on our own top surface. It is
  now `#9a9ab5`, one step lighter, clearing 4.5:1 on every level. "Muted" is now
  a hierarchy decision and never an accessibility one.
- **Text and fill are separate tokens for every status.** A single "status
  colour" cannot do both jobs: `danger-500` is a good dot and a failing 4.4:1
  as text. Hence `--vf-status-danger-text` (the 400 stop) and
  `--vf-status-danger-solid` (the 500 stop).
- **`--vf-status-on-solid` is near-black for all four families.** White measures
  1.9–3.8:1 on those fills and fails; near-black measures 5.4–10.6:1 and
  passes. White text on a green badge is a common and inaccessible pattern, so
  there is deliberately no token for it.

`--vf-text-disabled` is below AA on purpose: WCAG 1.4.3 exempts inactive
controls, and a disabled control that still meets 4.5:1 does not read as
disabled. The cost is a rule — **a disabled state must never be the only carrier
of meaning.** Pair it with `aria-disabled` and an explanation elsewhere.

### Non-text contrast (WCAG 1.4.11, 3:1)

- `--vf-border-interactive` (`#7d7d9c`) measures **3.55:1 on `surface-4`**, the
  worst case, and 4.6:1 on `surface-1`. Use it on anything a keyboard user can
  land on. The decorative `subtle`/`default`/`strong` borders do not meet 3:1
  and do not need to — but using them on an input is the easiest way to fail an
  audit.
- `--vf-focus-color` (violet-300) measures 5.2–7.2:1 against every surface.

### Focus over video

A single violet ring is **not** sufficient for Videofy. Mute, camera, leave and
caption controls sit on top of video, and violet-300 measures **2.72:1 against a
white frame** — below the 3:1 that WCAG 2.4.11 asks of the indicator itself.

`--vf-focus-ring-over-media` is therefore a dual ring: a near-black inner ring
that survives bright content (20.4:1 on white) and a violet outer ring that
survives dark content (7.7:1 on black). One of the two always wins, whatever is
behind the control. Mark such controls with `data-vf-on-media` and `base.css`
applies it.

### Captions over video

Video content is unknown and uncontrollable, so caption contrast is measured
against the worst case the scrim has to survive — a pure white frame:

|                                      | 0.50 scrim | **0.65 scrim (shipped)** |
| ------------------------------------ | ---------- | ------------------------ |
| `--vf-caption-final-color`           | 3.32 : 1 ✗ | **5.89 : 1 ✓**           |
| `--vf-caption-interim-color`         | 2.79 : 1 ✗ | **4.95 : 1 ✓**           |
| `--vf-caption-overlay-speaker-color` | 3.06 : 1 ✗ | **5.42 : 1 ✓**           |

The conventional 0.5 fails all three. 0.65 occludes more of the picture, and
that is the trade we make: §5.1.14 requires captions to remain readable over
varied video. `prefers-contrast: more` raises it further, to 0.82.

### Light theme

Rated against the _darkest_ light surface, `--vf-surface-sunken` (`#d9d7e8`),
because a chip inside a well is a real layout and it is where every hue comes
closest to failing: primary 13.9:1, secondary 6.8:1, muted 4.6:1, accent 5.0:1,
status 4.6–5.3:1. Two consequences worth stating:

- **`--vf-text-accent` is violet-700, not the brand violet-600.** The brand stop
  measures 4.0:1 on `sunken` and cannot carry body text on light.
- **Green, amber and blue all go one stop darker than red** (800 vs 700). That
  is a property of the hues, not an inconsistency.

---

## Theme story

**Dark is not a mode in Videofy. It is the product.**

A call stage and a programme stage are dark by design: video is the brightest
object on screen, light chrome around it perceptually dims the media, and a dark
surround is what the caption scrim contrast is calculated against. Dark is
therefore declared unconditionally on `:root` — it is not behind a media query,
and it is not something a user preference can take away.

### Why `prefers-color-scheme` is not honoured in CSS

Auto-flipping to light would hand a light call stage to the majority of users,
whose operating system is set to light, and would break the product's core
surface for them. That is not an accessibility win; it is a regression dressed
as one.

We do honour the _other_ two user preferences unconditionally, because those
only ever remove things:

- `prefers-reduced-motion: reduce` re-points the duration tokens themselves, so
  one block in `base.css` neutralises motion across the whole product rather
  than each app remembering its own media query. Durations collapse to **1ms,
  not 0** — at zero, browsers may skip `transitionend`/`animationend` entirely
  and any logic sequenced on those events hangs forever.
- `prefers-contrast: more` promotes decorative borders to the contrast-verified
  value, thickens the focus ring to 3px, and deepens the caption scrim.
- `forced-colors: active` restores a UA-drawn focus outline, which a custom
  `box-shadow` ring would otherwise lose.

### How light works anyway

The semantic layer exists precisely so a theme is a _re-point and nothing else_.
Setting `data-vf-theme="light"` on any element re-points 44 semantic tokens
beneath it — out of 342 in the system — with no new primitives, no component
CSS and no second palette. It is
intended for surfaces that are documents rather than stages — marketing, admin,
docs — and never for the call or programme stage.

```html
<html data-vf-theme="light"></html>
```

An app that genuinely wants to follow the OS resolves it in JS and writes the
attribute:

```ts
import { resolveSystemTheme, VF_THEME_ATTRIBUTE } from '@videofy-live/design-system';

document.documentElement.setAttribute(VF_THEME_ATTRIBUTE, resolveSystemTheme());
```

Doing it this way keeps the palette declared exactly once. A CSS
`@media (prefers-color-scheme: light)` block would force the entire light
mapping to be duplicated for the "system" case, and a duplicated palette drifts.
`resolveSystemTheme()` resolves _no preference_ to dark, not light.

Two things to know:

- **Themes are set at the document root.** A nested `data-vf-theme` region
  re-points colour correctly, but `--vf-elevation-*` and `--vf-canvas-wash` are
  substituted where they are declared. For a genuinely nested theme island,
  re-declare those on the island.
- **In light mode, surfaces 2–4 converge on white.** That is correct, not lazy:
  light themes carry depth with shadow, dark themes carry it with fill. The ramp
  does not simply invert.

---

## Deliberately not included

- **No components.** Three separate apps must be free to build their own. This
  package ships a language.
- **No icon glyphs.** An icon set is an asset-pipeline decision (sprite vs
  inline vs font) that belongs to each app; a framework-agnostic CSS package
  shipping SVG would force one on all of them. What _is_ standardised is the
  geometry — 24px grid, outline, 1.75px stroke, `currentColor` — which is what
  actually makes icons from different sources look like one family.
- **No webfont.** A shared package that pulls a font file forces every consuming
  app into a loading strategy (FOUT/FOIT, preload, self-host vs CDN, CSP) the
  design system cannot see and must not decide. The stack picks up Inter
  automatically if an app loads it; otherwise it falls back to the platform UI
  font.
- **No colour palette in TypeScript.** Duplicating it would create a second
  place for a colour to be wrong. A component that needs a Videofy colour in JS
  is a component that should have been styled in CSS.
- **No utility classes** beyond `.vf-sr-only`, which is the mechanism behind a
  hard accessibility rule rather than a styling convenience.
- **No `--vf-*` value expressed only in TS.** Breakpoints, durations and easings
  exist in both CSS and TS, and a test asserts the two agree — two sources of
  truth that nobody checks are one source of truth and one bug.

---

## Tests

```bash
npm run build     -w packages/design-system
npm run typecheck -w packages/design-system
npm run test      -w packages/design-system
```

The suite is mostly about invariants a stylesheet has no type system to catch:

- every `var(--vf-*)` reference resolves to a declared token (a dangling `var()`
  is not a CSS error — the property is just dropped);
- colour literals appear only in the primitive ramps, so a theme stays a
  re-point;
- `base.css` and the light theme may re-point tokens but never invent them;
- the CSS and TypeScript breakpoint, duration and easing scales agree;
- every documented contrast pairing is re-measured from the token graph, in both
  themes;
- interim captions differ from final on a non-colour channel, and stay more
  readable than muted text;
- breakpoint bands tile the width axis with no overlap and no dead zone;
- the `exports` map points at files that exist, CSS never lands in `dist`, and
  stylesheets are marked side-effectful so a bundler cannot tree-shake them away.
