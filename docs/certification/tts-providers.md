# TTS provider certification: ElevenLabs and Azure

Owner: masterzee001. Lane B of the 30 Aug 2026 CTO authorization.
Measured 2026-08-30T22:49:43Z on **c7-eu-01 staging**, against
`/etc/videofy/media-ingest.env` and the deployed build at
`/srv/videofy/app/services/media-ingest/dist` (commit `d08d95f1c3fa28958f80fcc30d6ed84fe36cc611`).

Harness: `scripts/certify/tts.mjs`. Re-run it with

```sh
# on c7-eu-01, from a checkout:
sudo node scripts/certify/tts.mjs --samples 5 --out /tmp/tts-evidence.json
# or, as this run was made, copied to the box first:
scp scripts/certify/tts.mjs c7-claude:/tmp/certify-tts.mjs
ssh c7-claude "sudo node /tmp/certify-tts.mjs --samples 5 --out /tmp/tts-evidence.json"
```

It reads the service env file itself, reports credential **names** only, and
never writes a value anywhere. It starts, restarts and reconfigures nothing.

Every number below came out of that run. Nothing here is inferred, remembered
or carried over from a previous wave.

---

## The one thing to read first

**Both vendors work. Neither is certified for a Nigerian language, and Azure
cannot be, in this region, on this evidence.**

`northeurope` — the region this deployment is configured for — hosts **655
voices across 154 locales and not one of them is `yo-NG`, `ig-NG` or `ha-NG`.**
The only Nigerian locale it hosts at all is `en-NG` (`en-NG-EzinneNeural`,
`en-NG-AbeoNeural`). So when the Nigerian fallback fires, Azure speaks Yoruba,
Igbo and Hausa text with `en-US-AvaMultilingualNeural`, an American English
voice, and returns HTTP 200 with no complaint of any kind. That is a measured
fact, and it is the mechanism behind the founder's 2026-08-26 listening test:
the vendor is not mispronouncing Yoruba, it is *reading Yoruba spelling in
English*, and nothing on the wire says so.

---

## What was actually exercised (not what was configured)

| Vendor | Field | Value in the run | How that value was arrived at |
| --- | --- | --- | --- |
| ElevenLabs | model id | `eleven_flash_v2_5` | `ELEVENLABS_MODEL` is **present but empty**, so the provider's hardcoded default applied. Confirmed by the chain's own provider name, `elevenlabs-streaming:eleven_flash_v2_5`. |
| ElevenLabs | voice id | `neMPCpWtBwWZhxEC8qpe` | `ELEVENLABS_DEFAULT_VOICE_ID`. `ELEVENLABS_VOICE_IDS` is **absent**, so this one voice serves every Videofy voice id. |
| Azure | endpoint | `northeurope` | `AZURE_SPEECH_REGION` |
| Azure | voice ShortName | `en-US-AvaMultilingualNeural` | `AZURE_DEFAULT_VOICE_ID`. `AZURE_VOICE_IDS` is **absent**, so this one voice serves every Videofy voice id **and every target language**. |
| Azure | output format | `raw-16khz-16bit-mono-pcm` | hardcoded in `AzureStreamingSynthesisProvider` |
| ElevenLabs | output format | `pcm_16000` | hardcoded in `ElevenLabsStreamingSynthesisProvider` |

Credential and configuration **names** present: `ELEVENLABS_API_KEY`,
`ELEVENLABS_DEFAULT_VOICE_ID`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`,
`AZURE_DEFAULT_VOICE_ID`, `NAIJALINGO_API_KEY`.
Absent or empty: `ELEVENLABS_MODEL`, `ELEVENLABS_VOICE_IDS`, `AZURE_VOICE_IDS`.
No value of any of them appears in this document, in the harness output, or in
the evidence JSON.

### How the ids were verified, given that the catalogue is closed

The ElevenLabs key on this box is **scoped to synthesis**: `GET /v1/models` and
`GET /v1/voices/{id}` both answer **401**. So the configured ids could not be
cross-checked against the vendor's catalogue, and this document does not claim
they were.

Identity was established the other way round, by driven negative control — if a
vendor *refuses* an id that does not exist, then it *reads* the id field, and
the id we sent is the id it used:

| Control | Result |
| --- | --- |
| ElevenLabs, nonsense `model_id` | refused **400** `model_not_found` |
| ElevenLabs, nonsense `voice_id` | refused **404** `voice_not_found` |
| Azure, nonsense voice ShortName | refused **400** with an **empty body** — Azure sends no reason at all |
| Azure, configured voice vs region catalogue | `en-US-AvaMultilingualNeural` **is** among the 655 voices `northeurope` hosts |

A vendor that answered 200 to nonsense would have been ignoring the field, and
every identity claim about it would be worthless. Neither did.

---

## ElevenLabs

### General TTS as primary — PASS for the languages tested

Driven through the shipped `ElevenLabsStreamingSynthesisProvider`, 5 samples
per language, one fixed sentence per language (the corpus is in the evidence
JSON and in the harness).

| Route | n | success | TTFB ms (min/med/mean/p95/max) | total ms | audio s (min/med/max) | peak | voiced frames | chars/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| en | 5 | 5/5 | 123 / 133 / 133.0 / 141 / 141 | 211 / 224 / 221.2 / 233 / 233 | 3.158 / 3.483 / 3.622 | 0.885–0.917 | 62–73 % | 18.9 |
| es | 5 | 5/5 | 116 / 126 / 126.2 / 135 / 135 | 204 / 219 / 220.2 / 234 / 234 | 3.529 / 3.622 / 4.133 | 0.907–0.959 | 74–78 % | 18.8 |
| fr | 5 | 5/5 | 119 / 126 / 125.8 / 131 / 131 | 209 / 215 / 215.0 / 223 / 223 | 3.715 / 3.762 / 4.226 | 0.912–0.946 | 70–77 % | 17.8 |

All output 16 kHz, mono, signed 16-bit — the engine's own format, no resample.

**The audio is real, not a well-formed absence of it.** Every sample was decoded
to samples and checked: peak amplitude 0.88–0.96 of full scale, 62–78 % of 20 ms
frames carrying energy, 3.2–4.2 s of speech for a 61–68 character sentence
(17.8–18.9 characters per second, which is ordinary speaking rate). A vendor
returning a correct header over digital silence would have failed here; the
thresholds that would have caught it are peak < 0.01, voiced frames < 15 %, or
duration < 0.3 s.

**Languages tested: `en`, `es`, `fr`. Nothing else.** No claim is made about any
other language, and `en` evidence is not `es` evidence.

### Streaming vs complete audio

| Surface | Result |
| --- | --- |
| **Streaming** (`/stream`, `pcm_16000`) — the shipped live path | **Genuinely streaming.** First audio at 126–133 ms median while the complete response takes 215–224 ms and contains 3.5 s of speech. Audio arrives an order of magnitude faster than real time and long before the request ends. |
| **Complete file, direct vendor probe** (`mp3_44100_128`) | **PASS.** ffprobe: `mp3`, 44100 Hz, 1 channel, declared 3.474 s. ffmpeg decoded it; peak 0.855, 68 % voiced. 238 ms end to end. The vendor can hand back a real container. |
| **Complete file, the shipped `ElevenLabsTextToSpeechProvider`** | **Audio is fine; the file is not a file.** The provider hardcodes `output_format=pcm_16000` on the non-streaming endpoint too, so it writes **104 026 bytes of headerless PCM** whatever extension the caller gives it. ffprobe: `Invalid data found when processing input`. Interpreted as raw 16 kHz PCM the audio is good — 3.251 s, peak 0.887, 73 % voiced — but no player, no browser and no `detectAudioContainer()` in this repository will open it. |

That last row is a latent defect, not a live one: `ElevenLabsTextToSpeechProvider`
is **referenced nowhere outside its own module and its unit test**. Its own
header comment says it "remains correct for uploaded programmes, lip-fit pacing
and personal-voice synthesis"; on this evidence it is correct for none of them,
because all three want a file something can open. Wiring it as-is to any
delivery route would serve unplayable bytes with a 200.

---

## Azure AI Speech

### General TTS as primary — PASS for the languages tested

Driven through the shipped `AzureStreamingSynthesisProvider`, 5 samples per
route. Both SSML `xml:lang` forms were driven, bare and locale, because the
pipeline's target language is a bare code on some paths and a locale on others
and guessing would have measured a configuration nobody deploys.

| Route (`xml:lang`) | n | success | TTFB ms (min/med/mean/p95/max) | total ms | audio s | peak | voiced | chars/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `en` | 5 | 5/5 | 36 / 44 / 56.4 / 121 / 121 | 67 / 137 / 129.6 / 172 / 172 | 4.088 | 0.698 | 68 % | 16.1 |
| `en-US` | 5 | 5/5 | 37 / 37 / 43.0 / 64 / 64 | 86 / 140 / 140.4 / 204 / 204 | 4.175 | 0.744 | 68 % | 15.8 |
| `es` | 5 | 5/5 | 38 / 42 / 47.6 / 70 / 70 | 117 / 142 / 150.4 / 184 / 184 | 4.912 | 0.778 | 68 % | 13.8 |
| `es-ES` | 5 | 5/5 | 37 / 41 / 44.8 / 64 / 64 | 85 / 131 / 133.4 / 190 / 190 | 4.787–4.825 | 0.651–0.731 | 68 % | 14.1 |
| `fr` | 5 | 5/5 | 37 / 58 / 53.4 / 66 / 66 | 86 / 113 / 129.8 / 183 / 183 | 3.900–3.938 | 0.604–0.647 | 66–67 % | 17.2 |
| `fr-FR` | 5 | 5/5 | 36 / 40 / 55.4 / 113 / 113 | 82 / 87 / 112.0 / 210 / 210 | 3.862–4.025 | 0.594–0.635 | 68–69 % | 16.6 |

**Both tag forms work.** Azure accepted the bare code and the full locale
identically. All output 16 kHz mono 16-bit.

Azure is roughly **three times faster to first audio than ElevenLabs**
(37–58 ms median vs 126–133 ms) and about **1.6× faster end to end**. Note that
it is also the *second* vendor in the general chain, so in normal operation this
speed is never used.

A caution the numbers themselves carry: every Azure duration for a given route
is identical to the millisecond across all five samples (`4.088`, `4.088`,
`4.088`…). That is the expected behaviour of a deterministic neural voice on
fixed text, and it also means **the audio distribution here has an effective
sample size of one**; only the latency distribution has five.

### Streaming vs complete audio

| Surface | Result |
| --- | --- |
| **Streaming** (`raw-16khz-16bit-mono-pcm`) — the shipped live path | **Genuinely streaming.** First audio at 37–58 ms median, complete at 87–142 ms, for 3.9–4.9 s of speech. |
| **Complete file, direct vendor probe** (`riff-16khz-16bit-mono-pcm`) | **PASS.** ffprobe: `wav` / `pcm_s16le`, 16000 Hz, 1 channel, declared 4.175 s. ffmpeg decoded it; peak 0.744, 68 % voiced. 92 ms end to end. |

The shipped provider only ever requests the raw variant, so the containered
format is a vendor capability, not a code path we run.

---

## Fallback behaviour — driven, not reasoned about

All three directions were driven against the **real** vendors, with refusal
produced by a real request carrying an id the vendor rejects. The observations
below are the shipped `createFallbackSpeechSynthesisProvider`'s own, read out of
its `onObservation` callback.

| Drive | Result | Verdict |
| --- | --- | --- |
| **Primary refuses** — ElevenLabs pointed at a non-existent voice, Azure healthy | `servedBy=azure-speech:tts-northeurope`, `fellThrough=[elevenlabs-streaming:eleven_flash_v2_5]`, 66 800 samples (4.175 s), **0 errors reported to the caller** | **PASS.** The listener hears a complete sentence; the failure is recorded, not surfaced. |
| **Primary healthy** — ElevenLabs healthy, Azure pointed at a non-existent voice | `servedBy=elevenlabs-streaming:...`, `fellThrough=[]`, 53 499 samples (3.344 s), 0 errors | **PASS.** Azure was never called. The chain does not speculatively double-spend. |
| **Everybody refuses** | `servedBy=null`, `fellThrough=[elevenlabs…, azure…]`, **0 samples**, caller told once: `every speech synthesis provider failed` | **PASS.** This is the one that matters. Total failure produces a reported error, **not** silence delivered as success. |

**The cost of a fall-through is ~330 ms of the listener's patience.** Chain total
was 527 ms when the primary refused versus 195 ms when it did not.

**A reporting nuance worth someone's attention.** In the fall-through case the
observation's `timeToFirstChunkMs` was **62 ms** — but the listener waited
527 ms. The field is measured from the *serving provider's* start, not the
sentence's, so during a fall-through it understates perceived latency by the
whole cost of the failed attempt. Nothing is wrong with the audio; the metric
just answers a narrower question than its name suggests. Flagged, not changed:
`fallback-speech-synthesis-provider.ts` is not this lane's file.

---

## Azure as the Nigerian fallback — DEGRADED, and recorded as such

Driven through the shipped `createNigerianSynthesisRoute` with a specialist that
refuses, so the fallback genuinely ran. Voice exercised:
`en-US-AvaMultilingualNeural`, in every case.

| Language | `xml:lang` | rendering | servedBy | duration | peak | voiced | chars/s | route marked degraded | result carried degradation flag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ha` | `ha-NG` | `degraded-fallback` | `azure-speech:tts-northeurope` | 4.575 s | 0.761 | 72 % | 11.6 | yes | yes |
| `ig` | `ig-NG` | `degraded-fallback` | `azure-speech:tts-northeurope` | 5.313 s | 0.787 | 77 % | 9.4 | yes | yes |
| `yo` | `yo-NG` | `degraded-fallback` | `azure-speech:tts-northeurope` | 4.713 s | 0.754 | 75 % | 12.1 | yes | yes |
| `pcm` | `en-NG` | `degraded-fallback` | `azure-speech:tts-northeurope` | 4.350 s | 0.713 | 69 % | 14.3 | yes | yes |

### Status: **technically produces audio; quality REFUSED by prior founder review**

Every row above is `degraded-produced-audio`, which is **not a pass** and must
never be read as one. It says exactly one thing: the fallback path is wired, it
is reached, and sound comes out of it. Whether that sound is acceptable Yoruba,
Hausa or Igbo was answered on **2026-08-26, by ear, and the answer was no.** No
measurement in this harness can overturn a listening test, and this document
does not attempt to.

Three measured facts explain *why* the ear was right, and they are worse than
"the accent is off":

1. **`northeurope` hosts no Yoruba, Igbo or Hausa voice at all.** 655 voices,
   154 locales, zero of the three. The only Nigerian locale present is `en-NG`.
2. **Azure returned 200 for `xml:lang='yo-NG'` with an `en-US` voice.** There is
   no error, no warning, no header and no field anywhere in the response
   indicating that the requested language is one the voice cannot speak. The
   platform's `degraded-fallback` marking is therefore the *only* signal that
   exists — remove it and this failure is completely invisible.
3. **The chars-per-second rate drops with the language's distance from English**
   — 14.3 for Pidgin, 12.1 Yoruba, 11.6 Hausa, 9.4 Igbo, against 15.8–16.1 for
   the same voice reading English. An English voice is labouring through
   unfamiliar orthography. This is a plausibility signal, not a verdict; it is
   consistent with the ear, and it decides nothing on its own.

So the honest formulation for any registry, console or report is:

> Azure `en-US-AvaMultilingualNeural` in `northeurope` **technically produces
> audio for ha/ig/yo/pcm; quality refused by prior founder review.** It is a
> guard against silence, not a rendering of the language.

### End of the chain, when there is nothing behind the specialist

| Drive | Result | Verdict |
| --- | --- | --- |
| Specialist refuses, `fallback: null` | `rendering=failed`, 0 samples, caller told once | **PASS.** Silence is reported, not served, and no second wrong voice is substituted. |

---

## Configuration findings from this run

These are facts about the staging deployment, recorded because they change what
the numbers above mean. **Nothing was reconfigured; no service was touched.**

1. **`ELEVENLABS_MODEL` is present but empty.** The provider's hardcoded default
   `eleven_flash_v2_5` applied. The measured model is a code default, not a
   deployment choice — so a change to that default silently changes the model in
   production with no configuration diff to review.
2. **`ELEVENLABS_VOICE_IDS` and `AZURE_VOICE_IDS` are both absent.** Every
   Videofy voice id collapses to the single default voice per vendor. The
   provider's own comment names the consequence: the speaker's male/female
   choice is discarded and every participant gets the same voice in every
   language. This lane measured it, it did not fix it.
3. **For Azure that same absence is worse than a lost voice choice**, because
   the default is `en-US-AvaMultilingualNeural`: with no map, *every* target
   language on the Azure leg is spoken by an American English voice, including
   the four Nigerian ones. The region hosts `en-NG-EzinneNeural` and
   `en-NG-AbeoNeural`, which would at least be Nigerian-accented English for the
   `pcm` route — that is a configuration decision for the founder, not a
   certification, and it is listed as an open question rather than a
   recommendation dressed as evidence.
4. **`TEXT_TO_SPEECH_PROVIDER=mock`** in this env file, while
   `STREAMING_SYNTHESIS_PROVIDER=chain`. The live streaming path is real; the
   file-based path is mocked. Consistent with the finding that the complete-file
   surface is unwired.

---

## What this certification does NOT establish

Stated here, and repeated inside the evidence JSON, because the JSON is what
gets pasted into a review and the scrollback is what gets lost.

- **Nothing about intelligibility, pronunciation, or even whether the output is
  in the requested language.** This harness decodes audio; it cannot hear. Every
  quality judgement in this document is the founder's 2026-08-26 listening test,
  not a measurement.
- **Nothing about a language that was not driven.** ElevenLabs was tested on
  `en`, `es`, `fr` only. Azure on `en`, `es`, `fr` (both tag forms) plus the four
  Nigerian languages *on the degraded path only*. English evidence is not
  Spanish evidence.
- **Nothing about ElevenLabs and the Nigerian languages.** Deliberately not
  driven: the 2026-08-30 founder ruling puts Azure alone behind the specialist,
  so an ElevenLabs Yoruba measurement would describe a route that does not
  exist. Absence of a row here is not permission to add one.
- **Nothing about production.** These are **staging** credentials on staging
  configuration. Production has its own env file, and may have a different
  region, a different voice, a different key scope and different quota.
- **Nothing about behaviour under load, over hours, or against a rate limit.**
  25 checks, 5 samples each, over about two minutes, with a 600 ms gap. No 429
  was seen, which is a fact about this run and not about the plan.
- **Nothing about mid-stream failure.** The chain's "a provider that has emitted
  audio is never replaced" rule was not driven, because neither vendor can be
  made to fail halfway through a sentence on demand. It remains covered by unit
  tests only.
- **No registry decision.** Lane F owns `TranslationRouteRecord`. This lane
  wrote no record and proposes none.

---

## Evidence for Lane F (proposal only — this lane writes no record)

Offered in the shape of `technicalEvidence`, for whoever owns the record. The
`serviceScopes` and `productionApproved` columns are **deliberately left for
Lane F and the founder**; nothing measured here entitles anyone to set them.

| Leg | provider | modelId | executionClass | sampleCount | successRate | latencyMs (min/median/mean/max) | humanReviewStatus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TTS `en` | elevenlabs | `eleven_flash_v2_5` | cloud | 5 | 1.0 | 211 / 224 / 221.2 / 233 | not-required |
| TTS `es` | elevenlabs | `eleven_flash_v2_5` | cloud | 5 | 1.0 | 204 / 219 / 220.2 / 234 | not-required |
| TTS `fr` | elevenlabs | `eleven_flash_v2_5` | cloud | 5 | 1.0 | 209 / 215 / 215.0 / 223 | not-required |
| TTS `en` | azure | `en-US-AvaMultilingualNeural @ northeurope` | cloud | 5 | 1.0 | 86 / 140 / 140.4 / 204 | not-required |
| TTS `es` | azure | `es` via `en-US-AvaMultilingualNeural @ northeurope` | cloud | 5 | 1.0 | 117 / 142 / 150.4 / 184 | not-required |
| TTS `fr` | azure | `fr` via `en-US-AvaMultilingualNeural @ northeurope` | cloud | 5 | 1.0 | 86 / 113 / 129.8 / 183 | not-required |
| TTS `ha` | azure | `en-US-AvaMultilingualNeural @ northeurope` | cloud | 1 | 1.0 | 119 (single sample) | **failed** (2026-08-26 listening test) |
| TTS `ig` | azure | `en-US-AvaMultilingualNeural @ northeurope` | cloud | 1 | 1.0 | 101 (single sample) | **failed** |
| TTS `yo` | azure | `en-US-AvaMultilingualNeural @ northeurope` | cloud | 1 | 1.0 | 152 (single sample) | **failed** |
| TTS `pcm` | azure | `en-US-AvaMultilingualNeural @ northeurope` | cloud | 1 | 1.0 | 84 (single sample) | **failed** |

`successRate` here means *audible decoded audio was produced*, never *the output
was correct*. The four Nigerian rows carry `humanReviewStatus: failed` and exist
only to document a degraded availability path.

Raw evidence: `/tmp/tts-evidence.json` on c7-eu-01 (regenerate with the harness;
it is not committed, and it contains no credential value).
