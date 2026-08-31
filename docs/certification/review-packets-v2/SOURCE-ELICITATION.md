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
- **cleanly licensed** — under an explicit contributor permission, see below
- **unbiased** — belongs to no engine's training distribution

> **Correction, 31 Aug 2026.** An earlier version of this document called the
> resulting corpus "C7-owned". **That was wrong.** A contributor writing
> sentences does not thereby transfer copyright in them, and calling the corpus
> owned would have been a licence assumption of exactly the kind this project
> refuses to make about model weights. The permission below is a broad licence,
> not an assignment; C7 does not own this text, it is licensed to use it.

Then C7 runs each candidate on those 15 sentences, `X→en`, and the reviewer
receives the English outputs to judge — which they can do, because they wrote
the source and know what it meant.

**Order matters: elicitation must complete before the reviewer sees any
candidate output**, or they will be judging engines on sentences they chose
after seeing how engines behave.

## Contributor permission — obtain this BEFORE collecting anything

Nothing may be collected until the contributor has agreed to the following. It
is a licence, not an assignment: the author keeps their copyright.

> By submitting these messages and English meanings, I confirm they are my
> original writing and grant C7 / Tech Advance Concept a perpetual, worldwide,
> irrevocable, royalty-free licence to use, reproduce, modify, evaluate, publish
> internally, and use them for training, testing, benchmarking and improving
> translation systems and related C7 services.

If C7 ever wants **ownership** rather than a licence, that requires an explicit
copyright assignment and is a different document. For this benchmark the broad
licence is sufficient, and simpler.

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
> - **at least one message that mixes English with your language**, if that is
>   how you normally write. Do not force it if it is not natural for you.
> - **at least one about money that uses "not"** — for example saying you have
>   NOT received a payment. This exact shape has already broken two engines.
>
> Short is good. One or two sentences each. Please also write, in English, what
> each one means — that is the answer we will compare against.
>
> Do not translate English sentences. Write what you would actually say.

## The English meaning is SEMANTIC ground truth, not wording

The English gloss the author supplies says what the message MEANS. It is not a
model answer and candidate output must never be scored by lexical similarity to
it. Both of these are correct for the same source:

```
author's meaning:  "I haven't received the money yet."
candidate output:  "The payment hasn't reached me yet."
```

A regex or a chrF score penalises the second. A human reading both does not.
This project's checker has been wrong four times for precisely this reason, and
the reverse direction must not repeat it: **the human verdict is the score.**

## Ordering — elicitation comes before EVERYTHING

The contributor must finish writing and submit their 15 messages before they
see:

- any candidate reverse output
- **the V2 forward review pack**
- any answer key
- any machine score

The forward pack matters as much as the rest. A contributor who has already read
30 translations of money, OTP and negation cases has learned what the benchmark
is hunting for, and will write toward it. Their sentences would then test the
engines on the cases we already knew about rather than the ones we did not.

Once submitted, the 15 messages and their English meanings are **FROZEN** before
any model is run against them.

## Cost and timing

Fifteen short messages is perhaps 20 minutes. It is a smaller ask than the
review itself and it unlocks the half of the evidence that currently cannot be
produced at all.

If a reviewer declines, `X→en` for that language stays **UNMEASURED** — which is
an honest state, and better than a number derived from a round trip.
