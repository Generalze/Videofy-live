# Nigerian language routing: the approved voice, then nothing

Owner: masterzee001. Current ruling: **18 Sep 2026**. Applies to `ha`, `ig`,
`yo`, `pcm`.

## The rule

For those four target languages the text-to-speech chain is:

1. **ElevenLabs** (`elevenlabs`) -- the approved voice.
2. Nothing.

**Azure is not a fallback for these four.** It returns HTTP 200 and plausible
audio and pronounces them wrongly, so its presence bought a second wrong
rendering rather than a second chance. **9jaLingo is not routed at all**: the
founder's finding, stated more than once, is that it does not work and
ElevenLabs does, having heard all three languages spoken by both.

Silence is therefore the outcome when the approved voice cannot answer. That is
deliberate. Audio that plays and is wrongly pronounced cannot be detected by
anyone who does not speak the language, and every server signal calls it
success; a failure somebody can read beats a success nobody can check.

Every other language keeps its existing chain (ElevenLabs, then Azure)
untouched. This is a per-language route, not a whole-deployment choice.

## Where the rule lives, and the seam that made this section necessary

The rule lives in exactly one place:
`services/ai-registry/src/commercial-routing.ts`, as
`NIGERIAN_SPECIALIST_LANGUAGES`, `NIGERIAN_SPECIALIST_PROVIDER_ID`,
`NIGERIAN_FALLBACK_PROVIDER_ID` and `NIGERIAN_TTS_ROUTE_ORDER`.

**It did not, for three weeks, and that is worth recording.** On 18 Sep 2026 the
ruling was implemented in `ai-registry`, thirteen pinned tests were rewritten to
assert it, the change was reviewed and DEPLOYED -- and production went on
speaking Yoruba with Azure. `media-ingest`'s `withNigerianSpecialist` imported
the LANGUAGES from `ai-registry` and restated the VENDOR inline, under a comment
claiming "nothing here restates them". Changing the constant moved nothing. The
live boot log said:

```
"speaks":"routed(ha,ig,pcm,yo -> azure-speech:tts-northeurope; * -> elevenlabs-streaming:eleven_flash_v2_5)"
```

Selecting a vendor is now a **lookup** in `NIGERIAN_VOICE_VENDORS`, keyed by
`NIGERIAN_SPECIALIST_PROVIDER_ID`, and an id with no builder throws at startup.
The wiring suite derives its expectations from the constants rather than naming
a vendor, so a future ruling that changes one and not the other fails a test
instead of shipping.

## Activation

```
ELEVENLABS_API_KEY=<the key>
ELEVENLABS_DEFAULT_VOICE_ID=<a voice id in that account>
ELEVENLABS_VOICE_IDS=yo:female=<id>,yo:male=<id>,...   # optional, per platform voice
```

Both of the first two are required, and their absence is reported at WARN
naming them: without them these four languages FAIL rather than falling to
Azure. A boot preflight calls `GET /v1/voices` once and reports whether the
configured voice ids are actually in the account -- the quiet failure being a
valid key whose account lacks the voice, which answers 200 to every check
except the first sentence of a broadcast.

**One product consequence, not yet decided.** 9jaLingo had a distinct chosen
speaker per language; ElevenLabs voices are multilingual, so unless a
deployment maps a separate voice per language in `ELEVENLABS_VOICE_IDS`, yo, ig
and ha share one voice. Whether that is wanted is a decision for whoever chose
the voices by ear.

## 9jaLingo is kept, and unrouted

The adapter, its warm keeper and its preflight remain in the tree and are
covered by tests. This is deliberate rather than an oversight: it is the only
working implementation this repository has of a vendor whose capacity **scales
to zero**, a shape that cost a measured staging programme on 31 Aug 2026 when
every routing decision was correct and the founder still heard the wrong voice
for five minutes. `warm-keeper-join.test.ts` mocks the ruling to keep that join
proved for whoever next selects such a vendor.

Everything below this line is the 30 Aug 2026 ruling and the evidence behind
it. **The reasoning still stands and is why the change was made this way rather
than by deleting the rule: these languages are decided by a listener, never by
a vendor returning HTTP 200. Only the answer to "which vendor" has changed.**
Read the vendor names below as history.

---

## Why a specialist, and why the fallback is labelled

A listening test on 26 Aug 2026 established the finding this entire wave is
built around: **ElevenLabs and Azure both return HTTP 200 with real, fluent-
sounding audio for Yoruba, Hausa and Igbo, and the audio is wrong.** A
multilingual voice reads unfamiliar orthography with the phonology it already
has. The status is 200, the byte count is plausible, the latency is normal.
Nothing on a server can see it. Only a speaker of the language can.

Three consequences, and they are not negotiable:

- **Never infer language quality from a status code.** A successful request is
  evidence that a request succeeded, and nothing else.
- **Never mark a language as good because a call worked.** The registry grades
  evidence (`live` / `declared` / `claimed` / `none`); a 200 is not a grade.
- **When the specialist is unavailable, the rendering is DEGRADED and says so**
  -- on the synthesis result, in the state the operator console and `/health`
  read, and in a WARN log naming the language and the reason.

"Enable everything" must never become "claim everything is good".

## Activation: paste the key

```
NAIJALINGO_API_KEY=<the key>
```

That is the whole activation. Restart media-ingest. Everything else has a
published default, read from the official `naijalingo` npm SDK (0.1.3 -- README
plus compiled `dist/index.js`, read 30 Aug 2026), which states four things the
vendor's documentation page still does not:

| | value | source |
|---|---|---|
| base URL | `https://api.9jalingo.org` | SDK `DEFAULT_BASE_URL` |
| auth | `X-API-Key: <key>` -- raw key, **no scheme** | SDK `BaseClient` |
| speech | `POST /v1/audio/speech` | SDK |
| streaming | `POST /v1/audio/speech/stream` | SDK |
| health | `GET /v1/health` | SDK |
| speakers | `GET /v1/speakers` | SDK |
| model | `9jalingo-tts-1` | SDK `DEFAULT_MODEL_NAME` |
| languages | `ha`, `ig`, `yo`, `pcm` | SDK |
| formats | `wav` `pcm` `mp3` `flac` `aac` `alac` `ogg` | SDK |

The previous implementation **guessed** the auth header. `Authorization: Bearer`
is the obvious guess -- the request body is OpenAI-shaped -- and it would have
failed every call with a 401 that a reader would blame on the key. The adapter's
401 message now names the header it sent, because a wrong header and a wrong key
are indistinguishable from the status alone.

### Optional overrides

| variable | default |
|---|---|
| `NAIJALINGO_BASE_URL` | `https://api.9jalingo.org` |
| `NAIJALINGO_MODEL` | `9jalingo-tts-1` |
| `NAIJALINGO_AUTH_HEADER` | `x-api-key` |
| `NAIJALINGO_AUTH_SCHEME` | empty (raw key) |
| `NAIJALINGO_VOICE_BY_LANGUAGE` | the published example speaker per language |
| `NAIJALINGO_VOICE_IDS` | per-Videofy-voice speaker ids |
| `NAIJALINGO_DEFAULT_VOICE` | last-resort speaker id |
| `NAIJALINGO_RESPONSE_FORMAT` | `wav` |
| `NAIJALINGO_SAMPLE_RATE` | unset; **required** only for `pcm` |

## A voice is a SPEAKER ID, never a language code

`yo` is a language. `adeola_yo` is a voice. The two fields sit next to each
other in the request and hold similar-looking strings, and the vendor's own SDK
raises an error for this exact mistake -- which is how we know it is common.

The adapter refuses it with a named error, at construction time for
`NAIJALINGO_DEFAULT_VOICE` and at request time for a mapped voice, rather than
letting it reach the vendor as a 4xx that reads like a bad key or an outage.

Published example speakers (SDK README, "Supported Languages"): `aisha_ha`,
`adaeze_ig`, `adeola_yo`, `ada_pcm`. These are defaults, not recommendations:
a speaker id that will be *accepted* is not a voice anyone has *listened to*.

## The sample rate is read, never guessed

The PCM sample rate is **still unpublished** -- not on the docs page, not in the
SDK. It is not guessed, and it is not going to be.

A wrong host looks like a network outage. A wrong header looks like a bad key.
A wrong sample rate **looks like nothing at all**: audio arrives, the byte count
is plausible, and it plays at the wrong pitch and speed in a language the
reviewer may not speak.

So the adapter requests `wav`, which carries its own rate in its RIFF header,
parses that header (walking the chunks, because real encoders insert `LIST` and
`fact` between `fmt ` and `data`), and resamples from the **declared** rate to
the engine's 16 kHz. The configuration variable was a guess; the header is a
fact the vendor sends with every response.

Raw `pcm` remains available for a deployment that has *measured* the rate, and
that path refuses to start without `NAIJALINGO_SAMPLE_RATE`.

## The preflight

`GET /v1/health` and `GET /v1/speakers`, run at boot, reported as one line.

```
9jaLingo preflight: reachable, speakers ha=<n> ig=<n> yo=<n> pcm=<n>
9jaLingo preflight: NAIJALINGO_API_KEY absent -- ha/ig/yo/pcm will be served by the Azure fallback, which mispronounces them.
9jaLingo preflight: NOT reachable -- /v1/health returned 401 (sent as the 'x-api-key' header)
```

The counts above are placeholders: nothing here has been run against the vendor.

It exists because every way "paste the key" goes wrong is quiet: a key that is
valid but has no plan, a key whose speaker catalogue does not cover Yoruba, a
header the vendor changed. All three end as a fallback that sounds like a
working product to anyone who does not speak the language, so the moment to find
out is before the demo rather than during it.

It **never throws and never fails the boot** -- a vendor outage must not become
an outage here, which is the coupling the fallback exists to avoid -- and it
**names only**: no key, and no value of one, reaches any report or log line. An
absent key is reported as *absent*, with no request attempted, rather than as a
rejected one.

Programmatic entry points:

- `preflightNaijaLingo(config)` and `describeNaijaLingoPreflight(preflight)` in
  `services/media-ingest/src/providers/naijalingo/streaming-tts.ts`
- `preflightNigerianSpecialist(env)` in
  `services/media-ingest/src/live-provider-wiring.ts` (same question, this
  deployment's values)

## Degraded labelling

When Azure serves one of the four languages instead of 9jaLingo:

1. The synthesis result carries `degraded: { language, expectedProvider, servedBy, reason }`.
2. `nigerianLanguageSynthesis` on `GET /health` reports `degraded: true`, the
   per-language rendering (`specialist` / `degraded-fallback` / `failed` /
   `not-attempted`), the counts, and the last preflight.
3. A **WARN** line is logged naming the language, the expected provider, the
   provider that answered, and why.

Deliberate distinctions, because collapsing them hides both halves:

- An **abort** is not degradation. The sentence was cancelled on purpose and
  nobody heard it.
- **Everything failing** is `failed`, not `degraded`. Degraded means the wrong
  voice spoke; silence is a different problem with a different fix.
- A language **nobody asked for** is `not-attempted`, not healthy. Reporting
  "no problems" for a language nobody used is how a broken specialist survives
  a demo.
- Once degraded, the state **stays** degraded. A listener already heard it.

No key at all is itself a degraded state, reported from boot: every sentence in
those four languages is then a fallback rendering.

## What is still not proven

`naijalingo` sits at integration stage `configured`, not `integrated`, and it
stays there. **No key exists yet, so this adapter has never been run against the
vendor.** Having read a contract is not evidence of having spoken it.

Nothing here is a claim that the Yoruba, Hausa, Igbo or Pidgin output is good.
That claim requires a speaker of the language listening to it, and no code
change can produce it.

## Files

- `services/ai-registry/src/commercial-routing.ts` -- the rule, single source
- `services/ai-registry/src/commercial-providers.ts` -- the vendor record and its citations
- `services/media-ingest/src/providers/naijalingo/streaming-tts.ts` -- adapter, WAV parse, preflight
- `services/media-ingest/src/nigerian-synthesis-route.ts` -- the chain and the degraded marker
- `services/media-ingest/src/live-provider-wiring.ts` -- activation and boot logging
- `deploy/{staging,production}/env-templates/media-ingest.env.template`
