# Phase 4 P4.0 WebRTC Signalling Contracts

Date: 2026-07-27

Baseline: `4be4d62 feat: close Phase 2 and Phase 3 playback pipeline`

Branch: `phase-4-webrtc`

## Status

P4.0 is implemented as an architecture and signalling-contract foundation only.

No real WebRTC media transport was added.

## Scope Implemented

- Shared TypeScript WebRTC signalling contracts.
- Zod validation for incoming signalling envelopes.
- Protocol versioning.
- Typed signalling errors.
- In-memory gateway signalling session registry.
- Broadcaster, listener, and server signalling roles.
- Session and peer state machines.
- Socket.IO routing through the existing realtime gateway.
- Duplicate session, duplicate peer, duplicate message, stale negotiation, and closed-session protection.
- Deterministic disconnect and teardown handling.
- Safe logging metadata only.
- Focused contract, registry, and gateway integration tests.

## Explicit Exclusions

- No `RTCPeerConnection` usage.
- No browser WebRTC media APIs.
- No browser microphone capture changes.
- No `getUserMedia` changes.
- No audio or video tracks.
- No server-side WebRTC termination.
- No STUN or TURN requests.
- No SFU or MCU infrastructure.
- No listener WebRTC playback.
- No translated-audio WebRTC delivery.
- No authentication redesign.
- No database, Redis, billing, subscriptions, analytics, HLS, recording, or deployment infrastructure.

## Contract Package Selection

`packages/shared-types` owns shared TypeScript event and metadata contracts, so the P4.0 TypeScript signalling envelopes were added there.

`packages/media-contracts` owns Zod validation for gateway-facing payloads, so runtime signalling validation was added there.

The design avoids duplicating the same contract in multiple locations: `shared-types` defines the typed shape and constants, while `media-contracts` validates inbound runtime payloads against those shapes and limits.

## Signalling Events

Socket.IO events added:

- `webrtc:session:create`: broadcaster requests a signalling session.
- `webrtc:session:join`: listener or server joins an existing session.
- `webrtc:signal`: SDP, ICE, ready, and heartbeat signalling envelope.
- `webrtc:session:leave`: peer disconnect envelope.
- `webrtc:session:close`: session close envelope.
- `webrtc:session:event`: routed acknowledgement, lifecycle, SDP, ICE, ready, or close event.
- `webrtc:error`: typed signalling error envelope.

Existing Phase 1-3 Socket.IO events are unchanged.

## Protocol Version

The signalling protocol version is `1`.

Unsupported versions are rejected with `unsupported-protocol-version`. Unknown versions are not silently accepted.

Future versions should add explicit compatibility handling rather than broadening the P4.0 schema.

## Envelope Model

Incoming envelopes are discriminated by `type` and include:

- `protocolVersion`
- `messageId`
- optional `correlationId`
- `broadcastId`
- optional or required `sessionId`, depending on message type
- `peerId`
- `senderRole`
- `revision`
- `createdAt`
- `payload`

Identifiers are validated by length and a restricted character pattern. They are not trusted merely because they are non-empty.

## Session State Model

Session states:

- `created`
- `waiting`
- `negotiating`
- `ready`
- `closing`
- `closed`
- `failed`

P4.0 creates sessions directly into `waiting` after the broadcaster is registered. `negotiating` starts when a valid offer is accepted. `ready` starts after the matching answer is accepted. `closed` is terminal for new signalling.

## Peer State Model

Peer states:

- `registered`
- `joined`
- `negotiating`
- `ready`
- `disconnected`
- `closed`

A peer cannot send offer, answer, ICE, ready, leave, or close messages unless its socket owns that peer in the target session.

## Ownership Rules

- One active broadcaster per broadcast session.
- Zero or more listeners.
- Zero or more server peers.
- A socket can only signal for the peer it registered.
- A listener cannot create a broadcaster session.
- A listener cannot send broadcaster-only SDP offers.
- A second broadcaster is rejected with `duplicate-broadcaster`.
- A second socket claiming the same peer is rejected with `duplicate-peer`.

The authorization boundary is intentionally minimal for P4.0. It uses current Socket.IO role and session identity assumptions and is not production authorization.

## Negotiation Rules

- Offers must come from the broadcaster.
- A peer cannot send an offer before joining.
- Offer revision must be exactly one greater than the current session revision.
- Answers require a current unanswered offer.
- Answers must match the current offer revision and target.
- ICE candidates require an active offer revision.
- ICE candidates for obsolete revisions are rejected.
- Closed sessions reject all new signalling.

SDP is stored and routed only as an opaque validated string. P4.0 does not parse or mutate SDP.

ICE candidates are routed only as opaque validated fields. P4.0 does not contact STUN or TURN servers.

## Duplicate Handling

- Duplicate active broadcast sessions are rejected.
- Duplicate peers are rejected.
- Duplicate message IDs are rejected with `duplicate-message`.
- Repeated SDP offers at the same revision are rejected as stale or duplicate.
- Answers for obsolete offers are rejected as stale.
- ICE for obsolete revisions is rejected as stale.
- Teardown is idempotent: repeated disconnect cleanup does not crash or close unrelated sessions.

## Disconnect And Teardown

- Listener socket disconnect marks only that listener peer as `disconnected`.
- Broadcaster socket disconnect closes the signalling session and marks peers `closed`.
- Explicit peer leave emits `peer-disconnect`.
- Explicit session close emits `session-close`.
- Stale signalling after close is rejected with `session-closed`.
- No P4.0 state claims that media ended, because no media transport exists.

## Typed Error Codes

P4.0 defines:

- `invalid-payload`
- `unsupported-protocol-version`
- `unauthorized`
- `forbidden-role`
- `session-not-found`
- `session-already-exists`
- `peer-not-found`
- `duplicate-peer`
- `duplicate-broadcaster`
- `duplicate-message`
- `stale-session`
- `stale-negotiation`
- `invalid-state-transition`
- `offer-required`
- `session-closed`
- `payload-too-large`
- `internal-signalling-error`

Error envelopes include safe fields only: code, message, retryable flag, correlation ID, and safe current state where useful.

## Payload And Abuse Limits

P4.0 constants:

- identifier max length: 128
- SDP max length: 65,536
- ICE candidate max length: 4,096
- reason max length: 512
- duplicate message cache size per session: 512
- maximum peers per session: 64
- maximum active sessions in memory: 100

These are gateway-level guards, not a complete production abuse-prevention system. Production still needs authentication, authorization, rate limiting, and distributed state.

## Logging And Redaction

Gateway logs include safe metadata:

- signalling message type
- session ID
- peer ID
- sender role
- revision
- result error code
- retryable flag

Gateway logs do not include full SDP, raw ICE candidates, TURN credentials, cookies, tokens, private headers, or environment secrets.

## Tests Added

Contract tests:

- `packages/media-contracts/src/__tests__/webrtc-signalling-schema.test.ts`

Registry tests:

- `services/realtime-gateway/src/__tests__/webrtc-session-registry.test.ts`

Gateway integration tests:

- `services/realtime-gateway/src/__tests__/webrtc-signalling.integration.test.ts`

Coverage includes valid parsing, invalid payloads, unsupported protocol versions, malformed roles, empty/oversized SDP, malformed/oversized ICE, session creation, duplicate sessions, peer joins, duplicate peers, offer/answer revision rules, stale negotiation, duplicate messages, listener disconnect, explicit close, targeted routing, role rejection, unknown session rejection, closed-session rejection, and preservation of existing media-state traffic.

## Files Changed

- `packages/shared-types/src/socket-events.ts`
- `packages/shared-types/src/webrtc-signalling.ts`
- `packages/shared-types/src/index.ts`
- `packages/media-contracts/src/webrtc-signalling-schema.ts`
- `packages/media-contracts/src/__tests__/webrtc-signalling-schema.test.ts`
- `packages/media-contracts/src/index.ts`
- `packages/media-contracts/package.json`
- `services/realtime-gateway/src/webrtc-session-registry.ts`
- `services/realtime-gateway/src/__tests__/webrtc-session-registry.test.ts`
- `services/realtime-gateway/src/__tests__/webrtc-signalling.integration.test.ts`
- `services/realtime-gateway/src/gateway.ts`
- `services/realtime-gateway/package.json`
- `docs/PHASE_4_WEBRTC_PLAN.md`
- `docs/PHASE_4_P4_0_WEBRTC_SIGNALLING.md`

## Known Limitations

- Session registry is in memory and not suitable for multi-instance production.
- Authorization is a placeholder based on current Socket.IO role and peer/session ownership assumptions.
- There is no rate limiter beyond bounded payload/session/peer/message-cache limits.
- No real browser WebRTC validation exists in P4.0 because no WebRTC media APIs were implemented.
- No backend media termination choice has been made.
- No TURN strategy is implemented.

## Preservation Status

Preserved:

- Phase 1 foundation and existing mock event traffic.
- Phase 2 upload, microphone chunking, transcription, translation, monitoring, recovery, and exports.
- Phase 3 generated audio delivery, listener queue scheduling, Interpretation Mode, and Replacement Mode.
- Existing Socket.IO event names and HTTP APIs.

## Readiness For P4.1

P4.0 is ready for P4.1 after full validation passes.

Recommended next milestone: P4.1 browser broadcaster media capture, still without listener WebRTC playback or backend WebRTC media termination.
