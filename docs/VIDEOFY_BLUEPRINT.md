# Videofy Blueprint

*Consummate 7 · Videofy Live — canonical product and architecture rulings.*
*Prepared 27 Aug 2026 · revised 28 Aug 2026 after the external competitive
review. This document is the source of truth; the styled artifact page is its
twin. Everything marked LIVE was verified by machine probes on staging before
being written here.*

---

## 0 · Product principles (locked)

These are canonical. Code that contradicts them is wrong, not the principles.

> **Videofy Live is language-native communication, not communication with
> translation bolted on.**

> **Original expression is authoritative; translation is a derived
> rendering.** Marked as a translation wherever shown, revealable everywhere,
> never silently overwriting the original, never lost to a vendor failure.

> **Calls optimize for interaction. Programmes optimize for coherence.**
> WebRTC where immediacy matters; the coherent programme clock where the
> audience does.

> **People speak in their language; listeners receive in theirs.**

> **African languages are qualification problems, not afterthoughts.**

> **Standard translation drives network growth; premium voice and broadcast
> capability drive monetization.**

> **Speak naturally. Be understood everywhere.**

---

## 1 · The five locked rulings (28 Aug 2026)

### 1.1 Text-translation billing — LOCKED

**Standard text translation is included, with fair use.** No character-level
charging is ever exposed to ordinary users. Exact characters are metered
internally — for cost understanding, abuse prevention, and later
enterprise/premium pricing. The fair-use ceiling is deliberately undefined
during staging; usage is collected first. Clients state "free during staging"
rather than letting silence read as "free forever".

### 1.2 Language model — LOCKED

Language is three independent account facts, seeded by one **Primary** at
onboarding:

- `spoken_language` — what this person speaks (writes).
- `listening_language` — what this person prefers to hear (read).
- `default_language` — the Primary; the seed and the fallback.

**Precedence is locked** so no later code invents another interpretation:

```
CALL speaking:    per-call override → spoken_language → primary
CALL listening:   per-call override → listening_language → primary

MESSAGE source:   sender.spoken_language → sender.primary
MESSAGE target:   reader.listening_language → reader.primary

source == target        → deliver original, no translation work
translation fails/unavailable → deliver original, report the rendering
                          unavailable, NEVER lose the message
```

Observability doctrine (already live): every translation decision emits
languages and outcome — **never message text**.

A UI language joins this model only when any UI is localized; a column
nothing reads is a lie. (LIVE: store, migration 013, routes, both profile
UIs, both call clients, message path.)

### 1.3 Coherent broadcast — LOCKED, with the timeline rule

The programme delay is an **end-to-end glass-to-glass SLO**, not a server
sleep: **~45 seconds target, operating range ~30–60s**, with a **90s
Broadcast Quality mode** for premium voices and hard languages. Every stage
(STT, MT, TTS, alignment, packaging, CDN/player) is measured at P50/P95/P99
against an airtime deadline; translated assets must be ready **≥ 6 seconds
before scheduled airtime**, or the session's next programme selects a longer
delay.

**The timeline rule (locked):** the delay is a property of the programme's
timeline, selected before broadcast from measured readiness
(30 / 45 / 60 / 90).

```
During a programme:
  delay MAY increase gradually if required
  delay MUST NOT suddenly decrease
```

A viewer at T+45 must never be jumped forward over programme they haven't
seen. Adaptive means *choose the lowest safe delay and defend it* — not
*move the viewer around the timeline*.

### 1.4 Voice system — LOCKED as three levels

```
STANDARD VOICE     platform synthetic voice, no enrollment
LIVE VOICE MATCH   ephemeral similarity, when provider-supported;
                   no persistent clone
MY C7 VOICE        persistent personal voice: explicit enrollment,
                   explicit consent, user-controlled deletion,
                   provider-side deletion
```

Never collapsed into a single "voice cloning" toggle. Legal boundary,
retained: synthesis using a person's own chosen/enrolled voice ✓;
identifying an unknown person by their voice ✗.

### 1.5 Operator model — LOCKED

Environment grant list (`OPERATOR_CONSOLE_ACCOUNT_IDS`, fail-closed) is
acceptable **only while every operator is a controlled internal account**.
Before the first external broadcaster:

```
APPLICATION → PENDING → APPROVED/REJECTED → OperatorGrant
(channelId, accountId, role, grantedBy, grantedAt, revokedAt) — auditable,
revocable, no deployment required to grant or revoke.
```

### 1.6 Direct calls vs conferences — LOCKED (28 Aug, correction wave)

| Area | Ruling |
|---|---|
| Direct call | Person-to-person. **No visible codes anywhere.** The session id is internal implementation data. |
| Conference | The only place human-readable, shareable call codes exist. |
| Mobile Conf tab | Conference creation/joining only (Start · Join). |
| Direct-call entry points | Contact → Call, Chat → Call, incoming call. Never a code. |
| Direct-call mode | Inherits the account pair's Normal/Translated conversation mode. **Resolved server-side at creation with the caller's session, locked into the session; the client's own mode is ignored.** A later chat-mode flip never mutates an active call. |
| Camera | **OFF at every call start, genuinely off** — the camera is not acquired. Camera on acquires it and attaches the track; camera off stops and releases capture. A denied camera permission never ends an audio call. |
| Caller status | Call-state authority (join ack → ring dispatch → callee JOINED = answered → receive leg up = connected), **never "does a video tile exist?"** `reachedDevices` proves push dispatch only. |
| Unreachable contact | Honest: "<name> couldn't be reached." Message/retry offered. No code fallback. |
| Remove contact | Straightforward Remove with a destructive confirmation; only the confirmed Remove mutates. |

Direct-call state machine: `DIALING → CALLING → ANSWERED → CONNECTING → CONNECTED`, with terminal `DECLINED · MISSED · UNAVAILABLE · FAILED · ENDED`. For the notification-flow build, the callee joining the session **is** ANSWERED.

One-way-audio doctrine: instrument the reverse leg with **metadata only** (participant ids, publish/receive/ICE states, slot bindings, routed-frame counters, inbound packet counters) — never audio or transcripts — and prove which of *callee publish → gateway routing → caller receive/playback* fails before any UI change.

### 1.7 The direct-call telephone — LOCKED (28 Aug, stabilization wave)

**A push is not the call; it only wakes the other device. The server owns
the call state and both phones reflect it.** `DirectCallLifecycle` in the
gateway: CALLING (call exists, devices being reached) → RINGING (a device
*acknowledged* showing the incoming surface — a push being sent is never
Ringing) → ANSWERED (peer joined) → CONNECTING → CONNECTED (**proven by the
server: frames routed in both directions**) → RECONNECTING (12s window) →
NETWORK; and BUSY (one active call per account, decided at creation),
DECLINED, NO ANSWER (30s window), UNAVAILABLE (ring reached no device),
ENDED. Broadcast to the room as `call:direct:state`; the callee's device
asks `GET /calls/direct/:id` before ringing (a stale push is answered
*expired* and stays silent), acknowledges with `POST …/ringing`, declines
with `POST …/decline`. The call push is HIGH priority, 30s TTL, carries
mode/issuedAt/expiresAt, and rings on the app's *Calls* channel. Direct
calls say **End call**; conferences say **Leave** (host: End conference).
Camera on is a `replaceTrack` on a video sender negotiated empty at setup
— instant, no renegotiation. Native Android Telecom/CallStyle is the next
step for this surface.

**Durability correction (29 Aug, P8 physical acceptance failed → fixed).**
Root causes found on staging: (1) the callee's join carries
`directPeerAccountId` too, and the gateway only counted a join *without* it
as an answer — so every live call sat at CALLING/RINGING and the 30-second
NO ANSWER window ended it under the callers' feet; (2) a phone whose
Socket.IO transport blipped reconnected the socket but never re-joined its
seat, so the gateway detached its voice legs and the 120-second disconnect
reaper ended the call. Rulings that follow, all LOCKED:

- **The join ack carries the telephone state** (`directState`), so a socket
  that joins or resumes after a transition never holds an old word.
- **The timer's origin is the server's `connectedAtMs`**, set at the FIRST
  two-way connection and never moved. Both phones show the same elapsed
  time; a reconnect cannot restart it; the final duration is frozen on
  screen at ENDED. Clients measure their clock offset once, from the first
  state received.
- **RECONNECTING is 30 seconds** (was 12): long enough for a phone to change
  network, resume the same seat and renegotiate both voice legs.
- **Resume is the client's duty.** On every Socket.IO reconnect the app
  re-joins with `resumeParticipantId`/`resumeToken` (same seat, reaper
  cancelled) and rebuilds publish + receive legs. The web client already
  did; the phone now does.
- **A personal call is over when either party leaves** — hung up, killed,
  or reaped after the grace. The other phone reads *Call ended*; it is
  never left alone in a room reading "guest left". Explicit End is
  `call:end`, acknowledged, and ends for both at once. Transport loss stays
  RECONNECTING → NETWORK, a separate outcome.
- **Call history is a domain record.** The gateway posts every finished
  direct call to the account service (`POST /internal/calls`, internal
  token): `callId, callerAccountId, peerAccountId, mode, createdAtMs,
  answeredAtMs, connectedAtMs, endedAtMs, outcome (completed | missed |
  declined | busy | unavailable | network | failed), endedByAccountId,
  durationSeconds` (from the first connection). Table `call_records`
  (migration 014). It renders in BOTH participants' conversation timeline
  from each reader's side (Outgoing/Incoming, No answer/Missed call) with
  *Call back*. Metadata only — never audio, never content.
- **No artificial gain; loudness is routing.** Earpiece by default for an
  audio-only call, loudspeaker when the camera comes on, and a Speaker
  control (expo-audio `setAudioModeAsync({ shouldRouteThroughEarpiece })`).
- **Direct calls say *Calling…* from the tap**; "Joining" never appears on a
  call screen. Production screens carry no diagnostics: the voice-leg line,
  ICE warnings, peer-state words and transport events show only under
  `EXPO_PUBLIC_CALL_DIAGNOSTICS=1`.
- **Instrumentation (metadata only)** on the gateway: socket disconnected /
  reaper armed / reaper cancelled / seat resumed / personal call ended
  because a party left — enough to attribute any future "died at N
  minutes" to its actual cause.
- The mobile **Conf › Start** button starts a conference at once (the code
  is shown on the call screen); it no longer just generates a code.

---

## 2 · Where the platform stands (all LIVE on staging)

- **Translated conversations**: per-pair Translate toggle (either side flips
  it; the flip affects the next message, nothing retroactive), renderings
  marked, original always revealable, multi-sentence messages translate
  whole (opus-mt is fed one sentence per call — it silently dropped the
  second sentence otherwise). Verified: *"Una prueba más. Dos oraciones esta
  vez."*
- **Voice notes** work at real sizes — two independent server bugs fixed: the
  global 16kb body parser consumed every upload before the route-scoped 6mb
  parser ran (Express mount order), and the media directory was
  write-protected under the unit sandbox.
- **Language facts** (§1.2) end to end.
- **Faces and real names on call tiles**, web and phone: the seat's verified
  `accountId` crosses the wire (server-derived, never client-supplied) and
  renders the profile picture with honest initials as fallback. The
  room-visibility privacy pin was *revised, not deleted*: session tokens,
  resume tokens and the voiceOwnerId field never cross; the deliberate
  accountId disclosure is itself pinned.
- **Official C7 badge** mechanism: `OFFICIAL_ACCOUNT_IDS` env — a badge no
  route can grant is a badge no bug can grant. Surfaced on /me, contacts,
  conversation partners. **Badge is identity, never authority** — identity
  claims, operator grants, verification and platform roles remain separate
  concepts.
- **Operator console gated** (§1.5).
- **Channels**: public / private / locked live, with scrypt-hashed
  per-channel-salted codes, per-client five-strikes/60s guess lockout, and
  the stale-LIVE bug fixed (ending a broadcast clears the session's own
  channel state — off actually means off).

---

## 3 · Web app — the hub-and-rooms flow

**Marketing pages sell; the dashboard operates. Nothing *privileged* is
reachable without an authenticated account — but every media participant
receives a scoped session.** Public programmes are watchable with no account
(and already are, today). Invited call guests join without registering.
Creators and operators must hold accounts; viewers need not.

```
Signed out   /             product story, samples, Join C7
             /videofy/live product page → Join C7 to start calls
             /listen/      public programmes, NO account required

Signed in    /app/         My C7 hub
             ├─ Overview     start/join call · programme cards · activity
             ├─ Messages     threads · Translate toggle · voice notes
             ├─ Contacts     requests → contacts → sent · Call / Message
             ├─ Profile      picture · name · languages · devices
             └─ Verification trust state, one place only

Products     /call/        joins with your session (name, languages, face)
             /operator/    granted accounts only
```

Next passes (post-integration): a real activity rail on Overview;
contacts-first call hierarchy (person → invite link → group → conference
code, codes as infrastructure not the main human model); one shared design
system (`packages/c7-style`: tokens + card/pill/badge/row/bubble).

---

## 4 · Mobile app — one thing at a time

**Tabs are places, overlays are moments.** Call > Chat > tabs; nothing else
stacks. Push routes: ring → call screen, message → that chat, cold-start
included.

**The phone is a telephone (Telecom phase 2, 29 Aug 2026).** A C7 call is
a call to Android: a self-managed ConnectionService owns the ring, the
audio focus and the speaker route (the Speaker control goes through the
Connection while Telecom owns the call, because Telecom overrides
AudioManager). Telecom is an upgrade, never a gate: if the phone account
cannot be registered or Telecom refuses the call, the phase-1 ring
(CallStyle notification + full-screen activity) rings exactly as before.
Every Connection ends -- `reportCallEnded` on every exit, and a 75 s
watchdog on a ring nobody answers -- because an un-ended self-managed
Connection makes the phone refuse every later call.

**Signed in until sign-out (founder ruling 29 Aug 2026).** The phone signs
in as `client: 'device'` and gets a 180-day token renewed while the app is
used (`POST /sessions/renew` hands back the same class; the class travels
in the token). What bounds a long token on a lost phone is the account's
token version -- sign-out-everywhere -- and the app lock in front of it:
one hour without the app on screen, then biometrics (fingerprint / face)
or the account password. The lock is NEVER in front of a ring or a live
call; it waits until the call ends. A lock unlocks; it never signs out.

**Everything else on the phone is in the app.** Programmes play inside the
app (the web viewer under the C7 shell, until HLS renditions give a native
player); reports are filed from the message or the profile without leaving
the conversation, metadata only; suggested connections, presence (accepted
contacts only), "Speaks …", the profile rows the canon shows, conference
title / privacy / restricted admission / target languages, and chat
search, jump-to-message, sending / failed bubbles, playback speed.

---

## 5 · Streaming — the Programme Quality Engine (canonical, 29 Aug 2026)

**Status: APPROVED by the founder on 29 Aug 2026 as the canonical
Programme Quality Engine design, with the four rulings in §5.11 and the
retry-ceiling refinement in §5.3. It becomes the programme-quality
implementation directive once the direct-call / PR #1 gate is cleared and
merged. There is NO authority to begin P9 before that.**

**Principle (locked): Videofy uses delay as production time, not waiting
time.** The objective is not to make the stream late; it is, for every
captured programme moment, to produce the highest-quality safe rendition
that can be completed before its fixed airtime. The source is live; the
runway gives Videofy time to understand it; the airtime deadline forces it
to finish safely; the audience receives the best coherent rendition in
their language, and one failing language never disrupts everyone else.

### 5.1 Two clocks

```
SOURCE CLOCK    what is happening in the studio now
                = platformTimestampMs, stamped by the gateway on every frame
                  (already built; media-ingest never substitutes arrival time)
      │  production runway = the selected delay (§1.3: 30 / 45 / 60 / 90)
      ▼
AIRTIME CLOCK   what the audience is watching now
                = sourceMs + delayMs, SERVER-OWNED on the broadcast session,
                  monotonic; never moves backward; the delay may only increase,
                  gradually, applied by holding at a segment boundary
```

Every captured segment gets `airtimeMs = segment.startMs + delayMs` and a
readiness deadline `airtimeMs − 6 000 ms` (the §1.3 margin). Everything
Videofy wants to improve must finish before that deadline.

**P95 selects; margin operates (founder refinement, locked).** Before
broadcast, `requiredRunway = P95(STT + MT + TTS + packaging) + 6 s`, and
the smallest ladder value ≥ that is chosen. During broadcast the delay is
NOT recomputed from rolling statistics; live operation is governed only by
each language's actual `marginMs = airtimeAt − readyAt`. A language whose
margin approaches the six-second boundary is the operator's warning — the
delay may then be raised gradually at a segment boundary, never lowered.

### 5.2 The processing path (existing spine, new stages)

```
LIVE SOURCE → ingest + source clock (built)
  → speech segmentation: platform-minted segments committed on a stabilised
    pause — COMPLETE speech units, never word-by-word (built:
    StreamingSegmentCoordinator; utterance ceiling to be wired per category)
  → STT with Programme Vocabulary keyterms
  → transcript quality gate (confidence floor; hallucination / repetition
    guards, live-wired)
  → MT with do-not-translate span protection and canonical renderings
  → translation quality gate: CRITICAL-ENTITY CHECK (numbers, money,
    percentages, dates, times compared source vs rendition; warn-and-speak
    default, one margin-gated retry; names and places protected by §7 terms)
  → TTS (three voice levels, §1.4) with speaking-rate fit 0.95–1.05 chosen
    BEFORE synthesis; invalid-audio rejection; −19 LUFS / −1.5 TP levelling
    shared with the upload path
  → captions (WebVTT)
  → per-language RENDITION READY
  → coherence runway: server-held, age-evicted, growable; releases video +
    original + every ready rendition at airtime through the packager
  → HLS: ONE video ladder + per-language audio renditions + WebVTT caption
    renditions (never one video copy per language)
  → viewer joins the programme clock at airtime
```

The original programme is authoritative throughout. Translation, captions
and generated speech are derived renditions; Videofy never rewrites a
speaker's meaning.

### 5.3 Readiness is per segment, per language

```
segment_18372  capturedAt 20:15:00  airtimeAt 20:16:30
  video      READY            original  READY
  fr         READY  +83 s     yo        READY  +79 s
  ha         RETRYING  attempt 2  margin +42 s
  captions   READY  +84 s
```

Rendition states extend the existing `TargetLanguageOutputStatus`:
`ready`, `ready-with-warning`, `retrying`, `captions-ready` (CAPTIONS_ONLY:
translated captions available AND original audio continues — never
silence), `original-fallback` (this translated audio rendition missed its
production deadline; original audio continues for that segment), `failed`;
**`unavailable` keeps its existing meaning — the language is not offered
for this programme.** (Founder-approved wording, 29 Aug.) RETRYING is legal only while BOTH hold: the remaining budget exceeds the
6 s margin plus that provider's P95 for the language, AND the attempt count
is below a small emergency ceiling (phase 1: one production attempt plus at
most one retry). The deadline decides whether another attempt is useful;
the ceiling stops a provider that fails instantly from being called a
hundred times with seventy seconds left. Otherwise the track declares its
miss at once. Billing: one segment translated for the customer is one
billable translation outcome, whatever the internal retries.

**Deadline-miss doctrine (locked, unchanged):** the programme clock never
moves backward, and nobody stalls because one language is late.

```
ON LANGUAGE TRACK DEADLINE MISS
  video, original audio, other languages, ready captions: continue
  the late track: original-fallback → recovery at next segment boundary
  logged: programme_translation_deadline_miss
          {language, segment, provider, latency, fallback}   ← core SLO
```

### 5.4 Grades (ruling, 29 Aug)

Exactly two operator-visible grades, mapped onto the §1.3 ladder and the two
billing grades:

```
LIVE MULTILINGUAL   adaptive 30 / 45 / 60 s, default 45 · standard voices
BROADCAST QUALITY   90 s · premium voices, hard languages, 9jaLingo admissible
```

Not programme modes: a "REALTIME 5–15 s" tier (cannot meet the 6 s margin;
sub-15 s is what CALLS are) and an "Editorial Live 2–5 min" tier (outside
the locked ladder; needs human review before airtime — filed as a separate
broadcaster product pending a founder ruling). Delay is selected before
broadcast from measured readiness and DEFENDED; it is never a purchasable
runway below what was measured.

### 5.5 Preflight, warm-up, hold

- **Preflight** measures each language's live chain (STT → MT → TTS) P95,
  recommends the lowest safe delay from the ladder, and refuses an unsafe
  choice by stating what was measured ("Hausa P95 27 s; 30 s is not
  recommended, use 60 s or longer").
- **Warm before Go Live** through the REAL live chain per target language;
  only dead STT or a stubbed engine blocks Go Live — a cold language
  degrades to original-fallback with a visible marker. Probes are constant
  text, unmetered, content-free.
- **Hold never stops the timeline**: the airtime clock keeps ticking and the
  runway is filled with original / silence / a held frame (phase 1); bumpers
  and alternate sources come with HLS discontinuities (phase 2). Hold
  minutes are unbilled.

### 5.6 Control room and viewer

The operator sees SOURCE NOW and PUBLIC OUTPUT, the runway between them,
and one row per rendition with its margin (`+74 s` = finished 74 seconds
before airtime). Both clocks and every margin are SERVER-emitted from the
coherence stage — never derived from a client clock. The viewer sees one
restrained badge, `● LIVE · Enhanced`, whose disclosure explains the
production delay; "Enhanced" appears only once the delay is server-declared.

### 5.7 The SLO

Not "how fast did translation finish" but **how much airtime margin did the
rendition have**, per language, per session: P50/P95/P99 of
`readyAtMs − airtimeMs`, measured at media-ingest's delivery of the
segment's final translated frame. A language whose P99 margin approaches
zero is operating dangerously even though nothing failed — that is the
signal to lengthen the delay or change provider.

### 5.8 Programme Vocabulary (see §7)

The §7 `ProgrammeTerm` model is the vocabulary; it influences STT keyterms,
MT span protection and canonical renderings, caption spelling and TTS
pronunciation — the last honestly per vendor (Azure SSML, ElevenLabs
dictionaries; 9jaLingo/Piper/MMS declare unsupported). Lower-thirds are not
a vocabulary feature: per-language burned-in graphics would need
per-language video, which §5.2 forbids; an overlay rendition is HLS phase-2.

### 5.9 Interaction, replay, audit

- Audience interactions carry `programmeTimestampMs` from the synchronized
  programme clock, never wall clock; the host sees the audience offset.
- The runway is EPHEMERAL: encoded segments on local disk, unlinked on
  eviction. Replay/recording is a broadcast-session attribute with its own
  billing and speaker-facing disclosure (ruling pending).
- Operator interventions are forward-only (a re-render lands at the NEXT
  boundary; aired audio is never replaced), recorded append-only with
  verified actor, segment, language, action, versions and reason code —
  never programme content.

### 5.10 Where the code stands (verified 29 Aug 2026)

Built: the source clock end to end; complete-unit segmentation; one
pipeline per target language with un-awaited fan-out; provider chains with
vendor fallback; the live confidence floor; levelling and timing fit on the
upload path. Unbuilt: the airtime clock and server-owned delay (today a
client build constant the WebRTC listener path cannot exceed by more than a
few seconds), the runway, the packager, the deadline-miss doctrine,
vocabulary, the entity check, live loudness/fit, preflight, the readiness
dashboard, the margin SLO. Governance (§10): this is the first cut from the
clean post-merge base, on `p9/programme-quality-engine`.

**Phase 1 (≈ 81 developer-days, each slice shippable and probe-measurable),
in the founder's order — the timeline contract first, HLS consumes it:**

```
P1.0  unwired seams (utterance ceiling, live translate deadline, onSpoken,
      viewer availability)                                   MANDATORY
  ↓
P1.1  authoritative programme timeline (delay on the session, airtime per
      segment, readiness records, deadline-miss, original-fallback)
                                                             MANDATORY
  ↓
  parallel lanes:  P1.3 quality gates + entity check + bounded retry
                   P1.4 Programme Vocabulary v1
                   P1.5 live audio production
                   P1.6 preflight and warm-up
                   P1.7 control room and viewer badge
  ↓
P1.2  runway + HLS packager — once the timeline/readiness contracts are
      stable. HLS is a consumer of the engine, never its architecture
      driver; packager constraints must not leak upward.
  ↓
P1.8  measured end-to-end margin SLO
```

**Phase 2 / broadcaster edition:** language audition UI, interventions
with audit trail, hold with bumpers/slates, overlap strategy,
audience-interaction offset, replay, and Editorial Live (§5.11).

### 5.11 Founder rulings (29 Aug 2026, LOCKED)

1. **Editorial Live (2–5 min, configurable, human-in-the-loop) is a
   SEPARATE future broadcaster product**, not part of the programme ladder.
   Standard Videofy programmes are Live Multilingual (30/45/60) and
   Broadcast Quality (90). Phase 1 does not carry it.
2. **Programme runway ≠ recording.** The runway is ephemeral by default.
   Recording, archive or replay requires explicit session attributes:
   `recordingEnabled`, `replayEnabled`, a retention policy, a billing
   treatment, speaker-facing disclosure, viewer-facing disclosure where
   applicable, and operator authority. Buffering ninety seconds to produce
   the programme is never permission to keep it.
3. **Language audition is free within a capped preflight allowance.** A
   reasonable number of auditions are included with the programme; they
   stay metered internally and do not consume customer translation charges
   until the cap is exceeded. No character-level micro-billing is exposed.
   Internal record: `programmeId, language, auditionCount, provider,
   duration / generated units, success | failure` — never source text. The
   numeric cap is set from real operator behaviour and does not block
   architecture.
4. **Quality grade = billing grade.** The operator chooses production
   intent; Videofy resolves the machinery:

   ```
   LIVE MULTILINGUAL  = Standard programme translation
     30 / 45 / 60 from measured readiness · standard qualified voices ·
     normal retry/fallback policy
   BROADCAST QUALITY  = Premium programme translation
     90 s · premium qualified voice path · greater recovery headroom ·
     hard-language qualification · stronger pre-air quality controls
   ```

### 5.12 Phase-1 acceptance: the thirty-minute programme

Phase 1 is not complete until one real 30-minute programme has run with at
least original, French, Yoruba, Hausa and captions, with these injected
deliberately: one slow translation, one TTS failure, one malformed /
low-confidence STT segment, one critical number or date, and one language
provider outage. It passes only if all of the following hold:

```
video never stops · original audio never stops · healthy languages never stop
failed language: retried if safe, otherwise original-fallback
captions continue where ready · no global stall
airtime never moves backward · no segment airs after its deadline
the operator sees the problem BEFORE airtime
the viewer sees no engineering diagnostics
```

This scenario outranks any number of happy-path unit tests; it validates
the philosophy. The headless programme probe is the instrument.

**Governance:** P9 opens only after PR #1 (+P8) clears its physical gate
and merges; `p9/programme-quality-engine` is then the next major programme
branch, with P1.0 → P1.1 as the mandatory foundation before the parallel
lanes.

---

## 6 · Channels — who can watch

| Tier | Display | Listed? | Who gets in |
|---|---|---|---|
| public | Public | Yes | Anyone who knows the channel |
| private | **Private · Link-only** | No | Anyone holding the invite link |
| locked | Locked | No | Code required — typed, or carried by access grant |

A bearer link is never sold as plain "Private". A future **Members** tier
(authenticated memberships/organisations) is its own tier — never forced
into Locked.

**Access links (design locked, build next):** a link that bypasses typing
the code is a **revocable signed grant** — `{channelId, grantId,
scope=VIEW, expiresAt, nonce}` server-backed — never `?code=482914`.
Revoking a grant kills that link without rotating the channel code, so a
broadcaster can invite VIPs, staff, media, subscribers and sponsors on
separately revocable invitations.

On/off is the broadcast itself: Start Interpretation → live; End → off
(and off means off).

---

## 7 · Programme Vocabulary — a broadcast-quality feature

Not merely an STT keyword list. A term influences the whole chain:

```
ProgrammeTerm {
  canonicalText            "Bola Ahmed Tinubu"
  sourceLanguage
  sttAliases               ["Tinubu", "President Tinubu"]
  pronunciationHint?
  doNotTranslate?          true for names like "Abeokuta"
  translations? { fr, es, yo, ha, ig, ... }   e.g. yo: "Bọ́lá Ahmed Tinúbú"
}
        ↓ STT (keyword boosting — Deepgram supports this natively)
        ↓ translation (canonical renderings / do-not-translate)
        ↓ TTS (pronunciation)
```

Operators load vocabulary before going live. In Nigeria this will move
perceived quality more than switching models.

---

## 8 · Nigerian languages — qualification-blocked, not vendor-blocked

Providers now exist (9jaLingo advertises yo/ha/ig/pcm TTS+streaming+cloning;
Azure lists yo/ha/ig text; ElevenLabs lists ha/ig TTS and yo/ha/ig STT).
Vendor claims — including 9jaLingo's <300ms first-chunk — are **benchmarked,
never believed**; our own earlier measurement of 9jaLingo (latency, quota)
is also re-run, not assumed still true.

**Qualification pipeline:** provider exists → quality benchmark → latency
benchmark → accent/dialect benchmark → privacy/DPA → deletion & voice-clone
controls → cost/concurrency → PRODUCTION APPROVAL. Routing then becomes
empirical per language, and that routing layer is proprietary value.

**The corpus is controlled, not scraped** — first qualification round:

- 5–10 speakers per language (Yoruba, Hausa, Igbo, Nigerian Pidgin),
  mixed genders, ages, regions/accents.
- Each speaker records: 20 ordinary sentences · 10 names/places ·
  10 numbers/dates/money · 10 fast conversational · 10 slang ·
  5 long sentences · 5 code-switched. Noise variants added separately.
- ≈ 70 utterances × 8 speakers × 4 languages ≈ **2,240 utterances**.
- Every speaker signs a simple recorded-data consent/release: recordings are
  for **Videofy language-provider testing**, not general AI model training.
- Measured: STT WER, meaning preservation, proper-name accuracy,
  tone/diacritic handling, TTS naturalness, first-audio latency, full
  latency, voice similarity, provider failure rate.

*The speakers are the one input only the founder's community can provide.*

---

## 9 · Identity — language, face, badge

- Languages per §1.2; the join screen still allows per-call changes — the
  account facts are a preload, not a cage.
- Faces and names follow people into calls at reading prominence.
- The official badge renders as the teal **C7** chip wherever the name does,
  and grants nothing (§2).

---

## 10 · Release governance (28 Aug ruling)

`p7/billing-tariff-and-language-routing` is no longer a feature branch; it
is the **Videofy integration / release-candidate branch**, and is treated as
such:

1. This document pass is the branch's next commit. ✔
2. Architecture additions on this branch are frozen.
3. The complete repository gate runs: builds, typecheck, hygiene, build
   order, all workspace tests, instrumentation checks, deployment smoke
   probes.
4. The staging acceptance matrix runs; items that require physical devices
   or human ears are listed as HUMAN, not silently skipped.
5. The integration PR to `main` is created and held.
6. `main` gains protection: PR required, required CI, no force pushes.
7. The branch is reviewed as an integration release, not line-by-line.
8. The passing head is tagged as the release candidate; only then is it
   merged.
9. The coherent-programme/HLS work is cut from the clean post-merge base.

---

## 11 · Next wave (locked spec, NOT yet built): presence and the identity card

Ruled 28 Aug 2026; deliberately queued behind the direct-call correction
wave. Canonical when built:

**Presence — four visible states, a hint never a permission.**
`ACTIVE NOW` (foreground + authenticated + recent heartbeat) · `BUSY` (in a
call or Do Not Disturb — a DND person never looks offline) · `ACTIVE
RECENTLY` (heartbeat expired recently) · `OFFLINE`. `HIDDEN` (presence
sharing disabled) is **never distinguishable from OFFLINE** to others. Shown
as a small dot at the lower-right of the avatar wherever identity appears
(contacts, chat header, call history, profile preview, conference
participants): green active · amber busy · grey offline. No exact "last
seen" by default. Privacy control: Everyone / Contacts only / Nobody.
Presence never gates a call: an offline contact still receives the push.

**The identity card** — photo · name · `@username` · C7 badge · presence ·
languages — is the recurring component tying chats, direct calls,
conferences and channels into one identity. Tapping a picture answers
"who is this person and what can I do with them?", never exposes settings:
own picture → profile *preview* (what others see) with Edit profile /
Change photo; another's → the limited public card with Message / Call (or
Add contact; nothing when blocked), and an overflow: Share profile · Remove
contact (confirmed) · Block (distinct, confirmed) · Report.

**Profile tab structure** (five compact sections): Identity (photo, name,
username, badge, bio) · Language & Voice (primary, I speak, I prefer to
hear, translated-voice mode, **My C7 Voice** as its own row: Not enrolled /
Active / Deletion pending) · Availability (active status, DND, presence
privacy, who can call) · Account & Trust (email/phone verification,
security, devices, sign out) · Privacy & Preferences (who can
find/contact/call you, blocked accounts, translation and notification
preferences).

**Visibility model.** Public: photo, displayName, username, badge, bio, the
languages the user chooses to show. Contact-visible: presence, call/message
actions, richer bio. Private, never shown to others: email, security,
devices, **listening language** (an internal delivery preference — only
"Speaks …" is public unless the user opts in), voice profile/provider,
privacy settings, billing, verification reasons, account id, IPs, logins.

## 12 · Standing refinements ledger

- "Translation unavailable" should be *visible* to the reader when a
  rendering was expected and the original was delivered instead (post-merge
  client polish; the server event already fires).
- Web↔phone A/V sync inside calls is good; the programme path's cure is §5.
- The operator console's status pills must never again say "Live" while the
  pipeline is dead — the programme probe is the standing guard.
- Fair-use ceilings for included text translation: defined after staging
  usage data exists (§1.1).
