# Lane B — non-Nigerian route qualification (machine evidence)

Run 31 Aug 2026 on c7-eu-01, one engine at a time. OPUS-MT against M2M100 1.2B.
MADLAD excluded from this lane on infrastructure grounds, per directive.

**Machine evidence only. No route is promoted. Fluent-speaker review pending.**

- forward `en->X`: the 34-case C7 corpus
- reverse `X->en`: **direct source** in fr/es/pt, 20 cases each, machine-authored
  and **pending fluent confirmation** — not a round trip, and not native-authored

## Results — catastrophic failures

| direction | OPUS-MT | M2M100 | wrong-language | machine winner |
|---|---:|---:|---:|---|
| en→es | 2 / 34 | **1 / 34** | — | M2M100 *(marginal)* |
| en→fr | **0 / 34** | 1 / 34 | — | **OPUS-MT** |
| en→pt | 8 / 34 | **1 / 34** | **OPUS: 6** | **M2M100** *(decisive)* |
| es→en | **0 / 20** | 1 / 20 | — | **OPUS-MT** |
| fr→en | **0 / 20** | 1 / 20 | — | **OPUS-MT** |
| pt→en | **0 / 20** | 1 / 20 | — | **OPUS-MT** |

| engine | peak RSS | median latency | licence |
|---|---:|---:|---|
| OPUS-MT | 1 343 MB | 192–252 ms | CC-BY-4.0, commercial OK |
| M2M100 1.2B | 5 309 MB | 1 760–2 104 ms | MIT, commercial OK |

**No engine wins everything, and the split is directional** — OPUS takes four of
six, M2M100 takes `en→pt` decisively and `en→es` marginally. That is the shape
the route registry was built for.

## The finding that matters: OPUS answers Portuguese in Italian

`Helsinki-NLP/opus-mt-en-ROMANCE` with the `>>por<<` target token is **not
honouring the token**. Six of 34 outputs are Italian:

```
EN  Call me on 08031234567 when you arrive.
PT  Chiamami a 080312344567 quando arrivi.          <- Italian, and the phone
                                                       number gained a digit
EN  Your verification code is 483920. Do not share it.
PT  Il vostro codice di verificazione e 483920. Non lo condividi.
EN  Congratulations on the new baby, we are very happy for you.
PT  Felicitazion per il new new new new new new estims felici per te.
```

**This is the failure class no automatic check catches.** Italian is Latin
script, fluent, and keeps most identifiers — it passes every structural test in
the harness. It was found only because the negation markers for Portuguese did
not match Italian words, which is luck, not method. A targeted Italian alarm now
sits in `rescore_laneb.py`, but that is a smoke detector for one known fire, not
language identification.

A dedicated `en-pt` checkpoint exists upstream and has not been evaluated. That
is the obvious remedy and is **not** assumed to work: it would need the same
screen.

## Two checker corrections during this lane

Both were mine, both changed the ranking, and neither would have surfaced from
reading the counts.

**Romance negation.** `NEG_MARKERS` had no `fr`/`es`/`pt`, and an unknown target
silently fell back to the **English** markers. Every correct French negation --
`n'ai pas`, `Ne ... pas` -- registered as a lost one: six spurious catastrophes
per language. OPUS `en->fr` went from 6 to **0**.

**English contractions.** `\bn't\b` never matches, because in "didn't" there is
no word boundary before the `n`. So `I didn't get the money` read as a lost
negation -- most of how people actually write. Reverse counts fell from 4 to 0-1.

The durable fix is neither marker set: an unknown target now yields
`negation-unverified(<lang>)` instead of borrowing another language's grammar.
Silently applying one language's rules to another is the shape of nearly every
error this checker has made.

## Recommended candidate pairs for fluent review

One reviewer per language is enough for first qualification, recorded as
`SINGLE_REVIEWER`.

| language | forward | reverse |
|---|---|---|
| French | OPUS-MT and M2M100 | OPUS-MT and M2M100 |
| Spanish | M2M100 and OPUS-MT | OPUS-MT and M2M100 |
| Portuguese | **M2M100 and OPUS-MT** — the reviewer must be asked directly whether the OPUS output is Portuguese at all | OPUS-MT and M2M100 |

Reviewers must also be asked to confirm the **direct source sentences** read
naturally. They are machine-authored; a reviewer who finds one unnatural
invalidates the item, not the reviewer.
