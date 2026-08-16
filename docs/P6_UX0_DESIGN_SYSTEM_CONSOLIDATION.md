# P6-UX0 — Design System Consolidation

**Status:** complete for what the screens have proven
**Commit:** `396b13b`

The brief was to extract the design system *from proven screens*. The
discipline that follows from that wording: extract what two or more surfaces
have independently arrived at, and leave alone what only one of them does.

## What was consolidated

**One palette.** Operator was the last surface holding its own colours — raw
hex values and no tokens import at all — while Call and the Viewer both
resolved theirs through `@videofy-live/design-system`. Operator now aliases the
same way, which also moves it from Segoe UI onto Inter.

Aliasing (`--color-surface: var(--vf-surface-1)`) rather than rewriting every
rule is deliberate. It keeps this an experience-layer change, every existing
selector keeps working, and it stops the three products drifting apart one
shade at a time. The alias layer is the seam where a full migration can happen
later, per surface, without a flag day.

**One caption treatment.** Call was reinventing values the design system
already defines — including a `60ch` measure that is literally
`--vf-caption-max-width-panel`. Captions in a side panel and captions over a
stage are the same reading problem at two widths, and the system already held
both answers. Call now uses the caption tokens for measure, size, weight,
line-height, letter spacing and colour.

Interim wording moved from "muted text" to `--vf-caption-interim-color`. It is
a state the product reasons about and announces to screen readers, not a shade
that happens to be dimmer.

## What was deliberately NOT extracted

**The status-banner pattern.** The Viewer has `.viewerStatus` with info/warn/
danger tones, built during the Viewer overhaul. Call renders status as inline
text in its connection row; Operator has no equivalent surface. That is one
use, not a pattern, and promoting it now would be inventing an abstraction
from a single example — then bending the second and third surfaces to fit a
shape that was never designed for them.

It is a strong candidate for the moment a second surface genuinely needs it.
Recorded here so the decision is deliberate rather than forgotten.

## Verification

Checked in three running browsers rather than by reading CSS, because a
palette swap fails silently: an unresolved custom property computes to empty,
and the page simply goes blank in that spot.

| Surface | Body background | Text | Font | Unresolved props | Overflow | Page errors |
| --- | --- | --- | --- | --- | --- | --- |
| Operator | `rgb(11, 11, 16)` | `rgb(236, 234, 246)` | Inter var | 0 | 0px | 0 |
| Call | `rgb(11, 11, 16)` | `rgb(236, 234, 246)` | Inter var | 0 | 0px | 0 |
| Viewer | `rgb(11, 11, 16)` | `rgb(236, 234, 246)` | Inter var | 0 | 0px | 0 |

The operator also renders structurally unchanged — same hero, same Steps 1–5,
same diagnostics drawer.

Gates: typecheck, lint, unit, build.

## Not verified

Captured in Microsoft Edge (Chromium); Chrome is not installed on this
machine. Colour and font resolution are engine-level and identical, but the
owner's real-Chrome visual review is still outstanding.
