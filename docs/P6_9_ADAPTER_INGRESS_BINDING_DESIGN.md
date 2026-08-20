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

**Two corrections to that optimism, both found by inspecting the code rather
than trusting the shape of it.** The pipeline is *substantially* neutral, not
*completely* neutral, and one layer that P6.9 needs does not exist at all:

- Live-media behaviour is currently selected by a STRING PREFIX on the session
  id — see §9. An adapter session would silently get the wrong queue policy.
- `MediaAdapterPort` is a TypeScript interface, and adapters are separate
  processes. There is no wire protocol — see §3.

Neither changes the direction. Both change the work.

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

## 3. The wire contract — a TypeScript interface does not cross a process boundary

`MediaAdapterPort` is an interface, and its only implementation is an in-memory
double. That works when both objects live in one Node process. It does nothing
at all for:

```text
SIP adapter process      (near the SBC)
Zoom adapter process
LiveKit adapter process
            │
            ▼
Realtime Gateway process
```

An earlier draft of this document filed the transport as an open question about
where to put a capability header. That presupposed a transport nobody had
chosen. The transport is a decision, and it is made here.

### Two planes, because they have opposite characteristics

```text
                 CONTROL PLANE                     MEDIA PLANE
        route → session exchange            continuous 16 kHz PCM frames
        participant lifecycle               one frame per 20 ms
        capability issuance                 50 operations/second/speaker
        close                               doubled for two-way, multiplied
                                            again for conferences
                    │                                   │
              HTTPS / internal RPC          persistent authenticated WebSocket
                    │                                   │
                    ▼                                   ▼
                        Adapter Ingress Binding
```

**Control plane: HTTPS.** Infrequent, request/response, naturally idempotent
(§6), and it already matches how the gateway talks to `media-ingest`.

**Media plane: a persistent authenticated WebSocket.** One HTTP request per
20 ms frame would be fifty request ceremonies per second per speaker — an
ambitious tribute to header overhead, and a new connection-setup cost on the
path of every utterance. A persistent connection also gives the binding
somewhere to put backpressure that the sender can actually observe.

### The capability is bound at channel establishment

The session capability authorizes the **channel**, once, when it is opened —
not each frame at each call site:

```text
open media channel  ──►  present capability  ──►  channel is bound to
                                                  exactly one session
                                                       │
                                            every frame on this channel
                                            belongs to that session, by
                                            construction
```

This is the same principle as §4. A capability that must be remembered at every
call site is a capability that will eventually be forgotten at one of them.
Binding it to the channel makes "which session is this frame for?" unanswerable
by the sender, which is precisely the point.

A channel carries one session. An adapter handling many concurrent calls opens
many channels, which also gives per-call backpressure and per-call teardown for
free.

### Shape

```text
RemoteMediaAdapterPort            (adapter side)
        │  implements MediaAdapterPort
        │
       WSS
        │
AdapterIngressServer              (gateway side)
        │
Adapter Ingress Binding
```

The adapter is unchanged by becoming remote. `SipCall` already speaks
`MediaAdapterPort` and already treats every seam call as bounded, fallible and
counted — P6.8 bounds each one with a deadline and books the outcome in its
media ledger. A remote port that rejects, times out or refuses is a case those
adapters already handle, because a hanging callback and a slow network are the
same event to them.

That is the payoff for the seam existing at all: the transport becomes remote
without SIP, Zoom or LiveKit learning that it did.

## 4. Session capability resolves the session; it does not accompany one

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

## 5. Identifier typing — adapter refs must not masquerade as session ids

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

## 6. Session creation must be retry-safe

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

## 7. Fail closed — a security prerequisite, not later hardening

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

## 8. Transport-neutral rename, migrated atomically

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

## 9. Identity mapping, and the media policy that must stop being a prefix

`call-runtime` already solves the identity half; the binding follows it rather
than inventing a second convention:

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

### The prefix coupling, and why an earlier draft of this document was wrong

`WebRtcTranscriptionBridge` currently selects live-media behaviour by a **string
prefix on the session id**:

```ts
const CALL_BRIDGE_SESSION_PREFIX = 'call_';
function isCallBridgeSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CALL_BRIDGE_SESSION_PREFIX);
}
```

and that predicate gates three things at chunker construction:

```text
queueOverflowPolicy: 'evict-oldest'
onQueueOverflow:     the eviction callback
partialIntervalMs:   streaming partial captions
```

So an adapter session named `adaptercast_…` would silently get `reject-new` and
no partials — the programme behaviour, on a live phone call, where a backlog of
stale speech would be kept in preference to the sentence being spoken now.

An earlier draft of this document claimed the binding could "reuse the existing
live-media principle" simply by joining the pipeline. **That claim was false**,
and it was false in the one place the behaviour is actually decided. It was
found by reading the bridge, not by reasoning about the architecture. The
pipeline is substantially transport-neutral; it is not completely so.

The fix is not to name adapter sessions `call_` so they inherit the right
behaviour by disguise. That would deepen exactly the naming-as-policy coupling
this milestone exists to remove, and it would make the correct behaviour of a
phone call depend on a string literal.

**Replace prefix inference with an explicit, gateway-owned media mode:**

```ts
mediaMode: 'programme' | 'live-conversation'
```

carried on the session context, from which the gateway derives the detailed
policy:

```text
programme          → reject-new, no streaming partials
live-conversation  → evict-oldest, streaming partials
```

The high-level mode is the right level for the same reason as §12: adapters do
not decide product behaviour, and neither should a naming convention. Every
producer then declares what it is rather than being guessed at:

```text
browser programme broadcast  → programme
native call                  → live-conversation
SIP                          → live-conversation
Zoom                         → live-conversation
LiveKit                      → live-conversation
```

This is part of the §8 rename, not a separate refactor: both remove a historical
implementation detail that had quietly become architecture. When the prefix goes,
`isCallBridgeSessionId` goes with it — the session id returns to being an
identifier rather than a carrier of policy.

## 10. Bounded calls, explicit outcomes, and backpressure

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

## 11. Lifecycle reconciliation

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

## 12. Product configuration stays with the gateway

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

## 13. Observability

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

## 14. Negative security tests — required before P6.9 is complete

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

## 15. Shared media staging — a recorded scale boundary

The bridge writes each chunk into a staging directory and sends `media-ingest` a
**`sourcePath`**. Gateway and media-ingest therefore share a filesystem
namespace today.

For the initial single-VPS topology that is fine and needs no change:

```text
Contabo VPS
├── realtime-gateway
├── media-ingest
└── shared media staging volume        (an explicitly configured mount
                                         if containers are used)
```

What does not survive splitting the services across hosts:

```text
Gateway on host A
      │  sends /uploads/chunk-1729.wav
      ▼
media-ingest on host B      ← cannot open host A's path
```

Host B cannot open host A's path through optimism. When the services separate,
`sourcePath` becomes an object-storage reference, streamed bytes on the existing
channel, or genuinely shared network storage.

**This is not a P6.9 blocker** and P6.9 should not pre-emptively solve it —
building object storage for a single-host deployment would be cost without a
benefit. It is recorded here so that the constraint is known before someone
scales horizontally and discovers it as an outage. It is the same class of
assumption as `MEDIA_INGEST_PUBLIC_URL`, whose own `.env.example` comment records
two rounds of investigation lost to a loopback address that resolved to the wrong
machine.

## Not in scope

- Merging P6.6, P6.7 or P6.8 to `main`.
- External certification: Zoom validation, KingsConference staging access,
  independent SIP interoperability testing. Deferred by policy; not development
  blockers.
- Any new AI pipeline, provider, or language capability work.
- Deployment and hosting, deferred until Phase 6 blockers clear — except the
  fail-closed and network-exposure requirements above, which gate it.

## Implementation order

0. **Resolve the SIP package entrypoint contradiction** before P6.8 is described
   as a runnable service. *(Done: `0158cd3` settled it as a library — there is
   nothing for a running SIP process to deliver audio to until this milestone
   exists — with four pins so a manifest cannot again advertise a runtime that
   is not there.)*
1. **Fail-closed internal auth**, plus startup refusal when configuration is
   absent. Independent of adapters, and blocks public deployment.
2. **Transport-neutral rename**, as a mechanical atomic refactor with the
   existing suites green before and after — including removing the `call_`
   prefix as the selector of live-media policy (§9), since both are the same
   correction.
3. **Identifier typing**: branded `AdapterSessionRef` / `VideofySessionId` across
   the port and its adapters.
4. **The remote wire contract** (§3): HTTPS control plane, persistent
   authenticated media channel, capability bound at channel establishment.
5. **Credential and capability model**: issuance, resolution, expiry, revocation,
   rotation, and the idempotent route/session exchange.
6. **Adapter Ingress Binding** implementing `MediaAdapterPort` over the renamed
   chunker.
7. **Wire one adapter end to end** — SIP first, as the most reviewed — and only
   then the others.

Each step should stand alone with the suites green, so a half-finished P6.9 never
leaves the platform worse than it is now.

## Open questions for implementation

- Capability lifetime for long calls: renewal on the existing channel, or a
  capability that outlives its session by construction. (Channel binding, §3,
  removes the per-call-site question this list previously asked.)
- Media channel behaviour on reconnect: whether a dropped channel may re-present
  the same capability, or must re-exchange. Re-presenting is simpler; re-exchange
  is safer if a capability can leak.
- Frame framing on the media channel: one frame per message, or batched. Batching
  cuts per-message overhead at the cost of latency, and 20 ms is already small.
- Whether `adaptercast_` is right, or whether call and adapter sessions should
  converge on one scheme now that there would be three producers.
- Where route credentials are provisioned and stored, and how revocation
  propagates to adapters already holding one.
