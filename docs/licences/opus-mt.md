# OPUS-MT: the licence, and what it obliges Videofy Live to do

**Status: prepared for the founder's signature. NOT yet a signed position.**
Everything below was verified on 2026-09-25 and is recorded so that approving a
translation route cites something a person can check, rather than a field
somebody set. What it deliberately is *not* is legal advice.

## Why this document exists

Every route in `translation-routes.seed.json` carries
`licenceStatus.commercialUse: "unknown"`, and that single field blocks approval
on its own — before quality, before human review. It says "unknown" not because
anybody suspected a problem but because **nobody had read the obligations**. The
evidence string on each record says exactly that.

Two of our own documents disagreed about what the licence even was, which is
the other reason this is written down.

| our record | claimed licence |
|---|---|
| `packages/translation-routes/routes/translation-routes.seed.json` | Apache-2.0 |
| `docs/certification/translation-engine-landscape.md` (table, line 16) | CC-BY-4.0 |

## What the licence actually is

**Apache-2.0, for the model weights we run.** Verified three ways on
2026-09-25:

1. **From the artefact we hold.** `opus-mt-en-alv` is the only one of our four
   models whose card was downloaded with it, at
   `/var/lib/videofy/models/models--Helsinki-NLP--opus-mt-en-alv/snapshots/d4a06bd.../README.md`.
   Its front matter reads `license: apache-2.0`.
2. **From source, for the two the French pair needs.** The model pages for
   `Helsinki-NLP/opus-mt-en-fr` and `Helsinki-NLP/opus-mt-fr-en` both state
   `License: apache-2.0`. Neither page requests a specific citation format.
3. **The other three snapshots on the box carry no card at all** — only
   weights, tokenizer and config. So for `opus-mt-en-fr`, `opus-mt-fr-en` and
   `opus-mt-yo-en` the licence is established from the upstream page, not from
   anything on our disk. If that matters to you, the fix is to re-fetch the
   cards alongside the weights and keep them.

**The landscape document's `CC-BY-4.0` is wrong for the weights** and should be
corrected. The likeliest origin is the OPUS *corpora* the models were trained
on, which carry their own mixed terms. Training-data terms are a different
question from the terms on the released weights, and conflating them is what
produced two contradictory rows in our own records.

## What Apache-2.0 obliges us to do, and whether it is triggered

Apache-2.0 attaches its conditions to **redistribution**. Section 4 requires,
when you *"Redistribute the Work or Derivative Works thereof"*: give recipients
a copy of the licence; mark modified files; retain copyright, patent, trademark
and attribution notices; and reproduce any NOTICE file.

**Videofy Live does not redistribute the model.** The weights live on the
server at `/var/lib/videofy/models`, inference runs server-side in
media-ingest, and what reaches a user is the *output* — translated text and
synthesised audio. The APK contains no model: `apps/mobile` does not reference
OPUS-MT at all. Apache-2.0 places **no restriction on the output** of running
the licensed work, and no condition in section 4 is triggered by running it as
a service.

There is also an express grant of patent rights (section 3) and the usual
disclaimer of warranty (sections 7 and 8) — we carry the risk of the output
being wrong, which is precisely why the human-review gate exists separately.

**Conclusion offered for signature: commercial use is PERMITTED, and no
redistribution obligation is currently triggered.**

## What would change that

- **Shipping the weights** — bundling a model into the APK, into a container we
  hand to somebody, or into an on-device build. Then section 4 applies in full
  and we must carry the licence text and notices.
- **A different engine.** This covers OPUS-MT only. NLLB-200 is CC-BY-NC-4.0
  and cannot be used commercially at all; any derivative inherits that.
  M2M100 is MIT, MADLAD-400 is Apache-2.0. Each needs its own reading.
- **The corpora, if we ever redistribute them** or a derivative of them. We do
  not.

## What this document does NOT establish

- It is a reading of the licence text by an engineer, not advice from a
  lawyer. If the commercial stakes warrant a professional opinion, get one.
- It says nothing about **quality**. A permitted licence and a usable
  translation are unrelated, and the human-review gate is the one that answers
  the second. Hausa is the standing example: Apache-2.0 and unusable.
- It covers the four models named above. `opus-mt-en-ROMANCE`,
  `opus-mt-ROMANCE-en`, `opus-mt-en-es`, `opus-mt-es-en`, `opus-mt-en-ha`,
  `opus-mt-ha-en`, `opus-mt-en-ig` and `opus-mt-ig-en` are very likely the same
  and have not been checked.

## Recommended follow-ups

1. Correct line 16 of `docs/certification/translation-engine-landscape.md`.
2. Re-fetch and keep model cards next to the weights, so the licence travels
   with the artefact instead of living on a web page.
3. Read the remaining eight model cards and extend the table above.
