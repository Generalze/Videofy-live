# KingsConference Integration — Access Findings and Adapter Design (P6.6)

> **Status: read-only investigation complete; no adapter code written.** The
> integration path is gated on access KingsConference's own team must grant.
> This document records what is publicly verifiable as of 2026-08-19, the
> adapter design each access level implies, and the questions that decide it.

## 0. What P6.6 is, and is not

KingsConference (kingsconference.app) is a **real, independent third-party
conferencing product**. It owns its rooms, video, audio, streamed rooms,
scheduling, screen share, chat, reactions, waiting rooms, recording, identity
and UI. Videofy does not build, rebuild or replace any of that.

P6.6 adds a **language layer** to meetings that already work:

```
KingsConference meeting (theirs)
        |
        |  speaker audio + participant identity
        v
KingsConference <-> Videofy adapter        <-- P6.6
        |
        v
   Videofy Connect
        |
        v
 Videofy translation engine  (STT -> MT -> TTS + captions)
        |
        v
translated audio + captions, per listener language
        |
        v
KingsConference meeting (theirs)
```

An earlier same-day ratification framed KingsConference as a first-party
Videofy product to be built on Connect. That reading was wrong and is
withdrawn (master architecture §18). The artifact built under it is retained,
renamed, as the **Connect Reference App** — P6.5 evidence that an outside
product can integrate through the public SDKs alone. It never talked to
kingsconference.app and is not part of P6.6.

## 1. Verified platform surface

Every claim below was checked against a live public source on 2026-08-19.
Claims are labelled **[V]** verified, **[I]** inference, **[U]** unknown.

### 1.1 The decisive finding: they run LiveKit

**[V] KingsConference runs a self-hosted LiveKit SFU.** Four independent
confirmations:

| Evidence | Detail |
|---|---|
| Their own API declares it | `GET /api/rooms/{identifier}` returns `"media_server_type":"livekit"` |
| A live LiveKit server on their domain | `livekit.kingsconference.app` → `200 OK` health; `/rtc/validate` → `401 "no permissions to access the room"`, the exact `livekit-server` error string |
| Self-hosted, not LiveKit Cloud | TLS `CN=*.kingsconference.app`, Amazon-issued, AWS eu-west-1 — Cloud would serve `*.livekit.cloud` |
| Client bundles the stack | `livekit-client` + `@livekit/protocol` across the `/v2/` meeting app |

**[V] A migration off Janus is in flight.** Their legacy router branches on
`media_server_type === "janus" ? /room/... : /v2/room/...`. v1 was Janus
Gateway; v2 is LiveKit and is where live rooms go today.

**[V] Backend is Elixir/Phoenix**, with signalling over
`wss://api.kingsconference.app/channels` (Phoenix channels). The LiveKit URL
and access token are delivered **over that channel**, not over REST. Built by
Appunite (an Elixir consultancy) — their legal pages give
`kingsconference@appunite.com` as the contact.

### 1.2 Developer surface

**[V] A complete OpenAPI spec is public and unauthenticated:**
`https://api.kingsconference.app/api/docs` (Swagger 2.0, 37 paths). Notably:

| Endpoint | Why it matters |
|---|---|
| `POST /api/rooms/join` | Returns a Phoenix `channel` + `access_key` — **not** a media token |
| `POST /api/room_sessions/:id/start_recording` / `stop_recording` | Recording control (LiveKit Egress underneath) |
| `GET /api/rooms/session_recordings/:id/download_url` | Retrieves a finished recording |
| `GET /api/rooms/:identifier` | Room detail — answers with **no auth** |

**[V] What does not exist publicly:** no SDK, no embed SDK, no webhooks, no
bot/participant API, no developer portal for conferencing. The ecosystem's
developer platform (`developers.kingschat.online`) is **identity only** —
KingsChat OAuth2, which is also how meeting auth works.

### 1.3 Media and scale

**[V]** SFU (LiveKit), self-hosted on AWS eu-west-1. Advertised capacity is
**1000 participants audio-only / 500 video**, sessions up to 30h — from their
live offers endpoint. **[V]** No SIP, no dial-in, no telephony. **[V]**
Recording exists and is LiveKit Egress writing to S3.

### 1.4 Language features today: none — but the transport is already deployed

**[V] KingsConference ships no translation, transcription, captions or
subtitles.** Not on the site, not in the help centre, not among the 37 API
endpoints.

**[V] And yet their client already links LiveKit's transcription machinery** —
`livekit.TranscriptionSegment` and `RoomEvent.TranscriptionReceived` are present
in their bundle, with **no application handler subscribed to them**.

That says a caption path is within reach in their deployed client. It does
**not** settle which path we use: LiveKit is moving transcription onto text
streams (the `lk.transcription` topic), and the event-based mechanism those
symbols belong to is the older one. See §2.6 — caption transport is negotiated
against their deployed version, never assumed from a bundled symbol.

## 2. Adapter design

### 2.1 Recommended: a Videofy LiveKit Agent (Path 1)

LiveKit's canonical, documented pattern for exactly this problem. Videofy runs
an **agent** that joins the room as a participant, subscribes to speaker audio,
and publishes translated audio plus captions back.

```
                LiveKit room (KingsConference's SFU)
   speakers ------> audio tracks
                          |
                          v
              Videofy KingsConference Agent          <-- new, P6.6
                          |
              +-----------+------------+
              |                        |
        track -> PCM              identity map
              |                   (LiveKit participant
              v                    -> Videofy participantId)
        Videofy Connect  (trusted server-side media ingress)
              |
        existing translation engine (unchanged)
              |
      +-------+--------+
      |                |
 translated audio   captions
   per language          |
      |                  v
      |        negotiated caption path (§2.6):
      |        text streams on lk.transcription,
      v        else the legacy transcription event
 published as one audio track per target language
```

**Why this path wins:** it is real-time, it needs no media re-architecture on
either side, it avoids a browser bot, and it rides infrastructure they already
operate. Our STT/MT/TTS pipeline is reused unchanged behind an agent wrapper.

**What Videofy builds:** a LiveKit-participant adapter that terminates their
media and speaks Connect on the other side. This is the **first trusted
server-side media ingress** — the gap the P6.5 universal-engine audit named
(verdict B: browser/WebRTC was the only implemented ingress). P6.6 therefore
closes that gap, and P6.7 (Zoom) and P6.8 (SIP/RTP) reuse the same seam.

**What KingsConference must grant:**
1. A LiveKit API key/secret, or a token-minting endpoint scoped to
   consenting rooms.
2. Agent dispatch permission (or acceptance of an agent joining as a
   participant).
3. A UI decision: which caption path they render (§2.6), and a per-listener
   language/track picker.

**What KingsConference must build (small):** a caption renderer and a language
picker. Their UI is custom (raw `livekit-client`, not the React component
library), so this is bespoke work on their side — worth flagging early because
it, not our engine, is likely the schedule risk.

### 2.6 Caption transport (negotiated, not frozen)

Captions are an **adapter capability pinned to the authorized KingsConference
environment**, not a fixed Videofy contract.

| | Path |
|---|---|
| **Preferred** | LiveKit **text streams on the `lk.transcription` topic**, where their deployed LiveKit version supports it — this is where LiveKit is taking transcription |
| **Compatibility** | the legacy transcription-event delivery, only if their deployed client requires it |

We deliberately do not make `RoomEvent.TranscriptionReceived` the permanent
contract. Building a new integration on the mechanism LiveKit is replacing
would buy a rewrite at the worst possible moment. The adapter therefore treats
caption delivery as a capability negotiated at §3, and carries both paths
behind one internal egress contract (§4.7) so the choice never reaches the
translation engine.

### 2.2 Fallback: Egress/Ingress (Path 2)

If they refuse agent dispatch, LiveKit Egress can tap room audio out and
Ingress can publish translated audio back. Higher latency, more moving parts,
no advantage over Path 1. **[U]** whether Egress and Ingress are deployed at
all — recording implies Egress; Ingress is unconfirmed.

### 2.3 Zero-access pilot: translate their recordings (Path 3)

Their **existing recording API is a complete, already-shipped audio tap**:
`start_recording` → `recording_status` → `download_url`. With only a KingsChat
OAuth client and no media access whatsoever, Videofy can translate and subtitle
finished meetings.

This is not the real-time product, but it is a very low-cost pilot, it proves
value to their business side before any engineering commitment, and for an
organisation that broadcasts multilingually at scale it may sell itself.
**Recommended as the door-opener while Path 1 access is negotiated.**

### 2.4 Rejected: headless browser bot (Path 4)

Join requires KingsChat OAuth, and the LiveKit token arrives only over an
authenticated Phoenix channel — so a bot must either drive a real browser or
reimplement their signalling. Brittle, expensive, strictly worse than Path 1.
Their terms happen to contain no anti-bot clause; **that is not permission**
and we will not treat it as such. Pursue only with written consent, and only
if every credentialed path is refused.

### 2.5 Rejected: the Janus v1 path (Path 5)

Being decommissioned. Do not build against it.

## 3. What we ask them

Addressed to `kingsconference@appunite.com` (Appunite is the engineering
counterpart; Kinging LLC / KingsSuite is the business owner).

**Blocking — the answer decides the design:**
1. Will you issue Videofy a LiveKit API key/secret, or a token-minting
   endpoint scoped to explicitly consenting rooms?
2. Do you run, or will you enable, **LiveKit Agents dispatch**? This is the
   whole integration in one question.
3. Confirm `livekit.kingsconference.app` is production, self-hosted, and give
   the `livekit-server` version.
4. Are Egress and Ingress deployed, or only the SFU?

**Design-shaping:**
5. Captions: can your deployed LiveKit version receive **text streams on the
   `lk.transcription` topic**? Your client links the older
   `TranscriptionReceived`/`TranscriptionSegment` symbols but subscribes
   nothing, so we would rather agree the current path than inherit the one
   LiveKit is moving away from. If your version cannot, we will use the
   legacy event as a compatibility path.
6. How should a listener choose a translated audio track — do we publish one
   track per language with metadata and you expose a picker, or do you swap
   the subscribed track server-side?
7. What fraction of rooms are still Janus, and when is v1 retired? Will you
   commit to LiveKit-only before we build?
8. Is `POST /api/rooms/join` reachable by a service account or
   client-credentials grant, or only a KingsChat user token?

**Governance:**
9. Media is processed in eu-west-1. What consent and participant notification
   do you require before a third party processes meeting audio, given Nigerian
   governing law and a global user base?
10. Is the Swagger at `/api/docs` intentionally public and stable? Will you
    version it? (We would rather depend on a committed contract than on an
    endpoint that may be internal-and-exposed.)
11. Recording retention and `download_url` TTL, if we pilot Path 3.
12. Who signs — KingsSuite/Kinging LLC, or Appunite?

## 4. Open questions we could not settle from outside

- **[U]** `livekit-server` version; whether Egress/Ingress/Agents are deployed.
- **[U]** Whether agent dispatch is enabled — not externally observable.
- **[U]** The LiveKit URL/token payload issued at join (authenticated channel).
- **[U]** Whether guest/anonymous join is possible. Leaning unlikely: their
  profile endpoint returns `401` and the app is OAuth-first.
- **[U]** Sub-processors. Their privacy policy and terms name **zero** vendors
  — no AWS, no LiveKit. Every vendor identification here comes from
  infrastructure evidence, not their disclosures. Worth raising with them:
  if Videofy processes participant audio, a sub-processor disclosure is
  probably required.

## 5. Decision record

| Date | Decision |
|---|---|
| 2026-08-19 | KingsConference confirmed a real third-party product; first-party framing withdrawn; P6.6 restored as an adapter (master architecture §18, §29). |
| 2026-08-19 | Artifact built under the wrong framing retained and renamed to the **Connect Reference App**; reclassified as P6.5 evidence. |
| 2026-08-19 | Investigation complete: they run self-hosted LiveKit; a LiveKit Agent (§2.1) is the recommended adapter; recordings (§2.3) are the zero-access pilot. |
| — | **Pending:** their answers to §3. No adapter code until access is known. |

## 6. References

| Ref | Source |
|---|---|
| R15 | https://kingsconference.app/ |
| R16 | https://kingsconference.app/help-center |
| R17 | https://api.kingsconference.app/api/docs — public OpenAPI spec |
| R18 | `livekit.kingsconference.app` — live LiveKit health and `/rtc/validate` |
| R19 | https://kingsconference.app/privacy-policy, /terms-and-conditions — Kinging LLC, `kingsconference@appunite.com` |
| R20 | https://kingssuite.com/ — KingsSuite ecosystem context |
