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

Next passes: a genuinely native incoming-call surface — on Android via the
Telecom framework (self-managed ConnectionService, full-screen intent
permissions handled correctly), not merely a React Native screen on a push;
Chats empty-state that leads somewhere; verification state on Profile.

---

## 5 · Streaming — the coherent programme

Architecture (design locked, build next after integration):

```
Broadcaster → ingest → coherence pipeline (delay per §1.3)
                        ├ transcribe → translate → synthesize
                        └ align every asset to capture timestamps
            → HLS: ONE video ladder + per-language audio renditions
                   + WebVTT caption renditions (never one video copy
                   per language)
            → viewer joins the programme clock at T+delay;
              preferred listening language selects the rendition
```

**Deadline-miss doctrine (locked):** the programme clock never moves
backward, and nobody stalls because one language is late.

```
ON LANGUAGE TRACK DEADLINE MISS
  video, original audio, other languages, ready captions: continue
  the late track: marked temporarily unavailable → original-audio
  fallback → recovery at next segment boundary
  logged: programme_translation_deadline_miss
          {language, segment, provider, latency, fallback}   ← core SLO
```

**LIVE is a session, not a flag**: `BroadcastSession`
(SCHEDULED/STARTING/LIVE/ENDING/ENDED/FAILED) with heartbeat/lease becomes
the source of truth — a channel is live iff an authoritative LIVE session
exists. This also carries schedule, DVR ("start from beginning"),
automatic replay of every generated language track, and programme history.

Phases: (1) delayed-coherent single output; (2) HLS ladder + renditions +
quality selection; (3) DVR + automatic replay. Each independently shippable
and machine-measurable by the programme probe.

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
