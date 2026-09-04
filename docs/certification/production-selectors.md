# Production provider selectors — RECOMMENDATION

**Status: a recommendation, not a change.** Nothing in this document has been applied.
No production service was started, restarted or reconfigured by the work that produced
it. The orchestrator applies these values to `/etc/videofy-prod/media-ingest.env` and
restarts; this file exists so that decision is made against evidence rather than against
a template nobody re-read.

Written 2026-08-31, reconciling the seven evidence lanes of the provider-certification
wave. Every line below names the measurement behind it and the file the measurement
lives in. Where there is no measurement, the line says so and the value is the one that
fails visibly rather than the one that looks capable.

---

## `mock` and `development-demo` appear nowhere in this recommendation

Stated explicitly because it is the one thing a reader should be able to confirm without
reading the rest.

- **`mock` appears on no selector line.** Not on `TRANSCRIPTION_PROVIDER`, not on
  `STREAMING_TRANSCRIPTION_PROVIDER`, not on `STREAMING_SYNTHESIS_PROVIDER`, not on
  `TEXT_TO_SPEECH_PROVIDER`, not on `TRANSLATION_PROVIDER`. A mock provider returns
  fabricated output carrying every success signal a real one has, so a deployment
  running one does not fail — it publishes invented words in somebody's programme, or
  speaks a sentence nobody said into somebody's call. `media-ingest` already refuses
  `mock` on the two streaming selectors and on batch transcription when
  `C7_ENVIRONMENT=production`; this recommendation does not rely on that guard, it
  simply never asks for the value.
- **`development-demo` appears nowhere.** `AI_RUNTIME_PROFILE` is `commercial-cloud`.
  `development-demo` is the staging profile and does not follow production; it is also
  the only profile that starts without asking the registry whether a certified provider
  exists, which is exactly the question production must not skip.

---

## The recommended values

```
AI_RUNTIME_PROFILE=commercial-cloud
TRANSCRIPTION_PROVIDER=off
STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova
STREAMING_SYNTHESIS_PROVIDER=chain
TRANSLATION_PROVIDER=opus-mt
TEXT_TO_SPEECH_PROVIDER=piper
DEEPGRAM_MODEL=nova-3
ELEVENLABS_MODEL=eleven_flash_v2_5
```

One line of evidence for each:

| Name | Value | Evidence |
|---|---|---|
| `AI_RUNTIME_PROFILE` | `commercial-cloud` | Gated, not declarative: `media-ingest` asks `commercialProfileBlockers({minimumStage:'certified'})` whether the profile may start and refuses with the blocker named. Setting it asks a question; it grants nothing. |
| `TRANSCRIPTION_PROVIDER` | `off` | **Changed from the template's `faster-whisper`.** faster-whisper is not installed in `/opt/videofy-ai` on the production box and no lane measured it; the template itself says the path "will fail when it is first attempted". `off` says that at boot instead of at first upload. See *The production crash loop* below — this line is also half of what has been restarting the service 7418 times. |
| `STREAMING_TRANSCRIPTION_PROVIDER` | `deepgram-nova` | 32 real-time samples through the deployed adapter from c7-eu-01: en-US mean WER 0.0111 and en-NG mean WER 0.0175 over 12 samples each, es 0.0000 over 8; median finalisation 284 / 319 / 343 ms from the last voiced sample. Bad key fails closed (401 at connect); 4 s of silence and 4 s of broadband noise invented no words. `docs/certification/deepgram.md`. |
| `STREAMING_SYNTHESIS_PROVIDER` | `chain` | The three-way fallback was driven with real vendor refusals: primary refuses → Azure serves 4.175 s of audio, 0 errors; primary healthy → Azure never called; **everybody refuses → the caller is told once, and silence is never served as if it were speech**. A single-vendor value here would discard the Nigerian ordering entirely. `docs/certification/tts-providers.md`. |
| `TRANSLATION_PROVIDER` | `opus-mt` | Twelve directions benchmarked twice through the deployed provider, medians within 1.3%. This selects the ENGINE only. Which *directions* production may invoke is decided by `packages/translation-routes`, and today it approves none — see *What this configuration does not turn on*. `docs/certification/opus-benchmarks.md`. |
| `TEXT_TO_SPEECH_PROVIDER` | `piper` | Unchanged, and unavailable: Piper is not installed on the box and no lane measured it. The selector admits only `mock`, `piper` and `piper+mms`, so there is no honest "off" — `piper` is the value that fails where somebody can see it, and `mock` is the value that succeeds while inventing speech. Batch synthesis is unavailable alongside batch transcription; one missing runtime, one unavailable path. |
| `DEEPGRAM_MODEL` | `nova-3` | **Must be written explicitly, not left blank.** Blank falls through to a hardcoded default in `live-provider-wiring.ts`, so a change to that default would silently change the production model with no configuration diff to review. `nova-3` is the model every accuracy figure above was measured on. |
| `ELEVENLABS_MODEL` | `eleven_flash_v2_5` | Same reason. Measured present-but-empty on staging, which means the model came from a code default; the fallback chain reported its own provider name as `elevenlabs-streaming:eleven_flash_v2_5`, so that is the model the numbers describe. |

### `deepgram-flux` is refused for this line

Not on protocol grounds — the adapter is correct — but on two measurements. It commits
a final in a median of 913 ms against nova-3's 284 ms, roughly 3x slower, and nothing
can be spoken until a final exists. And the model is single-language: until the fix in
this wave it accepted a session declaring Yoruba and returned fluent English. It now
refuses such a session at `openStream`, before any audio, but a recogniser that can only
hear English is not the recogniser for this platform's live path.

---

## The production crash loop, and why it is a configuration defect and not a code one

`videofy-prod-media-ingest.service` has been in `activating (auto-restart)` with
`NRestarts=7418` and climbing. `/etc/videofy-prod/media-ingest.env` carries
`TRANSCRIPTION_PROVIDER=` and `STREAMING_TRANSCRIPTION_PROVIDER=` — **present, and
empty**. Empty is not absent: `process.env['X'] ?? 'default'` treats an absent variable
as unset and a present-but-blank one as the literal empty string, so the documented
defaults never applied and the service died on `received ""`.

Two things follow, and they belong to different people.

1. **The env file contradicts the template shipped beside it.** The template sets
   `STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova`; the box has it blank. That is the
   orchestrator's to fix, with the values in the table above.
2. **The refusal named the value and not the cause.** Fixed in this wave:
   `services/media-ingest/src/config.ts` now refuses a blank selector with
   `"<NAME> is present but empty. A blank selector is not a choice: set it to one of …,
   or remove the line entirely to accept the default …"`. Pinned by
   `src/__tests__/blank-selector.test.ts`.

**Blank remains a refusal.** It was tempting to read an empty value as "unset, so take
the default" and end the crash loop in one character. That is the trap this repository
has been bitten by before: a blank line quietly choosing a provider is how an unapproved
engine reaches production without appearing in any diff. What changed is only that the
refusal is diagnosable.

Note also that the deployed production build **predates the current `config.ts`** — its
error text lacks the `off` option that the 30 Aug ruling added. Production is running an
older commit than staging, so `TRANSCRIPTION_PROVIDER=off` will not be accepted until it
is redeployed. Set the value and deploy together, or the box will crash-loop on a new
message instead of an old one.

---

## What this configuration does NOT turn on

This is the part most likely to be misread as a regression, so it is stated plainly.

**No translation direction is approved for any service.** `packages/translation-routes`
holds fourteen directions; every one is `productionApproved: false` and no scope is
`approved`. Twelve of them now carry real measurements — that is the point, and it is
why the refusals are specific rather than merely cautious. The four reasons are
independent, so closing any one changes nothing on its own:

1. **No human has read a single output**, in any language, on any route.
2. **Three defects live on every route**: blank and emoji-only input hallucinate
   confident invented sentences; digits are deleted or reformatted (`08031234567` →
   `080314567`); long input either times out for 120 s at concurrency 1 or is silently
   truncated to its first sentence.
3. **Latency is 4.8–9.1 s median for one short chat line**, and that on a box under load
   8.4–9.3 on 8 vCPU. The idle-box figure that would decide live use is unmeasured.
4. **Four directions the deployed service cannot invoke at all** — `pt->en`, `ha->en`,
   `ig->en`, `yo->en` are absent from `DEFAULT_OPUS_MT_LANGUAGE_MODELS`.

The messaging path consults that registry (`services/account/src/index.ts` →
`loadTranslationRouteRegistry()`), so **translated conversations will deliver the
original message with `translation.status: 'unavailable'`, `reason: 'no-route'`.** On
staging that will look like a regression against chat translation that works today. It
is the ruling working as written: an uncertified route may not be invoked. If a demo
needs translated chat, the honest way to get it is a human reviewer signing off a
direction, not an edit to the document.

`TRANSLATION_PROVIDER=opus-mt` is still the right value. It says which engine serves an
approved direction, not which directions are approved.

---

## Credential and voice settings that are not selectors but decide the same things

These were measured in this wave and are the difference between "a provider answered"
and "a provider answered correctly".

- **`ELEVENLABS_VOICE_IDS` and `AZURE_VOICE_IDS` are absent on staging**, so every
  Videofy voice id collapses to one vendor voice per vendor. For Azure the consequence
  is larger than a lost gender choice: with no map, **every target language on the Azure
  leg is spoken by `en-US-AvaMultilingualNeural`**. Production should not inherit that
  silently. At minimum, map `pcm` to `en-NG-EzinneNeural` / `en-NG-AbeoNeural` — those
  voices *are* hosted in northeurope and give Nigerian-accented English for the Pidgin
  route instead of American English. That is a founder decision about adequacy, not a
  certification; it does nothing for yo/ig/ha.
- **`AZURE_SPEECH_REGION`: northeurope hosts zero yo-NG, ig-NG or ha-NG voices.** 655
  voices across 154 locales were enumerated; the only Nigerian locale present is en-NG.
  Azure returns HTTP 200 for `xml:lang="yo-NG"` with an English voice and emits no
  error, header or field indicating the voice cannot speak the requested language. The
  platform's own `degraded-fallback` marking is the only signal that exists.
- **9jaLingo voices need no env line.** The founder's six chosen UUIDs are compiled in as
  `NAIJALINGO_SELECTED_VOICE_IDS`, and all six were verified against the live catalogue
  to resolve to the correct **language and gender**. Keep that check: a UUID belonging to
  the wrong language would be accepted with a 200 and would sound exactly like the defect
  the specialist was bought to avoid.
- **9jaLingo scales to zero and the cold start is ~11–12 minutes, not the vendor's stated
  five.** Measured: 36 consecutive 503s over 606 s of continuous polling. `/v1/health` is
  **not** a readiness signal — it reported `engine_ready:false` while synthesis was
  answering 200 in ~5 s, so anything gating on that field is wrong. Readiness must be
  established by a synthesis request. Any runbook or demo checklist derived from the
  vendor's 503 message is about half the true figure.
- **Production credentials were never exercised.** Every measurement in this wave used
  staging credentials. A key can be valid in one environment and not another, quota and
  rate limits are per key, and the ElevenLabs key's scope was such that `/v1/models` and
  `/v1/voices` both answered 401. **A connect-level probe against each production
  credential is owed before any production approval.**

---

## Two things that must be decided before any of this is applied

1. **`AZURE_SPEECH_KEY` being set is what puts Azure behind the Nigerian specialist.**
   There is no separate switch. With it set, a cold or failing 9jaLingo means ha/ig/yo/pcm
   are spoken by an American English voice; with it unset, they are silent. The 30 Aug
   ruling puts Azure there deliberately, so this recommendation leaves it — but it is a
   choice between a degraded voice and no voice, and it should be made knowingly rather
   than inherited from whether a key happens to be pasted.
2. **The route document has no production location.** `TRANSLATION_ROUTES_DOCUMENT` is
   set nowhere, so every environment falls back to the shipped document and refuses
   everything. That is the correct default. But it means the deploy lane must place a
   document somewhere durable — `/etc/videofy-prod/translation-routes.json` or
   equivalent — before any direction can ever be approved, and a single edit to that one
   file is the entire distance between "refused" and "live in call-live". Every
   validation rule still applies to that edit; nothing else does.
