# Zoom Integration — Official-Surface Audit and Adapter Design (P6.7)

> **Status: M0 audit complete; RTMS ingest adapter implemented; egress unresolved.**
> Zoom → Videofy has an official, clean path and is built. Videofy → Zoom does
> not, and no outbound path has been invented to claim completion.

Every claim below is labelled **[C]** confirmed against a named official Zoom
page, **[I]** inferred from official material, or **[U]** not findable in
official material. Claims were produced by one pass and then adversarially
re-checked by a second; nine were demoted on that check and are recorded here
at their demoted level, not their original one.

## 1. The asymmetry that defines this phase

```
ZOOM MEETING                             VIDEOFY
     |                                      |
     |  RTMS: audio + identity + timing     |
     |------------------------------------->|   P6.7A  official, built
     |                                      |
     |         translated audio/captions    |
     |<-------------------------------------|   P6.7B  no RTMS path
```

**[I] RTMS is delivery-to-application only.** No official page states that RTMS
cannot send media into a meeting; the conclusion rests on five pages that
describe only delivery ("a data pipeline that gives your app access to live
audio, video, and transcript data"), SDKs exposing only receive callbacks,
read-only scopes, and a sole REST endpoint carrying start/stop/pause/resume.
Absence of a documented send is not a documented prohibition — but it is the
same planning conclusion, and we plan on it.

## 2. Ingress — confirmed, and a good fit

| Fact | Status | Detail |
|---|---|---|
| Per-participant audio | **[C]** | audio param `data_opt`: `AUDIO_MULTI_STREAMS = 2` |
| Mixed is the DEFAULT | **[C]** | `AUDIO_MIXED_STREAM = 1`; its packets carry `user_id: 0` — the whole room, anonymous |
| Concurrency ceiling | **[C]** | multi-stream documented as "up to 3 speakers per 20ms" |
| Audio format | **[C]** | default raw L16 / PCM, 16 kHz, mono, base64, 20 ms packets |
| Per-packet identity | **[C]** | `msg_type 14`, `content{user_id, user_name, data, length, timestamp}` |
| Timestamps | **[C]** | Zoom server creation time, advancing by `send_rate`, per user |
| Transcript stream | **[C]** | `msg_type 17`, Zoom's own recognition, scope-gated |
| End-to-end latency | **[U]** | Zoom publishes no figure. Videofy must measure it; the product lives or dies on it |

Two consequences the adapter is built around. The **default is useless to us** —
anonymous audio cannot be translated per speaker or spoken back in a per-speaker
voice — so the adapter always requests multi-stream and refuses `user_id: 0`
rather than attributing a room to a phantom. And the **3-speaker ceiling** is a
real crosstalk limit to design tests around, not a footnote.

The documented default format is *exactly* the engine's existing contract
(16 kHz mono PCM16), so audio crosses the seam with no resampling and no
transcode, as master architecture §17.2 requires.

## 3. Protocol shape the adapter implements

**[C]** Webhook `meeting.rtms_started` → signaling websocket
(`SIGNALING_HAND_SHAKE_REQ` 1 → `RESP` 2, which returns media server URLs) →
media websocket (`DATA_HAND_SHAKE_REQ` 3 → `RESP` 4) → **`CLIENT_READY_ACK` (7)
sent back on the SIGNALING socket**, only after the media handshake completed.

Three documented traps, each absorbed in code:

1. **Two fields named `server_urls`.** The webhook's is a bare string; the
   handshake response's is an object keyed `audio`/`video`/`transcript`/`all`.
   Parsed by separate functions so they can never be confused.
2. **Names disagree between Zoom's own pages** (`PARTICIPANT_JOIN` on the enum
   page vs `PARTICIPANT_JOINED` in prose) while the numbers agree. Everything
   dispatches on the number.
3. **Keepalives run backwards** from most protocols: **[C]** the *server* sends
   `KEEP_ALIVE_REQ` (12) every 10s on *both* sockets and the app answers (13).
   So: no send timer, a responder plus a watchdog. **[C]** Zoom advises
   re-establishing via a fresh signaling handshake after 65s of silence.

**[C]** Events are **opt-in** (`EVENT_SUBSCRIPTION` 5). Skip it and the stream
connects, plays audio, and reports no joins or leaves at all — which looks
exactly like a broken roster. **[C]** `PARTICIPANT_LEAVE` carries `user_id`
only, with no name: an asymmetry with join that a naive parser drops.

## 4. Egress — ranked, with the one unknown that decides it

| Option | Official | Meetings vs Video SDK | Side | Delivers audio | Targets one language | Needs a bot | Plan | P6.7 fit |
|---|---|---|---|---|---|---|---|---|
| Interpretation channel + Meeting SDK bot | **[C]** both halves separately | Meetings | client | yes | **yes** | yes | paid | **best — pending one unknown** |
| Meeting SDK virtual mic alone | **[C]** | Meetings | client | yes | no — everyone hears it | yes | paid | single-language only |
| PSTN dial-out / SIP Room Connector | **[C]** | Meetings | server | yes | no — floor audio | yes | extra entitlement | poor |
| RTMS | **[I]** no send path | Meetings | — | **no** | — | — | — | not an egress |
| Video SDK raw audio send | **[C]** | **Video SDK — a different product** | client | yes | n/a | n/a | n/a | **architecture comparison only** |

**[U] The gap that decides the architecture:** no official page states that
virtual-microphone audio is routed into the interpreter's *active language
channel*. Each half is documented — `SetInterpreterActiveLan`, and raw-audio
send via `setExternalAudioSource` — but the join between them is not. Settle
this with Zoom developer support or a controlled test in a meeting Videofy owns
**before** any roadmap commitment. Two further unknowns: **[U]** whether Zoom
permits a non-human interpreter, and **[U]** whether raw-audio *send* needs an
entitlement (documented licence text covers only the receive side).

The Video SDK row exists to be explicit: it is a **different product** and is
not evidence about ordinary Meetings. Treating it as such would be the
KingsConference mistake in a new costume.

## 5. Captions

1. **[C] Third-party Closed Caption API** — Zoom issues a signed per-meeting URL
   that an external service POSTs UTF-8 text to with an incrementing `seq`.
   Renders in Zoom's native caption UI. Two hard constraints: **[C]** the
   parameter set is `id, ns, expire, spparams, signature, seq, subconfid` —
   there is **no language parameter**, so this channel carries one untagged
   language for the whole meeting; and **[I]** the URL is obtained by a human
   host clicking "Copy the API token", with no documented REST retrieval.
2. **[C] Meeting SDK `IClosedCaptionController`** — `GetClosedCaptionUrlFor3rdParty()`
   and `SendClosedCaption()` remove the copy-paste ritual for a joined client.
3. **[C] Zoom App panel** — Videofy renders its own caption UI, the **only**
   per-user multilingual path, bypassing Zoom's caption system entirely.

Videofy's own recognition stays authoritative; Zoom's transcript stream is
supplemental evidence, never a silent replacement (master architecture §17.2).

## 6. App model, scopes and commercial prerequisites

**[C]** A **General app**, which **must be user-managed** and **must use
granular scopes**. Confirmed scope strings: `meeting:read:meeting_audio`,
`meeting:read:meeting_transcript`, `meeting:update:participant_rtms_app_status`,
and the `rtms:read:*` event family. **[U]** Video/screen-share/chat media scope
strings are described in prose but never printed — read them from the
Marketplace UI rather than guessing.

**[C] Two secrets, easily conflated**, kept in one file in the adapter for
exactly that reason:

| Secret | Signs | Over |
|---|---|---|
| Secret Token | webhooks | `v0:{x-zm-request-timestamp}:{raw body}` → `x-zm-signature: v0={hex}` |
| Client Secret | RTMS stream handshake | `{client_id},{meeting_uuid},{rtms_stream_id}` → hex |

**[C]** Operational hazards: webhook endpoints are revalidated every 72 hours
and disabled after six consecutive failures, and the `endpoint.url_validation`
challenge must be answered within 3 seconds.

**Commercial gates.** **[C]** Developer Pack credits are a hard prerequisite;
**[U]** the credit price and per-RTMS-minute consumption are not published, so
unit economics cannot be modelled from documentation. **[C]** Every customer
account must have an admin enable "Share realtime meeting content with apps",
hosts hold a live approve/deny gate and a mid-meeting kill switch, and reaching
meetings outside our own account requires publishing the app.

**[C] RTMS cannot be silent.** Zoom displays the disclosure to everyone in the
meeting and participants can inspect running apps. That is a product design
input, not merely a legal one.

## 7. What was built

`services/zoom-adapter` — the **ingest half only**. It normalizes RTMS audio
into `MediaAdapterPort`, the transport-neutral seam P6.6 (LiveKit), P6.7 (RTMS)
and P6.8 (SIP/RTP) share. It contains **no speech recognition, translation,
synthesis or language planning**; those stay behind Connect so the platform does
not acquire one engine per integration.

Identity is one-directional, per master architecture §"External identifiers
remain adapter metadata": Zoom `meeting_uuid` → Videofy session, Zoom `user_id`
→ Videofy `participantId`. The Zoom numbers stay in the adapter's map. Mappings
survive reconnect, so a speaker's transcript does not split in two mid-sentence.

**Not built, deliberately:** any outbound path, and the gateway-side trusted
ingress that `MediaAdapterPort` must eventually bind to. Connect's only
implemented media ingress is the browser/WebRTC path; defining a server-side one
touches a frozen surface and cannot be validated without Zoom credentials.
Inventing it now would be building against guesses.

## 8. Status and blockers

### 8.1 External validation dependency (the phase's defining unknown)

> **Question, stated exactly:** can audio injected by a Meeting SDK participant
> through the supported audio-input path be delivered specifically into that
> participant's active native Zoom **interpretation-language channel**?

This is **not** to be inferred, and no workaround based on undocumented
behaviour may be implemented against it. Each half is separately documented for
ordinary Meetings; the join between them is not documented anywhere we could
find. It closes by exactly one of:

1. **authoritative Zoom confirmation**, or
2. **a controlled test using our own Zoom meeting and credentials.**

Until then P6.7 stands as **ingress complete and hardened; interpreted-audio
egress NOT certified**. It is not end-to-end Zoom interpretation, and must not
be described as such.

### 8.2 Blockers

| Blocker | Blocks |
|---|---|
| The §8.1 interpretation-channel question | the entire egress architecture |
| Zoom Developer Pack credits + a configured General app | any real-meeting E2E |
| Ratification of a trusted server-side media ingress in Connect | binding the seam to the engine |
| **[U]** RTMS end-to-end latency | whether the product is viable at all |

## 9. References

| Ref | Source |
|---|---|
| R8 | https://developers.zoom.us/docs/rtms/ |
| R9 | https://developers.zoom.us/docs/rtms/meetings/media/ |
| R21 | https://developers.zoom.us/docs/rtms/media-parameter-definition/ |
| R22 | https://developers.zoom.us/docs/rtms/data-types/ — enums |
| R23 | https://developers.zoom.us/docs/rtms/event-reference/ — message shapes |
| R24 | https://developers.zoom.us/docs/api/rtms/events/ — webhook events |
| R25 | https://developers.zoom.us/docs/rtms/sdk/ and github.com/zoom/rtms |
