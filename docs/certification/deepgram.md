# Deepgram — live (streaming) recogniser certification evidence

**Owner:** masterzee001 · **Lane:** A (Deepgram certification) · **Measured:** 2026-08-30, 22:50–22:56 UTC
**Environment:** C7 staging on `c7-eu-01`, staging Deepgram credential · **Status:** measured; **certification is not claimed here**

This file records what was measured and what was not. It sets no approval. `productionApproved`, `humanReviewStatus`
and `serviceScopes` belong to the route registry and to whoever owns the decision; nothing below asserts them.

---

## 1. Scope, stated before the numbers

Deepgram is the **live streaming recogniser**. The batch (pre-recorded) path is a separate capability and is **not**
measured here — `TRANSCRIPTION_PROVIDER` (batch) and `STREAMING_TRANSCRIPTION_PROVIDER` (live) are independent
selectors, and the Deepgram batch adapter (`providers/deepgram/batch-stt.ts`) was not exercised.

What each row of evidence is bounded by:

| Boundary | Why it is not crossed |
| --- | --- |
| **Per model** | `nova-3` speaks Listen **v1**; `flux-general-en` speaks Listen **v2**. Different products, different protocols, different adapters. Nova evidence is never quoted for Flux. |
| **Per language** | An English success rate says nothing about Spanish and nothing at all about Yoruba. Each language is measured or reported unmeasured. |
| **Per accent** | `en-US` and `en-NG` are recorded as **separate rows**. A platform whose speakers are largely Nigerian is not certified by American-accented English. |
| **Recogniser only** | This is speech→text. It certifies no translation route, no direction (`en→X` / `X→en`), and no synthesis. |

---

## 2. Provenance — what was actually driven

The harness does **not** open its own socket. It builds the recogniser through
`buildStreamingTranscriptionProvider(...)` — the exact function `live-provider-wiring.ts` calls at boot — against the
**deployed** staging build, and pushes 20 ms frames through `StreamingTranscriptionSession` exactly as
`LiveStreamPipeline.onAudio` pushes them. A benchmark that opened its own socket would have certified Deepgram; this
certifies **this platform's path to Deepgram**.

| Fact | Value |
| --- | --- |
| Box | `c7-eu-01` (Contabo), Linux 6.8.0-138, Node v22.23.2 |
| Staging app | `/srv/videofy/app`, commit `d08d95f` |
| Adapter under test | `/srv/videofy/app/services/media-ingest/dist/services/media-ingest/src` |
| Selector exercised | `buildStreamingTranscriptionProvider({ streamingTranscriptionProvider }, { deepgramApiKey, deepgramModel })` |
| Deployed `nova-streaming-stt.ts` | `sha256:6f83e54fd7ab9e15…` — **byte-identical** to the working tree |
| Deployed `flux-streaming-stt.ts` | `sha256:3ba662e89cde41ba…` — byte-identical |
| Deployed `transport.ts` | `sha256:6b5cc35a86cea079…` — byte-identical |
| Staging live provider | `STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova`, `DEEPGRAM_MODEL=nova-3` |
| Production template | `STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova`, `DEEPGRAM_MODEL` blank → adapter default `nova-3` |
| Wire parameters (Nova) | `encoding=linear16`, `sample_rate=16000`, `channels=1`, `model=nova-3`, `interim_results=true`, `punctuate=true`, `language=<source>` |
| Wire parameters (Flux) | `model=flux-general-en`, `encoding=linear16`, `sample_rate=16000` — **no language parameter is sent** (see §6.2) |
| Credentials | Read from `/etc/videofy/media-ingest.env` via Node's `--env-file`. No value was printed, logged, copied or passed on a command line. |

**The model measured is the model production runs.** `nova-3`, streaming, Listen v1, driven by the `deepgram-nova`
code path. `flux-general-en` is measured separately below because it is a *selectable* production value, not because
it is deployed.

---

## 3. Method

- **Audio is paced in real time.** Frames are 20 ms (320 samples at 16 kHz mono), the size the realtime ingress
  carries, released on a wall clock. Pushing a file at once would measure how fast a server chews a buffer; live
  translation cares about the gap between a speaker stopping and a transcript existing, and that gap only means
  anything if the audio arrived at the speed speech arrives.
- **The latency clock starts at the last *voiced* sample**, found by RMS over 20 ms windows — not at the end of the
  file. The first run of this harness reported a finalisation latency of **−61 ms**, which is not a latency: the
  synthesiser leaves room tone after the last word, and the recogniser had endpointed on the voice while the harness
  was still measuring to the file. Quoting that number would have credited Deepgram with clairvoyance.
- **Finals are taken the way a call takes them.** The harness waits for the recogniser to end the turn *on its own*
  (nobody presses a button on a phone call) and only then falls back to the pipeline's flush. Which of the two
  produced the final is recorded. **Every single sample below finalised naturally; the flush was never needed.**
- **Meaningfulness is measured, not assumed.** A non-empty string is not evidence. Each transcript is compared to the
  known input by word error rate over a normalisation that folds case, punctuation and accents (formatting choices,
  not hearing). `wordSimilarity = 1 − WER`; **≥ 0.70 counts as meaningful**. No reference sentence contains a digit,
  deliberately: "10" versus "ten" is a formatting argument that would swamp a sample this size.

### 3.1 The speech is synthetic, and that matters

Fixtures were generated with **Azure TTS** (`raw-16khz-16bit-mono-pcm`, so nothing in the harness resamples anything)
using the staging Azure credential. Voices: `en-US-AvaMultilingualNeural`, `en-NG-EzinneNeural`, `es-ES-ElviraNeural`.

**TTS-generated speech is not a human speaker.** It is clean, evenly paced, correctly pronounced, free of crosstalk,
room noise, packet loss, disfluency, overlapping talkers and coughing. **Every accuracy number below is an upper
bound on what a real caller would get, and every latency number is a best case.** Nothing here substitutes for a
human listening pass, and this file does not claim one has happened.

Repo speech fixtures were considered and rejected: the only audio in the tree is under `.openvoice-evidence/`, which
is synthesised voice-conversion output at other sample rates with no reliable ground-truth text — worse evidence than
purpose-made fixtures, not better.

---

## 4. Results — accuracy and latency

All latencies in milliseconds. `final` is measured from the **last voiced sample** to the final transcript;
`first partial` from the **first voiced sample** to the first non-empty interim; `connect` is the WebSocket open.

| Model | Language | Speech source | n | Opened | Got final | **Meaningful** | Success rate | Mean WER | final min/med/mean/max | first partial med | connect med |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `nova-3` | **en** | `en-US-AvaMultilingualNeural` | 12 | 12 | 12 | **12** | **1.00** | 0.0111 | 243 / **284** / 308 / 450 | 617 | 315 |
| `nova-3` | **en (NG accent)** | `en-NG-EzinneNeural` | 12 | 12 | 12 | **12** | **1.00** | 0.0175 | 263 / **319** / 327 / 427 | 544 | 329 |
| `nova-3` | **es** | `es-ES-ElviraNeural` | 8 | 8 | 8 | **8** | **1.00** | 0.0000 | 259 / **343** / 324 / 366 | 572 | 394 |
| `flux-general-en` | **en** | `en-US-AvaMultilingualNeural` | 6 | 6 | 6 | **6** | **1.00** | 0.0000 | 116 / **913** / 957 / 1665 | 392 | 459 |

Every non-zero error was inspected. There were exactly three across 38 samples, and **none of them is a mishearing**:

| Reference | Transcript | Nature |
| --- | --- | --- |
| …abandoned at **half time**. | …abandoned at **halftime**. | compounding (both en-US and en-NG runs) |
| She asked whether the **payment** had cleared… | She asked whether the **payments** had cleared… | one true substitution, en-NG run |

Interim behaviour differs sharply between the models and is worth recording: **Nova-3 emits ~3.5 partials per
utterance; Flux emits ~16.5.** Flux gives a much richer live-caption stream and reaches its first partial ~225 ms
sooner, then takes **~3× longer to commit a final** (median 913 ms vs 284 ms). For a pipeline that cannot speak a
translation until a final exists, that is the number that decides the product.

---

## 5. Results — which languages the live path can even start

Opening a stream per platform language code, `nova-3`. **This is an acceptance probe, not an accuracy measurement.**

| Platform code | `nova-3` | `flux-general-en` |
| --- | --- | --- |
| `en` | opens — **measured, see §4** | opens — **measured, see §4** |
| `es` | opens — **measured, see §4** | opens — unmeasured |
| `fr` `de` `pt` `it` `ja` `zh` `ar` | opens — **UNMEASURED for accuracy** | opens — unmeasured |
| `multi` | opens — **UNMEASURED for accuracy** | n/a |
| **`yo` (Yoruba)** | **REFUSED — HTTP 400 at connect** | opens (language is discarded, §6.2) |
| **`ha` (Hausa)** | **REFUSED — HTTP 400 at connect** | opens (language is discarded) |
| **`ig` (Igbo)** | **REFUSED — HTTP 400 at connect** | opens (language is discarded) |
| **`pcm` (Nigerian Pidgin)** | **REFUSED — HTTP 400 at connect** | opens (language is discarded) |
| `zz-not-a-language` | not probed | **opens** — proof the code is discarded |

**"Opens" is not certification.** It means the vendor accepted a parameter. `fr`, `de`, `pt`, `it`, `ja`, `zh`, `ar`
and `multi` have **no accuracy evidence whatsoever** in this file and must be recorded as unmeasured. The whole reason
this table is separate from §4 is that a status code is not evidence.

### 5.1 The Nigerian languages are refused, and a refusal is an outage

`LiveStreamPipeline.open` **awaits** `openStream`. A 400 at connect is therefore not a bad caption — it is a live
session that never starts. On `nova-3`, a call or programme whose declared source language is **Yoruba, Hausa, Igbo or
Nigerian Pidgin cannot open a live transcription stream at all.** This was measured directly and is independent of
the audio, since the refusal happens before a byte of it is sent.

Yoruba/Hausa/Igbo **audio** could not be measured: the staging Azure region publishes 655 voices across 154 locales
and **none of them is `yo`, `ig`, `ha` or `pcm`** (only `en-NG`, Nigerian-accented English). A follow-up run using
9jaLingo — which does speak all four — is the way to measure what `flux-general-en` *does* with Nigerian-language
audio it has accepted. Until then that cell is **unmeasured**, not "fine".

---

## 6. Failure behaviour

### 6.1 Probes

| Probe | `nova-3` | `flux-general-en` | Verdict |
| --- | --- | --- | --- |
| **Invalid credential** (well-formed 40-hex string, not a credential) | `Unexpected server response: 401`, stream never opens, ~287 ms | `401`, never opens, ~282 ms | **Fails closed.** No audio is accepted, no transcript is produced, the adapter rejects `openStream`. |
| **Unsupported language** (`yo` requested, English audio) | `400`, **never opens** | **opens and returns a confident English transcript** | Divergent — see §6.2 |
| **Digital silence**, 4 s | one final, transcript `""` | zero finals, transcript `""` | **No invented words.** |
| **Broadband noise**, 4 s, speech-level amplitude | one final, transcript `""` | zero finals, transcript `""` | **No invented words.** |

The silence and noise results are the ones worth dwelling on: a recogniser that fabricates words when handed
non-speech is worse than one that returns nothing, because the fabrication is confident and someone acts on it.
Neither model did. Note the shape difference — Nova returns an **empty final** where Flux returns **no final at all**;
downstream code must not treat "a final arrived" as "words arrived".

### 6.2 Two defects found in our own code while measuring

Both are in files this lane does not own. They are reported, not fixed.

**(a) `requestEndpointing` is wired to nothing.** `live-stream-pipeline.ts:119` sets `requestEndpointing: true` on
every live session. **No adapter reads it** — `grep` finds exactly two occurrences in the service, the one that sets
it and the one that declares it. The Nova adapter sends `utterance_end_ms` / `vad_events` only when its *config* field
`utteranceEndMs` is set, and `live-provider-wiring.ts` never sets it. Measured consequence: **`endpoint` signals
received across all 38 samples = 0.** The platform's candidate-boundary signal path is dead in production, and looks
alive in the source.

**(b) The Flux adapter silently discards the caller's source language.** `flux-streaming-stt.ts` never reads
`options.sourceLanguage`; it sends `language_hint` only from *config* and only for `*multi*` models. Measured
consequence: a session declared `sourceLanguage: 'yo'` **opened and returned fluent English**, and a session declared
`sourceLanguage: 'zz-not-a-language'` opened too. Per-session language selection is impossible on the Flux path. On
`flux-general-en` (English-only) the practical effect is confident wrong output for non-English speakers rather than
an honest refusal; on `flux-general-multi` it would mean the vendor never learns which language to expect.

Nova and Flux therefore **fail in opposite directions** on the same input, which is precisely the kind of divergence
a per-model registry record exists to capture.

---

## 7. What this file does NOT establish

- **No human review.** No person has listened to or read these transcripts against the audio. Everything above is
  machine comparison against machine speech.
- **No human-speaker evidence.** Real callers, real rooms, real packet loss, real accents beyond one synthetic
  Nigerian voice — all unmeasured.
- **No accuracy evidence** for `fr`, `de`, `pt`, `it`, `ja`, `zh`, `ar`, `multi` (they merely connect), for any
  Nigerian language on either model, or for `es` on Flux.
- **No batch evidence.** The Deepgram pre-recorded path was not exercised.
- **No translation evidence.** This is a recogniser measurement; it says nothing about any `X→Y` route.
- **No production evidence.** Measurements ran against **staging** credentials. Production holds its own Deepgram
  credential which was never exercised.
- **Sample sizes are small** (12 / 12 / 8 / 6). A 100 % success rate over 12 clean synthetic samples is consistent
  with a real-world rate well below 100 %.
- **Cost, quota, rate limits and concurrency** were not measured. One session at a time was opened throughout.

---

## 8. Reproducing this

```
# on c7-eu-01, staging credentials, values never leave the process
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs \
  --model nova-3 --languages en,es --out nova3.json
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs \
  --model nova-3 --languages en --tts-locale en=en-NG --skip-probes --out nova3-enNG.json
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs \
  --model flux-general-en --languages en --samples 6 --out flux.json
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs \
  --model nova-3 --samples 0 --skip-probes \
  --language-support en,es,fr,de,pt,it,ja,zh,ar,yo,ha,ig,pcm,multi --out nova3-langs.json
```

Fixtures are cached by `sha256(voice|text)`, so a re-run re-measures without re-synthesising, and the exact bytes
behind any number can be listened to afterwards.

---

## 9. Machine-readable evidence

Shaped to drop into `TranslationRouteRecord.technicalEvidence`. **Deliberately omitted:** `productionApproved`,
`humanReviewStatus`, `licenceStatus` and `serviceScopes` — those are the registry owner's to set, not this lane's.
`sourceLanguage` here is the **recogniser input** language; these records certify no translation direction.

```json
{
  "tool": "scripts/certify/deepgram.mjs",
  "provider": "deepgram",
  "capability": "streaming-speech-to-text",
  "environment": "staging",
  "box": "c7-eu-01",
  "appCommit": "d08d95f",
  "recordedAt": "2026-08-30T22:56:02Z",
  "speechSource": "azure-tts",
  "speechSourceCaveat": "TTS-generated speech, not human speakers: clean, evenly paced, no crosstalk or disfluency. Every number is an upper bound on live human performance. No human review has taken place.",
  "meaningfulThreshold": 0.7,
  "frameMs": 20,
  "sampleRateHz": 16000,
  "measurements": [
    {
      "modelId": "nova-3",
      "protocol": "deepgram-listen-v1",
      "executionMode": "streaming",
      "executionClass": "cloud",
      "serviceContext": "media-ingest live path: buildStreamingTranscriptionProvider -> DeepgramNovaStreamingProvider -> LiveStreamPipeline frame contract",
      "recogniserLanguage": "en",
      "speechVoice": "en-US-AvaMultilingualNeural",
      "sampleCount": 12,
      "successRate": 1.0,
      "meaningfulCount": 12,
      "meanWordErrorRate": 0.0111,
      "latencyMs": { "min": 243.1, "median": 283.8, "mean": 308.1, "max": 450.1 },
      "latencyDefinition": "last voiced sample -> final transcript",
      "firstPartialMs": { "min": 562.1, "median": 616.9, "mean": 617.2, "max": 680.3 },
      "connectMs": { "min": 278.0, "median": 314.9, "mean": 350.7, "max": 490.5 },
      "finalsViaNaturalEndpoint": 12,
      "finalsViaFlush": 0,
      "recordedAt": "2026-08-30T22:50:03Z",
      "notes": "Only deviation across 12 samples: 'half time' -> 'halftime' (compounding, not a mishearing)."
    },
    {
      "modelId": "nova-3",
      "protocol": "deepgram-listen-v1",
      "executionMode": "streaming",
      "executionClass": "cloud",
      "serviceContext": "media-ingest live path",
      "recogniserLanguage": "en",
      "accent": "en-NG (Nigerian-accented English)",
      "speechVoice": "en-NG-EzinneNeural",
      "sampleCount": 12,
      "successRate": 1.0,
      "meaningfulCount": 12,
      "meanWordErrorRate": 0.0175,
      "latencyMs": { "min": 262.6, "median": 319.1, "mean": 327.1, "max": 427.3 },
      "firstPartialMs": { "min": 476.8, "median": 544.3, "mean": 550.0, "max": 601.9 },
      "connectMs": { "min": 279.2, "median": 328.8, "mean": 359.0, "max": 482.4 },
      "finalsViaNaturalEndpoint": 12,
      "finalsViaFlush": 0,
      "recordedAt": "2026-08-30T22:54:50Z",
      "notes": "Separate record from en-US on purpose. Two deviations: 'payment'->'payments' (one substitution) and 'half time'->'halftime'."
    },
    {
      "modelId": "nova-3",
      "protocol": "deepgram-listen-v1",
      "executionMode": "streaming",
      "executionClass": "cloud",
      "serviceContext": "media-ingest live path",
      "recogniserLanguage": "es",
      "speechVoice": "es-ES-ElviraNeural",
      "sampleCount": 8,
      "successRate": 1.0,
      "meaningfulCount": 8,
      "meanWordErrorRate": 0.0,
      "latencyMs": { "min": 258.9, "median": 342.8, "mean": 323.6, "max": 365.5 },
      "firstPartialMs": { "min": 534.2, "median": 571.7, "mean": 574.4, "max": 614.7 },
      "connectMs": { "min": 275.3, "median": 394.3, "mean": 383.5, "max": 484.0 },
      "finalsViaNaturalEndpoint": 8,
      "finalsViaFlush": 0,
      "recordedAt": "2026-08-30T22:50:03Z",
      "notes": "Zero word errors across 8 samples."
    },
    {
      "modelId": "flux-general-en",
      "protocol": "deepgram-listen-v2",
      "executionMode": "streaming",
      "executionClass": "cloud",
      "serviceContext": "media-ingest live path: DeepgramFluxStreamingProvider (selectable, NOT deployed)",
      "recogniserLanguage": "en",
      "speechVoice": "en-US-AvaMultilingualNeural",
      "sampleCount": 6,
      "successRate": 1.0,
      "meaningfulCount": 6,
      "meanWordErrorRate": 0.0,
      "latencyMs": { "min": 116.1, "median": 912.8, "mean": 956.6, "max": 1665.3 },
      "firstPartialMs": { "min": 331.6, "median": 392.4, "mean": 411.9, "max": 589.3 },
      "connectMs": { "min": 456.7, "median": 458.7, "mean": 460.9, "max": 468.3 },
      "finalsViaNaturalEndpoint": 6,
      "finalsViaFlush": 0,
      "recordedAt": "2026-08-30T22:51:53Z",
      "notes": "Accurate but ~3x slower to commit a final than nova-3, with ~16.5 partials per utterance vs ~3.5. Separate record; nova-3 evidence does not transfer."
    }
  ],
  "languageAcceptance": {
    "definition": "Whether openStream succeeds for a platform language code. NOT an accuracy measurement.",
    "nova-3": {
      "opens": ["en", "es", "fr", "de", "pt", "it", "ja", "zh", "ar", "multi"],
      "refusedHttp400": ["yo", "ha", "ig", "pcm"],
      "accuracyMeasured": ["en", "es"],
      "accuracyUnmeasured": ["fr", "de", "pt", "it", "ja", "zh", "ar", "multi"]
    },
    "flux-general-en": {
      "opens": ["en", "es", "yo", "ha", "ig", "pcm", "zz-not-a-language"],
      "opensBecause": "the adapter never sends the source language to the vendor; acceptance is meaningless here",
      "accuracyMeasured": ["en"],
      "accuracyUnmeasured": ["es", "yo", "ha", "ig", "pcm"]
    }
  },
  "failureBehaviour": {
    "invalidCredential": {
      "nova-3": "HTTP 401 at connect; openStream rejects; no audio accepted; ~287ms",
      "flux-general-en": "HTTP 401 at connect; openStream rejects; ~282ms",
      "verdict": "fails closed on both"
    },
    "unsupportedLanguage": {
      "nova-3": "HTTP 400 at connect; the live session cannot open",
      "flux-general-en": "opens and transcribes in English regardless; the requested language is discarded by our adapter",
      "verdict": "divergent; see platform defect (b)"
    },
    "digitalSilence4s": {
      "nova-3": "one final, empty transcript, no invented words",
      "flux-general-en": "zero finals, no invented words"
    },
    "broadbandNoise4s": {
      "nova-3": "one final, empty transcript, no invented words",
      "flux-general-en": "zero finals, no invented words"
    }
  },
  "platformDefectsFound": [
    {
      "id": "requestEndpointing-unwired",
      "file": "services/media-ingest/src/live-stream-pipeline.ts:119",
      "summary": "requestEndpointing:true is set on every live session and read by no adapter; the Nova adapter requests utterance_end_ms/vad_events only from its own config, which live-provider-wiring never sets.",
      "measuredConsequence": "endpoint signals received across all 38 measured samples: 0",
      "ownedByThisLane": false
    },
    {
      "id": "flux-discards-source-language",
      "file": "services/media-ingest/src/providers/deepgram/flux-streaming-stt.ts",
      "summary": "options.sourceLanguage is never read; language_hint comes only from config and only for *multi* models.",
      "measuredConsequence": "sourceLanguage 'yo' and 'zz-not-a-language' both opened; the 'yo' session returned a fluent English transcript.",
      "ownedByThisLane": false
    }
  ],
  "notCertified": [
    "human review (nobody has listened)",
    "human speakers (all fixtures are TTS)",
    "fr/de/pt/it/ja/zh/ar/multi accuracy on any model",
    "yo/ha/ig/pcm accuracy on any model",
    "es accuracy on flux-general-en",
    "the Deepgram batch (pre-recorded) path",
    "any translation route or direction",
    "the production Deepgram credential",
    "cost, quota, rate limits, concurrency"
  ]
}
```
