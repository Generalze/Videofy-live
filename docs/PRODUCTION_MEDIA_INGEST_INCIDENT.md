# Production media-ingest: incident, determination, and the change I am not applying

**Status: PREPARED, NOT APPLIED.** Production has not been modified. Everything
below was read from `c7-eu-01`, and every credential is named rather than shown.

---

## 1. What is wrong

`videofy-prod-media-ingest.service` has never started. It exits at
configuration parsing and systemd restarts it, and had done so **106,722 times**
when this audit began.

```
Error: TRANSCRIPTION_PROVIDER must be "mock" or "faster-whisper"; received ""
  at loadConfig (…/media-ingest/dist/…/config.js:80)
videofy-prod-media-ingest.service: Scheduled restart job, restart counter is at 106722.
```

`videofy-prod-gateway` and `videofy-prod-account` are both `active (running)`.
**Production therefore looks alive while having no media ingest at all.**

The application is not at fault. It refuses to start rather than guess an
engine, which is the behaviour this repository deliberately keeps: a blank
selector is fatal precisely so that nobody silently defaults it. What failed is
the production environment file, and an operations layer that let a six-figure
crash loop stay invisible.

---

## 2. What production is actually running

| Fact | Value |
| --- | --- |
| Deployed SHA | `56db8462755fc825b863f41e3232225aa4d9ed75` |
| Relationship to this branch | **ancestor — production is 135 commits behind** |
| Built | 2026-08-30 21:27 |
| Unit | `ExecStart=/usr/bin/node dist/services/media-ingest/src/index.js`, `Restart=on-failure`, `StartLimitBurst=5` |
| Env file | `/etc/videofy-prod/media-ingest.env` (145 lines) |
| Node | v22.23.2 |
| FFmpeg / ffprobe | 6.1.1 |
| Python | 3.12.3 |

### The deployed configuration contract, read from the deployed `config.js`

| Selector | Values the DEPLOYED binary accepts | Values THIS BRANCH accepts |
| --- | --- | --- |
| `TRANSCRIPTION_PROVIDER` | `mock`, `faster-whisper` | `off`, `mock`, `faster-whisper` |
| `TEXT_TO_SPEECH_PROVIDER` | `mock`, `piper`, `piper+mms` | `mock`, `piper`, `piper+mms`, `streaming` |
| `STREAMING_TRANSCRIPTION_PROVIDER` | `off`, `mock`, `deepgram-nova`, … | same |
| `STREAMING_SYNTHESIS_PROVIDER` | `off`, `mock`, `elevenlabs`, `azure`, `chain` | same |
| `AI_RUNTIME_PROFILE` | `development-demo`, `commercial-local`, `commercial-cloud` | same |

**The deployed binary has no `off` for batch transcription and no `streaming`
for batch text-to-speech.** Both were added after `56db846`.

---

## 3. Why copying staging would have made things worse

Staging's selectors are:

```
AI_RUNTIME_PROFILE=development-demo
TRANSCRIPTION_PROVIDER=faster-whisper
TEXT_TO_SPEECH_PROVIDER=streaming
STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova
STREAMING_SYNTHESIS_PROVIDER=chain
TRANSLATION_PROVIDER=opus-mt
```

Three of those are wrong for production, for three different reasons:

1. **`TEXT_TO_SPEECH_PROVIDER=streaming` is not a value the deployed binary
   accepts.** Copying it turns "crash on empty" into "crash on unsupported",
   which is a different failure wearing the same clothes.
2. **`TRANSCRIPTION_PROVIDER=faster-whisper` names an engine that is not
   installed on the production host.** `faster_whisper` is not importable by
   the system Python and there is no virtual environment anywhere under
   `/srv`. The service would start and then fail at the first upload.
3. **`AI_RUNTIME_PROFILE=development-demo` is a development profile.** It is
   the value that permits mock providers.

This is the second time this class has bitten: blank was not a choice, and
neither is "whatever staging says".

---

## 4. The selector matrix

`SET` / `EMPTY` below is about presence, never value. No secret is printed.

| Variable | Production now | Staging | Deployed allows | Branch allows | Runtime installed? | Proposed for production | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AI_RUNTIME_PROFILE` | EMPTY | `development-demo` | 3 profiles | same | n/a | `commercial-cloud` | Production uses cloud providers and must not permit mock. |
| `TRANSCRIPTION_PROVIDER` | EMPTY | `faster-whisper` | `mock`,`faster-whisper` | `+off` | **NO** — not importable, no venv | `off` | Batch upload transcription has no installed engine. `off` is truthful; `mock` fabricates transcripts. **Requires the newer binary.** |
| `TEXT_TO_SPEECH_PROVIDER` | EMPTY | `streaming` | `mock`,`piper`,`piper+mms` | `+streaming` | **NO** — piper not on PATH | `streaming` | Batch speech is served by the live stack. **Requires the newer binary.** |
| `STREAMING_TRANSCRIPTION_PROVIDER` | EMPTY | `deepgram-nova` | includes `deepgram-nova` | same | credential SET | `deepgram-nova` | The live path this deployment actually serves. |
| `STREAMING_SYNTHESIS_PROVIDER` | EMPTY | `chain` | includes `chain` | same | ElevenLabs + Azure SET | `chain` | Accepted by both binaries; Azure covers the Nigerian languages. |
| `TRANSLATION_PROVIDER` | `opus-mt` | `opus-mt` | — | — | — | unchanged | Already set and consistent. |

### Credentials in production, by name

**SET:** `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_DEFAULT_VOICE_ID`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`,
`AZURE_DEFAULT_VOICE_ID`.

**EMPTY:** every `NAIJALINGO_*` and every `GOOGLE_*`. `NAIJALINGO_API_KEY` is
absent from the file entirely.

Empty optional credentials are not defects. The consequence is stated rather
than hidden: **production has no Nigerian language specialist**, so Yoruba,
Igbo, Hausa and Pidgin would be served by the Azure fallback that mispronounces
them, and the readiness ladder on this branch reports that provider as
unconfigured rather than approved.

---

## 5. Determination: **CODE + CONFIG. Config-only is impossible.**

For the deployed binary there is **no truthful production value** for either
batch selector:

- `TRANSCRIPTION_PROVIDER` must be `mock` or `faster-whisper`. The engine is
  not installed, and `mock` fabricates transcripts.
- `TEXT_TO_SPEECH_PROVIDER` must be `mock`, `piper` or `piper+mms`. Piper is
  not installed, and `mock` fabricates speech.

A running service that fabricates output is worse than a stopped one, so there
is no env-only repair that is both green and honest. **The production repair
requires deploying a qualified newer build**, which has `off` and `streaming`.

Two options for that build, and I recommend the first:

- **Recommended: deploy the certified candidate from this wave** once the
  remaining certification work lands, so production moves from 135 commits
  behind to a build that has been through the full gate.
- Alternative: cherry-pick only the config-contract commits onto `56db846`.
  Smaller, and it puts a build into production that no full run has covered.

Either way the env change below is the same, and neither may be applied to the
old binary.

---

## 6. The exact proposed env change

Against `/etc/videofy-prod/media-ingest.env`, five lines, all currently blank:

```diff
-AI_RUNTIME_PROFILE=
+AI_RUNTIME_PROFILE=commercial-cloud
-TRANSCRIPTION_PROVIDER=
+TRANSCRIPTION_PROVIDER=off
-TEXT_TO_SPEECH_PROVIDER=
+TEXT_TO_SPEECH_PROVIDER=streaming
-STREAMING_TRANSCRIPTION_PROVIDER=
+STREAMING_TRANSCRIPTION_PROVIDER=deepgram-nova
-STREAMING_SYNTHESIS_PROVIDER=
+STREAMING_SYNTHESIS_PROVIDER=chain
```

Nothing else changes. The remaining empty variables are optional credentials
whose absence is a stated capability limit, not a startup fault.

**This diff is invalid against the currently deployed binary** — `off` and
`streaming` would both be rejected. It may only be applied together with the
newer build.

---

## 7. Validation and rollback, prepared and not executed

```
 1. back up the env, preserving mode/owner:
      cp -a media-ingest.env media-ingest.env.<ISO8601>.bak
 2. render the candidate to media-ingest.env.candidate (not in place)
 3. validate with the NEW binary and no port bound:
      PORT=0 node dist/.../index.js --check       # config parse only
    the gate is: exits 0, and prints no secret
 4. grep the validation output for every credential NAME; require zero values
 5. stop the restart storm for the window:
      systemctl stop videofy-prod-media-ingest
 6. install atomically: mv candidate -> media-ingest.env  (same filesystem)
 7. systemctl daemon-reload   # only if the unit file itself changed
 8. systemctl start videofy-prod-media-ingest
 9. require: systemctl is-active = active
10. require STABLE uptime: NRestarts unchanged after 120 s
      -- one successful start is not recovery; the loop started successfully
         106,722 times
11. probe /health on the internal address; require translation engine "real"
12. probe the gateway -> media-ingest join; require connectedToGateway true
13. require NO mock provider active in the boot lines
14. require the readiness ladder to report the expected rung per provider
15. watch journal + NRestarts for a 15-minute observation window
16. rollback on any failed gate:
      systemctl stop; mv the .bak back; redeploy previous build; start; verify
```

Rollback is a file move and a build swap, both on one filesystem, both
reversible without data loss: media-ingest holds no production database.

---

## 8. What must not be done

- **Do not set any production transcription or synthesis path to `mock`.** It
  would make the unit green and publish fabricated transcripts and speech.
- **Do not remove the blank-is-fatal check** to make an empty value default.
  That check is the only reason this was ever visible.
- **Do not apply the env diff to `56db846`.**
