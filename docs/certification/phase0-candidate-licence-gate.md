# Phase 0 — candidate and licence gate

CTO directive, 31 Aug 2026. Verified against the original publisher's model
card and, where a claim was checkable by running something, by running it.
**No commercial permission is inferred from an aggregator tag alone.**

Baseline for comparison remains current OPUS-MT. NLLB-200 stays a quality
reference only and is not a commercial candidate.

## Summary

| candidate | licence | commercial | staged | status |
|---|---|---|---|---|
| **M2M100 1.2B** | MIT | **yes** | yes | **CLEARED — screening** |
| **MADLAD-400 3B** | Apache-2.0 | **yes** | yes | **BLOCKED (technical)** |
| **TranslateGemma 4B** | Gemma terms | needs review | **no** | **BLOCKED (gated)** |

---

## A. M2M100 1.2B — CLEARED

| field | value |
|---|---|
| repository | `facebook/m2m100_1.2B` |
| revision | `7b36184180524c1a1bbfa37f120a608046250b98` |
| licence | **MIT** (stated on the publisher's model card) |
| commercial / hosted service | **permitted** — MIT places no field-of-use restriction |
| attribution | MIT notice retention; the card also requests citation of Fan et al. 2020 (arXiv:2010.11125) — a request, not a licence condition |
| source languages | 100, many-to-many (any supported language to any other) |
| target languages | same 100 |
| Hausa `ha` | **yes** |
| Igbo `ig` | **yes** |
| Yoruba `yo` | **yes** |
| Nigerian Pidgin `pcm` | **NO** — not in the supported list |
| parameters | 1.2 B |
| disk | 4.7 GB |
| expected RAM | ~5–6 GB resident at fp32 |
| CPU compatible | yes |
| quantisation | int8 / 4-bit available via bitsandbytes or ONNX |
| quantisation and licence | MIT imposes no additional obligation on a quantised derivative |

Being genuinely many-to-many, this is the only cleared candidate that can serve
`X→en` from one set of weights. Pidgin is absent and **must not be faked**.

---

## B. MADLAD-400 3B — BLOCKED, TECHNICAL

| field | value |
|---|---|
| repository | `google/madlad400-3b-mt` |
| revision | `fa184c675da0b5c9e1c8694fccd4e12e2d422094` |
| licence | **Apache-2.0** |
| commercial / hosted service | **permitted** |
| attribution | Apache-2.0 NOTICE retention |
| languages | 419 trained, 204 evaluated; `<2yo>`, `<2ha>`, `<2ig>` are all single vocabulary tokens (verified), `<2pcm>` is **not** — it tokenises to five pieces, so Pidgin is not an addressable target |
| parameters | 3 B |
| disk | 11 GB |
| CPU compatible | in principle |

**The licence passes. The model does not currently run here.**

Staged complete and loads with **0 missing, 0 unexpected, 0 mismatched keys,
no non-finite parameters, finite logits** — and then generates uniform nonsense
for *every* language, including French and Spanish:

```
<2fr> Good morning everyone.  ->  ةتيدة تةتيدة تةتيدة تةتيدة …
<2es> Good morning everyone.  ->  ةتيدة تةتيدة تةتيدة تةتيدة …
```

Because French and Spanish fail identically to Yoruba, **this is the
environment, not the model**, and no quality statement about MADLAD is
admissible from this box. Two hypotheses were tested and rejected: the language
tag is correctly in the vocabulary, and the `lm_head` is genuinely tied in the
checkpoint (restoring it from the file changed nothing).

Remaining hypothesis: a 2023 T5X export against **transformers 5.15.1 /
torch 2.13**. Marian (OPUS-MT) and NLLB produce sensible output on the same
interpreter, so the fault is T5-specific.

**Remedy: an isolated benchmark virtualenv with an older pinned transformers.**
The production AI venv must not be downgraded — media-ingest's translation and
TTS workers run on it.

### Retraction

Every MADLAD-400 figure and sample in the earlier three-way run is **withdrawn**.
It was produced by this broken path. The published FLORES-200 en→yo BLEU of 2.4
still stands as third-party evidence and is unaffected, but it is not our
measurement.

---

## C. TranslateGemma 4B — BLOCKED, GATED

| field | value |
|---|---|
| repository | `google/translategemma-4b-it` |
| revision | `10042cb0e6e7fdce748996a71dc3dc432a4e0c89` (from the 401 response) |
| licence | **Gemma Terms of Use** — not Apache, not MIT |
| commercial / hosted service | **contemplated but conditional**; requires reading the Gemma terms and prohibited-use policy against C7's actual use, and accepting them |
| staged | **no — cannot be** |

Confirmed by attempting it, not assumed:

```
GatedRepoError: 401 — Access to model google/translategemma-4b-it is
restricted. You must have access to it and be authenticated.
```

**Language coverage is unresolved and cannot be resolved from outside the
gate.** The definitive list lives in the repository's `chat_template.jinja`,
which returns 401. From secondary sources: Yoruba and Hausa are reported among
the 55 benchmarked languages, and Nigerian Pidgin is reported in the technical
report's tables 5–6. **Igbo is unconfirmed** — and Videofy needs all three.

One further caveat found in the publisher's own discussion thread: the 55
languages are the *rigorously benchmarked* set, and additional languages exist
in the weights but are **experimental with higher hallucination rates**. Which
tier each Nigerian language sits in matters more than whether it appears at all,
because "present but experimental" is precisely the confident-wrong failure this
whole wave exists to avoid.

### What unblocks it — founder actions

1. Accept the Gemma terms on Hugging Face for `google/translategemma-4b-it`
   under an account C7 controls.
2. Provide a read token so the model and its `chat_template.jinja` can be
   staged. **Send it via `deploy/Set-EnvKey.ps1`, never in chat.**
3. Record the Gemma obligations in the C7 licence register before any
   production use, per directive.

Until then TranslateGemma's status is **LICENCE/ACCESS BLOCKED — NOT STAGED**,
and it is neither passed nor failed on quality.

---

## Excluded by directive

- **NLLB-200 / AfriNLLB** — CC-BY-NC-4.0. Quality reference only; derivatives
  inherit the restriction.
- **Toucan / Cheetah** — gated materials require agreeing to non-commercial use.
  Technically the closest fit to C7's exact language set, Pidgin included, and
  therefore the one worth *asking* UBC-NLP about a commercial licence for. Not a
  candidate until such permission exists in writing.
