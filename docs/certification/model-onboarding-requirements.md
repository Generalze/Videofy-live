# Model onboarding requirements

**Every new model must pass this before it is benchmarked, and again before it
is considered for production.** Adopted 31 Aug 2026 by CTO ruling.

```
model revision
  + runtime dependency manifest
  + known-answer sanity suite
        must pass
  before benchmark or production consideration
```

## The incident that produced this rule

On 31 Aug 2026 MADLAD-400 was benchmarked and reported as producing Armenian,
Thai and Korean characters for Yoruba. That result was published, then
withdrawn.

**The precise fact, and no more than it:**

> MADLAD revision `fa184c6` — a T5/T5X-derived checkpoint — is incompatible
> with the C7 `transformers 5.15.1` runtime in a **silent-wrong-output failure
> mode**: it loads with 0 missing keys, 0 unexpected keys, 0 mismatched keys,
> no non-finite parameters and finite logits, and then generates uniform
> nonsense. Nothing raises. Under `transformers 4.44.2` the identical revision
> translates correctly.

**Do not generalise this to "all T5 models".** One checkpoint under one runtime
pair is what was measured; Marian and NLLB run correctly on `5.15.1` and no
other T5 checkpoint has been tested on it. The rule below exists precisely
because the failure mode is silent, not because the cause is understood.

## What is required

### 1. Exact identification

| field | why |
|---|---|
| repository id | — |
| **revision SHA** | a moving `main` makes every result unreproducible |
| tokenizer revision | can drift separately from weights |
| licence identifier + commercial status | see the Phase 0 gate |

### 2. Runtime dependency manifest

Recorded with the results, never assumed from "whatever is installed":

- Python version
- torch version
- transformers version
- sentencepiece / tokenizers version
- any model-specific requirement

**Isolated environments.** A model needing versions other than production's is
staged in its own venv under `/var/lib/videofy/bench/`. **`/opt/videofy-ai` is
never downgraded** — media-ingest's translation and TTS workers run on it, and a
downgrade to please a benchmark would put every live route at risk to answer a
question about a candidate.

### 3. Known-answer sanity suite — before any benchmark

Translate a handful of **high-resource** pairs whose correct answers anybody on
the team can verify by eye:

```
en -> fr    fr -> en
en -> es    es -> en
```

The bar is deliberately low: is it translating **at all**. Latin script, no
runaway repetition, plausible length, recognisably the right language.

**If the sanity suite fails, stop.** Record `STATUS = TECHNICALLY REFUSED` and
do not run the target-language screen. A model that cannot do French will teach
nothing about Yoruba, and running it anyway produces a confident wrong verdict —
which is exactly what happened before this rule existed.

**If it passes, still change nothing to make results look better.** Not the
revision, not the prompt format, not the decoding parameters. Tuning until
something works is how a broken configuration gets promoted.

### 4. Only then, the screen

Same corpus, same checks, same conditions as every other candidate. One engine
at a time on a box that is otherwise idle, or the latency column is fiction.

## Why the sanity suite is the load-bearing part

Every check in step 3 could be replaced by a smarter one. None of them could be
replaced by *trusting the loader*, and that is the entire point.

The MADLAD failure passed every signal a careful engineer would think to check:
the file was complete, the keys all matched, the parameters were finite, the
logits were finite, the tokenizer round-tripped its input correctly. The only
thing that revealed it was **asking for an answer somebody could check**.

This is the same shape as two other failures in this project — a TTS mock that
wrote 44-byte WAVs while logging "Generated audio ready", and general vendors
returning fluent wrong Yoruba with HTTP 200. In all three the machinery reported
success. The remedy is always the same: **verify the artefact, not the status.**
