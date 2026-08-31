# TranslateGemma 4B — formally EXCLUDED for all four C7 languages

Tested 31 Aug 2026, benchmark runtime only. `/opt/videofy-ai` untouched.

| field | value |
|---|---|
| model | `google/translategemma-4b-it` |
| revision | `10042cb0e6e7fdce748996a71dc3dc432a4e0c89` |
| licence | Gemma terms — **commercial hosted use permitted**, see the licence review |
| runtime | python 3.12.3 · torch 2.13.0+cpu · transformers 5.16.1 |
| venv | `/var/lib/videofy/bench/gemma-venv` |
| **verdict** | **NOT SUPPORTED for yo, ha, ig, pcm** |

**The licence was never the problem.** The Gemma terms permit exactly what C7
wanted. The model cannot do the languages.

## Language presence — the gate finally answered

`chat_template.jinja`, which had been returning 401, lists **yo**, **ha** and
**ig** (plus `yo-BJ`, `ha-Arab`, `ha-GH`, `ha-NE`, `en-NG`). It does **not**
list `pcm`.

Presence settled nothing. Per directive, support is established by translating.

## What translating established

Controls first — the same code path, same session:

| direction | output | verdict |
|---|---|---|
| en→fr | `Bonjour à tous, et bienvenue à cette émission.` | correct |
| en→es | `No he recibido el dinero que me enviaste.` | correct, **negation preserved** |
| en→pt | `Por favor, envie 45.000 naira para a minha conta hoje.` | correct, **45.000 and "naira" preserved** |
| **en→sw** | `Habari zote, na karibuni kwenye programu hii.` | **correct — and Swahili is an African language** |

Then the four that matter:

| direction | input | output |
|---|---|---|
| en→yo | Good morning everyone… | `सान्, Ẹkun Ẹkun, ẹnọ, ẹnọ wọn, ẹnọ ẹnọ ẹnọ.` |
| en→yo | I have not received the money you sent. | `હું पैसा којa तिंले पठा, હन प्राप्तंनु।` |
| en→yo | Good morning. | `सान् गु।` |
| en→ha | Good morning everyone… | `يا زوار, ساءلا, kuma ياللا cikin wannan راديو.` |
| en→ha | I have not received the money you sent. | `أنا لست قد استلمت النقد الذي سار.` |
| en→ig | Good morning everyone… | `Ịga ụtụtụ Ụmụ, ụnwe obi ụtọ ịpụrụ ụzọ.` |
| en→ig | I have not received the money… | `أنا لم أتلقเงินที่คุณส่ง` |
| en→ig | Please send 45,000 naira… | `कृपया 45,000 naira nkeṅụṅụṅụṅụ…` (75 s, repetition loop) |
| en→pcm | — | **REFUSED by the chat template**: `'dict object' has no attribute 'pcm'` |

Devanagari, Gujarati, Arabic and Thai appear in output requested as Yoruba,
Hausa and Igbo.

## Ruling out the caller before blaming the model

This project has already published one verdict that turned out to be its own
harness (MADLAD, withdrawn 31 Aug). The same discipline was applied here:

1. **Sanity controls pass** — fr, es, pt are clean through the identical path.
2. **An African-language control passes** — Swahili is correct, so this is not
   "the model cannot do African languages" and not a script-handling fault in
   the harness.
3. **Regional and script variants were tried**, because `ha-Arab` is listed and
   Arabic output suggested the bare code might resolve to Ajami:

   - `ha-NE` → `أنا لست قد استلمت النقد الذي سألت.` (identical Arabic)
   - `ha-GH` → identical
   - `yo-BJ` → identical to `yo`

   The variant is not the problem.
4. **Input handling was corrected** mid-test — the chat template returns a
   `BatchEncoding`, which is not a `dict`, and the full encoding including
   `attention_mask` is now passed. Output was unchanged.

The harness translates French, Spanish, Portuguese and Swahili correctly in the
same run. The deficit is the model's.

## What this is an instance of

Google's own model discussion states that the 55 benchmarked languages are one
tier, and that further languages exist in the weights but are **experimental
with higher hallucination rates**. Yoruba, Hausa and Igbo are in the chat
template and are evidently in that second tier.

**This is the whole reason the directive forbids inferring support from a
language list.** Every paper source said Yoruba and Hausa were supported. The
model accepts the request, returns HTTP-equivalent success, and produces
Devanagari.

It is at least *obviously* wrong. A speaker is not needed to see that Yoruba is
not written in Gujarati script — which makes it less dangerous than OPUS-MT's
fluent Qur'anic Hausa, and no more usable.

## Consequences

- **TranslateGemma does not enter the top two for any C7 direction.** Per the
  standing ruling, **Review Pack V2 may be distributed unchanged** — no V3 is
  needed.
- Nigerian Pidgin remains uncovered by every cleared candidate. **Toucan is
  still the only surveyed model that covers it**, and still needs written
  commercial permission.
- The Gemma licence review stands and remains valid should Google publish a
  version that serves these languages.
- The staged weights and `gemma-venv` are benchmark-only and touch nothing that
  serves traffic.

`productionApproved = false`. `qualityStatus = EXCLUDED-PHASE1`.
