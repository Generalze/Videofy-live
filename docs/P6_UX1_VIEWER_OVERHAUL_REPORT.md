# Viewer Page Overhaul

**Status:** engineering complete; owner visual review pending
**Commits:** `45d9b59`, `770774e`, `60166bd`, `c6f19b7`

The Videofy Live Viewer is the audience-facing page for a programme. "Listener"
survives only as the internal package name (`listener-web`).

This was an experience-layer reconstruction. The delivery engine was not
rewritten: WebRTC playback, programme timeline, translated audio queue,
captions, language switching, interpretation/replacement modes, reconnect
behaviour and source handling all keep their existing code paths.

## Acceptance gate

| Gate item | Status | Evidence |
| --- | --- | --- |
| Programme video clearly dominates | Done | Column 900px → 1360px; stage width capped by available height so the whole frame fits a 900px viewport; edge-to-edge below 768px |
| First-time viewer can change language without instruction | Done | Language moved to the header at control size, its own row on mobile |
| Translated captions highly readable | Done | Rebuilt on design-system caption tokens: 46ch measure, caption size/weight/line-height, scrim; raised to clear native video controls |
| Original text optional, not permanent clutter | Done | Opt-in "Show original text"; renders quieter, beneath the translation, in the caption overlay |
| Audio modes understandable | Done | "How I hear this" — Interpretation (original speaker softly underneath) / Translated only (original speaker silent); unavailable state explains itself |
| Mobile works | Partly verified | No horizontal overflow at 390px, asserted not eyeballed; controls stack; **not tested on a real phone** |
| Empty/loading/reconnecting/error states designed | Done | `resolveViewerStatus`, 8 tests; designed empty stage |
| No engineering information leaks to viewers | Done | Queue state, mix internals, source identifier and sequence numbers moved to diagnostics; a real leak was found and fixed (below) |
| Existing regressions green | Done | typecheck, lint, unit, integration, build |
| Screenshots pass visual review | **Pending owner** | Captures exist but in Edge, pre-connection — see below |

## The leak the screenshots found

Reviewing the CSS did not find this; looking at the rendered page did.

In `45d9b59` a regex removed four unused rules. One of them was the last
selector in a shared `display: none` block, so the rule body was consumed and a
dangling comma merged four sections into the next rule. The generated-audio
queue panel — state, queued, played, skipped, sync offset, Reset, Replay —
became visible inside the viewer's settings sheet.

Its own `hidden={!showDiagnostics}` guard never protected it. **Any `display`
declaration defeats the `hidden` attribute**, so a panel with `display: grid`
is visible regardless. That guard had been decorative for as long as it had
existed.

Worth keeping in mind for the operator overhaul, where the same pattern of
"hide it with `hidden`" is likely to recur.

## Failure messages

`resolveViewerStatus` is the contract for what a viewer is told. It returns one
message, in their terms, plus `programmeContinues` — because most failures here
are partial, and a viewer not told the programme survives will assume it did
not and close the tab.

Ordering is deliberate: connection loss outranks anything downstream of it, a
viewer watching the original is never told a translation failed, and a working
programme produces silence rather than a permanent status line.

## What is NOT verified

- **Not Chrome.** Captures drive Microsoft Edge (Chromium); Chrome is not
  installed on this machine. Same engine, not the same browser.
- **Not a live programme.** No gateway was running, so captures show
  pre-connection states. Captions in flight, translated audio, language
  switching mid-programme and reconnect behaviour are unverified visually.
- **Not a real phone.** 390px viewport in a desktop browser is not a handset.

Regenerate with `npm run viewer:screenshots` after `npm run build -w
apps/listener-web` and a `vite preview` on port 4319. Output goes to
`.videofy-screenshots/`, which is git-ignored.

## Pending owner verification

1. Real Chrome, desktop and phone.
2. A live programme: captions, language switch mid-programme, audio modes.
3. Confirm the empty and reconnecting states read as intentional.
4. Confirm no engineering vocabulary is reachable without opening diagnostics.
