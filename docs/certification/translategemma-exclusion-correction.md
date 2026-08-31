# Correction to the TranslateGemma exclusion

Follow-up to [translategemma-phase1-exclusion.md](translategemma-phase1-exclusion.md),
issued 31 Aug 2026 on CTO correction. The original document is left as written;
this records what was wrong with it and what the evidence actually shows.

## 1. The script was named wrongly

The exclusion document closed with:

> "nobody needs Yoruba to see it is not written in Gujarati script"

**That named the minority script.** Counting the characters rather than glancing
at them:

| output | scripts present |
|---|---|
| en→yo #1 | Latin 92 %, **Devanagari 7 %** |
| en→yo #2 | **Devanagari 66 %**, Cyrillic 22 %, Gujarati 11 % |
| en→yo #3 | **Devanagari 100 %** |
| en→ha #1 | **Arabic 58 %**, Latin 41 % |
| en→ha #2 | **Arabic 100 %** |
| en→ig #1 | **Latin 100 %** |
| en→ig #2 | Arabic 52 %, Thai 47 % |
| en→ig #3 | Latin 80 %, Devanagari 20 % |

**Devanagari is the dominant intrusion in Yoruba**, present in all three
outputs. Gujarati appears in exactly one output, as two characters. Cyrillic
appears alongside it. The memorable line was reached for before the characters
were counted, and it named the least significant of the three.

## 2. A second error the count exposed — Igbo was not uniformly broken

The exclusion document presented Igbo as script-mixed throughout. It is not:

```
en->ig  "Good morning everyone, and welcome to this broadcast."
     -> "Ịga ụtụtụ Ụmụ, ụnwe obi ụtọ ịpụrụ ụzọ."      100% Latin
```

That output is **100% Latin script using Igbo-specific orthographic characters
and diacritics**. That is the whole of what was observed — a character-class
count, made by a program.

**Whether it is valid or meaningful Igbo is HUMAN-UNVERIFIED.** The earlier
wording here said "correct Igbo orthography", which is a claim about validity
that nobody on this project is in a position to make. Being in the right script
is not being right, and the distance between those two is exactly where this
project's failures have lived.

The two Igbo failures were real — `أنا لم أتلقเงินที่คุณส่ง` mixes Arabic and
Thai, and the money sentence entered a 75-second repetition loop — but "Igbo is
script-mixed garbage" overstated a 1-of-3 into a 3-of-3. One output was in the
expected script; two were not; none has been read by a speaker.

This does not change the exclusion. One output in the expected script out of
three, with a repetition loop and a wrong-script answer in the other two, is not
a route C7 can carry — and "in the expected script" is not "usable", which is a
verdict still owed to a speaker. It changes how the failure should be described, and being right about
that matters more than the sentence sounding decisive.

## 3. The exclusion is recorded narrowly

Replacing any broader reading of the original document:

> **TranslateGemma 4B is excluded for C7 Hausa, Igbo, Yoruba and Nigerian Pidgin
> translation using the tested official TranslateGemma chat-template path and
> the exact benchmark configuration recorded below.**

| | |
|---|---|
| model | `google/translategemma-4b-it` |
| revision | `10042cb0e6e7fdce748996a71dc3dc432a4e0c89` |
| runtime | python 3.12.3 · torch 2.13.0+cpu · transformers 5.16.1 |
| path | official chat template, `source_lang_code` / `target_lang_code` |
| decoding | greedy, `do_sample=False`, `max_new_tokens=96` |
| precision | float32, CPU |

**This is not a claim that the model can never translate these languages** under
any prompt, any decoding strategy, any precision, or any future revision. It is
a claim about what the documented path produced here, which is what a candidate
gate is entitled to decide on.

What would reopen it: a new revision, a Google statement moving these languages
into the benchmarked tier, or a differently-prompted path someone has reason to
believe behaves differently. Any of those means re-running the same screen, not
arguing from the model card.

## 4. What stands unchanged

- `pcm` is **refused by the chat template itself** — not a quality judgement, a
  hard absence.
- The **licence was never the problem**; the Gemma review stands and stays valid.
- The **controls were sound**: fr, es, pt and Swahili were all correct in the
  same session, through the same code, and Swahili in particular rules out both
  "cannot do African languages" and a script-handling fault in the harness.
- TranslateGemma enters the top two for **no** direction, so **Review Pack V2 is
  final** and no V3 is required.
