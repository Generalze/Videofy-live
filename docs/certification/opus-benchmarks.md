# OPUS-MT translation routes — measured evidence, twelve directions

**Lane E, C-AI certification wave. Measured 2026-08-30/31 on staging (c7-eu-01).**
**Nothing in this document approves anything for production.** It reports what was
run, what came back, and where the evidence stops. The registry (Lane F) decides
what production may invoke; this is the measurement half, kept deliberately
apart from the deciding half.

Harness: `scripts/certify/opus.mjs`
Raw reports on the box: `/tmp/videofy-certify/opus-benchmarks.json` (run 1) and
`/tmp/videofy-certify/opus-benchmarks-2.json` (run 2, one hour later — §7)

---

## 1. What was measured, and what a "success" had to survive

Twelve **directions**, each on its own. `en->yo` is not the reverse of `yo->en`
and is not reported as if it were: separate model, separate samples, separate
latency distribution, separate verdict. Nothing here averages a pair, and no
result is extended from one language to another.

Every sample had to clear four gates before it counted:

1. **The provider returned without an error.**
2. **The output was non-empty.** A non-empty string is where the check starts,
   not where it ends.
3. **The output was not the input.** Handed a target it cannot reach, a Marian
   model very often returns the source almost verbatim. Measured as token
   Jaccard against the source; anything at or above 0.6 is an echo and fails.
   Equality alone was not used — a copy that drops a comma is still a copy.
4. **The output was in the target language.** Identified by the
   marker-and-orthography classifier described in §3, which must rank the
   target strictly first with a non-zero score.

A fifth gate was added after the run, because the run produced the failure it
catches:

5. **The output was the length of a translation.** `opus-mt-en-ha`, handed the
   four words *"See you tomorrow morning."*, returned **72 words** — 350
   characters of unrelated devotional prose, in fluent Hausa, after **73.7
   seconds**. It passes gates 1–4 perfectly. Output more than 5x the input's
   word count (floor: 40 output words) is now classified `runaway-expansion`
   and does not count as a success. That sample measured 18x.

Outcomes are six-valued — `in-target-language`, `wrong-language`,
`undetermined`, `echo`, `runaway-expansion`, `empty`/`error` — because
"the judge could not read this" and "the model answered in Ewe" are different
facts, and collapsing them would let a weak judge manufacture failures the same
way an HTTP 200 manufactures successes.

### The runtime is the service's own

The harness imports `OpusMtTimestampedTranslationProvider` from the **deployed**
media-ingest build at `/srv/videofy/app/services/media-ingest/dist/...` and runs
it against `/opt/videofy-ai/bin/python`, with `OPUS_MT_MODEL_CACHE_DIR`,
`HF_HOME` and `HF_HUB_OFFLINE` taken from `/etc/videofy/media-ingest.env`.
Decoding flags, tokenizer prefix logic and model revisions are therefore exactly
what production would run. A private inference path would have measured itself.

Concurrency was 1 (`OPUS_MT_MAX_CONCURRENCY` default); request timeout 120 s.

### The sample set, and why it represents messaging

Eight short conversational turns per source language, the same eight meanings in
all seven languages: greeting, arrival time, thanks, whereabouts, money
received, call-me-back, reassurance, sign-off. Six to nine words, one clause,
present or perfect tense. That is what a chat line looks like. A latency taken
on a paragraph of prose is not the latency of a chat line, and a success rate
taken on curated literary sentences is not the success rate of *"Ina kake?"*.
The full sentences are in the harness (`SAMPLE_SETS`) and every one of the 96
outputs is stored verbatim in the JSON report.

The same eight meanings across languages let a direction be read next to its
opposite. That is a convenience for the reader and not a licence to merge them.

---

## 2. Results — twelve directions

Latency is **per short chat line, warm worker**, in milliseconds, over the
samples that passed. Cold start (interpreter spawn + model load) is reported
separately and excluded from the distribution, because production keeps the
worker warm.

**Read §7 before quoting any latency here.** The box carried a 1-minute load
average of 8.4–9.2 on 8 vCPU throughout, including a rogue process that has held
a full core for seven days. These are upper bounds under contention.

| Direction | Model (Helsinki-NLP/) | Revision | Token | n | in-target | min | median | mean | max | cold start |
|---|---|---|---|---|---|---|---|---|---|---|
| en->fr | opus-mt-en-fr | dd7f6540a7 | — | 8 | **8** | 3176 | 5647 | 5444 | 7025 | 9708 |
| fr->en | opus-mt-fr-en | c4aed37b31 | — | 8 | **8** | 4210 | 5621 | 5414 | 6476 | 8477 |
| en->es | opus-mt-en-es | 5bc4493d46 | — | 8 | **8** | 4256 | 5106 | 5083 | 5862 | 9305 |
| es->en | opus-mt-es-en | c96e2c5399 | — | 8 | **8** | 4225 | 5662 | 5505 | 7036 | 8399 |
| en->pt | opus-mt-en-ROMANCE | f8f3a28e8b | `>>pt<<` | 8 | **8** | 3695 | 4800 | 5085 | 7063 | 8482 |
| pt->en | opus-mt-ROMANCE-en | e9ca9975e3 | — | 8 | **8** | 4239 | 5640 | 5499 | 6478 | 8686 |
| en->ha | opus-mt-en-ha | 9736e603aa | — | 8 | **7** | 4240 | 5832 | 6218 | 9794 | 9776 |
| ha->en | opus-mt-ha-en | 71a171f838 | — | 8 | **8** | 4255 | 4820 | 5507 | 8128 | 9613 |
| en->ig | opus-mt-en-ig | 0657b968cb | — | 8 | **7** | 4774 | 6519 | 6554 | 9284 | 10792 |
| ig->en | opus-mt-ig-en | 88be2fe2e1 | — | 8 | **8** | 4280 | 5658 | 6530 | 10105 | 8920 |
| en->yo | opus-mt-en-**alv** | d4a06bd700 | `>>yor<<` | 8 | **8** | 4811 | 9103 | 9323 | 13413 | 13362 |
| yo->en | opus-mt-yo-en | f3d791bfa5 | — | 8 | **8** | 4254 | 6393 | 6777 | 10671 | 8609 |

Two non-perfect rows, and neither is a wrong-language failure:

- **en->ha 7/8** — one `runaway-expansion` (§1 gate 5). The other seven were
  Hausa, prompt, and unremarkable.
- **en->ig 7/8** — one `undetermined`: *"How are you doing today?"* returned
  *"Olee otú i si eme taa?"*. That is Igbo, but written without the sub-dot
  diacritics the orthography signal relies on, so it scored Igbo 1 (`taa`)
  against English 1 (the bare pronoun `i`) — a tie, and a tie abstains.
  **This is a limitation of the judge, not an observed failure of the model.**
  A reviewer reading the sentence would count it; the harness does not, on
  purpose.

**Zero `wrong-language` results and zero echoes across all 96 samples.** Every
model answered in the language it was asked for, and none returned its input.

Every revision above is the current `main` of that repository on the Hugging
Face hub. Three sources agree: the hub API's `sha` per model id, the local
snapshot directory names (which *are* the commit ids), and the harness's own
`modelLocation.revision` recorded during run 2. Only snapshots holding a
complete file set were accepted — a half-finished download leaves a directory
containing `model.safetensors` and no tokenizer, which looks present and fails
at first use. The
four routes already carried in `services/ai-registry/src/registry.ts` — en-fr,
fr-en, en-es, es-en — pin the same four revisions.

### Four of these twelve are measurable but the running service cannot invoke them

`DEFAULT_OPUS_MT_LANGUAGE_MODELS` — in the repository and in the build deployed
at `/srv/videofy/app` — configures **eight** pairs:

```
en:fr  fr:en  en:es  es:en  en:pt  en:ha  en:ig  en:yo
```

**`pt->en`, `ha->en`, `ig->en` and `yo->en` have no configured route.** The
weights are present under the configured cache root and this lane benchmarked
them by handing the provider its own `languageModels` list, but the deployed
`media-ingest` would reject those four pairs with `unsupported-language` (HTTP
400) at `findModel`, before any model is loaded.

So for those four rows, "the model works at this latency" is established and
"the service can serve this pair today" is **not**. The two are different claims
and only the first is evidence. Whoever owns
`DEFAULT_OPUS_MT_LANGUAGE_MODELS` has to add the four entries before the
measurement above describes anything a user could reach; the models it needs are
already downloaded.

---

## 3. The judge, and how good it is

Deciding whether output is "in the target language" needs a language identifier,
and an unmeasured judge produces unmeasured verdicts. The one used here is a
**marker-and-orthography heuristic**, deliberately simple so that any verdict can
be audited from the stored scores:

- **Function words.** Closed-class words per language. Words shared between
  siblings are *omitted* rather than shared, so a point is only scored on
  evidence that discriminates — es/pt `cinco`, `minutos`, `problema` are in
  neither list.
- **Orthography**, weighted 2.5. Each entry lists only marks a language does
  *not* share with its nearest confusable: Yoruba gets the dot under **e** and
  **s** but **not** under **o**, because Igbo writes that too; French gets
  `œ ù è` but not the circumflex, because Portuguese writes that too.

Calibration, reproducible with `node scripts/certify/opus.mjs --self-check`:

| Set | Correct | Abstained | **Wrong** | Total |
|---|---|---|---|---|
| In-sample (the 56 benchmark sentences) | 56 | 0 | **0** | 56 |
| Out-of-sample (14 sentences the marker lists were not written from) | 14 | 0 | **0** | 14 |

The in-sample row is a consistency check, not an accuracy estimate — those
sentences informed the lists. The out-of-sample row is the meaningful one. Its
important property is the third column: across both sets the identifier has
never assigned a *wrong* language. When it is unsure it abstains, and an
abstention is reported as `undetermined`, never as a pass.

**Two corrections were made to the judge during this work, both recorded here
rather than quietly applied.** It confused a Portuguese sentence for French on a
shared circumflex, and it could have confused Igbo for Yoruba on a shared
sub-dot. Both were fixed in the marker sets, and the twelve routes were then
**re-judged from the stored outputs** with `--reclassify` — no model was run
again, so the latencies are the originals and the sentences are fixed. Re-running
inference after adjusting a judge is how a benchmark gets repeated until it
passes; re-judging fixed outputs cannot do that.

---

## 4. The `>>yor<<` trap — checked directly, and not present

`opus-mt-en-yo` does not exist. English into Yoruba runs through
**`opus-mt-en-alv`**, the Atlantic-Volta *group* model, which selects its output
language from a `>>lang<<` control token. Handed the wrong token — or none — a
group model answers fluently in a sibling language at a perfectly good latency,
and every naive check passes.

Three things were established, not assumed:

1. **The token the runtime actually chooses is `>>yor<<`.** The worker probes its
   own tokenizer vocabulary rather than being told a token, so nothing in the
   repository states what any route ends up using. The probe reproduces
   `_target_prefix`'s candidate order exactly (`yo`, then `yor`, then `yo_br`)
   and reports the hit. `opus-mt-en-alv` carries **16** `>>lang<<` tokens.
2. **The token steers the model.** Same model, same sentence, different token:

   | Token | *"How are you doing today?"* |
   |---|---|
   | `>>yor<<` | Báwo lọ̀rọ̀ náà ṣe rí lára rẹ lónìí? |
   | `>>ewe<<` | Aleke wòle egbeae? |

   Different outputs, and the second is Ewe. Had they matched, the token would
   have been decorative and the Yoruba route a coincidence.
3. **All eight Yoruba outputs were identified as Yoruba**, none echoed the
   English input, none was a sibling language.

The same check ran on the other group model. `opus-mt-en-ROMANCE` selects
Portuguese with **`>>pt<<`** (47 control tokens present), and `>>ro<<` on the
same sentence returns Romanian *"Ce mai faci azi?"* — steering confirmed.

`pt->en` needs no token: `opus-mt-ROMANCE-en` is a multi-**source** model and
takes Portuguese input directly.

---

## 5. Where "in the target language" is not "correct"

**For yo, ha and ig, human quality review is REQUIRED and is not done.** The
strongest claim this document supports for those six directions is: *output was
produced, in the target language, at the measured latency.* Nothing here is a
quality claim, and the classifier cannot make one — it can tell Yoruba from
Igbo; it cannot tell good Yoruba from bad Yoruba.

What can be said honestly is about the **X->en** directions, because the source
meanings are known and the outputs are English. Reading them as a reviewer, not
as a metric:

**ig->en — 4 of 8 diverge materially from the source:**

| Source (meaning) | Output |
|---|---|
| Kedu ka ị mere taa? *(How are you today?)* | "And what about you today?" — the greeting is gone |
| Anọ m nʼụzọ, nye m nkeji ise. *(I'm on my way, give me five minutes)* | "I was on the way, for five minutes." — wrong tense, request lost |
| Daalụ nke ukwuu maka enyemaka gị. *(Thank you very much for your help)* | "Give too much attention to your help." — thanks became an instruction |
| Enwetala m ego ahụ, daalụ. *(I have received the money, thank you)* | **"I had found the money, and I lost it."** |

The last row is the one to look at. A money confirmation came back as a money
loss. Nothing in gates 1–5 can see that.

**ha->en — 3 of 8 diverge:** *"Na gode sosai da taimakonka."* (thank you very
much for your help) → "Thanks to your help."; *"Babu matsala ko kaɗan."* (no
problem at all — reassurance) → "There was no problem." (a past-tense report);
*"Sai gobe da safe."* (see you tomorrow morning) → "The next morning." — the
farewell is gone.

**yo->en — 4 of 8 diverge:** *"Mo wà ní ọ̀nà, fún mi ní ìṣẹ́jú márùn-ún."* →
"I am on your way, and for me I am five minutes."; *"Mo ti gba owó náà, ẹ ṣé."*
(I have received the money, thank you) → "I have taken the money, you.";
*"Jọ̀wọ́ pè mí padà tí o bá ní àyè."* (please call me back) → "Ask me back if
you have time."; *"A ó rí ara wa ní àárọ̀ ọ̀la."* (we'll meet tomorrow morning)
→ "We will see ourselves in the future."

**The Romance directions read accurately**, with two small time-word losses worth
noting because they are the kind of error a scheduling message cannot absorb:
*"On se voit demain matin."* → "I'll see you in the morning." (tomorrow dropped),
and *"Llego en cinco minutos."* → "I'll be here in five minutes." ("here", not
"there").

**Nothing above licenses a claim about en->ha, en->ig or en->yo.** English into
those languages was not reviewed by anyone who reads them. Evidence does not
cross a direction.

---

## 6. Malformed input and failure behaviour

Six probes per route, then a normal request to check the worker was still alive,
then an unsupported target. **All twelve routes: the persistent worker survived
every probe, and the unsupported target was rejected as `unsupported-language`
(HTTP 400) rather than translated into something arbitrary.**

| Probe | Behaviour | Assessment |
|---|---|---|
| Empty string | Returns `""` in 0 ms — short-circuited before the model | Correct |
| **Whitespace only** | **Invents text.** en->fr produced *"Le présent règlement entre en vigueur le jour suivant celui de sa publication au Journal officiel de l'Union européenne."*; ha->en *"The Bible"*; yo->en *"[ Picture on page 27]"*; en->ig *"(th copy)"*; ig->en *"_Undolance"* | **Defect** |
| **Emoji only** | **Invents text.** en->fr *"C'est pas vrai."*; en->pt *"- Não, não, não."*; ig->en *"ELIO"*; en->ha *"keyboard- key- name"*. en->es and es->en returned empty | **Defect** |
| **Digits only** (`08031234567`) | fr/pt/en pairs echo it intact. **en->es returns `080314567` — two digits deleted.** en->yo returns `08031 23367`. **en->ig invents a sentence about a person; ha->en returns "Caring for Our Kingdom Ministry"; ig->en returns `1,777,67`** | **Defect** |
| NUL + BEL embedded in "hello world" | Survives; most routes translate the words normally. en->ig returned *"ọkụ ala mmụọ"*, ha->en *"He Assctted"* | Tolerable |
| 5000 characters | **Romance routes (all six): `translation-timeout` at 120 s.** Nigerian routes did not time out but **silently translated only the first sentence** — en->ha returned one 29-character sentence from 5000 characters of input. en->yo produced 176 characters of degenerate repetition after **84.9 s** | **Defect** |

Four findings that belong on somebody's backlog, stated as findings and not as
fixes — Lane E does not own this code:

1. **Blank input hallucinates.** A message that is only whitespace or only emoji
   produces invented sentences. In a chat this is worse than an error: the user
   sees confident text nobody wrote. The pipeline already short-circuits the
   truly empty string; the same guard does not cover whitespace, or
   punctuation-and-emoji-only content.
2. **Numbers are not safe.** Phone numbers and amounts were deleted, reordered,
   reformatted or replaced with invented prose depending on the route. Anything
   carrying a figure through these models is carrying a corrupted figure.
3. **Long input is silently truncated, or blocks the worker for two minutes.**
   With `OPUS_MT_MAX_CONCURRENCY=1`, a single pasted document stalls every queued
   chat line behind it for the full 120 s timeout.
4. **A short line can occupy the worker for 74 seconds.** The en->ha runaway
   (§1) is a latency event as well as a quality one, and there is no output
   length or generation-time bound to stop it.

---

## 7. The latency numbers are upper bounds, and here is why

Throughout the run the box carried a **1-minute load average of 8.4 to 9.2 on
8 vCPU**. The harness records `loadAverageBefore` and `loadAverageAfter` on every
route, so this is visible in the data rather than inferred.

Part of that is other certification lanes working in parallel, which is expected.
Part of it is not: **PID 79452, `python3 -` running as root from `/home/claude`,
has held 99.9% of one core continuously since 25 August — seven days of CPU
time.** It is not a Videofy service and it is not this lane's to touch. Every
latency in this document was measured with one of eight cores already gone.

### The time is going into generation, not into overhead

The 94 passing samples say where it goes. Latency tracks the **length of the
output**, not the length of the input and not a per-request cost:

> latency ≈ **1.7 s + 0.79 s per output word** (least squares over 94 samples,
> outputs of 3–12 words, R² = 0.66)

The samples also fall into tight bands about 540 ms apart — every route, every
language — which is the signature of a fixed cost per decoding step rather than
of random CPU contention. Roughly two words generated per second.

That matters for what to do about it. A fixed overhead would be answered by
warming, batching or pooling; a per-token cost is answered by the decode itself
— thread configuration for torch on this box, beam width, or a smaller/quantised
model. **Which of those it is has not been established here**, and nothing in
this document should be read as recommending one; it is stated because it points
the next measurement somewhere specific instead of at "the box is busy".

**What this means for the numbers.** Medians of 4.8–9.1 s per short chat line are
far too slow for live translation, and they are contended measurements. The
honest statement is: *under this load, on this hardware, a warm OPUS-MT route
answers a chat line in roughly five to nine seconds.* Whether a quiet box answers
in one second or in four is **not established here** and needs a re-run once the
box is idle — the harness takes `--only` for exactly that.

### The measurement repeats, which is why the caveat is about the box and not the noise

The full twelve were run a **second** time, an hour later, same harness, same
box. Every median landed within **1.3%** of the first run, and the pass/fail
pattern was identical down to which sample failed:

| Direction | Run 1 median | Run 2 median | Δ |
|---|---|---|---|
| en->fr | 5647 | 5663 | +0.28% |
| fr->en | 5621 | 5605 | −0.28% |
| en->es | 5106 | 5105 | −0.02% |
| es->en | 5662 | 5622 | −0.71% |
| en->pt | 4800 | 4801 | +0.02% |
| pt->en | 5640 | 5625 | −0.27% |
| en->ha | 5832 | 5897 | +1.11% |
| ha->en | 4820 | 4811 | −0.19% |
| en->ig | 6519 | 6440 | −1.21% |
| ig->en | 5658 | 5658 | 0.00% |
| en->yo | 9103 | 9065 | −0.42% |
| yo->en | 6393 | 6404 | +0.17% |

Two things follow. First, **these numbers are not noise** — the measurement is
stable to about a percent, so the five-to-nine seconds is a real property of this
model, this decoding configuration and this hardware, not an artefact of a
momentarily busy minute. Second, **the en->ha runaway and the en->ig abstention
both reproduced exactly.** Beam search is deterministic; the 73.7-second
devotional paragraph is a defect that will happen again on the same input, not a
bad night.

What is still unmeasured is the *idle-box* number, because the box was never
idle: the load average was 8.7–9.3 during both runs.

---

## 8. Licence and provenance

All twelve models are **Helsinki-NLP OPUS-MT (Marian)**, and every one carries
**`apache-2.0`**, read from `cardData.license` on the Hugging Face hub for each
model individually. Three of the twelve also ship a `README.md` inside the local
snapshot and it agrees (`opus-mt-en-alv`, `opus-mt-en-ha`, `opus-mt-en-ig`).

The licence was checked **per model, not per family.** A blanket claim covering
"OPUS-MT" is the kind that turns out to have an exception in it.

| Field | Value |
|---|---|
| Licence | Apache-2.0 |
| Commercial use | Permitted by the licence |
| Evidence | `cardData.license` per model id from the hub API, 2026-08-31; local snapshot `README.md` for en-alv / en-ha / en-ig; snapshot directory names match the hub `sha` for all twelve |
| Attribution | Apache-2.0 requires the licence and notices to be carried — **not checked here**, and no distribution obligation has been reviewed |

Execution class for every route is **`local`**: the weights are on the box under
`/var/lib/videofy/models`, downloads are disabled
(`OPUS_MT_ALLOW_MODEL_DOWNLOAD=false`), and `HF_HUB_OFFLINE=1`. All twelve resolve
under the **configured** cache root, so the service can reach each of them.

---

## 9. What a registry record could say — proposed, not written

Lane F owns the route registry. What follows is the `technicalEvidence` this lane
can support, per direction, and nothing beyond it. Twelve records; en->X and
X->en are separate; no global OPUS switch is implied or requested.

For **all twelve**:

- `provider: "opus-mt"`, `executionClass: "local"`
- `licenceStatus: { licence: "Apache-2.0", commercialUse: "permitted", evidence: "hub cardData.license per model id, 2026-08-31; docs/certification/opus-benchmarks.md §8" }`
- `technicalEvidence.sampleCount: 8`, `recordedAt: "2026-08-30T22:48:15Z"`
- `technicalEvidence.notes`: measured through the deployed media-ingest provider
  on staging under a load average of ~9 on 8 vCPU; latencies are upper bounds;
  independently replicated one hour later with every median within 1.3% (§7)

Per direction — `successRate` counts only samples confirmed in the target
language, not merely non-empty:

| Direction | modelId | successRate | latency min/median/mean/max (ms) | humanReviewStatus |
|---|---|---|---|---|
| en->fr | Helsinki-NLP/opus-mt-en-fr | 1.0 | 3176 / 5647 / 5444 / 7025 | `not-required` |
| fr->en | Helsinki-NLP/opus-mt-fr-en | 1.0 | 4210 / 5621 / 5414 / 6476 | `not-required` |
| en->es | Helsinki-NLP/opus-mt-en-es | 1.0 | 4256 / 5106 / 5083 / 5862 | `not-required` |
| es->en | Helsinki-NLP/opus-mt-es-en | 1.0 | 4225 / 5662 / 5505 / 7036 | `not-required` |
| en->pt | Helsinki-NLP/opus-mt-en-ROMANCE | 1.0 | 3695 / 4800 / 5085 / 7063 | `not-required` |
| pt->en | Helsinki-NLP/opus-mt-ROMANCE-en | 1.0 | 4239 / 5640 / 5499 / 6478 | `not-required` |
| en->ha | Helsinki-NLP/opus-mt-en-ha | 0.875 | 4240 / 5832 / 6218 / 9794 | **`required-not-done`** |
| ha->en | Helsinki-NLP/opus-mt-ha-en | 1.0 | 4255 / 4820 / 5507 / 8128 | **`required-not-done`** |
| en->ig | Helsinki-NLP/opus-mt-en-ig | 0.875 | 4774 / 6519 / 6554 / 9284 | **`required-not-done`** |
| ig->en | Helsinki-NLP/opus-mt-ig-en | 1.0 | 4280 / 5658 / 6530 / 10105 | **`required-not-done`** |
| en->yo | Helsinki-NLP/opus-mt-en-alv (`>>yor<<`) | 1.0 | 4811 / 9103 / 9323 / 13413 | **`required-not-done`** |
| yo->en | Helsinki-NLP/opus-mt-yo-en | 1.0 | 4254 / 6393 / 6777 / 10671 | **`required-not-done`** |

`humanReviewStatus: not-required` on the six Romance directions is a statement
about *this* evidence being sufficient for a `messaging` scope decision, not a
quality certificate — see the two dropped time words in §5.

**`productionApproved` is not proposed for any of the twelve, in any scope.**
Three separate reasons, each sufficient on its own:

- The **latency** is 4.8–9.1 s per chat line under contention and has not been
  measured on a quiet box. Nothing about `programme-live` or `call-live` is
  supportable at that figure, and even `messaging` deserves the clean number
  first.
- The **malformed-input defects in §6** — hallucinated output for blank input,
  corrupted digits, silent truncation — are live in every route, and none of them
  is a registry problem to route around.
- **Human review of yo/ha/ig has not happened**, and §5 shows exactly why it
  cannot be skipped: a money confirmation came back as a money loss in a route
  that scored 8/8 on every automated gate.

And for `pt->en`, `ha->en`, `ig->en` and `yo->en` there is a fourth: the deployed
service has no configured route for them at all (§2). A registry record marking
those approved would describe a pair the runtime rejects before it reaches a
model.

---

## 10. What is NOT established

- **Quality, in any direction.** 96 outputs in the right language is not 96 good
  translations, and §5 shows several that are in the right language and wrong.
- **Anything about yo/ha/ig quality from a native reader.** Not one of these
  outputs has been read by a speaker of the language.
- **English into Yoruba, Hausa or Igbo.** §5's meaning review covers only the
  X->en half. `ha->en` reading well says nothing about `en->ha`.
- **Latency on an uncontended box.** §7.
- **Behaviour under real load.** Concurrency 1, one request at a time, no queueing
  pressure. The 429 `translation-delayed` path was not exercised.
- **Longer or noisier text.** Eight clean short sentences per direction.
  Transcribed speech arrives with disfluencies and no punctuation, and that was
  not measured.
- **Any other language.** `de`, `it`, `ja`, `zh` and `ar` are named as OPUS-MT
  targets in `services/ai-registry/src/self-hosted-engines.ts` but have no
  configured model route and were not benchmarked. `pcm` (Nigerian Pidgin) has no
  OPUS-MT model in either direction and is honestly untranslatable here.
- **Apache-2.0 attribution obligations.** The licence was read; the obligations it
  creates were not reviewed.

---

## 11. Reproducing this

```
# on the box, as root (reads the service env file for its own settings)
sudo node scripts/certify/opus.mjs --samples 8 --out /tmp/videofy-certify/opus-benchmarks.json

# one direction only
sudo node scripts/certify/opus.mjs --only en-yo

# calibrate the language identifier (exits non-zero if it ever mislabels)
node scripts/certify/opus.mjs --self-check

# re-judge stored outputs without running a model again
node scripts/certify/opus.mjs --reclassify report.json --out report-rejudged.json
```

The harness reads `/etc/videofy/media-ingest.env` for the runtime's own settings
and reports environment facts **by name and presence only**. No credential value
is read, printed, stored or returned; these routes need none, since the weights
are local files.
