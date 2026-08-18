# P6.4 — Conference design (approved architecture)

```
Branch     p6.4/conference-foundation
Baseline   70fb554  (P6.3 M1 baseline — PARKED and OPEN, not closed)
Wave       W1 complete, awaiting review. W2 not started.
```

P6.3 acoustic work is frozen. Nothing in P6.4 may modify the VAD, the resampler,
W1–W5A instrumentation, or any W5B/W6/W7/W8 surface.

## Approved architecture

### Scale

**Development-demo cap: 4 participants.** Hard, configured, and not SFU-scale.

The number is measured, not chosen for tidiness. The gateway decodes every
publisher's Opus to PCM — it has to, for transcription — and re-encodes per
recipient, so cost is **N(N−1) encoder streams** in one Node process:

```
N=2 →  2      N=4 → 12      N=6 → 30      N=8 → 56
```

Four is comfortable. Beyond about six this stops being a demo and becomes an
SFU, which this architecture is not: it forwards nothing, it decodes everything.
**Do not describe it as SFU-scale or production conference scale.**

### Media topology

Gateway server fan-out. Each participant holds one publish peer (sendonly) and
one receive peer (recvonly) to the gateway. No mesh.

**W2 target: one remote audio track per remote speaker.** Not one interleaved
recipient source, and not server-side DSP mixing.

Server-side mixing was rejected deliberately. It would require per-recipient
jitter alignment and summation with clipping protection — real DSP, in a service
that has just spent a wave demonstrating how quietly audio assumptions fail.
Separate tracks let the browser mix natively and unlock three things the product
needs anyway: per-speaker ducking (Interpretation must duck *the speaker being
translated*), per-speaker mute, and speaker attribution on original audio.
Encoder cost is identical either way.

**Receive slots: pre-allocate `maxParticipants − 1` = 3 remote speaker slots per
participant**, bound to speakers as they join. Avoids renegotiation storms on
membership change at demo scale.

**Track attribution: explicit `mid`/slot → `speakerParticipantId` mapping**,
delivered as its own event. Identity is never inferred by parsing SDP on the
client.

### Call Mode — CALL-GLOBAL

```
Normal      direct original WebRTC
            NO STT · NO translation · NO translated captions
            NO TTS · NO personal voice

Translated  translation pipeline active
```

**Authority: call owner only** — the participant who creates the call. This is a
minimal ownership concept, not a moderator or enterprise-role system. One
participant discovering a button must not be able to switch translation off for
an entire multilingual conference.

If the owner disconnects temporarily the mode is unchanged. **No automatic
ownership transfer in P6.4.**

### Audio Mode — PER LISTENER

`translated` | `interpretation` | `original`. Each listener controls their own.

### State ownership

| State | Scope | Authority |
|---|---|---|
| Call Mode | call-global | call owner |
| Audio Mode | per listener | that listener |
| hear language | per listener | store |
| speak language | per speaker | store |
| original mute / volume | per listener, per speaker | client-local, never sent |

### Mode transitions

**Use the existing `mediaRevision`. No third revision counter.**

```
Normal → Translated
  bump revisions · create fresh ingest plans · fresh translation state

Translated → Normal
  server retires ingest sessions
  + client clears captions
  + client resets the generated-audio queue
  + late server output rejected on revision
```

Two independent mechanisms, deliberately. Server-side revision rejection cannot
stop a clip already sitting in a browser's queue; a client-side reset cannot stop
a buggy or hostile peer. Neither alone is sufficient.

### Generated conference audio

Single **serial** translated playback channel initially — no simultaneous
synthetic voices. Two synthetic speakers at once are unintelligible, and a human
interpreter does not double-track either.

**Speaker attribution is mandatory.** With three or more people, knowing *whose*
translation you are hearing matters far more than it did with two.

**No per-speaker clip cap is specified yet.** Revision and freshness protection
already provide a safer basis than inventing a number before conference latency
has been measured. Calibrate after measurement.

### Mobile

- **Lifecycle:** screen suspension and resume is **recovery work, not
  network-loss handling**. Android screen-off suspends the application; the
  socket reconnects on resume.
- **Audio outputs:** capability-detected only. System Default always available;
  Speaker / Earpiece / Bluetooth exposed **only where the browser exposes them**.
  Android Chrome does not offer earpiece routing to a web page, and a control
  that silently does nothing is worse than no control.

Both deferred to their designated waves.

## Waves

| Wave | Scope | Status |
|---|---|---|
| **W1** | Session foundation: cap 4, N-way proof for state/routing/planning/revisions | **complete, in review** |
| W2 | Per-speaker receive tracks; slot pre-allocation; track mapping contract | next, consequential |
| W3 | Client multi-remote audio; per-speaker mute/volume | |
| W4 | Per-speaker mix policy; Interpretation ducks the translated speaker only | |
| W5 | Call Mode: contract, owner authority, ingest teardown, client reset | |
| W6 | Generated-audio conference semantics: attribution, bounds, interruption | |
| W7 | Recovery: suspension/resume, track remap, unlock-after-suspend | |
| W8 | Mobile output capability detection | |

W2 must prove the thing the current suite structurally cannot express: **two
people speaking simultaneously without their PCM being interleaved into one
source.**

## W1 findings

### Corrected: the cap was load-bearing twice

`lifecycleStateOf` decided `active` vs `waiting` from
`DEFAULT_MAX_CALL_PARTICIPANTS`. That was correct only while the cap was 2 —
"the call is full" and "somebody is here to talk to" were the same number by
coincidence. Raising the cap to 4 would have reported every two- and
three-person call as `waiting`.

Split into `DEFAULT_MAX_CALL_PARTICIPANTS = 4` (seats) and
`CONVERSATION_QUORUM = 2` (enough people to be a conversation).

### Confirmed N-way, now proven

- caption routing to all others, never the speaker, never across calls
- generated-audio routing by language eligibility, never the speaker
- **language de-duplication** — two French listeners cost one translation
- target work drops when the last listener of a language leaves
- per-participant revision-scoped ingest identity
- stale rejection after join, language change and leave

### Open: leave is asymmetric with join

A **join** bumps every connected participant's `mediaRevision` and returns fresh
ingest plans. A **leave** does neither — it deletes the seat and returns a
snapshot.

At two participants this never surfaced, because the call ended. At conference
size the departed listener's language remains in the speaker's **live** ingest
session, so media-ingest keeps translating and synthesising for a language
nobody is listening to. The current plan and the live session disagree until the
next bump.

Nothing is delivered wrongly — routing finds no recipient — so this is **wasted
work and a model inconsistency, not a leak.**

**Deliberately not fixed in W1.** Bumping revisions on leave would invalidate
output being spoken at that moment: every remaining participant would lose a
sentence because a fourth person hung up. That is a trade-off requiring a
decision, not a quiet change inside a wave whose job was to prove the existing
model. Current behaviour is pinned by a test so the decision is explicit when it
is taken.

### LOCKED — participant leave

```
Participant leave:
- remaining mediaRevision does NOT bump merely because somebody left
- stale translation targets may temporarily remain as a harmless superset
- routing still prevents delivery to departed participant
- therefore: wasted work, NOT privacy leakage or incorrect delivery

Resolution:
- deferred to P6.4-W5 ingest-plan reconciliation
- no third revision counter
- preserving in-flight speech is an acceptance requirement
```

Losing current output for three remaining people in order to save a little
unnecessary synthesis would be a bad trade. W5 reconciles the plan without
touching revisions, alongside the Call Mode teardown path, which already has to
stop ingest sessions mid-call.

## P6.4-W3.1 — product contract (LOCKED) and evidence findings

### Product hierarchy

```
CALL TYPE        Personal Call | Conference        both: audio + video
      ↓
CALL MODE        Normal | Translated               owner-controlled (W5)
      ↓ if Translated
AUDIO MODE       Translated | Interpretation | Original    per listener
      ↓
MEDIA            camera on/off · mic on/off · speaker/output
```

- **Normal**: direct original WebRTC. No STT, no translation, no translated
  captions, no TTS, no personal voice — and no translated-voice controls shown.
- **Translated**: full pipeline; language controls; Audio Mode per listener;
  personal voice selectable where available.
- **Personal Call is a dedicated 1:1 flow, not conference UI with a cap of 2.**
- Conference demo cap stays 4; owner controls global Call Mode.
- W5 still owns the authoritative Call Mode engine. The entry flow ships the
  structure now; **Normal is honestly disabled** until W5 exists, because a
  Normal that secretly ran translation underneath is precisely the kind of
  contradiction this contract removes.

### Entry flow (implemented structurally in W3.1)

```
Home → Personal Call | Conference → Mode (Translated live, Normal disabled)
     → setup (existing prejoin) → call surface (type-aware)
```

Deferred to later UI increments, deliberately: create/join before mode,
camera/mic preview step (camera arrives with video), and the dedicated
Personal call surface. Invite links skip straight to setup — the caller
already decided what the call is.

### Caption architecture (implemented in W3.1)

The page never grows with the conversation:

```
live strip        newest 3 lines, bounded, overflow hidden
transcript        drawer/side panel, full history, scrolls INSIDE itself
control dock      sticky; reachable after 300 captions (tested)
```

Desktop: right-side panel. Mobile: bottom sheet (55dvh). Hiding captions
withholds the text from the markup entirely, not merely from view.

### calm-tide-33 evidence findings (18 Aug 2026, real 3-device session)

Status of W3/W3.1: code complete, all gates green, **awaiting the final human
retest** (entry flow, three-party audio, rejoin sequence, transcript layout,
acoustic observation-only). On a pass, W3 and W3.1 close together as one
commit: `feat(p6.4): establish multi-speaker conference call experience`.

Retest attempt, 18 Aug 2026 ~11:55: **failed on visual quality before the
functional checks concluded.** Two findings, both fixed the same day:

- `.transcript-drawer` set `display: flex`, which overrides the `hidden`
  attribute — the drawer overlaid the right ~384px of every call permanently,
  clipping participant tiles and the connection status. The `.audio-drawer`
  rules guarded this exact trap; the transcript rules did not. Fixed with
  `.transcript-drawer[hidden] { display: none }` plus a redesign: the
  transcript is now a real grid side panel that PUSHES the call column on
  desktop (≥1024px) and a bottom sheet on mobile — it can no longer cover
  call content in either form.
- The surface styling used token names that do not exist in the design system
  (`--vf-surface-raised`, `--vf-accent`), silently falling back to hardcoded
  near-black — the drawer rendered as raw unstyled text. The visual pass that
  followed adopted `base.css` and real `--vf-*` tokens throughout call-web,
  replaced the app's 640px media queries with the system's 768/1024
  breakpoints, and strengthened `--vf-canvas-wash` at its source in
  tokens.css (still two low-alpha radial fields — the whole gradient budget).

The functional retest checklist (A–E) remains open and human-owned.

Retest rule for fabricated captions, locked in advance: record time, speaking
device, audible TTS, and the immediately preceding noise/action. **Do not
adjust thresholds during the test.**

1. **PROBABLE Defect B — acoustic recapture. Confidence: high, not proven.**

   ```
   Classification:  PROBABLE Defect B — acoustic recapture
   Confidence:      High
   Evidence:        12/12 fabricated phone captions ("thank you" family)
                    temporally associated (±1.5 s) with generated TTS playback
                    on the co-located laptop, via W4 ledger containment;
                    revision, queue and routing explanations excluded.
   Limitation:      the phone's microphone WAVs are unavailable for this
                    session, so direct acoustic-content confirmation is
                    impossible. Timing containment alone does not prove what
                    entered the microphone — this is one evidentiary tier
                    below the earlier forensic corpus, where generated speech
                    was matched to recaptured speech directly.
   Not authorised:  threshold tuning, phrase filtering, acoustic suppression.
   ```

   This wording is deliberate and must not harden in later summaries: evidence
   records have a way of becoming more certain every time they are retold.
   It does NOT reopen P6.3 now; it strengthens the case for returning to the
   parked acoustic work later.
2. **Caption-language targets generate undeliverable TTS.** "Read captions
   in: Spanish" put `es` into speaker plans; 301 es captions delivered
   correctly, but **143 es TTS clips were synthesised and 0 were ever
   deliverable** (nobody *hears* es), using a fallback voice
   (`es_ES-sharvard-medium`) outside the male/female table. Wasted synthesis
   on every caption-only language. **Open defect — W5 ingest reconciliation.**

   **LOCKED — planning invariant for the W5 fix:**

   ```
   Caption target language ≠ automatically an audio synthesis target.
   TTS is planned only when at least one listener currently requires
   generated audio in that language.
   ```

   At four participants this compounds per caption-only language, per
   utterance — otherwise the platform synthesises speech for an audience
   consisting entirely of the garbage collector.
3. **Per-call master volume was structurally wrong at N>2** and keyed to an
   arbitrary "first other participant". Fixed in W3.1: original-voice
   suppression is now **per speaker-pair** (translated mode: cross-language
   speakers arrive as TTS and their originals are silenced; same-language
   speakers stay audible because their original IS the delivery), and the UI
   states "Hearing translated voice" instead of showing controls that move
   and do nothing. Interpretation **ducking** remains W4 policy.
4. **"Male/female made no difference" — by design, plus finding 2.** All
   pairs were en↔en until 08:26 (original voice is the delivery; gender
   selects the *speaker's own* outbound TTS voice and never what a listener
   hears). The only delivered TTS (fr, 15/15) used the speakers' default
   female voice.

   **LOCKED — voice-selector presentation:**

   ```
   Normal                              → no translated-voice selector at all
   Translated, same-language delivery  → selector must not imply it changes
                                         the original audio being delivered
   Translated, cross-language delivery → Standard Male / Standard Female /
                                         Personal Voice applies
   ```

### Video capability audit (W3.1, findings only)

| Layer | Today | For 1:1 video | For 4-way video |
|---|---|---|---|
| client capture | `video: false` everywhere; no `<video>` elements | camera constraint + local preview + remote `<video>` | same + tile grid (2-up / 2×2) |
| publish peer | audio tracks only | add video track | same |
| gateway | `videoExpected`/`videoFrameCount` exist for the *programme* path; call path is audio-only; receive slots are `RTCAudioSource` only | wrtc has `RTCVideoSource`/`RTCVideoSink`, but decoding+re-encoding video per recipient in Node is expensive and buys nothing (nothing server-side needs the pixels) | quadratic and worse |

**APPROVED topology for the P6.4 demo: hybrid.** Audio stays through the
gateway — it must be decoded for transcription anyway. Video goes
**peer-to-peer mesh between clients** (N=4 → at most 3 remote video peers each,
comfortably in-browser), so the gateway never touches pixels. Translation
transport stays independent of camera media.

```
P6.4 video mesh = development-demo topology
NOT long-term conference video architecture
```

At larger conference scale video moves toward an SFU-style architecture; no
reason to build that now. Implemented in its own conference-video wave before
P6.4 closes; nothing implemented in W3.1.
