# Provider certification matrix

Reconciled 2026-08-31 from the seven evidence lanes of the provider-certification wave.

**How to read the Status column.** There are five values and they are not degrees of the
same thing:

| Status | Means |
|---|---|
| **CERTIFIED (technical)** | Measured, multi-sample, through the deployed adapter. The provider answered, in the shape expected, at the recorded latency. It does **not** mean the output is correct. |
| **UNMEASURED** | The route may work. Nobody ran it. An empty cell is not a passing cell. |
| **DEGRADED** | Produces audio or text, and the output is known to be wrong or known to be served by something that cannot do the job. |
| **REFUSED** | Decided against, on evidence. Not "not yet" — a later green harness may not move it. |
| **BLOCKED** | Cannot run at all: the vendor refuses it, or the deployment cannot reach it. |

**Nothing in this matrix is `productionApproved` for any service scope.** Technical
certification and production approval are different facts, kept in different fields, on
purpose. No human has read or listened to a single output of any route in this wave.

---

## Deepgram — streaming speech recognition

Measured from c7-eu-01 against staging credentials, driving the **deployed** adapter
through the same `buildStreamingTranscriptionProvider` selector production boots with, at
real-time 20 ms frame pacing. Speech source is Azure TTS, **not a human speaker**: clean,
evenly paced, no crosstalk, no disfluency, no packet loss. Every accuracy figure is an
upper bound and every latency a best case.

| Provider | Model | Capability | Direction / Language | Service | Evidence | Status |
|---|---|---|---|---|---|---|
| Deepgram | nova-3 | streaming STT | en (en-US) | call-live, programme-live | n=12, WER 0.0111, meaningful 12/12; final median 284 ms from last voiced sample; first partial median 617 ms | **CERTIFIED (technical)** |
| Deepgram | nova-3 | streaming STT | en (en-NG accent) | call-live, programme-live | n=12, WER 0.0175, meaningful 12/12; final median 319 ms. **Recorded separately from en-US on purpose** — the WER differs and this platform's speakers are largely Nigerian | **CERTIFIED (technical)** |
| Deepgram | nova-3 | streaming STT | es | call-live, programme-live | n=8, WER 0.0000, meaningful 8/8; final median 343 ms | **CERTIFIED (technical)** |
| Deepgram | nova-3 | streaming STT | fr, de, pt, it, ja, zh, ar, multi | — | Connect succeeds. **Zero accuracy samples.** Acceptance is not accuracy | **UNMEASURED** |
| Deepgram | nova-3 | streaming STT | **yo, ha, ig, pcm** | — | **HTTP 400 at connect.** `LiveStreamPipeline.open` awaits `openStream`, so a live session in any of the four cannot start at all — this is not a bad caption, it is no session | **BLOCKED (vendor refuses)** |
| Deepgram | flux-general-en | streaming STT | en | — | n=6, WER 0.0000; first partial ~225 ms sooner than nova-3, but **final median 913 ms vs 284 ms** — roughly 3x slower to commit, and nothing can be spoken until a final exists | **CERTIFIED (technical), not selected** |
| Deepgram | flux-general-en | streaming STT | any non-English | — | Single-language model with no per-session language parameter. Before this wave it **opened a session declaring `yo` and returned fluent English**, and `zz-not-a-language` opened too. Now refused at `openStream` before any audio | **REFUSED (fixed this wave)** |
| Deepgram | nova-3 / flux | batch STT | all | uploaded programmes | Not exercised. Batch transcription is recommended `off` in production | **UNMEASURED** |

**Failure behaviour, both models.** An invalid credential fails closed (401 at connect,
~285 ms, no audio accepted). Four seconds of digital silence and four seconds of
broadband noise at speech level produced **no invented words** on either model.

**Shape difference worth propagating downstream:** on silence, Nova returns an *empty
final* where Flux returns *no final*. Code must not read "a final arrived" as "words
arrived".

**Nigerian-language audio could not be measured at all.** The staging Azure region
publishes 655 voices across 154 locales and none is yo/ig/ha/pcm. That cell is
unmeasured, not fine.

---

## ElevenLabs — streaming speech synthesis

Every byte decoded rather than a status code trusted. The key answers 401 to `/v1/models`
and `/v1/voices`, so model and voice identity were established by **driven negative
control** (nonsense `model_id` → 400 `model_not_found`; nonsense `voice_id` → 404
`voice_not_found`) rather than claimed from the vendor catalogue.

| Provider | Model | Capability | Direction / Language | Service | Evidence | Status |
|---|---|---|---|---|---|---|
| ElevenLabs | eleven_flash_v2_5 | streaming TTS | en | call-live, programme-live | 5/5 audible, 16 kHz mono; TTFB median 133 ms, total median 224 ms, 3.2–3.6 s audio, peak 0.885–0.917 | **CERTIFIED (technical)** |
| ElevenLabs | eleven_flash_v2_5 | streaming TTS | es | call-live, programme-live | 5/5 audible; TTFB median 126 ms, total median 219 ms | **CERTIFIED (technical)** |
| ElevenLabs | eleven_flash_v2_5 | streaming TTS | fr | call-live, programme-live | 5/5 audible; TTFB median 126 ms, total median 215 ms | **CERTIFIED (technical)** |
| ElevenLabs | eleven_flash_v2_5 | streaming TTS | every other language | — | Not driven | **UNMEASURED** |
| ElevenLabs | eleven_flash_v2_5 | streaming TTS | **ha, ig, yo, pcm** | — | **Deliberately not driven.** The 30 Aug ruling puts 9jaLingo then Azure behind those four and excludes ElevenLabs; measuring it would describe a route that does not exist | **REFUSED (by routing ruling)** |
| ElevenLabs | eleven_flash_v2_5 | complete (non-streaming) TTS | — | uploaded programmes, lip-fit, personal voice | `ElevenLabsTextToSpeechProvider` hardcodes `output_format=pcm_16000` on the non-streaming endpoint, so it writes **headerless PCM whatever extension the caller gives it**; `ffprobe` returns "Invalid data found". Read as raw 16 kHz the audio is fine — but nothing will open the file | **DEGRADED (latent — wired nowhere today)** |

**Voice selection is not configured.** `ELEVENLABS_VOICE_IDS` is absent, so every Videofy
voice id collapses to the single voice `neMPCpWtBwWZhxEC8qpe`. Any claim of per-language
or per-gender voice selection on this leg is contradicted.

---

## Azure Speech — streaming synthesis, and the Nigerian fallback

| Provider | Model / Voice | Capability | Direction / Language | Service | Evidence | Status |
|---|---|---|---|---|---|---|
| Azure | en-US-AvaMultilingualNeural (northeurope) | streaming TTS | en, en-US | call-live, programme-live | 5/5 audible; TTFB median 44 / 37 ms, total median 137 / 140 ms. ~3x faster to first audio than ElevenLabs — and it is the **second** vendor in the chain, so that speed is never used in normal operation | **CERTIFIED (technical)** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | es, es-ES | call-live, programme-live | 5/5 audible; TTFB median 42 / 41 ms | **CERTIFIED (technical)** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | fr, fr-FR | call-live, programme-live | 5/5 audible; TTFB median 58 / 40 ms | **CERTIFIED (technical)** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | **ha (ha-NG)** | Nigerian fallback | 4.575 s audio, 11.6 chars/s. **northeurope hosts no ha-NG voice** | **DEGRADED** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | **ig (ig-NG)** | Nigerian fallback | 5.313 s audio, 9.4 chars/s. **northeurope hosts no ig-NG voice** | **DEGRADED** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | **yo (yo-NG)** | Nigerian fallback | 4.713 s audio, 12.1 chars/s. **northeurope hosts no yo-NG voice** | **DEGRADED** |
| Azure | en-US-AvaMultilingualNeural | streaming TTS | **pcm (en-NG)** | Nigerian fallback | 4.350 s audio, 14.3 chars/s, spoken by an **American** English voice | **DEGRADED** |
| Azure | en-NG-EzinneNeural, en-NG-AbeoNeural | streaming TTS | en-NG | — | These voices **are** hosted in northeurope and are **not configured**. `AZURE_VOICE_IDS` is absent | **UNMEASURED / unconfigured** |

**The three measured facts behind the founder's 2026-08-26 ear judgement**, so the
DEGRADED status rests on mechanism and not only on taste:

1. northeurope hosts **655 voices across 154 locales and zero** of yo-NG, ig-NG, ha-NG.
   The only Nigerian locale present is en-NG.
2. Azure returned **HTTP 200 for `xml:lang="yo-NG"` with an en-US voice** — no error,
   warning, header or field indicates the voice cannot speak the requested language. The
   platform's own `degraded-fallback` marking is the only signal that exists anywhere.
3. chars/s falls with distance from English (14.3 pcm → 12.1 yo → 11.6 ha → 9.4 ig,
   against 15.8–16.1 for the same voice reading English) — an English voice labouring
   through unfamiliar orthography. A plausibility signal that decides nothing on its own.

**End of chain, driven:** specialist refuses and fallback is null → 0 samples, caller
told once, no second wrong voice substituted. Silence is reported, never served.

**Cost of a fall-through:** 527 ms chain total vs 195 ms healthy — about 330 ms of extra
listener wait. Note that the chain's own `timeToFirstChunkMs` is measured from the
*serving* provider's start, so during a fall-through it reported 62 ms while the listener
actually waited 527 ms. The metric answers a narrower question than its name suggests.

---

## 9jaLingo — Nigerian-language synthesis specialist

All four languages tested independently. **No rolled-up total exists anywhere**, because
a combined figure would let Hausa carry Igbo.

| Provider | Model / Speaker | Capability | Language | Service | Evidence | Status |
|---|---|---|---|---|---|---|
| 9jaLingo | 9jalingo-tts-1 / bilkisu_ha | TTS | **ha** | Nigerian specialist | 10/10 success, 0 silent, 22050 Hz mono 16-bit verified by two decoders; latency median 4802 / max 5744 ms. Clipping on 2/10 clips | **CERTIFIED (technical)** · human review **required-not-done** |
| 9jaLingo | 9jalingo-tts-1 / ogechi_ig | TTS | **ig** | Nigerian specialist | 10/10, 0 silent; median 6062 / max 13824 ms. **Same text re-rendered at 1.96x duration** | **CERTIFIED (technical)** · human review **required-not-done** |
| 9jaLingo | 9jalingo-tts-1 / olufunke_yo | TTS | **yo** | Nigerian specialist | 10/10, 0 silent; median 6697 / max 12085 ms. **1.78x re-render variance**; 5/10 clipped on the preceding run. Least stable of the four | **CERTIFIED (technical)** · human review **required-not-done** |
| 9jaLingo | 9jalingo-tts-1 / ada_pcm | TTS | **pcm** | Nigerian specialist | 10/10, 0 silent; median 5411 / max 5703 ms. Tightest durations, lowest level, and **the only language whose voice was not chosen by ear** | **CERTIFIED (technical)** · human review **required-not-done** |
| 9jaLingo | — | **translation** | any | — | Recorded `UNVERIFIED_TRANSLATION` in `commercial-providers.ts`. It speaks these languages; it is not a translator here | **BLOCKED (no capability)** |

**Six findings that are real and are deliberately not folded into the certification**,
because the audio does play and redefining the term after the numbers were in would be
dishonest:

1. **Cold start ~11–12 minutes**, not the vendor's stated five: 36 consecutive 503s over
   606 s of continuous polling. Once warm, first request in 3.1–6.2 s.
2. **`/v1/health` is not a readiness signal** — it reported `engine_ready:false` while
   synthesis was answering 200 in ~5 s. Anything gating on that field is wrong.
3. **Output duration is not a function of input text**: 1.96x in Igbo, 1.78x in Yoruba
   for identical input, with voiced-energy time doubling too — so it is extra generated
   speech, not padding. Invisible to every server signal.
4. One **93.6 s** synthesis observed on an earlier run, not reproduced across 20 later
   Yoruba samples. Whether it is contention on the shared single copy or a Yoruba
   property is **not resolved** and is asserted neither way.
5. **Clipping**: Hausa 2/10 this run, Yoruba 5/10 on the preceding one.
6. **~15 dB level spread between languages** (Hausa −15 to −12 dBFS RMS vs Pidgin −30 to
   −20). Findings 5 and 6 want one shared loudness-normalisation stage after synthesis.

**Two contract corrections this run produced.** `/v1/speakers` and `/v1/health` are
**unauthenticated** — no header, or a deliberately invalid key, both return 200 with the
full catalogue — so any auth probe must target `POST /v1/audio/speech` or it verifies
nothing. And the founder's chosen voices are `database_id` values, not `id` values; all
six resolve, and all six resolve to the **correct language and gender**. Keep that check
permanently: a UUID belonging to the wrong language would be accepted with a 200 and
would sound exactly like the defect the specialist was bought to avoid.

---

## OPUS-MT — all twelve directions

Eight short conversational turns per direction, driven through the deployed provider,
concurrency 1. **Run twice, one hour apart: every median within 1.3% and the identical
pass/fail pattern, including which sample failed.** Latency is an upper bound — both runs
sat at load 8.4–9.3 on 8 vCPU with an unrelated root process holding 99.9% of one core
since 25 August.

Success means five gates, not a non-empty string: no error, non-empty, **not an echo**,
identified as the **target language** by a judge calibrated 56/56 in-sample and 14/14
out-of-sample with zero wrong labels, and an output length consistent with a translation.

| Provider | Model | Capability | Direction | Service | Evidence | Status |
|---|---|---|---|---|---|---|
| OPUS-MT | opus-mt-en-fr | MT | **en→fr** | messaging | 8/8; median 5647 ms | **CERTIFIED (technical)** |
| OPUS-MT | opus-mt-fr-en | MT | **fr→en** | messaging | 8/8; median 5621 ms. Meaning loss: *"On se voit demain matin."* → *"I'll see you in the morning."* — **"tomorrow" is gone** | **CERTIFIED (technical)** |
| OPUS-MT | opus-mt-en-es | MT | **en→es** | messaging | 8/8; median 5106 ms | **CERTIFIED (technical)** |
| OPUS-MT | opus-mt-es-en | MT | **es→en** | messaging | 8/8; median 5662 ms. Meaning loss: *"Llego en cinco minutos."* → *"I'll be here in five minutes."* | **CERTIFIED (technical)** |
| OPUS-MT | opus-mt-en-ROMANCE | MT | **en→pt** | messaging | 8/8; median 4800 ms. Group model; `>>pt<<` proved to **steer** (`>>ro<<` returns Romanian) rather than coincide | **CERTIFIED (technical)** |
| OPUS-MT | opus-mt-ROMANCE-en | MT | **pt→en** | messaging | 8/8; median 5640 ms. Many-to-one, zero `>>lang<<` tokens — genuinely Portuguese-capable, not a substitute. **Service cannot invoke it** | **CERTIFIED (technical) · BLOCKED (unreachable)** |
| OPUS-MT | opus-mt-en-ha | MT | **en→ha** | messaging | 7/8. The failure is a **runaway**: 4 words in, 72 words of unrelated devotional prose out, in fluent Hausa, after **73.7 s** — 18x expansion passing every automated gate, reproduced identically on run 2 | **DEGRADED** · call-live **REFUSED** |
| OPUS-MT | opus-mt-ha-en | MT | **ha→en** | messaging | 8/8 automated; median 4820 ms. **3 of 8 materially wrong in meaning**: *"Sai gobe da safe."* (see you tomorrow morning) → *"The next morning."* Service cannot invoke it | **DEGRADED · BLOCKED (unreachable)** · call-live **REFUSED** |
| OPUS-MT | opus-mt-en-ig | MT | **en→ig** | messaging | 7/8 — the eighth is the **judge abstaining** on undiacritised Igbo, not an observed model failure. A human reader would likely score 8/8, and no human reader of Igbo has seen it | **CERTIFIED (technical)** · call-live **REFUSED** |
| OPUS-MT | opus-mt-ig-en | MT | **ig→en** | messaging | 8/8 automated; median 5658 ms. **4 of 8 materially wrong**, including *"Enwetala m ego ahụ, daalụ."* (I have received the money, thank you) → **"I had found the money, and I lost it."** Service cannot invoke it | **DEGRADED · BLOCKED (unreachable)** · call-live **REFUSED** |
| OPUS-MT | opus-mt-en-alv | MT | **en→yo** | messaging | 8/8; **median 9103 ms, max 13413 ms — the slowest route measured**. `>>yor<<` proved to steer (`>>ewe<<` returns Ewe) | **CERTIFIED (technical)** · call-live **REFUSED** |
| OPUS-MT | opus-mt-yo-en | MT | **yo→en** | messaging | 8/8 automated; median 6393 ms. **4 of 8 materially wrong**: *"Mo ti gba owó náà, ẹ ṣé."* → *"I have taken the money, you."* Service cannot invoke it | **DEGRADED · BLOCKED (unreachable)** · call-live **REFUSED** |

All twelve are **Apache-2.0**, read per model id in two independent places. Commercial-use
status remains **unknown**: the identifier is established, the obligations were never
read, and `ai-registry` still records `commercialUseState: 'review-required'`.

### Why the six Nigerian directions are `call-live` REFUSED and not merely unapproved

`unapproved` is "not yet". `refused` is "decided against", and this one is decided. The
three X→en routes return **fluent, confident, materially wrong English** with no signal a
caller can detect — the same failure already on record for general vendors on Yoruba,
Hausa and Igbo, reproduced here on local models in the reverse direction. They are fast
and they always return something, so a success-rate-and-latency harness **scores them
well**. That is precisely the danger. `call-live` puts the result in somebody's ear in
real time with nothing to check it against.

No future green harness may move that cell. Only a human reader of the language can.

### Three defects live on every OPUS route

Not routable-around, and they alone would block messaging approval:

- **Whitespace-only and emoji-only input hallucinate.** en→fr returned a paragraph of EU
  regulation boilerplate; ha→en *"The Bible"*; yo→en *"[ Picture on page 27]"*. The user
  sees confident text nobody wrote.
- **Digits are corrupted.** `08031234567` → `080314567` (en→es, two digits deleted);
  `"08031 23367"` (en→yo); ig→en `"1,777,67"`; en→ig invented a sentence about a person.
- **5000-character input** times out at 120 s on all six Romance routes — at concurrency 1
  one pasted document stalls every queued chat line for two minutes — while the Nigerian
  routes **silently translate only the first sentence** (en→ha returned 29 characters
  from 5000).

Latency tracks **output** length, not input length and not per-request overhead: roughly
1.7 s + 0.79 s per output word, in bands ~540 ms apart — the signature of a per-decoding-
step cost. About two words per second. Warming or pooling will not touch that.

---

## Missing and refused routes, named

| Route | Why it is not here |
|---|---|
| **en↔pcm machine translation** | **No model in this deployment covers Nigerian Pidgin in either direction.** OPUS-MT has no pcm pair; `self-hosted-engines.ts` records pcm as one of two catalogue languages NLLB-200 does not cover; pcm is absent from M2M-100's card list. 9jaLingo speaks pcm but its translation capability is `UNVERIFIED_TRANSLATION`. **Pidgin has a technically certified voice and no way to reach it.** Recorded as a declared gap with provider `unassigned`, which validation refuses to approve. |
| **pt→en, ha→en, ig→en, yo→en** | Weights staged and complete, benchmarked directly — but absent from `DEFAULT_OPUS_MT_LANGUAGE_MODELS`, so `findModel` rejects them with `unsupported-language` (400) before any model loads. **"The model works" is established; "the service can serve this pair" is not.** Deliberately not added: for the three Nigerian ones, that constant is currently the only thing stopping the service serving fluent wrong English, because media-ingest does not consult the route registry. |
| **Deepgram STT for yo, ha, ig, pcm** | HTTP 400 at connect on nova-3. Any registry record, roadmap line or routing table implying live Deepgram transcription of those four is wrong. 9jaLingo is the **synthesis** specialist for them; that is a different capability and does not cover recognition. |
| **Deepgram nova-3 for fr, de, pt, it, ja, zh, ar, multi** | Connects. Zero accuracy samples. Sized to the vendor's catalogue rather than to the roadmap; someone should say which of these the product actually needs before a run is commissioned. |
| **Google Translate v3** | A client exists at `providers/google/translation.ts` and **no non-test module imports it**. Never exercised, never certified. `GOOGLE_TRANSLATE_PROJECT_ID` is present in the staging env, so it is one import away from becoming the automatic paid cloud fallback the messaging ruling forbids. |
| **faster-whisper (batch STT)** | Not installed on the production box. No lane measured it. Production is recommended `TRANSCRIPTION_PROVIDER=off`. |
| **Piper / MMS-TTS (batch synthesis)** | Not installed on the production box. No lane measured either. |
| **NLLB-200** | CC-BY-NC-4.0. Covers more languages than anything else here, and we may not sell that breadth. Validation refuses production approval without `commercialUse: 'permitted'`, so this stays one rule away rather than one careless edit away. |
| **Nigerian-language recognition, any vendor** | Completely unmeasured for **audio**: the staging Azure region has no yo/ig/ha/pcm voice to synthesise a fixture from. A 9jaLingo-sourced fixture run would quantify the confident-wrong-output risk. Unmeasured, not fine. |
| **Human review, every route above** | **Nobody has read or listened to a single output**, in any language, on any provider. This is the one column no harness can ever fill, and it is not blocked on anything technical. |

---

## Conflicts between lanes, promoted neither way

| Conflict | Resolution |
|---|---|
| **Route registry named `m2m100` for the six Nigerian directions; every measurement and the deployed config say `opus-mt`.** | Not a conflict of evidence — nothing measured m2m100 on those directions and `TRANSLATION_PROVIDER=opus-mt`. Corrected to name the model that would actually run. A registry naming a model that would never serve the route is the unwired-seam defect in registry form. |
| **Licence: two lanes read Apache-2.0 in two independent places; the registry seed says `commercialUse: unknown`.** | **Both stand, and neither was promoted over the other.** The licence *identifier* is now established twice per model id and recorded. Commercial use stays `unknown` because the *obligations* were never read and `ai-registry` still records `review-required`. Under the document's rules `unknown` blocks production approval, so this is load-bearing rather than cosmetic. |
| **Benchmark lane proposed `humanReviewStatus: not-required` for the six Romance directions; the seed said `required-not-done` for all.** | Resolved toward the seed. The same lane's own reading found fr→en dropping "tomorrow" and es→en turning arriving into already being there. A dropped day in a chat message is not a matter of style, and a language nobody has checked is not a language known to be fine. |
| **9jaLingo Pidgin speaker: the brief named `blessing_pcm`; the shipped provider names `ada_pcm`.** | `ada_pcm` certified, because that is what the product sends. Both exist, both are pcm female, **and nobody has listened to either.** |
| **Two `productionApproved` fields now exist** — asset-level in `ai-registry` (non-directional) and directional in `translation-routes`. | Not reconciled, and flagged rather than papered over. They can disagree and nothing currently detects it. The CTO ruled the directional registry authoritative; whether the asset-level flag becomes advisory or gains a cross-check is an open decision. |
