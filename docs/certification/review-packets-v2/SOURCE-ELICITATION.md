# Native source sentences — the missing half of the review

**Read this before sending V2.** The V2 packs cover `en→ha`, `en→ig` and
`en→yo` only. The reverse directions are missing, deliberately, and this
document explains what is needed to produce them honestly.

## Why the reverse direction is not in V2

CTO ruling, §2:

> The reviewer packet must contain ACTUAL direct `ha→en`, `ig→en`, `yo→en`
> candidate outputs. Never an English→X→English reconstruction presented as
> direct evidence.

That is correct and it is exactly why those rows are absent. Everything C7
currently holds for the reverse direction is a **round trip**: English went into
an engine, came out as Yoruba, and went back through an engine into English.
Handing a reviewer that Yoruba as if it were a native sentence would ask them to
judge a translation of a translation while telling them it was direct.

**C7 has no native-authored Hausa, Yoruba or Igbo corpus.** Nobody on the team
writes these languages, so it cannot be authored internally.

## What was checked, and why each source was rejected

| source | licence | verdict |
|---|---|---|
| **FLORES-200** (`facebook/flores`) | — | **gated**, 401 |
| **FLORES+** (`openlanguagedata/flores_plus`) | — | **gated**, 401 |
| **MAFAND-MT** (`masakhane/mafand`) | **CC-BY-NC-4.0** | **non-commercial** — same bar that excludes NLLB |
| **Tatoeba MT** (`Helsinki-NLP/tatoeba_mt`) | permissive | **no Nigerian coverage** — zero matching files |
| **OPUS-100** (`Helsinki-NLP/opus-100`) | permissive | **methodologically invalid** — see below |

OPUS-100 has `en-ha` and `en-ig` and is permissively licensed, and it is still
the wrong choice for two independent reasons:

1. Its Hausa and Igbo content comes largely from the **same religious corpora**
   that make `opus-mt-en-ha` answer business questions with Qur'anic narrative.
   Native source drawn from that distribution would not resemble what C7
   carries.
2. It is **OPUS-MT's own training distribution.** Evaluating OPUS-MT on it would
   score a model against data it was built from, and quietly advantage one
   candidate in the exact direction under test.

## The proposal: reviewers author the source

Ask each language reviewer, **as a first short task before the review itself**,
to write **15 short messages in their own language** — the kind they would
actually send.

This is better than any corpus above, not merely available:

- **genuinely native** — written by a speaker, not translated into the language
- **the right domain** — real messaging, which no news or encyclopedic corpus is
- **C7-owned** — no licence encumbrance, now or later
- **unbiased** — belongs to no engine's training distribution

Then C7 runs each candidate on those 15 sentences, `X→en`, and the reviewer
receives the English outputs to judge — which they can do, because they wrote
the source and know what it meant.

**Order matters: elicitation must complete before the reviewer sees any
candidate output**, or they will be judging engines on sentences they chose
after seeing how engines behave.

## What to ask for

Give the reviewer this, in their language or in English:

> Please write **15 short messages in {language}** — the kind you would really
> send to a friend, a family member, or someone you do business with. Write them
> as you would type them, not as formal writing.
>
> Please include, roughly:
>
> - **4 about money** — a price, an amount owed, confirming you received or did
>   **not** receive something
> - **2 with a phone number, account number or code** in them
> - **3 with a date or a time** — an appointment, a delay, a change of plan
> - **3 instructions or warnings** — including at least one saying **not** to do
>   something
> - **3 ordinary messages** — a greeting, a question, ordinary news
>
> Short is good. One or two sentences each. Please also write, in English, what
> each one means — that is the answer we will compare against.
>
> Do not translate English sentences. Write what you would actually say.

## Cost and timing

Fifteen short messages is perhaps 20 minutes. It is a smaller ask than the
review itself and it unlocks the half of the evidence that currently cannot be
produced at all.

If a reviewer declines, `X→en` for that language stays **UNMEASURED** — which is
an honest state, and better than a number derived from a round trip.
