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

## Language update (owner decision, 2026-08-14)

**English–French is the constant development pair** — French verifiers are easier to source.
Call languages are now `en`/`fr`/`es`: French joins with validated duplex routes
(`opus-mt-en-fr`/`opus-mt-fr-en`), multilingual STT coverage, and registered Male/Female
development voices (`fr_FR-upmc-pierre`, `fr_FR-siwis-medium`); Spanish stays fully supported
with its P6.1A evidence.

## Explicitly deferred to P6.1C

Camera video tiles, real two-device/browser acceptance evidence, measured end-to-end latency
report, human quality review, and the §30.4 sign-off table. This wave must leave the Live
programme regressions green.
