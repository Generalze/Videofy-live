# Translation and transcription engines for Yoruba, Hausa, Igbo

Researched 2026-08-31. Companion to
[translation-quality-nigerian.md](translation-quality-nigerian.md), which holds
the measurements taken on our own sentences.

**LICENCE IS THE FIRST FILTER, NOT A FOOTNOTE.** The best-scoring open model
for these languages cannot be shipped by a commercial product, and a shortlist
that ranks it first produces a plan that fails at launch rather than at
evaluation. Every row below carries its licence before its score.

## Translation — the shortlist

| engine | licence | commercial? | ha | yo | ig | pcm |
|---|---|---|---|---|---|---|
| **OPUS-MT** (current) | CC-BY-4.0 | yes | **unusable** | middling | middling | none |
| **NLLB-200** | CC-BY-NC-4.0 | **NO** | best measured | good | good | yes |
| **MADLAD-400** | Apache-2.0 | yes | fair | **very poor** | untested | yes |
| **AfriNLLB** | NLLB-derived | **NO** | — | — | — | — |
| **Azure Translator** | commercial API | yes | yes | yes | yes | no |
| **Google Cloud Translation** | commercial API | yes | yes | yes | yes | yes |
| **Lelapa / Vulavula** | commercial API | yes | **no** | **no** | **no** | no |
| **9jaLingo** | commercial API | yes | — | — | — | — |

### What each row means

**OPUS-MT** — what we ship today. Hausa is categorically unusable: the
checkpoint is trained predominantly on religious text and returns Qur'anic
narrative for ordinary business sentences, fluently, with HTTP 200. Yoruba and
Igbo are usable with restrictions. Measured evidence in the companion document.

**NLLB-200** — the best open model for these languages and **CC-BY-NC-4.0**, so
a commercial product may not ship it. Published FLORES-200 en→X BLEU: Hausa
29.7, Yoruba 13.2. Our own round-trip found it fixing every OPUS-MT failure.
Staged on the box as a BENCHMARK ONLY. **Any NLLB derivative inherits the
licence** — that includes AfriNLLB, which is otherwise attractive (15 pairs, 10
African languages) and must be treated as equally blocked.

**MADLAD-400** — Google, Apache-2.0, 419 languages, and therefore the obvious
commercial candidate. Published FLORES-200 en→X BLEU tells against it for our
most important language: **Yoruba 2.4** against NLLB's 13.2, and Hausa 20.3
against 29.7 — and that is the 7.2B model; we staged the 3B. A BLEU of 2.4 is
not "weaker", it is not translating. Our own measurement is in the companion
document.

**Azure Translator** — supports all three. Azure is already a credentialed
vendor here for speech, but **Translator is a separate resource with its own
key**, which this deployment does not have. Untested for that reason; it is the
cheapest thing to test next and the most likely commercial answer.

**Google Cloud Translation** — supports all three plus Nigerian Pidgin, which
nothing else on this list does. Previously set aside on pricing grounds; that
decision predates knowing Hausa is broken and may be worth revisiting.

**Lelapa AI (Vulavula)** — African-language NLP-as-a-service, and a natural
first guess. It covers Southern African languages only: Zulu, Xhosa, Afrikaans,
Sotho, Swati, Tsonga, Tswana, Swahili. **No Nigerian languages.** Ruled out.

**9jaLingo** — our TTS vendor. `POST /v1/translate` returns 404: **they have no
translation product.** They solve the speech layer, not the text layer.

## Transcription

The finding that matters: **no major commercial ASR supports these languages.**
Google Cloud Speech-to-Text, AWS Transcribe and Azure Speech all cover none of
Hausa, Yoruba or Igbo as of 2026.

| engine | licence | ha/yo/ig | quality |
|---|---|---|---|
| **Deepgram** (current) | commercial | no | certified for **English**, which is what we transcribe |
| Google STT / AWS Transcribe / Azure Speech | commercial | **none** | n/a |
| Whisper (base) | MIT | yes, nominally | 40–55% WER — not production |
| Whisper fine-tuned | MIT | yes | 18–24% WER reported |
| MMS | CC-BY-NC | yes | **non-commercial** |
| **9jaLingo STT** | commercial | yes | **we already hold a key** |
| Orinode / Maraba | commercial | yes | API pilot opened Q3 2026 |

**This is less urgent than it looks.** Videofy transcribes the SOURCE, and our
programmes and calls are English-sourced — served by Deepgram, already
certified. Nigerian-language ASR is only needed for the reverse direction, a
Yoruba speaker being understood, which no current surface requires.

**9jaLingo STT exists and we can reach it.** Probed 31 Aug:
`POST /v1/audio/transcriptions` returns 422 (not 404), and the validation error
names the contract — **`file_url` is a required field**. It fetches audio from a
URL rather than accepting bytes or multipart, so integrating it means exposing
each clip at a URL the vendor can reach. That is a real design constraint for a
product whose audio is private by default, and it should be settled before
anyone plans around this endpoint.

## Recommendation

1. **Stop presenting Hausa translation.** Not a tuning problem, and no amount
   of prompt or voice work fixes a model answering from the wrong corpus.
2. **Provision an Azure Translator resource and measure it** with the harness
   already in the repo. It is the lowest-effort commercial candidate, covers
   all three, and sits with a vendor we already hold an account with.
3. **Do not adopt MADLAD-400 for Yoruba** on the published numbers, whatever
   its licence advantage. Confirm against our own measurement first.
4. **Treat NLLB and every derivative as unshippable** until somebody with
   authority to accept licence risk says otherwise in writing.
5. Nigerian-language ASR is not on the critical path. Revisit when a
   Nigerian-language SOURCE is a product requirement.

Nothing here is certified. `humanLanguageReview` remains `required-not-done`
for all three languages, and a score never replaces a speaker.
