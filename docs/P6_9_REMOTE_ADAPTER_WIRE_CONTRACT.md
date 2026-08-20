# P6.9 — Remote Media Adapter Wire Contract (Design)

Date: 2026-08-20
Status: DESIGN — for review before any network code is written.
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
2       2     flags                uint16    bit 0: end of stream
                                             bit 1: discontinuity
                                             others reserved, must be zero
4       4     streamId             uint32    0 for connection-scoped messages
8       4     wireSequence         uint32    per stream, see §8
12      8     platformTimestampMs  float64   media time, exact to 2^53 ms
20      4     payloadLength        uint32    bytes following the header
24      …     payload
```

**Endianness is pinned in two directions on purpose, and this is a trap worth
naming.** Header fields are **big-endian**, by network convention. The PCM
payload is **little-endian** `pcm_s16le`, because that is what the existing
pipeline already declares end to end (`pcmFormat: 'pcm_s16le'`) and what an
`Int16Array` is on every platform this runs on. Keeping the payload little-endian
means both ends can hand the bytes straight to an `Int16Array` with no byte
swapping on the audio path. Mixing them is deliberate; getting it wrong produces
audio that is loud, wrong and superficially plausible, so both are pinned by
test.

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

### Ordering

For a given `streamId`, media frames are **logically ordered by `wireSequence`**.
The gateway does not guess.

A WebSocket preserves message order within one connection, so in the normal case
the sequence merely confirms what the transport already provided. It earns its
place across reconnects, in diagnostics, against application bugs, and for any
future transport that is not a single ordered stream.

## 9. Acknowledgement and backpressure

**Media frames are not acknowledged individually.** Waiting for a round trip per
20 ms frame would serialise a live conversation around network latency.

```text
adapter sends   101 102 103 104 105
gateway replies ACK { streamId, acceptedThroughSequence: 105 }
```

Cumulative, periodic. Anything not covered by an ACK is reported explicitly:

```text
DISPOSITION {
  streamId,
  outcome,                       one of §11
  fromSequence, toSequence,
  count
}
```

so a gap is a statement rather than an absence. This gives the ledger evidence
P6.8 established without turning a realtime call into stop-and-wait networking.

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

**Five different things are counted separately.** Collapsing them into one
cheerful `dropped` is how a degraded seam becomes indistinguishable from a
degraded network:

```text
adapterOutboundEvicted     our queue, our choice
networkSendFailed          the socket refused or died
gatewayRefused             an explicit rejection
gatewayBackpressure        accepted-then-shed downstream
downstreamChunkEvicted     the chunker's own eviction
```

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
capability. A stream whose session has since closed is refused with
`rejected-stale`. `AdapterSessionRef` is correlation; it is not resurrection
magic, and a reference an adapter still happens to remember is not evidence that
a session exists.

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
control message                 64 KiB
binary frame payload            64 KiB      (a 20 ms 16 kHz mono frame is 640 B)
header                          24 B, fixed
active streams per connection   256
participants per session        64
outbound queue                  8 MiB / 2000 frames / 4 s, whichever first
malformed messages              8, then the connection is closed
idle without pong               30 s
```

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
Control request     Authorization: <service credential>       ← Step 5
Session create      response carries sessionCapability        ← Step 5
STREAM_OPEN         presents sessionCapability                ← Step 5
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
| Missing `wireSequence` | Gap reported by DISPOSITION |
| Reordered arrival | Ordered by sequence, or reported |
| Sequence wrap at 2^32 | Continues, no reordering artefact |
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
3. RemoteMediaAdapterPort     client, bounded queue, reconnect, state machine
4. AdapterIngressServer       server, framing, multiplexing, dispositions
5. loopback protocol tests    client ↔ server over a real socket
```

The codec being pure and testable without a network is deliberate: every
protocol property in §17 can be pinned before a single port is bound, and a
failure there is a failure of the contract rather than of the weather.
