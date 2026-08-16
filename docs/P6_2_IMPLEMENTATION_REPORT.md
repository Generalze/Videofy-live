# P6.2 — Personalized Captions

**Status:** complete, pending owner browser verification
**Commits:** `0465a8b` (routing core), `d458e94` (reader control), `95dc15b` (stale-language case)

## The closure test

The owner set the closure test in the owner's own words:

> Each participant receives captions according to their own preferred language,
> with speaker attribution, original-text access, revision safety and no
> cross-recipient leakage.

Each clause is treated as a separate claim below, with the test that backs it.
A clause with no test behind it is not closed, however obviously true it looks
in the code.

| Clause | Where it lives | Evidence |
| --- | --- | --- |
| Own preferred language | `call-session-store.setCaptionLanguage`, gateway `call:caption-language` | `call-runtime.test.ts` — "moves only the requesting reader onto the new caption language" |
| Speaker attribution | `CallScreen` caption entry | `CallScreen.test.tsx` — translated primary, speaker name present |
| Original-text access | `<details>` per caption | same test — asserts `<details>` and the original wording |
| Revision safety | `mergeCallCaption` language/media revision comparison | `callCaptions.test.ts` — newer revision replaces; older revision discarded |
| No cross-recipient leakage | recipient-room routing in `call-runtime` | `call-runtime.test.ts` — translated caption to the hearing recipient room only; mismatched-language caption not delivered; disconnected recipient never served |

## What changed in this milestone

**The reader controls their own language, and only their own.** A socket may
only change the preference of the participant it is bound to. This is enforced
by the same binding check every other call event uses, and there is a test that
drives one participant's socket carrying another's participant id and asserts
nothing moves. Cross-participant interference is not a policy here, it is
structurally unavailable.

**A language change re-plans the call.** When a reader asks for a language the
speakers were not producing, the store returns new ingest plans and the gateway
applies them through the same path a join uses. Without this the reader would
have changed a label and received nothing.

**The control does not lie during the round trip.** The select reflects the
broadcast snapshot rather than an optimistic local value. Showing the new
language before the gateway agreed would be wrong for the length of the round
trip, and would stay wrong if the change was refused.

**Stale captions in the abandoned language are discarded.** At the moment of a
switch, captions in the old language are already in flight. They arrive after
the new ones and carry the older language revision. `mergeCallCaption` rejects
them, so the switch does not flicker backwards.

## What is NOT claimed

- **No browser verification.** Every claim above rests on automated tests. Two
  real browsers on one call, each changing reading language independently, has
  not been run and is not claimed.
- **Two participants.** The store's participant ceiling is still 2 by default.
  Conference-scale caption fan-out is P6.3, not this milestone.
- **Caption language is per-reader, speak language is not.** A reader changing
  what they read does not change what anybody speaks. That remains ADR-004
  manual authority plus the P6.2 auto-detect settlement.

## Pending owner verification

1. Two browsers, one call, different reading languages.
2. Change reading language mid-call in one browser; confirm the other browser's
   captions do not move.
3. Confirm the switched browser starts receiving the new language rather than
   silence.
4. Confirm the original text remains reachable in both.
