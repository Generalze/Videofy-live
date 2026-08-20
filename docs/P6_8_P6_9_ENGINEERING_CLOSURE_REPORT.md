# P6.8 + P6.9 Engineering Closure Report

**Status at merge into `main`.** This records what is *engineering-complete* and,
just as deliberately, what is *not certified*. The distinction is the whole
point of the document: everything below the second heading is real work that has
been adversarially tested, and everything under "Deferred validations" is work
that cannot be done from this machine and must not be quietly implied as done.

- **P6.8 SIP/RTP ENGINEERING: COMPLETE**
- **P6.9 TRUSTED ADAPTER INGRESS: COMPLETE**
- **P6.9 LOCAL MULTI-PROCESS E2E: PASS**
- **Linux SIGTERM delivery: TO VERIFY ON CONTABO**
- **SIP-EV1 independent SIP interoperability: DEFERRED**
- **SIP-EV2 real PSTN / carrier E2E: DEFERRED**
- **Zoom RTMS external validation: DEFERRED**
- **KingsConference staging validation: DEFERRED**

Phase 6 is **not** externally certified. It is engineering-ready for Linux
staging.

---

## What "complete" is claimed on

Every claim below is backed by a suite in this repository, and the load-bearing
ones are backed by **mutation testing**: the defect is reintroduced and the pin
must fail. A pin that passes both with and without the behaviour it names is
not evidence, and this project has twice found gates that were green while
verifying nothing.

Test counts at the merge commit:

| Workspace | Tests | Files |
| --- | ---: | ---: |
| `services/sip-adapter` | 141 | 8 |
| `services/realtime-gateway` | 400 | 30 |
| `services/sip-runtime` | 26 | 4 |
| `packages/adapter-authority` | 35 | 1 |
| `packages/adapter-wire` | 36 | 2 |
| `packages/adapter-ingress` | 21 | 2 |
| `packages/media-adapter-remote` | 19 | 1 |
| `packages/media-adapter-port` | 4 | 1 |
| `packages/service-env` | 41 | 3 |
| **Repository total** | **2760** | **211** |

---

## P6.8 — SIP/RTP transport

`services/sip-adapter` is a **library, not a service**. It has no `dev` or
`start` script and nothing in it binds a socket. That was settled deliberately:
the package manifest once advertised an entry point that did not exist while
`tsc --noEmit` stayed happy, so both build and typecheck passed for a runtime
that would have failed on first invocation. Four pins now prevent a manifest
from advertising a runtime that is not there.

Delivered:

- **Signalling.** INVITE/ACK/BYE/CANCEL, SDP offer and answer, dialog state
  machine, T1 retransmission, Timer B, RFC 3261 §12.2.2 stale-CSeq handling,
  §17.1.1.2 Calling→Proceeding on a provisional response.
- **Media.** RFC 3550/3551 framing, G.711 **PCMU (0)** and **PCMA (8)**,
  resampling between the 8 kHz wire and the engine's 16 kHz mono PCM.
- **Jitter buffer** with an accounting invariant that is checked rather than
  assumed: `received === emitted + discarded + depth`. `releaseHeld()` and
  `flush()` are separate operations because one keeps the play pointer and the
  other clears it, and using the wrong one at renegotiation silently discarded
  buffered speech.
- **Lifecycle hardening.** Every seam callback is *bounded* and every outcome is
  *explicit*. Three consecutive falsification passes each found exactly one
  defect in the same family — async at the seam boundary that was unbounded,
  unanswered, or unqueued — and the branch-level pins were replaced with an
  invariant pin: **every INVITE receives exactly one final response.**
- **Bounded teardown**, with buffered speech drained rather than dropped, and
  everything undelivered counted rather than vanishing.
- **Three clocks kept apart**, because conflating any two produces a bug that
  looks like a codec fault: `wireSequence` (transmission order),
  `platformTimestampMs` (media time), `gatewayReceivedAtMs` (arrival).
- **Real UDP loopback** end-to-end suite over actual sockets.

Closed after **8 adversarial falsification passes**, the last clean.

---

## P6.9 — Trusted adapter ingress

Before this milestone, every Phase 6 adapter normalized its transport correctly
and then handed perfect 16 kHz frames to `RecordingMediaAdapterPort`, an
in-memory double. **There was no gateway behind the seam.** P6.9 is that
gateway.

### The pipeline is transport-neutral, and there is only one

Adapter audio is the **fourth producer** on the one media pipeline, beside the
browser broadcast path and the native call path — the same
`MediaTranscriptionBridge`, the same chunker, the same media-ingest. Not a
second pipeline.

Live-media behaviour is now **declared** (`mediaSessionMode:
'live-conversation'`) rather than inferred from a `call_` session-id prefix. The
prefix coupling was real: evict-oldest and partial captions were gated on a
string prefix, so adapter sessions would have silently received programme
semantics — buffering the backlog instead of keeping the newest speech, on a
telephone call where the person on the other end is waiting for the sentence
being spoken now.

### Identity: resolved, never accepted

`AdapterSessionRef` and `VideofySessionId` are distinct branded types in
separate modules. `VideofySessionId` lives behind a `/platform` subpath and is
**not reachable from `MediaAdapterPort`** — an adapter cannot name a platform
session because the type is not in scope, enforced by compile-time
`@ts-expect-error` pins that fail the build if the error ever disappears.

`AdapterAuthority.authorize` **has no parameter for a session id.** "Write into
someone else's session" has no way to be expressed.

### Authorization is three layers with three different powers

| Layer | Object | Answers | May NOT |
| --- | --- | --- | --- |
| 1 | Service credential | may this process connect at all? | act within any session |
| 2 | Route credential | which routes may it originate on? | **submit media, ever** |
| 3 | Session capability | which session may this act on? | create further sessions |

The two secrets live in **separate namespaces** (`vfr_` / `vfc_`) and separate
maps. A route credential presented where a capability belongs is not caught by a
check somebody might forget on one path — it is looked up in a table it was
never in.

### Remote wire

A versioned binary protocol (`packages/adapter-wire`): 24-byte big-endian
header, little-endian PCM payload independent of host architecture, explicit
`SETTLEMENT` / `DISPOSITION` accounting. Settlement means **gateway wire-ingress
custody and nothing more** — it does not promise the speech reached STT.
`acceptedThroughSequence` was removed during design review because one number
was being asked to carry two facts and could not state the truth when a frame
inside its range was refused.

Client (`media-adapter-remote`) and server (`adapter-ingress`) were built
against **separate fakes**, so the loopback suites prove contract agreement
rather than shared misunderstanding.

### Cross-session spoofing defence

Tested **on the wire**, with raw frames, not argued from the code. The honest
client used everywhere else physically cannot express the attack — it says what
is true, so a gateway that blindly trusted it would look identical.

A second adapter, entirely legitimate in itself, opens a stream with its own
valid capability while claiming the victim's session reference. The gateway
resolves from the capability and ignores the claim. **Mutation-proved**:
believing the claim lets the attacker take the victim's place in the binding
table, and the victim's next words are translated into the attacker's call.

### Deployable surface

- **HTTPS control plane** — four thin handlers over `AdapterControlPlane`. No
  authorization decision is made in an Express handler.
- **Authenticated WSS** — the service credential is checked **on the HTTP
  Upgrade, before `HELLO`**. A caller without a valid service identity never
  becomes an adapter connection at all, so none of the protocol state machine is
  reachable by a stranger. This is why `HELLO` carries no secret and does not
  need to.
- **`services/sip-runtime`** — the service host. It owns UDP sockets, port
  allocation, route configuration, gateway URLs, credentials, pump scheduling,
  startup and shutdown. The SIP library stays a library.

### Capability replay semantics

An idempotent replay returns the **same session, same `capabilityId`, same
secret, same expiry**, and mutates nothing. A retransmission is observationally
harmless.

The secret is **derived**, not stored: `HMAC(processKey, capabilityId +
immutable binding identity)`, over immutable fields only. The key is 32 random
bytes per authority instance with the same lifetime as the in-memory capability
state it protects.

Replays may not revive anything: expired → `rejected-stale`, revoked →
`rejected-auth`, closed → `rejected-stale` (and no longer falls through to mint
a second session under the same key), changed body → `rejected-auth`. Identity
is checked **before** state, so refusals cannot be used as an oracle for which
idempotency keys exist.

### Local multi-process acceptance

`npm run p6.9:acceptance` launches **three actual OS processes** and puts a
telephone call through them:

```
real UDP → sip-runtime → real WSS → realtime-gateway → real HTTP → media-ingest
```

It **imports nothing from the system under test** — not the authority, the
binding, the wire codec, or `SipCall`. It carries its own mu-law encoder,
because the codec is one of the things being checked, and observes results
through the gateway's own diagnostics endpoint over HTTP.

**Result: PASS**, with one check deferred (see below).

---

## Security posture

Stated explicitly, because each of these was once the other way round:

- **media-ingest's internal API fails closed.** Absence of configuration is a
  refusal, not a licence. It previously read `if (!token) return true;` with the
  token shipped blank, so the default deployment authenticated nobody.
- **Adapter ingress fails closed.** An unconfigured gateway refuses every
  adapter request and every upgrade. A *half*-configured one — routes declared
  with no credential to authenticate the adapters that would use them — refuses
  to start, because it would otherwise mount the endpoints and 401 every adapter
  indistinguishably from a wrong secret.
- **Route credentials cannot submit media.** A leaked one lets an attacker ask
  for a session it was already entitled to originate: noisy, rate-limitable,
  revocable. One that could also inject audio would be a master key.
- **The service token cannot act as a session capability.** Different namespace,
  different table, pinned in both directions.
- **Capabilities resolve the platform session server-side.** Always.
- **No caller-provided `VideofySessionId`.** There is no parameter for one.
- **The adapter service credential is separate from the internal media
  credential.** Different pair of processes, rotated independently; pinned that
  disabling one does not disable the other.
- **Secrets are never logged.** Not in summaries, not in error messages, not in
  refusals. Correlation is by public id or by digest fingerprint.

---

## Deferred validations

**None of the following is claimed.** Each requires access this machine does not
have, and each is a real gate before the corresponding claim may be made.

| Ref | Validation | Blocked on |
| --- | --- | --- |
| — | **Linux SIGTERM delivery and graceful drain** | Contabo. Windows cannot deliver SIGTERM to a child process (`child.kill('SIGTERM')` is an unconditional terminate), so the acceptance script *probes* for deliverability and reports SKIP with the reason. The drain's **order and bounds** are proved by the `sip-runtime` lifecycle suite; what is deferred is only whether the **signal arrives**. On Linux this check must PASS with no deferral. |
| SIP-EV1 | **Independent SIP interoperability** | A third-party softphone or PBX. Both endpoints in every current suite are ours, so a shared misreading of RFC 3550/3261 would pass unnoticed. |
| SIP-EV2 | **Real PSTN / carrier end-to-end** | A carrier trunk (Telnyx or equivalent) and a purchased number. |
| — | **Zoom RTMS external validation** | Zoom RTMS access. Implementation is complete; validation is not. |
| — | **KingsConference staging validation** | Their staging credentials. Design is complete; validation is not. |
| — | **TLS termination, NAT traversal, firewall topology** | The VPS. |
| — | **STT/MT/TTS output quality on adapter audio** | A separate subsystem with its own suites and models. The acceptance script deliberately does not assert on it, because that would make a deployment proof fail for reasons unrelated to deployment. |

---

## Known boundaries, recorded rather than hidden

- **Shared-filesystem staging.** The gateway hands media-ingest a `sourcePath`
  rather than bytes. That is correct for a single host and becomes a scale
  boundary the moment the two services are on different machines.
- **Capability TTL is 4 hours with no renewal path.** A call outliving it starts
  receiving `rejected-stale` mid-conversation. Not reachable for ordinary calls;
  a real cliff for long ones, and the renewal design is an open question in
  `docs/P6_9_ADAPTER_INGRESS_BINDING_DESIGN.md`.
- **`webrtcTranscriptionBridge`** and several `WEBRTC_*` environment variables
  keep their historical names in client-facing and operator-facing surfaces. The
  internal pipeline is transport-neutral; the labels have not all caught up.
- **P6.7 Zoom still carries a private copy of the media seam.** It must be
  rebased onto this baseline and switched to
  `@videofy-live/media-adapter-port` — one of the reasons for merging P6.9
  first, so that every adapter conforms to a canonical shared binding rather
  than carrying its own historical interpretation.

---

## Gate hygiene

Two classes of failure were found in which a gate was **green while verifying
nothing**. Both are now checked mechanically, because both were found by
accident:

1. **Literal NUL bytes in committed source.** Behaviour identical, all tests and
   typecheck green, and git silently reclassifying the files as binary — no
   diff, no review. It reached three files. Tests cannot catch this: the tests
   were not wrong, the *file* was unreadable.
   `scripts/check-source-hygiene.mjs` now refuses control characters and
   bidirectional formatting (CVE-2021-42574), and runs first in the root `test`
   script. It has since caught the same defect within seconds of it being
   written.
2. **Vitest file arguments are filters, not paths.** A name matching no file
   selects nothing and exits 0. A rename left two stale names, so the
   transcription chunker and bridge suites — 80 tests — silently stopped running
   while every gate stayed green. `test-manifest.test.ts` in both
   `realtime-gateway` and `sip-runtime` now checks **both** directions and
   asserts it is itself in the fast chain.

**Green checks that verify nothing are worse than no checks, because they are
believed.**
