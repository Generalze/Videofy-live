# Phase 1 — quick quality screen

Run 31 Aug 2026 on c7-eu-01, **one engine at a time**, box otherwise idle.
Raw results and the generated report are in `screen-results/`.

Ranked by **catastrophic-error rate**, per directive. chrF is recorded but is
never the verdict.

## Final report table

| field | OPUS-MT (baseline) | M2M100 1.2B |
|---|---|---|
| model | `opus-mt-en-{alv,ha,ig}` + reverse | `facebook/m2m100_1.2B` |
| revision | per-pair | `7b36184180524c1a1bbfa37f120a608046250b98` |
| licence | CC-BY-4.0 | **MIT** |
| commercial status | permitted | **permitted** |
| parameters | ~75 M per pair | 1.2 B |
| disk | ~300 MB per pair | 4.7 GB |
| peak RAM | **1 301 MB** | 5 409 MB |
| CPU | 8 cores, fp32 | 8 cores, fp32 |
| directions tested | en↔yo, en↔ha, en↔ig | same |
| sample count | 34 cases × 6 directions = 204 | 204 |
| **catastrophic, en→X** | **15 / 102 = 14.7 %** | **8 / 102 = 7.8 %** |
| identifier corruption | 10 | 1 |
| negation lost | 1 | 2 |
| omissions | 2 | 1 |
| hallucination | 2 | 0 |
| wrong script | 0 | 0 |
| repetition loops | 0 | 2 |
| empty output on real text | 0 | 0 |
| median latency en→X | **262–360 ms** | 2 114–2 678 ms |
| p95 latency en→X | **600–826 ms** | 2 997–6 890 ms |
| Nigerian Pidgin | not supported | not supported |
| human review | **not done** | **not done** |
| current VPS viability | **yes, comfortably** | **yes, but 6–8× slower** |
| final status | baseline retained | **leading candidate** |

Per direction, catastrophic count out of 34:

| direction | OPUS-MT | M2M100 |
|---|---:|---:|
| en→ha | 7 | **1** |
| en→ig | 6 | **4** |
| en→yo | **2** | 3 |

## What the numbers actually say

**M2M100 halves the catastrophic rate and nearly eliminates identifier
corruption** — 1 failure against OPUS-MT's 10. That is the single most
decision-relevant number in this table, because an identifier failure is a
phone number or an OTP arriving wrong, and OPUS-MT produced:

```
08031234567  ->  08031,32367            (digits scrambled)
483920       ->  [43920]                (a digit dropped)
0123456789   ->  "year 0 from year 3"   (rendered as prose)
```

**Hausa is where the difference is decisive.** OPUS-MT's religious-corpus
problem is unchanged — `45,000 naira` became a Watchtower book title, and
`12,500 naira` became "twelve". M2M100 en→ha had one catastrophic failure in 34.

**Yoruba is the one direction OPUS-MT wins** (2 vs 3), and M2M100's failures
there are degeneration, not corruption: repetition loops on `OTP-483920` and on
a hashtag. Different failure shape, similar frequency.

**M2M100's weak spot is Igbo** (4 catastrophic), and two are genuine meaning
reversals:

```
"I have not received the money you sent."
  ->  "Ọ bụ ezie na m na-enweta ego ị na-enweta."
      (it is true that I am receiving the money)
```

That is exactly the failure the directive singles out as automatically
disqualifying, and it must be part of the human-review packet.

**Cost of the win: 6–8× the latency and 4× the RAM.** 2.1–2.7 s median per
message against 262–360 ms, and a p95 of 6.9 s on Yoruba. For asynchronous
chat translation that is acceptable. For a live caption path it is not, and
that distinction should be settled before any wiring.

## Honest caveats — read before quoting any number here

**The checker was wrong three times, and each error changed the ranking.** It
is recorded because a screen nobody can audit is worth nothing:

1. **Spelled-out numerals and exonyms counted as loss.** `two thousand` →
   `ẹgbẹ̀rún méjì` and `Lagos` → `Èkó` are CORRECT, and were scored as defects.
   First run reported OPUS-MT at 73.5 %.
2. **Igbo negates by suffix.** `enweghị`, `bụghị`, `dịghị` all negate, and a
   word-boundary pattern cannot see them. Five correct Igbo negations were
   reported as reversals — the checker nearly condemned M2M100 for working.
3. **"Identifier" was inferred from digit length**, so the quantity `2000` was
   treated like an account number.

Corrected figures are 14.7 % and 7.8 %. **The direction of the result survived
all three corrections; the magnitude did not.** Anything derived from the
earlier 73.5 %/23.5 % pair is withdrawn.

**`unverified(human)` is the largest column and is deliberately not scored.**
OPUS-MT produces 17–19 per language against M2M100's 1–4. That gap could mean
M2M100 preserves source tokens better, or that it is simply more literal and
less idiomatic — a checker that cannot read Yoruba cannot tell those apart, and
guessing would reintroduce exactly the error above.

**X→en is provisional.** C7 has no native-authored corpus, so the reverse
direction runs over each engine's own output and measures round-trip
self-consistency. A consistently wrong model scores well against itself.

## Recommendation

Take **M2M100 1.2B** and **OPUS-MT** as the top two into Phase 4, and treat the
comparison as unfinished rather than won: the two engines fail differently
rather than one dominating, and the deciding evidence is Igbo negation and
Yoruba degeneration — both of which need a native speaker, not a bigger corpus.

MADLAD-400 and TranslateGemma are unresolved for reasons in
[phase0-candidate-licence-gate.md](phase0-candidate-licence-gate.md), not on
quality. Neither has been fairly measured and neither should be dismissed.
