# 9jaLingo certification: Hausa, Igbo, Yoruba and Nigerian Pidgin

Owner: masterzee001. Measured 30 Aug 2026 against **staging** credentials, from
`c7-eu-01`, by `scripts/certify/naijalingo.mjs`.

**Nothing in this document says the pronunciation is good.** It says the API
returned real, playable, non-silent audio, quickly, in four languages measured
separately. Whether that audio is acceptable Yoruba is a different question,
it is answered by ear, and it has not been answered yet.

---

## The two states

Every route carries two states that must never be collapsed into one.

| | `technicalCertified` | `humanLanguageReview` |
|---|---|---|
| **What it means** | the API returned valid playable audio at acceptable latency | a named speaker has listened and judged the pronunciation |
| **Who can set it** | measurement | a person, by ear |
| **Set by this document** | yes, per language, from the run below | **no — `required-not-done` for all four** |

| Language | Voice sent | `technicalCertified` | `humanLanguageReview` |
|---|---|---|---|
| Hausa (`ha`) | `bilkisu_ha` | **true** | **required-not-done** |
| Igbo (`ig`) | `ogechi_ig` | **true** | **required-not-done** |
| Yoruba (`yo`) | `olufunke_yo` | **true** | **required-not-done** |
| Nigerian Pidgin (`pcm`) | `ada_pcm` | **true** | **required-not-done** |

**No language above is production-approved for any service scope.** The
registry (`serviceScopes`) is the authority on that, this document is not, and
the evidence here is not sufficient for a scope approval on its own.

### Why the second column cannot be filled in by any script

Both general vendors already accept these four languages and answer HTTP 200
with audio of the right length, at normal latency, with a plausible byte count.
On 26 Aug 2026 that audio was played to the founder and refused: a multilingual
voice reading unfamiliar orthography with the phonology it already had. Nothing
on the server saw it. Nothing on the server *can* see it.

So `scripts/certify/naijalingo.mjs` hard-wires `humanLanguageReview` to
`required-not-done`, has no flag that sets it, and refuses to emit a report if
some later edit makes it anything else. A harness that can promote its own
vendor is not a gate. **A 200 is not a pronunciation.**

---

## Reproducing this

```
ssh c7-claude
sudo node /path/to/scripts/certify/naijalingo.mjs --samples 10 \
  --json /tmp/naijalingo.json --audio-dir /tmp/naijalingo-audio
```

It reads `NAIJALINGO_API_KEY` from `/etc/videofy/media-ingest.env`, prints the
NAME only, and never writes the value anywhere. Warm the endpoint before
measuring — see the cold start below — and expect roughly seven minutes for a
ten-sample run across four languages.

**Run of record:** `2026-08-30T23:26:10Z`, 10 samples per language, staging
credentials, 40 clips retained at `/tmp/naijalingo-audio` on `c7-eu-01`
(ephemeral; not committed).

---

## The contract, confirmed live rather than quoted

Every line below was re-established against the live API during the run of
record, not read from the SDK and copied forward.

| Fact | Observed |
|---|---|
| Base `https://api.9jalingo.org` | `GET /v1/health` → 200 in 587 ms |
| Auth is `x-api-key`, checked | on `POST /v1/audio/speech`: `Authorization: Bearer` → **401 `Missing API Key`**; an invalid `x-api-key` → **401 `Invalid API Key`** |
| Speech: `POST /v1/audio/speech` `{input, voice, lang, response_format}` | 200 with `audio/wav` on all 40 samples |
| Response format | WAV, **22 050 Hz, mono, 16-bit linear PCM** (WAVE tag 1) on all 40 |
| `voice` is a SPEAKER ID, never a language code | `voice:"yo"` → **404 `Voice 'yo' was not found`** |
| Speaker inventory | `ha` 33, `ig` 66, `yo` 59, `pcm` 82 — **240 speakers** |

### Two contract corrections this run produced

**`/v1/speakers` and `/v1/health` are UNAUTHENTICATED.** No header at all, and
a deliberately invalid key, both answer 200 with the full catalogue. The
catalogue is public; only synthesis is charged, so only synthesis is guarded.
An earlier revision of the harness tested the auth header against
`/v1/speakers`, read the 200 as "`Authorization: Bearer` works too", and would
have reported a correct contract as broken on evidence that measured nothing.
**Any auth probe must target `POST /v1/audio/speech`.**

**The founder's chosen voices are `database_id` values, not `id` values.** A
speaker row is `{id, voice_code, name, language, gender, domain, provider,
is_local, database_id}`. The opaque UUIDs wired into
`NAIJALINGO_SELECTED_VOICE_IDS` match the `database_id` column, so a membership
test against the visible names reports "not listed" about a perfectly valid
voice. All six resolve, and all six resolve to **the right language and the
right gender**:

| Configured | Resolves to | Language | Gender |
|---|---|---|---|
| `a48b979b…` | `kunle_yo` | yo | male |
| `e8792ad0…` | `olufunke_yo` | yo | female |
| `f5a63082…` | `obi_ig` | ig | male |
| `036d27c0…` | `ogechi_ig` | ig | female |
| `c4c90444…` | `aliyu_ha` | ha | male |
| `93ef940b…` | `bilkisu_ha` | ha | female |

This check is worth keeping: a UUID belonging to the wrong language would be
accepted with a 200 and would sound exactly like the defect the specialist was
bought to avoid.

Both `ada_pcm` and `blessing_pcm` exist in the catalogue. The product ships
`ada_pcm`, so `ada_pcm` is what was certified.

---

## Hausa (`ha`)

Voice `93ef940b-5e72-43d8-99d9-23cb96539cba` → `bilkisu_ha` (ha, female),
model `9jalingo-tts-1`. **10 samples, 10 succeeded, 0 silent.**

| | |
|---|---|
| Latency | min 3 710 · **median 4 802** · mean 4 811 · max 5 744 ms |
| Audio | 22 050 Hz, mono, 16-bit PCM; 2.23–4.40 s |
| Peak amplitude | 0.90–1.00 |
| Level (RMS) | −15.4 to −12.5 dBFS |
| Voiced fraction | 0.55–0.74 |
| Clipping | **2 of 10 clips**, worst 2 samples at full scale |
| Same text, re-rendered | 1.30× duration ratio (2.95 s / 3.83 s) |
| Alternate speaker `aisha_ha` | 200, valid audio, 5 069 ms |

**`technicalCertified: true`** — every sample returned decodable, non-silent
linear PCM within the stated budget. Hausa is the best-behaved of the four:
tightest latency, highest voiced fraction, most consistent duration.

## Igbo (`ig`)

Voice `036d27c0-448d-4d6c-a97c-9606a58a849e` → `ogechi_ig` (ig, female).
**10 samples, 10 succeeded, 0 silent.**

| | |
|---|---|
| Latency | min 4 170 · **median 6 062** · mean 7 135 · max 13 824 ms |
| Audio | 22 050 Hz, mono, 16-bit PCM; 1.83–11.89 s |
| Peak amplitude | 0.15–0.88 |
| Level (RMS) | −30.2 to −15.6 dBFS |
| Voiced fraction | 0.28–0.59 |
| Clipping | none |
| Same text, re-rendered | **1.96×** duration ratio (6.99 s / 3.58 s, 43 characters) |
| Alternate speaker `adaeze_ig` | 200, valid audio, 6 278 ms |

**`technicalCertified: true`.** Note the spread: the slowest sample took 3.3×
the fastest, and one 45-character sentence produced 11.89 s of audio.

## Yoruba (`yo`)

Voice `e8792ad0-97c9-4a09-aa14-a013b53a2772` → `olufunke_yo` (yo, female).
**10 samples, 10 succeeded, 0 silent.**

| | |
|---|---|
| Latency | min 5 290 · **median 6 697** · mean 7 106 · max 12 085 ms |
| Audio | 22 050 Hz, mono, 16-bit PCM; 3.36–10.98 s |
| Peak amplitude | 0.32–1.00 |
| Level (RMS) | −24.6 to −13.6 dBFS |
| Voiced fraction | 0.33–0.51 |
| Clipping | none this run (**5 of 10** on the preceding 10-sample run) |
| Same text, re-rendered | **1.78×** duration ratio (10.98 s / 6.17 s, 40 characters) |
| Alternate speaker `adeola_yo` | 200, valid audio, 6 918 ms |

**`technicalCertified: true`** — but see the two Yoruba anomalies below. This
is the language with the least stable output, and it is also the language the
product most needs, because no `opus-mt-en-yo` exists and Yoruba already
travels a longer route than Hausa or Igbo.

## Nigerian Pidgin (`pcm`)

Voice `ada_pcm` (pcm, female). **10 samples, 10 succeeded, 0 silent.**

| | |
|---|---|
| Latency | min 4 052 · **median 5 411** · mean 5 188 · max 5 703 ms |
| Audio | 22 050 Hz, mono, 16-bit PCM; 2.57–4.06 s |
| Peak amplitude | 0.23–0.80 |
| Level (RMS) | −30.0 to −20.5 dBFS |
| Voiced fraction | 0.24–0.49 |
| Clipping | none |
| Same text, re-rendered | 1.25× duration ratio |
| Alternate speaker | not run — the product voice already is the published name |

**`technicalCertified: true`.** Pidgin has the tightest durations of the four
and the lowest level. It is also the one language with **no chosen voice** —
`ada_pcm` is a vendor example that nobody has listened to — and, per
[`NIGERIAN_LANGUAGE_ROUTING.md`](../NIGERIAN_LANGUAGE_ROUTING.md), no MT model,
so a certified Pidgin *voice* still has nothing Pidgin to say.

---

## Findings that are real but are not certification failures

Each of these was measured. None changes `technicalCertified`, because the
audio genuinely plays — redefining the word after the numbers were in would be
the dishonest move. All of them belong in front of a human.

**1. The engine sleeps for far longer than the vendor claims.** The first
approach of the evening met **36 consecutive `503 {"detail":"Inference capacity
is starting after an idle period. Please retry shortly in about 5 minutes."}`
over 606 seconds** of continuous 15-second polling, and never served inside a
ten-minute budget. It served on the next attempt roughly a minute or two later
— so the true cold start was about **eleven to twelve minutes, more than double
the vendor's stated five**. Once warm it served the first request of every
later run in 3.1–6.2 s. *A demo that opens with a Nigerian-language sentence
fails unless the engine was warmed well beforehand, and 503 must be treated as
"warming, retry", never as "vendor down, fall back" — the fallback is the very
Azure rendering the founder refused by ear.*

**2. `/v1/health` is not a readiness signal, in either direction.** During the
run of record — with synthesis answering 200 in five seconds — health returned
`{"status":"starting","engine_ready":false,"current_copy_count":0,
"desired_copy_count":0}`. It said not-ready while serving perfectly. Anything
that gates on `engine_ready` (a warm-keeper, a health probe, an operator
badge) will be wrong. **Readiness must be established by a synthesis request,
not by `/v1/health`.**

**3. Output duration is not a function of the input text.** The same sentence,
sent twice in the same run, came back at **1.96× different length in Igbo** and
**1.78× in Yoruba** (a 40-character Yoruba sentence: 10.98 s once, 6.17 s the
other time). Voiced-energy time roughly doubled too — 5.6 s against 2.8 s — so
this is not padding silence, it is *more speech generated for identical input*.
Hausa (1.30×) and Pidgin (1.25×) are far tighter. This is the autoregressive
run-on signature, it is invisible to every server signal, and **only a speaker
of the language can say whether the extra audio is a slower reading or extra
words.** It is the single most important item to put in front of the reviewer.

For a live programme it also matters mechanically: a scheduler that budgeted
five seconds and receives eleven has to cut, and the cut lands mid-word in a
language the operator does not speak.

**4. A 93-second synthesis happened once.** On the preceding six-sample run, one
Yoruba request took **93 643 ms** and returned an ordinary 6.3 s clip. It did
not recur across the 20 later Yoruba samples. The endpoint is single-copy and
shared, so this may be contention rather than anything about Yoruba — **that
distinction is not resolved by this evidence** and should not be asserted
either way. It is recorded because a heavy tail on a live path is an outage
even when the median is healthy.

**5. Clipping.** Hausa clipped on 2 of 10 clips this run; Yoruba clipped on 5 of
10 on the preceding run (worst clip: 65 samples pinned at full scale; an earlier
Hausa clip reached 620). `ffmpeg volumedetect` agrees: `max_volume: -0.0
dB` with `histogram_0db` in the hundreds. Audible distortion that a reviewer
will naturally blame on the language model rather than on a gain stage.

**6. Level varies by about 15 dB between languages.** Hausa sits at −15 to −12
dBFS RMS; Pidgin at −30 to −20. A programme that cuts from Hausa to Pidgin
sounds like the second speaker walked away from the microphone. One shared
loudness-normalisation stage after synthesis fixes 5 and 6 together.

### Audio validity was cross-checked with a second decoder

Every figure above comes from the harness's own RIFF parser. `ffprobe` was run
independently over the retained clips and agrees to the millisecond —
`pcm_s16le, 22050, 1, 16`, `yo-1` 10.981950 s against the parser's 10.982 s,
`ig-3` 11.890340 s against 11.890 s. **Zero silent clips in 40 samples plus 3
alternate-speaker probes.**

---

## What the human language review requires

This is the open work. It is not blocked on anything technical.

1. A **named** speaker of each language — Hausa, Igbo, Yoruba and Pidgin
   separately. One reviewer's Yoruba judgement says nothing about Hausa.
2. Play the retained clips (or a fresh run's) and judge: is this the language,
   pronounced correctly, with plausible tone and stress? Yoruba and Igbo are
   tonal and the input text carries **no diacritics** — that is realistic,
   because the MT stage upstream emits undiacritised text, and it is exactly
   where tone will be guessed.
3. Specifically ask about finding 3: on the Yoruba sentence that rendered at
   10.98 s and again at 6.17 s, **is the long one saying more words?**
4. Record the outcome here as `passed` or `failed`, with the reviewer's name and
   the date, and only then may Lane F move `humanReviewStatus` off
   `required-not-done` for that one language.

Until then all four stay `required-not-done`, and that is the correct state —
not a gap in this work.

---

## What this evidence does not cover

Stated so nobody extends it.

- **It is synthesis evidence only.** Nothing here measures transcription or
  translation. A certified Yoruba *voice* with no `opus-mt-en-yo` still puts a
  Yoruba voice on air with nothing Yoruba to say.
- **It is staging evidence.** Production holds its own credentials in
  `/etc/videofy-prod/`. The vendor is the same, the key is not, and quota and
  rate limits are per key.
- **It is per language, and it stops there.** Hausa evidence is not Igbo
  evidence. Each table above stands alone by design.
- **It is one speaker per language.** 240 speakers exist; 4 were exercised as
  product defaults and 3 more as alternate-identity probes. A different speaker
  is a different voice and inherits nothing from this.
- **It says nothing about the streaming endpoint.** `/v1/audio/speech/stream`
  was not exercised; the adapter asks for the complete buffer, and
  `timeToFirstChunkMs` therefore equals total time.
- **It is not a scope approval.** `messaging`, `programme-live` and `call-live`
  have different tolerances — a 6.7 s median that is fine for a message is not
  fine for a live call — and those are Lane F's records to write.

---

## For the registry (Lane F)

Proposed, not written — this lane does not touch the registry.

Per language, `technicalEvidence` may be populated from the run of record above
(`sampleCount` 10, `successRate` 1.0, the latency quartet as tabled,
`recordedAt` `2026-08-30T23:26:10Z`), with `provider: "naijalingo"`,
`modelId: "9jalingo-tts-1"`, `executionClass: "cloud"`,
`humanReviewStatus: "required-not-done"` and `productionApproved: false` for
**all four languages**.

Two notes the record shape may not hold:

- `TranslationRouteRecord` has `sourceLanguage`/`targetLanguage`. This is a
  **synthesis** route, not a translation route: the meaningful key is
  (language, speaker id), and there is no field for the speaker id — which is
  precisely the thing certified, since another of the 240 speakers inherits
  none of this evidence.
- `licenceStatus` was not established by this lane. Commercial-use terms for
  9jaLingo output are a contract question, not a measurement, and are
  `unknown` here rather than assumed permitted.
