# P6.9 — Trusted Media Adapter Ingress Binding (Design)

Date: 2026-08-20
Status: DESIGN — approved with amendments. Implementation follows; no P6.9
production code has been written.

## Purpose

Phase 6 built three transport adapters — SIP/RTP (P6.8), Zoom RTMS (P6.7) and
LiveKit/KingsConference (P6.6) — and a shared seam, `MediaAdapterPort`. All three
normalize their transport into 16 kHz mono PCM and hand it to that port.

The port has exactly one implementation in this repository:
`RecordingMediaAdapterPort`, an in-memory double used by the adapter suites. The
seam's own header says so: *"the binding that carries these frames into the
gateway's trusted server-side ingress does not exist yet."*

So every adapter negotiates correctly, decodes correctly, and hands perfect
frames to nothing. **P6.9 is the binding that makes them platform integrations
rather than isolated transport implementations.** It is the only genuine
development blocker left in Phase 6; the outstanding Zoom and KingsConference
items are external certification, deferred by policy, and are not development
blockers.

## What already exists

The most important finding of the design read: **there is already one media
pipeline, and it already has two producers.**

`WebRtcTranscriptionChunker` accepts `{ samples, sampleRate, channelCount }`,
runs VAD segmentation, and emits chunks stamped:

```text
sampleRate:   16000
channelCount: 1
pcmFormat:    'pcm_s16le'
samples:      Int16Array
```

That is the same shape as `AdapterAudioFrame`. Its context —
`{ sessionId, broadcastId, broadcasterPeerId, revision }` — is generic identity;
only the *names* are WebRTC. It already carries a `queueOverflowPolicy` of
`evict-oldest`, documented as *"correct for a live call, where the newest speech
is what the other person is waiting to hear"*: live-call backpressure has already
been reasoned about here.

Downstream, `media-ingest` exposes the trusted internal API the gateway drives:

```text
POST   /internal/webrtc/sessions              create
POST   /internal/webrtc/sessions/:id/chunks   deliver
POST   /internal/webrtc/sessions/:id/stop     stop
DELETE /internal/webrtc/sessions/:id          remove
```

And `call-runtime.ts` is **already a second producer** on that path. It drives
`CallTranscriptionBridgeLike` with a `WebRtcTranscriptionBridgeContext`,
synthesising the broadcast-shaped fields for a call:

```text
broadcastId       = `callcast_${callId}_${participantId}`
broadcasterPeerId = callPublisherPeerId(participantId)
```

This matters more than anything else in this document. The adapter binding is
**not new plumbing**. It is a third driver of an interface that already has two
drivers and a working precedent for exactly the mapping problem it faces. It also
confirms the master architecture rather than straining it: external systems
normalize into one Videofy session and media model, and must not grow separate
translation pipelines.

## Architecture

```text
                       REALTIME GATEWAY
                authoritative session owner
                           │
                           │ route configuration
                           │ product / language policy
                           │
              ┌────────────┴────────────┐
              │                         │
       Service Authentication     Route Authorization
        "who are you?"            "what may you originate?"
              │                         │
              └────────────┬────────────┘
                           │
                  CREATE / BIND SESSION
                           │
                           ▼
                   VideofySessionId
                      server-owned
                           │
                   Session Capability
                    "what may you touch?"
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
        SIP              Zoom            LiveKit
      adapter           adapter          adapter
          │                │                │
          └────── MediaAdapterPort ─────────┘
                           │
                   AdapterSessionRef
                    correlation only
                           │
                   session capability
                           │
                           ▼
                Adapter Ingress Binding
                           │
                     resolves session
                           │
                           ▼
               MediaTranscriptionChunker
                           │
                    VAD / segmentation
                           │
                           ▼
                trusted internal media API
                           │
                           ▼
                      media-ingest
                           │
                           ▼
                     STT → MT → TTS
```

WebRTC becomes one producer among four, not the shape everything else must
pretend to be.

## 1. Where `MediaAdapterPort` terminates

At the **Adapter Ingress Binding inside `realtime-gateway`**, which implements
the port and terminates it by driving the existing chunker.

Not `media-ingest`: that service would have to learn what SIP, Zoom and LiveKit
are, which is the coupling Phase 6 exists to prevent. The moment `media-ingest`
grows a `if (source === 'sip')`, transport neutrality is gone and every future
transport pays for it.

Not a new service: it would duplicate the chunker, the staging directory, the
ingest client and the session registry — all of which already live in the
gateway, and three of which `call-runtime` already shares.

The gateway owns adapter ingress because it already owns session authority, the
chunker and the ingest client. The binding is the smallest thing that can sit
between the port and those three.

## 2. Authorization is three layers, not one token

```text
Layer 1   SERVICE AUTHENTICATION     "who are you?"
Layer 2   ROUTE AUTHORIZATION        "what may this adapter originate?"
Layer 3   SESSION CAPABILITY         "what session may you touch?"
```

One `INTERNAL_WEBRTC_TOKEN` blessed with omnipotence satisfies none of these
properly. It proves a caller knows a password; it says nothing about which
sessions that caller may write into.

### The inbound-call problem

A SIP call arrives unannounced. The adapter cannot already hold a capability for
a session that does not exist:

```text
Inbound SIP call
      ↓
no Videofy session exists yet
      ↓
there cannot already be a session capability
```

So the flow is an exchange:

```text
Service Credential  +  Route Authorization
                    ↓
              REQUEST SESSION
                    ↓
    Gateway creates the authoritative session
                    ↓
        Gateway issues SESSION CAPABILITY
                    ↓
          Adapter may now send media
```

### The two objects carry strictly different powers

A route credential authorizes **creation only**. It must never authorize audio
injection, and must never be accepted where a session capability is required:

```text
SIP adapter identity
  authorized routes:
    +234-xxx-xxx-xxxx
    customer-route-17

  may:      create_session
  may NOT:  push_audio
            participant_join
            participant_leave
            stop_session
            address any internal sessionId
```

The session capability authorizes exactly one created session:

```text
  may:      push_audio
            participant_join
            participant_leave
            stop_session
  scope:    one VideofySessionId, and where practical one participant
```

This split is the point. A leaked route credential lets an attacker ask for a
session it is already entitled to originate — noisy, rate-limitable, revocable.
A route credential that could also inject audio would be a master key.

### Route credential requirements

If the first implementation uses an opaque secret, it must be:

- high entropy;
- stored hashed server-side where practical;
- bound to a service/adapter identity;
- scoped to named routes;
- explicit about allowed operations;
- rotatable;
- revocable, without waiting for expiry;
- given an expiry or a controlled lifecycle;
- carried over TLS only;
- never logged, and never accepted as a session capability.

mTLS or a service identity system can later strengthen Layer 1 without changing
the session-authority design, because Layer 3 does not depend on how Layer 1 is
proved.

## 3. Session capability resolves the session; it does not accompany one

The binding must never do this:

```text
request: { capability, sessionId: "cs_some-session" }
         ↓
if (capability.sessionId === suppliedSessionId) …
```

because eventually someone forgets that check on one path. Instead:

```text
sessionCapability
       ↓
gateway lookup
       ↓
authoritative Videofy session
```

**No caller-selected internal session id exists in the media operation at all.**
Cross-session injection is therefore not a check that can be omitted — it is
unrepresentable. That is a stronger property than validating a claim, and it is
the property to aim for.

## 4. Identifier typing — adapter refs must not masquerade as session ids

P6.8 mints its own `sc_…` locally precisely because the SIP `Call-ID` is
caller-chosen and untrusted. Under this design that identifier becomes
**adapter-scoped correlation metadata**: useful for logs and for tying
adapter-side measurements to a call, never platform authority.

Leaving the field typed as a bare `string` is a foot-gun for whoever reads this
in six months. P6.9 is explicitly authorized to correct the boundary, so it
should carry the distinction in the type system:

```ts
type AdapterSessionRef = string & { readonly __brand: 'AdapterSessionRef' };
type VideofySessionId  = string & { readonly __brand: 'VideofySessionId' };
```

so that this cannot happen by accident:

```ts
const platformSession: VideofySessionId = adapterSessionRef; // rejected
```

The chain of authority, stated once:

```text
SIP Call-ID        → adapter metadata, untrusted, caller-chosen
sc_xxxxxx          → AdapterSessionRef, correlation only
Session Capability → Gateway → VideofySessionId → authoritative
```

**No external or adapter-minted identifier ever becomes authority.**

This is a change to `packages/media-adapter-port` and to the adapters that speak
it. It is specified here and not yet made.

## 5. Session creation must be retry-safe

Inbound telephony retries. SIP in particular retransmits an INVITE every T1 until
it is answered — P6.8 has three separate defects and four pins that exist purely
because of that behaviour.

If an adapter exchanges its route authorization for a session capability and the
response is lost, retrying must **not** create a second Videofy session:

```text
POST create                     → cs_123 + capability_A
  (response lost in transit)
POST create (retry)             → cs_123 + same binding
```

and never:

```text
POST create (retry)             → cs_124, while cs_123 stays alive
                                  holding a chunker, a staging dir and an
                                  ingest session that nothing will close
```

The idempotency key is deterministic:

```text
adapter identity + route identity + AdapterSessionRef
        ↓
the same active binding, for as long as that call exists
```

This is an explicit P6.9 acceptance test, not an implementation detail.

## 6. Fail closed — a security prerequisite, not later hardening

Today:

```ts
function assertInternalWebRtcRequest(req, res): boolean {
  if (!config.internalWebRtcToken) return true;   // open when unset
  ...
}
```

`.env.example` ships `INTERNAL_WEBRTC_TOKEN=` blank, so a default deployment
exposes an **unauthenticated internal media-injection API**: anyone who can reach
the port can create sessions and inject audio into any of them. That is
survivable only because the sole caller is the gateway on the same host behind a
firewall, and it stops being survivable the moment this reaches a public VPS.

Required:

```text
production + internal auth configuration absent
                  ↓
        PROCESS REFUSES TO START
```

Refusing the request with 403 is the minimum. Refusing to *start* is correct,
because a service that boots without its credential is discovered by an attacker
before it is discovered by an operator. This follows the precedent already set by
`VIDEOFY_AUTH_SECRET`, which services refuse to start without — *"a key committed
to a repository is a key every deployment shares."*

Development and test may have a deliberate, explicit development mode. What must
not exist is the current semantics, where **missing security configuration means
security disabled**.

Independently of application auth, and stated here because it is part of the same
threat model: **`media-ingest` must not be reachable from the public Internet on
the Contabo host.** It should bind to localhost or a private service network, with
the firewall closed to 3002 regardless. Application authorization is the second
line, not the first.

## 7. Transport-neutral rename, migrated atomically

The pipeline is not WebRTC-specific and has not been since calls joined it. Once
SIP, Zoom and LiveKit ride it too, names like `WebRtcTranscriptionChunker` and
`/internal/webrtc/sessions` would promote a historical implementation detail into
architecture, and every future reader would have to be told the name is a lie.

```text
WebRtcTranscriptionChunker   →   MediaTranscriptionChunker
/internal/webrtc/*           →   /internal/media/*
```

Constraints:

- This is a **rename and refactor of the existing pipeline, not a new one**.
  There must remain exactly one path: 16 kHz PCM → VAD/chunking → media-ingest →
  STT → MT → TTS.
- **Migrate atomically.** Do not end up permanently serving both
  `/internal/webrtc/*` and `/internal/media/*`, which would turn a rename
  intended to remove duplication into duplication. Compatibility shims only if
  migration genuinely requires them, and then removed within P6.9.
- The boundary was deliberately frozen, so this is recorded as an **authorized
  P6.9 architectural correction**, not opportunistic cleanup.

Transport-specific names stay where the thing really is transport-specific: the
WebRTC peer registries, SDP handling, the RTMS client.

## 8. Identity mapping

`call-runtime` already solves this; the binding follows it rather than inventing
a second convention:

```text
call:     broadcastId = `callcast_${callId}_${participantId}`
adapter:  broadcastId = `adaptercast_${VideofySessionId}_${participantId}`
          broadcasterPeerId = derived, as callPublisherPeerId does today
```

The adapter supplies a Videofy `participantId` already — P6.8 mints one from the
dialog rather than echoing the caller's SIP identity, for the same reason it
mints its own session ref. The binding maps that to internal peer identity;
external identifiers (SIP `Call-ID`, Zoom meeting id, LiveKit room) stay adapter
metadata and never cross into engine identity.

## 9. Bounded calls, explicit outcomes, and backpressure

**Silence must not be a result.** Every boundary operation terminates with a
stated outcome. Neither of these is acceptable:

```text
await somethingForever()      // no deadline
return;                       // no one knows whether the frame was accepted
```

A media operation resolves to one of, conceptually:

```text
accepted
rejected-auth
rejected-session-closed
rejected-stale
dropped-backpressure
timed-out
internal-failure
```

The exact enum is an implementation choice; having one is not.

This rule is carried forward from P6.8, where three separate confirmed defects
were an `await` with no deadline or an exit that returned silently — and the
third survived two rounds of fixing its siblings, because each was patched as
reported instead of auditing every exit from the same `await`. The binding is the
other side of that same boundary.

**Backpressure reuses the existing live-media principle** rather than inventing an
adapter-specific queueing policy: a bounded queue, oldest stale speech sacrificed
before current speech, every drop observable. That is already the chunker's
`evict-oldest` semantics, already documented for live calls. The binding surfaces
refusal back through the port, which every adapter treats as a bounded, counted
event — P6.8 bounds each seam call with a deadline and books the outcome in its
media ledger.

**Engine disconnect must not strand a call.** The binding closes the adapter
session through the port's `closeSession`, and each adapter turns that into a
proper transport teardown. P6.8's `CallLifecycle` is the reference: one authority,
bounded waits, resources released before the call may report itself closed.

## 10. Lifecycle reconciliation

The port's five events map onto session state the gateway already keeps:

```text
openSession       → session already created by the exchange; the capability is
                    redeemed and the ingress attaches to it
participantJoined → register the participant on that session
pushAudio         → frames into the chunker for that participant
participantLeft   → deregister
closeSession      → stop the chunker, stop the ingest session, release
```

Ordering is not optional. P6.8 found and pinned that a slow `participantJoined`
could land *after* `closeSession`, and that audio could cross the seam for a
participant the seam had never been told about. The binding is the other side of
that boundary and holds the same invariants: no media for an unannounced
participant, no close for a session still opening, no join for a session already
closed.

## 11. Product configuration stays with the gateway

**Target languages, voices, pacing, providers, interpretation mode, source-language
authority and fallback chains continue to be decided when the gateway creates and
configures the session. They never come from SIP, Zoom, LiveKit or any other
adapter.**

For an inbound call these come from platform-side sources — organization policy,
route configuration, customer configuration, participant preferences, session
defaults — resolved inside the gateway.

An adapter may say:

```text
this is an inbound call on route X
participant metadata is Y
here is normalized 16 kHz audio
```

An adapter may never say:

```text
translate to Spanish using provider Z
```

This is already true — `createWebRtcSession` takes `targetLanguages`,
`voiceIdsByLanguage` and `sourceLanguageMode` from the gateway, never from the
media source, and `MediaAdapterPort` deliberately carries none of it. An adapter
that could name a language would be an adapter that knows what the engine is, and
every provider decision would leak outward from there.

## 12. Observability

Enough to answer "is this call working?" without reading logs, and to tell a
degraded seam from a degraded network:

```text
frames accepted / refused, by outcome, per session and per adapter
chunk emission and queue depth, with evictions counted apart from losses
capability redemptions, refusals, expiries and revocations
session lifecycle transitions, with reasons
latency decomposed: arrival → chunk → ingest accepted
```

Decomposition matters. P6.8's measurement report separates a *chosen* jitter
budget from *measured* cost, because a single "94 ms" figure invites the wrong
optimisation. The same discipline applies: a queue that drops audio on purpose
must be counted apart from a queue that lost it.

**Credentials must never appear in logs, metrics, thrown error text, test
snapshots or persisted media metadata.** Log a capability fingerprint or id where
correlation is needed; never the capability itself.

## 13. Negative security tests — required before P6.9 is complete

| Attack / failure | Required result |
| --- | --- |
| No service credential | Refused |
| Valid service, unauthorized route | Refused |
| Route credential used to submit audio | Refused |
| Session capability A used against session B | **Unrepresentable / refused** |
| Adapter supplies a fabricated internal session id | Not accepted by the contract |
| Expired session capability | Refused |
| Revoked session capability | Refused |
| Capability used after session close | Refused |
| Route credential revoked | New sessions refused |
| Duplicate create request | Same logical session, not a duplicate |
| One adapter uses another adapter's route | Refused |
| Missing production auth configuration | Service does not start |
| Downstream queue saturated | Explicit bounded drop result, counted |
| Gateway or media-ingest hangs | Deadline reached, no permanent resource leak |
| Credential in any log, metric, error or snapshot | Test fails |

These are acceptance criteria, not a wish list. Each should be pinned, and — given
what mutation testing found in P6.8 — each pin should be checked by reintroducing
the defect and confirming the pin fails.

## Not in scope

- Merging P6.6, P6.7 or P6.8 to `main`.
- External certification: Zoom validation, KingsConference staging access,
  independent SIP interoperability testing. Deferred by policy; not development
  blockers.
- Any new AI pipeline, provider, or language capability work.
- Deployment and hosting, deferred until Phase 6 blockers clear — except the
  fail-closed and network-exposure requirements above, which gate it.

## Implementation order

1. **Fail-closed internal auth**, plus startup refusal when configuration is
   absent. Independent of adapters, and blocks public deployment.
2. **Transport-neutral rename**, as a mechanical atomic refactor with the
   existing suites green before and after.
3. **Identifier typing**: branded `AdapterSessionRef` / `VideofySessionId` across
   the port and its adapters.
4. **Credential and capability model**: issuance, resolution, expiry, revocation,
   rotation, and the idempotent route/session exchange.
5. **Adapter Ingress Binding** implementing `MediaAdapterPort` over the renamed
   chunker.
6. **Wire one adapter end to end** — SIP first, as the most reviewed — and only
   then the others.

Each step should stand alone with the suites green, so a half-finished P6.9 never
leaves the platform worse than it is now.

## Open questions for implementation

- Capability transport: header, or part of the ingress call signature? A header
  keeps `MediaAdapterPort` unchanged; a parameter makes it impossible to forget.
- Capability lifetime for long calls: renewal, or a capability that outlives its
  session by construction.
- Whether `adaptercast_` is right, or whether call and adapter sessions should
  converge on one scheme now that there would be three producers.
- Where route credentials are provisioned and stored, and how revocation
  propagates to adapters already holding one.
