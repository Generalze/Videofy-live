# Dedicated `en->pt` route — targeted replacement screen

Run 31 Aug 2026. A narrow replacement test for the grouped OPUS route that was
disqualified for answering in Italian. **Not general model discovery.**

## Two kinds of evidence, kept apart

| | what it exercised |
|---|---|
| **RAW MODEL SCREEN** (below) | the model, with the integrity checker. **Not the production gate.** |
| **PRODUCTION PATH** (separate) | the gate, which decides what reaches a model at all |

An earlier draft of this record said the screen ran "through the same production
guards". **That was wrong**, and the stored evidence contradicts it: emoji-only,
number-only, OTP-only and punctuation-only inputs all reached the provider
during the screen, with measurable latency. Only blank input was
short-circuited. Correcting it here rather than quietly, because the two claims
support different decisions.

## Raw model screen — observations

`Helsinki-NLP/opus-mt-tc-big-en-pt`, 34 fixed cases, greedy beam 4, CPU.

| | |
|---|---|
| machine-classified catastrophic | **1 / 34** |
| wrong-language cases **detected by current automated checks** | **0 / 34** |
| peak RSS | ~870 MB |
| median latency | ~256 ms |

**"0 detected wrong-language" is not "34/34 proven Portuguese."** The detector is
a targeted alarm for Italian tells, built after one specific failure. It is not
language identification, and it cannot confirm a positive. **Human review
remains authoritative.**

### What the 1/34 is

```
category  emoji-only
input     👍👍
output    (empty)
defect    empty-output
```

The model was handed two emoji and returned nothing. That is the entire
catastrophic count — and in production the model is never handed it.

Also observed, and not counted as catastrophic: `???!!!` came back as `????!!!`,
the model having added a question mark to punctuation it should never have seen.

## Production path — the same inputs, separately proven

The gate bypasses non-linguistic input before any provider is reached. Proven
by invocation count in `gated-translation-provider.test.ts`, not by inspection:

| input | provider invocations | outcome | charge |
|---|---:|---|---:|
| `👍👍` | **0** | BYPASS, original retained | none |
| `45000` | **0** | BYPASS, original retained | none |
| `OTP-483920` | **0** | BYPASS, original retained | none |
| `???!!!` | **0** | BYPASS, original retained | none |
| blank / whitespace | **0** | BYPASS, original retained | none |

**The raw record is not rewritten to manufacture 0/34.** The model did return
empty for emoji; that observation stands. What the production path adds is that
the model is never asked.

## Comparison with the excluded grouped route

| | grouped `en-ROMANCE` + `>>por<<` | dedicated `tc-big-en-pt` |
|---|---:|---:|
| catastrophic | 8 / 34 | **1 / 34** |
| wrong-language detected | **6 / 34** | 0 / 34 |
| peak RSS | 1 343 MB | 870 MB |
| median | 252 ms | 256 ms |

`Helsinki-NLP/opus-mt-en-ROMANCE` with `>>por<<` remains
**TESTED ROUTE EXCLUDED — WRONG LANGUAGE**, and that exclusion is not
generalised to other OPUS Portuguese models.

## Status

The dedicated route **advances to blind human review** alongside M2M100 1.2B.
It is not production-qualified and no route is promoted.
