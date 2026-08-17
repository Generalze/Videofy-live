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
