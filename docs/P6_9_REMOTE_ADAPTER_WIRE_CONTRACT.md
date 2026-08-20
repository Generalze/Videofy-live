# P6.9 — Remote Media Adapter Wire Contract (Design)

Date: 2026-08-20
Status: DESIGN — approved with amendments, 2026-08-20. No network code written.
Scope: the contract and protocol layer only. Credential and capability
**issuance** is Step 5 and is deliberately not designed here; this document
reserves the places authority attaches so Step 5 does not have to redesign
transport.

## Why this exists

`MediaAdapterPort` is a TypeScript interface. Adapters are separate processes —
the SIP adapter sits near the SBC, the Zoom adapter near Zoom's webhooks. An
interface does not cross a process boundary, however confidently it is typed.

An earlier draft of the P6.9 design filed this as an open question about where
to put a capability header. That presupposed a transport nobody had chosen.
This document chooses it.

**One correction from review is worth reading before the rest**, because it was
a genuine protocol bug rather than a matter of taste: the first draft
acknowledged media with `acceptedThroughSequence`, which cannot state the truth
when a frame inside the range was refused. §9 replaces it with settlement plus
explicit exceptions. Implementing the original would have baked an accounting
contradiction into version 1, and versioning a mistake only gives it a number.

## 1. Two planes, because they have opposite characteristics

```text
              CONTROL PLANE                        MEDIA PLANE
     create/bind session                  continuous 16 kHz PCM
     participant lifecycle                one frame per 20 ms
     close                                50 ops/second/speaker, doubled
     infrequent, request/response         for two-way, multiplied again
     naturally idempotent                 for conferences
              │                                        │
        HTTPS / JSON                    WSS, binary, persistent, multiplexed
              │                                        │
              ▼                                        ▼
                        Adapter Ingress (realtime-gateway)
```

One HTTP request per 20 ms frame would be fifty request ceremonies a second per
speaker — a surprisingly elaborate way to benchmark headers, and a
connection-setup cost on the path of every utterance.

## 2. Where the code lives

```text
packages/media-adapter-port     semantic contract. UNCHANGED, still zero
                                dependencies, still no network vocabulary.

packages/adapter-wire           the protocol: message types, binary codec,
                                limits, outcomes. Pure encode/decode, no
                                sockets, testable without a network. Follows
                                the existing `packages/call-wire` pattern.

adapter side                    RemoteMediaAdapterPort — implements
                                MediaAdapterPort over the wire. The rest of
                                SIP does not learn that it became remote.

services/realtime-gateway       AdapterIngressServer — terminates the wire and
                                drives the binding.
```

The seam package stays pure. Step 3's transport-neutrality pin already fails the
build if anything outside the package is imported into it, and that must keep
holding.

## 3. Identity on the wire

The wire may carry:

```text
AdapterSessionRef        the adapter's own correlation reference
participantId            Videofy participant identity, adapter-minted
displayName
platformTimestampMs
wireSequence
PCM samples
reason
protocol metadata
```

It must **never** carry `VideofySessionId` as something the adapter supplies.
The platform resolves its own session from the capability presented at bind
time (Step 5); nothing an adapter sends names a platform session.

```text
AdapterSessionRef + session capability
                 │
                 ▼
          gateway binding
                 │
                 ▼
          VideofySessionId          never crosses back
```

## 4. Protocol versioning, from the first byte

Every media frame header begins with a version octet. Every control request
carries `protocolVersion`. A mismatch fails **explicitly**:

```text
PROTOCOL_UNSUPPORTED
```

and the connection is refused. What must not happen is the alternative:

```text
connection accepted → unrecognised field ignored → audio quietly disappears
```

Control routes are versioned in the path (`/internal/adapter/v1/…`). This is the
right place for versioning, unlike the internal media rename in the previous
step: that contract is between two services released as one unit, while this one
faces adapter processes that may be deployed and upgraded separately. Internal
protocols age too — they simply do so while everyone insists they are temporary.

## 5. Control plane

```text
POST   /internal/adapter/v1/sessions             create or rebind
POST   /internal/adapter/v1/sessions/participants        announce
DELETE /internal/adapter/v1/sessions/participants        withdraw
POST   /internal/adapter/v1/sessions/close               end
```

No authoritative session identity appears in any route parameter. Requests
identify their subject by `adapterSessionRef` plus the capability that resolves
it; the gateway does the resolution.

Request envelope (illustrative):

```json
{
  "protocolVersion": 1,
  "adapterSessionRef": "sc_9f3a1c7b",
  "routeRef": "route_17",
  "idempotencyKey": "…",
  "platformSessionRef": "external-call-id"
}
```

`platformSessionRef` is the external system's own identifier — a SIP `Call-ID`,
a meeting id. Metadata, recorded for correlation, never authority.

### Where `routeRef` comes from — and where it does not

`routeRef` appears on the wire and **must not** appear in `MediaAdapterPort`.
Route authorization is remote composition and security; the semantic seam faces
the engine and has no business carrying either.

The remote client is **bound to a route at construction**:

```ts
RemoteMediaAdapterPort.forRoute(routeRef, connection)
```

A process serving several numbers or meetings holds several lightweight
route-scoped facades over ONE underlying connection. So:

```text
SIP signalling determines the configured route
        ↓
select that route's RemoteMediaAdapterPort facade
        ↓
SipCall sees an ordinary MediaAdapterPort — openSession(sessionRef, …)
        ↓
the remote implementation supplies routeRef itself
```

`SipCall` never learns a route exists, which is the same reason it never learns
a language exists.

### Session creation is idempotent

Encoded now, because retrofitting idempotency after an adapter is in production
is miserable. The logical key is deterministic:

```text
adapter identity + routeRef + adapterSessionRef
```

so a lost response cannot produce a second session:

```text
POST create            → binding B, capability C
  (response lost)
POST create (retry)    → binding B, same logical session
```

and never a second binding while the first stays alive holding a chunker, a
staging directory and an ingest session nothing will close. SIP retransmits; P6.8
has three defects and several pins that exist only because of that.

Replays outside the retry window, or with a changed body under the same key, are
refused rather than silently reinterpreted.

## 6. Media channel

**One persistent connection per adapter process**, multiplexing every session and
participant it handles:

```text
SIP adapter process
      │
      └── one media connection
              ├─ stream 1 → session A / participant X
              ├─ stream 2 → session B / participant Y
              └─ stream 3 → session C / participant Z
```

Not one connection per stream. One connection gives one place for service
authentication, reconnect, health, resource limits and observability. Session
capability still scopes each logical stream, so multiplexing does not merge
authority.

### Stream binding

A media frame must not carry `adapterSessionRef` and `participantId` as strings
fifty times a second. A control envelope on the channel binds them once and
receives a compact `streamId`:

```text
STREAM_OPEN { adapterSessionRef, participantId, capability }
        │
        ▼
STREAM_OPEN_ACK { streamId }
        │
        ▼
MEDIA frames reference streamId only
```

This is the same idea as an RTP SSRC, and it is what keeps the per-frame header
at 24 bytes.

`streamId` **0 is reserved** for connection-scoped messages, and **a streamId is
never reused within one connection's lifetime**. A reconnect gets a fresh
namespace. Both rules exist so that a frame still sitting in a buffer somewhere
cannot acquire a new meaning by arriving late against a recycled number — the
same class of hazard as an RTP SSRC being reused mid-call.

### STREAM_OPEN binds media; it does not create a participant

Participants exist because the control plane announced them:

```text
HTTPS participant announce   →  participant exists
                                       ↓
                             STREAM_OPEN may bind its media
```

`STREAM_OPEN` for a participant that was never announced is refused with
`rejected-participant`. Two paths capable of creating participant state is one
path too many, and P6.8 spent a round on the consequence of media arriving for
a participant the seam had never been told about.

### Message types

```text
0x01  HELLO             client → server, opens the connection
0x02  HELLO_ACK
0x10  STREAM_OPEN       bind sessionRef+participant → streamId
0x11  STREAM_OPEN_ACK
0x12  STREAM_CLOSE
0x20  MEDIA             binary PCM
0x30  ACK               cumulative, per stream
0x31  DISPOSITION       gaps, refusals, evictions
0x40  PING
0x41  PONG
0x50  ERROR
```

## 7. Binary frame layout

Header is fixed at 24 bytes, big-endian (network order). Payload follows.

```text
offset  size  field                type      notes
------  ----  -------------------  --------  ---------------------------------
0       1     protocolVersion      uint8     1
1       1     messageType          uint8     see above
2       2     flags                uint16    bit 0: discontinuity (§9)
                                             bits 1-15 reserved, must be zero
4       4     streamId             uint32    0 for connection-scoped messages
8       4     wireSequence         uint32    per stream, see §8
12      8     platformTimestampMs  float64   media time, exact to 2^53 ms
20      4     payloadLength        uint32    bytes following the header
24      …     payload
```

**Endianness is pinned in two directions on purpose, and this is a trap worth
naming.** Header fields are **big-endian**, by network convention. The PCM
payload is **little-endian** `pcm_s16le`, because that is what the existing
pipeline already declares end to end (`pcmFormat: 'pcm_s16le'`). Mixing them is
deliberate; getting it wrong produces audio that is loud, wrong and superficially
plausible, so both are pinned by test.

**The codec defines PCM as little-endian independently of host architecture.**
An earlier draft said both ends could "hand the bytes straight to an
`Int16Array`", which is true only because the machines involved happen to be
little-endian — and a protocol whose correctness derives from CPU byte order is
a protocol with an undocumented dependency on where it runs. A typed array uses
NATIVE order, so that shortcut is a fast path, not a definition:

```text
host is little-endian   → zero-copy typed-array view
otherwise               → explicit little-endian conversion
```

Both branches produce identical bytes by definition, and both are tested. At 640
bytes per ordinary frame this is not where the CPU budget will be decided.

### MEDIA payload validity

```text
payloadLength > 0
payloadLength % 2 === 0        PCM16 with an odd byte count is malformed
payloadLength <= 16 KiB        see §12
```

An odd length is not a short read to be tolerated; it is a frame that cannot be
what it claims to be.

`platformTimestampMs` is float64 rather than an integer type because JavaScript
numbers already are float64: every integral millisecond value up to 2^53 is
exact, no `BigInt` is allocated per frame, and the value survives the round trip
identically to the number the adapter computed.

Control messages (`0x01`–`0x12`, `0x30`–`0x50`) carry a UTF-8 JSON payload.
Media messages carry raw PCM. No base64 anywhere: base64 in JSON would inflate
every frame by a third to move bytes that are already binary through a channel
that already carries binary.

## 8. Three clocks, kept apart

P6.8 taught this expensively — a monotonic media clock hid a 45-hour error
because nothing compared it against arrival.

```text
wireSequence          transmission order, per (streamId)
platformTimestampMs   source media time, from the adapter
gatewayReceivedAtMs   arrival, observed by the gateway
```

They answer different questions and must not be collapsed. Together they give
duplicate detection, missing-frame accounting, reorder detection, and the ability
to tell a slow network from a re-based sender.

`wireSequence` is a per-stream uint32 starting at 0 and increasing by one per
media frame. Wrap at 2^32 is defined as continuing modulo 2^32 and compared with
signed 32-bit distance, exactly as RTP sequence numbers are compared in P6.8's
jitter buffer — at 50 frames/second a wrap is 2.7 years away, but "unreachable"
is not a specification.

**It is allocated when a frame is committed to transmission** — after the
outbound queue has made its eviction decisions, immediately before the send.
That keeps the field true to its name: it numbers what went onto the wire, not
every frame the adapter once contemplated sending. A locally evicted frame is
counted as `adapterOutboundEvicted` and never manufactures a gap the network did
not cause.

`platformTimestampMs` must satisfy `Number.isFinite(value) && value >= 0`. NaN
and the infinities are rejected as `protocol-error`: they encode and decode
perfectly well as binary64 and would then poison every downstream comparison.

### Ordering

For a given `streamId`, media frames are **logically ordered by `wireSequence`**.
The gateway does not guess.

A WebSocket preserves message order within one connection, so in the normal case
the sequence merely confirms what the transport already provided. It earns its
place across reconnects, in diagnostics, against application bugs, and for any
future transport that is not a single ordered stream.

### The ingress server does NOT reorder

Transport reordering is already normalized before `MediaAdapterPort`: P6.8's
jitter buffer exists precisely for that, and WSS is ordered besides. Adding
another reorder buffer here would give one sentence three queues to clear:

```text
RTP jitter buffer  →  remote-wire reorder buffer  →  transcription chunk buffer
```

So the server classifies rather than buffers:

```text
expected sequence      accept
duplicate or behind    count, do NOT deliver twice
forward gap            report the missing range, mark discontinuity, deliver
                       the current frame if the gap is within a sane bound
absurd jump            stream protocol error (§13)
```

## 9. Acknowledgement and backpressure

**Media frames are not acknowledged individually.** Waiting for a round trip per
20 ms frame would serialise a live conversation around network latency.

An earlier draft of this document used `acceptedThroughSequence`, and it was
wrong in a way worth recording. Given:

```text
101 accepted   102 accepted   103 refused   104 accepted   105 accepted
```

`acceptedThroughSequence: 105` asserts under ordinary cumulative semantics that
103 was accepted, which is false. Holding at 102 leaves 104 and 105 unresolved
forever. **There is no truthful value**, because one number was being asked to
carry two different facts.

Separate them. The cumulative number reports **settlement** — that a terminal
disposition exists — and the exceptions are stated:

```text
SETTLEMENT  { streamId, settledThroughSequence: 105 }
DISPOSITION { streamId, outcome: 'gateway-refused', fromSequence: 103,
              toSequence: 103, count: 1 }
```

with one invariant:

> Every sequence at or below `settledThroughSequence` has a terminal
> disposition. Anything not named by a negative `DISPOSITION` was accepted.

which reads back cleanly as 101 accepted, 102 accepted, 103 refused, 104 and 105
accepted. A gap is a statement rather than an absence, and the ledger gets the
evidence P6.8 established without stop-and-wait networking.

### What settlement means, and what it does not

> **Settlement is gateway wire-ingress custody, and nothing further.**

It says the gateway owns the frame. It does not say the speech reached STT, nor
that a listener will hear it. If the transcription chunker later evicts a chunk
under its own bounds, that is downstream observability — it does **not**
retroactively invalidate a settled frame, and no negative disposition is emitted
for it.

```text
AdapterAudioFrame
      ↓
adapter outbound queue
      ↓
wire send
      ↓
gateway accepts custody          ← WIRE SETTLEMENT ENDS HERE
      ↓
MediaTranscriptionChunker
      ↓
chunk queue
      ↓
media-ingest  →  STT → MT → TTS
```

Collapsing that boundary would make a wire acknowledgement a promise about
interpretation, which no transport can keep.

### Bounded outbound buffering

The client queue is bounded, or a slow gateway turns the SIP adapter into an
accidental RAM benchmark — which is precisely the defect found in P6.8's own
delivery chain, where an unbounded queue of pump tasks grew at ~50/second while
completing one.

```text
bounded by bytes, by frames, and by age
on saturation: evict OLDEST, preserve newest speech
```

consistent with the `live-conversation` policy the pipeline already uses.

**Each loss is counted at the custody boundary where it happened**, and the
categories are mutually exclusive by construction. Collapsing them into one
cheerful `dropped` is how a degraded seam becomes indistinguishable from a
degraded network:

```text
adapterOutboundEvicted   discarded before transmission, by our own bounded queue
networkSendFailed        transmission attempted, transport failed
gatewayRefused           the gateway refused custody of the wire frame
downstreamChunkEvicted   frame entered the pipeline; a later transcription
                         chunk was evicted under the chunker's own bounds
```

The first three are wire dispositions. The fourth is **observability, not a
frame-level NACK** — by then the gateway has custody and settlement has already
happened.

A fifth category for gateway ingress queueing is deliberately absent. P6.9's
binding drives the chunker directly and introduces no queue of its own between
the wire and it, so there is nothing there to evict. If such a queue is ever
added, it earns a category then. Inventing a metric for a queue that does not
exist, merely because five sounds more comprehensive than four, would produce a
counter that is always zero and a reader who trusts it.

## 10. Lifecycle and reconnection

```text
CONNECTED      hello acknowledged, streams may open
DEGRADED       liveness suspect: pong overdue, or send queue saturated
RECONNECTING   transport lost, backoff in progress
CLOSED         terminal
```

`PING`/`PONG` on an idle deadline. A dead socket must become an explicit state
rather than a healthy-looking one that Node has not yet emitted an event for —
P6.8's whole teardown redesign exists because "not yet answered" and "never going
to answer" were indistinguishable without a deadline.

### Reconnection resumes transport, never authority

This belongs in Step 4 even though capabilities arrive in Step 5, because the
rule constrains the protocol:

```text
connection drops
      ↓
reconnect
      ↓
session state is REVALIDATED
```

and never:

> "I used to send `sc_123`, therefore `sc_123` exists again."

A reconnected client re-runs `HELLO` and re-opens each stream, presenting its
capability:

```text
reconnect  →  service credential on the Upgrade  →  HELLO  →  revalidate
           →  STREAM_OPEN per live stream  →  NEW streamId
           →  wireSequence restarts at 0 for that new stream
```

A stream whose session has since closed is refused with `rejected-stale`.
`AdapterSessionRef` is correlation; it is not resurrection magic, and a reference
an adapter still happens to remember is not evidence that a session exists.

This costs a round trip per live stream on reconnect. That is the right trade:
implicit resumption is exactly how "I remember `sc_123`" becomes "therefore it
exists", and authority is worth more than one RTT of recovery latency.

## 11. Outcomes — silence is not a result

Every control operation and every disposition resolves to one of:

```text
accepted
rejected-auth            credential or capability refused
rejected-route           adapter not permitted to originate this
rejected-session         no such session, or not this adapter's
rejected-participant     unknown or not permitted on this session
rejected-stale           session closed, or capability expired
dropped-backpressure     bounded queue shed it, counted
timed-out                deadline reached with no answer
protocol-error           malformed, oversized, or unknown type
internal-failure         the gateway's fault, and it says so
```

No operation disappears into `Promise<void>` once it has crossed a network.

The **local** `MediaAdapterPort` keeps its present shape: `RemoteMediaAdapterPort`
translates these outcomes into resolution or rejection, so `SipCall` continues to
see the bounded, counted, fallible seam it already handles.

## 12. Limits

Generous is fine. Unbounded is not — the gateway becomes an authenticated parser
facing adapter processes.

```text
control message (JSON)          64 KiB
MEDIA payload                   16 KiB      even, non-zero; see below
header                          24 B, fixed
active streams per connection   256
participants per session        64
outbound queue                  8 MiB / 2000 frames / 4 s, whichever first
malformed messages              8, then the connection is closed
idle without pong               30 s
```

16 KiB for media rather than 64. At a fixed 16 kHz mono PCM16:

```text
 20 ms  →     640 bytes
100 ms  →   3,200 bytes
~500 ms →  ~16 KiB
```

so 16 KiB is still twenty-five times an ordinary frame while rejecting absurd
multi-second "frames" at the header rather than after allocating for them. A
limit that only rejects the obviously insane is a limit doing half its job.

## 13. Malformed input — proportionate responses

The blast radius of bad input must match its scope. One bad frame must not kill
every unrelated SIP call multiplexed over the same connection, and a corrupted
header must not be politely ignored forever.

```text
one undecodable MEDIA payload
      → drop that frame, count it, DISPOSITION protocol-error

a violation scoped to one stream
  (unknown streamId, sequence far outside any window)
      → close that stream, leave the connection

structural violation
  (header shorter than 24 bytes, payloadLength disagreeing with the frame,
   reserved flags set, unknown message type)
      → close the connection

authentication or protocol-version failure
      → refuse the connection before any stream exists
```

The malformed-message counter in §12 bounds the first case so a peer cannot
stream garbage indefinitely at zero cost.

## 14. Transport security

The contract assumes `wss://` and `https://`. Step 5's route and service
credentials cannot safely travel in plaintext, and a protocol that only works
because the network is trusted is a protocol that will eventually be run on a
network that is not.

Same-host deployment over loopback is an acceptable *operational* choice on the
initial single VPS. It is not a property the contract may depend on.

## 15. Where authority attaches — reserved, not implemented

Step 5 owns issuance. Step 4 reserves the slots so that adding them is not a
transport redesign:

```text
HTTPS control request   Authorization: <service credential>     ← Step 5
WSS HTTP Upgrade        Authorization: <service credential>     ← Step 5
                        validated BEFORE HELLO is accepted
Session create          response carries sessionCapability      ← Step 5
STREAM_OPEN             presents sessionCapability              ← Step 5
```

The persistent media connection authenticates on its **HTTP Upgrade**, not in a
JSON frame afterwards. `HELLO` therefore carries protocol version and an adapter
instance identity for correlation, and **no secret material at all** — long-lived
credentials do not belong inside application frames that get logged, buffered and
replayed.

That gives two distinct authorities:

```text
connection authority  =  service identity      (who is connected)
stream authority      =  session capability    (what this stream may touch)
```

Until then these are typed as opaque and threaded through unvalidated, with the
server rejecting nothing on their basis. **No interim shared secret is invented
here.** A homemade placeholder is exactly the sort of thing that becomes the
permanent answer, and the internal ingress token this milestone already had to
repair is the cautionary example.

## 16. Product configuration is absent, and that is a checked property

The schema contains **no field** for source language, target language, voice,
provider, translation mode, personal voice, pacing, STT engine or TTS engine.

An adapter may say:

```text
this is a call on route X, participant Y, here is normalized audio
```

It may never say:

```text
translate to Spanish using provider Z
```

The gateway resolves product policy from route and organisation configuration.
§17 makes the absence a test rather than an intention.

## 17. Negative and protocol test matrix

Required before Step 4 is complete. Each pin mutation-checked — the defect
reintroduced, the pin required to fail — because this project has earned its
paranoia and roughly ten pins have already passed vacuously in it.

| Case | Required result |
| --- | --- |
| Encode → decode round trip | Byte-identical |
| PCM payload fidelity | Samples identical, bit for bit |
| Int16 endianness | Payload little-endian, pinned explicitly |
| Header endianness | Big-endian, pinned explicitly |
| `platformTimestampMs` round trip | Exactly equal, including large values |
| Header shorter than 24 bytes | `protocol-error`, connection closed |
| `payloadLength` disagreeing with frame | `protocol-error`, connection closed |
| Oversized frame | Refused, counted, connection closed past the limit |
| Unknown message type | `protocol-error`, connection closed |
| Reserved flag bits set | `protocol-error` |
| Unsupported protocol version | Connection refused before any stream |
| Duplicate `wireSequence` | Detected, counted, not delivered twice |
| Missing `wireSequence` | Gap reported by DISPOSITION, discontinuity marked |
| Reordered arrival | Classified and reported; **never buffered for reorder** |
| Absurd forward jump | Stream protocol error, connection survives |
| Sequence wrap at 2^32 | Continues, no reordering artefact |
| Sequence allocated after eviction | A locally evicted frame leaves no wire gap |
| `platformTimestampMs` NaN or infinite | `protocol-error`, rejected |
| `platformTimestampMs` negative | `protocol-error`, rejected |
| MEDIA payload of zero bytes | `protocol-error` |
| MEDIA payload of odd length | `protocol-error` — PCM16 cannot be odd |
| MEDIA payload above 16 KiB | Refused at the header, not after allocating |
| Settlement with a refused frame inside the range | Refusal named by DISPOSITION; every other sequence at or below reads as accepted |
| Settlement never regresses | `settledThroughSequence` is monotonic per stream |
| Downstream chunk eviction after settlement | No negative disposition; settlement stands |
| Drop categories | Mutually exclusive; no frame counted in two |
| `streamId` 0 used for MEDIA | `protocol-error` |
| `streamId` reused within one connection | Refused |
| Reconnect | New `streamId`, `wireSequence` restarts at 0 |
| `STREAM_OPEN` for an unannounced participant | `rejected-participant` |
| Big-endian host (simulated) | Identical bytes to the little-endian path |
| `routeRef` present in `MediaAdapterPort` | Test fails |
| Secret material in `HELLO` | Test fails |
| Two participants on one session | Multiplexed, never interleaved |
| Two sessions on one connection | Multiplexed, independent |
| One malformed stream | Other streams unaffected |
| Unknown `streamId` | That stream refused, connection survives |
| Disconnect then reconnect | Streams re-opened, transport resumed |
| Stale session after reconnect | `rejected-stale`, not recreated |
| Outbound queue saturation | Bounded; oldest evicted; counted separately |
| Cumulative ACK | Advances; unacked reported |
| Drop accounting | Five categories never collapsed into one |
| Idle without pong | DEGRADED, then RECONNECTING |
| Duplicate session create | Same binding, not a second session |
| Any product/language field in the schema | Test fails |
| `VideofySessionId` on the adapter wire | Test fails |

## 18. Not in scope

- Credential and capability **issuance**, validation, expiry, revocation and
  rotation. That is Step 5.
- The Adapter Ingress Binding's session resolution and chunker driving. Step 6.
- Wiring any adapter end to end. Step 7.
- Multi-host media staging, replicas, rolling deploys. Recorded as a scale
  boundary in the P6.9 design; not built now.

## 19. Implementation order, after this document is approved

```text
1. packages/adapter-wire      types, codec, limits, outcomes — no sockets
2. codec tests + mutation     the matrix above, before anything opens a port
3. RemoteMediaAdapterPort     client, route-scoped facade, bounded queue,
                              reconnect, connection state machine
4. AdapterIngressServer       server, framing, multiplexing, settlement,
                              dispositions
5. loopback protocol tests    client ↔ server over a real socket
```

The codec being pure and testable without a network is deliberate: every
protocol property in §17 can be pinned before a single port is bound, and a
failure there is a failure of the contract rather than of the weather.
