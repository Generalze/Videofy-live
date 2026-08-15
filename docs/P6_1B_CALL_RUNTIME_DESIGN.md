# P6.1B Native Call Runtime — Design Note and Interface Contract

- **Repository owner:** masterzee001
- **Date:** 2026-08-14
- **Milestone:** P6.1B — Native two-person call runtime (development profile)
- **Status:** Accepted for implementation; owner approval remains the closure gate

## Locked design decisions for this wave

1. **`services/call-session` is a pure core library hosted by the gateway**, following the
   accepted `language-router` precedent from P6.0: the package owns call/participant state,
   preference authority, revision bumps, and routing decisions; the gateway owns Socket.IO,
   rooms, and WebRTC transport. This preserves the §25.1 service boundary without introducing a
   second signalling stack; a separately deployed runtime remains possible later.
2. **No second AI pipeline (§28.4).** Each participant's raw microphone feeds the existing
   gateway backend media peer + transcription bridge into a per-participant media-ingest WebRTC
   session (`sourceLanguage` = participant's spoken language, `targetLanguages` = other
   participants' preferred languages). Translation and TTS run through the same providers the
   programme path uses.
3. **Audio-first call.** Camera video is explicitly deferred to P6.1C polish; §30.4's speech,
   caption, translated-audio, routing, feedback-isolation, reconnect, and cleanup criteria are
   all audio-scoped and are the target of this wave.
4. **Feedback isolation is structural.** The browser publishes only its `getUserMedia`
   microphone track to the backend peer. Generated/translated audio arrives as URL events and is
   played through a local audio queue that is never republished. Remote original audio arrives on
   a receive-only backend listener peer.
5. **Recipient-scoped delivery.** Captions and generated audio are emitted only to
   `call:{callId}:participant:{participantId}` rooms. Nothing call-scoped is broadcast to
   programme/language rooms, and legacy programme events are unchanged.
6. **Per-session standard-voice selection.** Media-ingest WebRTC sessions accept an optional
   `voiceIdsByLanguage` override so each recipient's Male/Female choice selects the registered
   Piper voice (en: `en_US-hfc_male-medium`/`en_US-hfc_female-medium`; es:
   `es_ES-sharvard-male`/`es_ES-sharvard-female`). This parameterizes the existing voice
   registry; it does not fork the pipeline.
7. **Collision-safe naming.** All new socket events use the `call:` prefix; all new contracts
   come from `@videofy-live/call-contracts` / `@videofy-live/participant-contracts`.

## Socket contract (gateway boundary)

Client → gateway:

| Event | Payload | Ack |
| --- | --- | --- |
| `call:join` | `{ callId, displayName, speakLanguage: 'en'\|'es', hearLanguage: 'en'\|'es', captionsEnabled: boolean, voiceGender: 'male'\|'female', audioMode: 'translated'\|'interpretation'\|'original', resumeParticipantId?: string, resumeToken?: string }` | `{ ok: true, participantId, resumeToken, snapshot } \| { ok: false, error }` |
| `call:leave` | `{ callId, participantId }` | `{ ok: boolean }` |
| `call:publish:offer` | `{ callId, participantId, sdp }` — mic publish peer | `{ ok, sdp? }` (answer) |
| `call:publish:ice` | `{ callId, participantId, candidate }` | — |
| `call:receive:offer` | `{ callId, participantId, sdp }` — remote-original receive peer | `{ ok, sdp? }` |
| `call:receive:ice` | `{ callId, participantId, candidate }` | — |

Gateway → client (recipient-scoped unless noted):

| Event | Payload |
| --- | --- |
| `call:state` (call room) | Sanitized session snapshot: participants `{ participantId, displayName, speakLanguage, hearLanguage, joined }`, lifecycle state. No provider/model/worker internals. |
| `call:caption` | `{ callId, speakerParticipantId, speakerDisplayName, sourceLanguage, targetLanguage, originalText, translatedText, sequence, mediaRevision, languageRevision, startMs, endMs, isFinal }` |
| `call:generated-audio` | `{ callId, speakerParticipantId, targetLanguage, voiceId, audioUrl, sequence, startMs, durationMs, mediaRevision, languageRevision }` |
| `call:publish:ice` / `call:receive:ice` | Trickle candidates for the two peers. |
| `call:error` | `{ code, message }` — user-facing wording only. |

## Data flow (per direction)

```text
A mic (getUserMedia, raw only)
  -> call:publish peer -> gateway backend media peer (per participant)
  -> transcription bridge -> media-ingest WebRTC session
       sourceLanguage = A.speak, targetLanguages = [B.hear], voiceIdsByLanguage = B's M/F pick
  -> STT -> canonical transcript -> translation (A.speak -> B.hear) -> Piper TTS
  -> gateway maps session events -> call:caption + call:generated-audio -> B's participant room
B hears: A's original audio (receive peer, mix-mode volume/duck) + A's translated voice (audio queue)
```

Reverse direction is symmetric. When `A.speak === B.hear` (same-language pair), translation/TTS
are skipped for that direction and captions deliver the original transcript.

## Ownership map for this wave

| Area | Owner |
| --- | --- |
| Root wiring, workspaces, CI, docs, integration | Acting lead |
| `services/call-session` (pure core + tests) | Session agent |
| `apps/call-web` (UI + transports + tests) | Frontend agent |
| Gateway `call:` wiring + media-ingest `voiceIdsByLanguage` (+ tests) | Runtime agent |
| Independent adversarial review before landing | Review agent |

## Post-review hardening (adversarial-review corrections, same wave)

- **Revision-scoped ingest identity:** ingest/broadcast ids are
  `call_{callId}_{participantId}_r{mediaRevision}` / `callcast_..._r{mediaRevision}`, so events
  and deferred stops from an old revision can never touch the replacement session.
- **Membership-change revision bumps:** every successful join or resume bumps the mediaRevision
  of ALL connected participants, so each speaker's ingest session is recreated with the current
  recipient set and voice choices.
- **Resume authentication:** the join ack privately returns a random `resumeToken`; resume
  requires participantId + token. Tokens never appear in `call:state`. The client persists
  `{callId, participantId, resumeToken}` in `sessionStorage` so a page reload can resume.
- **Disconnect grace reaper:** a disconnected seat not resumed within the grace period
  (default 120 s) is auto-left, freeing the seat and cleaning all state; captions/audio and
  same-language `translatedText: null` payloads are handled null-safely by the client.
- **Retired-session deletion:** after retiring an old-revision ingest session, the gateway
  deletes it from media-ingest (guarded internal endpoint, `call_` ids only) so membership
  churn cannot accumulate stopped sessions or output directories.
- **Accepted boundary loss:** retiring an old revision drops up to one in-flight chunk (~5 s)
  of the other speaker's speech at each join/resume boundary (captions/translated audio only;
  raw audio fan-out is unaffected). Recorded as a deliberate trade for revision safety.
- **Natural pacing (owner live-test finding):** the programme pipeline's window-fit
  (`length_scale` pre-fit + `atempo`) compressed call translations into the source segment and
  made them fast and clipped. Call ingest sessions now send `generatedAudioPacing: 'natural'`;
  translated speech keeps the voice's own pace and full length (loudnorm retained). Verified by
  unit tests at provider/session/bridge/runtime layers and a driven two-browser EN→FR run
  producing seven natural-length clips (0.9–3.6 s, tracking phrase length).

## Language update (owner decision, 2026-08-14)

**English–French is the constant development pair** — French verifiers are easier to source.
Call languages are now `en`/`fr`/`es`: French joins with validated duplex routes
(`opus-mt-en-fr`/`opus-mt-fr-en`), multilingual STT coverage, and registered Male/Female
development voices (`fr_FR-upmc-pierre`, `fr_FR-siwis-medium`); Spanish stays fully supported
with its P6.1A evidence.

## Call resilience (owner live-test finding: "translation is not persistent")

Live calls used to lose translation permanently after a single bad chunk, while the
untranslated voice kept flowing. Two compounding causes, both fixed for `call_` sessions only
(programme/Live keeps its existing strict behavior):

1. **Timeline contiguity vs VAD segmentation (the dominant cause).** Chunk acceptance required
   each chunk to start exactly where the previous one ended. That is correct for programme media
   (one continuous file timeline) but wrong for a call: VAD emits chunks around *speech*, so
   every natural pause is a legitimate gap. The first utterance was accepted and every later one
   was rejected with *"gap or overlap detected"* — for the rest of the call. Call sessions now
   accept a forward gap; overlap (starting before the previous chunk ended) still fails. Found
   from a real owner call log after synthetic tests missed it: they generated contiguous
   timestamps, which real speech never produces.
2. **Fatal per-chunk failure.** Any chunk error called `failWebRtcSession`, so the session left
   `processing` and media-ingest rejected every later utterance with *"chunks can only be
   accepted while the session is processing"* — with no recovery path. Call sessions now record
   the failure (`webrtcTranscriptionBridge.failedChunks`, `lastError`, monitoring) and stay
   `processing`.
3. **Strict sequence contiguity.** The expected chunk sequence was the count of *stored* chunks,
   so one dropped chunk made every later chunk "out of order" forever. Call sessions now require
   a strictly increasing sequence and tolerate gaps; duplicates and stale chunks are still
   rejected.

Measured after the fix (development machine, warm workers): 2.5–3.4 s per utterance end to end,
and 5/5 chunks accepted at a 3.5 s speech cadence.

**Known remaining limitation.** When utterances arrive faster than the pipeline processes them,
a chunk that arrives while another is in flight is rejected (`duplicate-processing`) and lost
rather than queued. It is now non-fatal — the call continues — but sustained rapid speech will
drop some utterances. Queuing with bounded depth is the next improvement.

Developer telemetry used to find this lives at `GET /internal/diagnostics` on the gateway
(`WEBRTC_DIAGNOSTICS_ENABLED=true`, internal-token gated), reporting per-bridge-session chunker
emission, queue depth, skipped frames, dropped VAD segments and failures.

## Streaming partial captions (§22.1, wave after P6.1C acceptance)

Captions used to appear only after the speaker paused, because a VAD segment is only closed by
silence. A speaker who talks for six seconds saw nothing for six seconds. Interim chunks close
that gap: while a segment is still open, the chunker re-emits the audio so far every
`WEBRTC_PARTIAL_CAPTION_INTERVAL_MS` (default 1500 ms, `0` disables) so a caption can be shown
mid-sentence.

The contract in one line: **a partial is a preview, never a record.**

- A partial carries the *same* `sequence` and `startMs` as the final chunk that will close its
  segment, and an `endMs` at the current speech position. It is a strict prefix of the final,
  so `(sequence, partialSequence ?? 'final')` is the identity a caption surface upserts on, and
  the final supersedes every partial before it.
- Emitting a partial changes nothing the final depends on: the sequence counter, the emitted
  timeline, pending discontinuity flags and queue accounting are all left alone. With partials
  off, emission is byte-identical to before.
- Programme sessions never emit partials — their recorded timeline is the product. Partials are
  call-only, and media-ingest rejects a partial on a programme session outright.
- Partials never join `audioExtraction.chunks`, never persist into the transcription/translation
  event arrays, and never generate speech. Their staged audio is deleted as soon as it is
  transcribed. Only finals form the durable record and produce voice.
- Under load a partial is *dropped*, never queued: anything already waiting would delay it past
  the point where a newer partial (or the final) supersedes it, and queueing it behind a final
  would push that final's caption later — the one thing a preview must never do.

Two correctness details that took a second pass to get right:

1. **The zod schemas strip undeclared keys.** `isFinal` and `partialSequence` had to be declared
   in `@videofy-live/media-contracts` as well as the shared-types interfaces, or the flag was
   silently removed in transit and every partial arrived looking final. Absence of `isFinal`
   means final, so every existing producer stays valid.
2. **A failed preview is not lost speech.** Partials are frequent and transcribing half an
   utterance is the likeliest thing to time out, so folding their failures into
   `failedChunks`/`lastError` would bury real speech loss in expected noise — on the exact
   surface used to diagnose it. Failed partials are counted separately
   (`failedPartialChunks`/`lastPartialError` on the bridge metadata, `partialSubmissionFailureCount`
   on the gateway) and never mark the call as faulted.

Delivery-latency statistics deliberately sample finals only, so the summary keeps meaning "time
to deliver a completed utterance"; partials are faster by construction and would flatter it.

Measured on a real two-browser EN↔FR call (`partial-9888`): 80 partial captions delivered
alongside 58 finals, **median 1700 ms earlier** than the final for the same utterance, no audio
generated for previews, zero ingest faults, and §30.4 still 7/7 with final-caption delivery at
median 529 ms / p90 1796 ms.

## Per-call model warm-up (§22)

`faster-whisper` is warmed when media-ingest starts, but each OPUS-MT language pair and each
Piper voice loads lazily on first use. The opening utterance of every call therefore paid for
loading them — the worst possible moment, since it is the part a demo audience watches.

When a native call ingest session is created its language pair and primary voice are now warmed
in the background, via the ordinary `translate`/`generate` calls so no provider interface has to
widen. It is fire-and-forget and failure-proof: a failed warm-up must leave the call exactly as
it would have been with none.

Controlled A/B, identical chunks through a freshly restarted service (so speech density cannot
confound it), measuring the first utterance's penalty over the same session's steady state:

| | run 1 | run 2 | steady state |
|---|---|---|---|
| warm-up off | 1001 ms | 941 ms | 1206 / 1308 ms |
| warm-up on | 540 ms | 680 ms | 1202 / 1204 ms |

So it removes roughly 360 ms from the first utterance and leaves steady state untouched. Real
and reproducible, but modest — worth knowing before anyone budgets a larger effort against it.

Guards, each of which exists because an adversarial review found the failure first:

- The background promise carries a `.catch`, and path construction (which validates the session
  id and language, and can throw) sits inside the guarded region. An unhandled rejection here
  would be fatal to the process and would take every live call with it.
- Auto-detect calls are skipped: the source language is still the default until the first chunk
  reconciles it, so warming would load the wrong pair *and* occupy the single translation slot
  exactly when the first real utterance needs it.
- Speech is warmed only for the primary target (the only language the final path synthesizes)
  and only when that language actually has a voice. Otherwise a captions-only language falls
  through to the default voice id and produces a guaranteed-failing probe on every call.
- Probes go through the same timeout wrappers as real work, so a hung probe cannot hold the
  single-concurrency translation slot against live speech.
- A 4xx failure is remembered rather than retried, so a misconfiguration costs one attempt per
  process instead of one per call. Transient failures still retry.
- Both the requested output and the engines' raw staging files are removed; if the call was
  retired mid-warm-up, the recreated session directory is removed with them.

## Open: pipeline saturation under dense speech

Two-browser runs show the pipeline holding roughly 500 ms caption delivery at ~1.2 caption
events per second, but falling behind at ~2.4 events per second — one run drained a backlog at an
8.5 s median with a 13.7 s p90. Speech-to-text, translation (single concurrency) and speech
synthesis are shared across all participants, so the ceiling is global rather than per-session,
and streaming partials roughly double the event rate.

A global shed (dropping previews whenever any call is mid-transcription) was implemented and then
**reverted**: it cut delivered partials by about 60% while the browser harness was too noisy —
utterance density varied between runs by more than the effect being measured — to demonstrate any
latency benefit. Trading a verified feature for an unverified one is not a good trade. The
per-session guard (a preview never queues behind its own session's work) remains.

Resolving this properly needs a load harness that holds speech density constant across runs;
until then the ceiling is documented rather than guessed at.

## Explicitly deferred to P6.1C

Camera video tiles, real two-device/browser acceptance evidence, measured end-to-end latency
report, human quality review, and the §30.4 sign-off table. This wave must leave the Live
programme regressions green.
