# Evidence vocabulary

Adopted 31 Aug 2026 after three separate CTO corrections to wording that claimed
more than the evidence supported. Each was a small phrase; each would have
survived into a decision.

**The rule underneath all of it: name what was OBSERVED, and by whom.** Every
overclaim here came from writing the conclusion a reader would want instead of
the measurement that was made.

## Support states — never collapse these

| state | meaning | example |
|---|---|---|
| **NOT OFFERED** | the candidate has no such route | `pcm` in OPUS-MT, M2M100 |
| **REFUSED** | the candidate rejects the request | `pcm` in TranslateGemma — the chat template raises |
| **NOT ADDRESSABLE** | nominally present, cannot be requested | MADLAD `<2pcm>` is not a single vocabulary token |
| **ATTEMPTED — WRONG** | it answered, and the answer is wrong | OPUS-MT Hausa returning Qur'anic narrative |
| **ATTEMPTED — UNVERIFIED** | it answered; nobody qualified has read it | almost everything in this project |
| **ATTEMPTED — VERIFIED** | a qualified human has judged it | nothing yet |

The first three are **absence**. The fourth is **failure**. Writing "every
cleared candidate fails Pidgin" collapsed absence into failure and would have
left a future reader believing Pidgin had been tried. It has not been tried,
because nothing cleared can accept the request.

**Correct phrasing:** *"No commercially cleared candidate currently provides
validated Nigerian Pidgin translation support."*

## Script observation is not language validation

A program can count character classes. It cannot read.

| may be written | may NOT be written |
|---|---|
| "100 % Latin script using Igbo-specific orthographic characters and diacritics" | "correct Igbo orthography" |
| "contains Devanagari where Yoruba was requested" | "is not Yoruba" |
| "no non-Latin characters present" | "is valid Hausa" |

Being in the expected script is not being right, and the gap between those two
is where every failure in this project has lived — the general TTS vendors
returned fluent, correctly-scripted, wrong Yoruba with HTTP 200.

Anything not read by a qualified speaker is **HUMAN-UNVERIFIED**, and saying so
costs one word.

## Scope of an exclusion

An exclusion is bounded by what was run. State the model revision, the runtime
versions, the invocation path and the decoding parameters, and say what would
reopen it.

- **Write:** "excluded for these languages via the tested official chat-template
  path at revision X under transformers Y, greedy decoding, float32 CPU"
- **Do not write:** "the model cannot translate these languages"

This project has already withdrawn one verdict that was its own harness. An
unbounded exclusion is the same error with no way back.

## Human review states

| value | meaning |
|---|---|
| `NOT_REVIEWED` | no qualified human has seen it |
| `SINGLE_REVIEWER` | one qualified reviewer; enough to proceed, and recorded as single |
| `DUAL_BLIND_REVIEW` | two independent blind reviewers; preferred |

Do not block a first-pass measurement waiting for a second reviewer.

**Disagreement between two reviewers is ADJUDICATED, never averaged**, where it
concerns: meaning reversal, negation, money, identifiers, omission, or
invention. Averaging "one said the meaning reversed, one said it did not" into
half a reversal destroys the only signal that mattered.

## Round trip is not reverse quality

`en→X→en` measures self-consistency. A consistently wrong model scores well
against itself. Reverse-direction evidence requires **native-authored source**,
and until it exists the honest state is **UNMEASURED**.

## A metric is never the verdict

chrF, BLEU and every similarity score are diagnostic. They have been wrong here
four times in one wave — on spelled-out numerals, exonyms, Igbo suffix negation,
and correct passthrough of non-linguistic input. **A low score is strong
evidence of a problem; a high score is weak evidence of quality.**
