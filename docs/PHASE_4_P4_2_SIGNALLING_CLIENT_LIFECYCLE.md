# Phase 4 P4.2 Client Signalling And Peer-Session Lifecycle

Date: 2026-07-27

Branch: `phase-4-webrtc`

Baseline: `4be4d62 feat: close Phase 2 and Phase 3 playback pipeline` plus completed P4.0 and P4.1 work.

## Status

P4.2 is implemented as client-side signalling orchestration only.

No real WebRTC media transport was added.

## Objective

P4.2 adds a typed browser-side signalling client and role-specific UI orchestration for:

- broadcaster signalling in `apps/operator-web`;
- listener signalling in `apps/listener-web`.

The apps can create, join, leave and close P4.0 signalling sessions through the existing Socket.IO gateway while keeping P4.1 local capture and Phase 3 listener playback separate.

## Shared Client Architecture

The shared controller lives in:

- `packages/shared-types/src/webrtc-signalling-client.ts`

It uses the P4.0 contracts from:

- `packages/shared-types/src/webrtc-signalling.ts`
- `packages/shared-types/src/socket-events.ts`

The controller is transport-based and accepts a narrow Socket.IO-compatible adapter surface:

- `on`
- `off`
- `emit`
- optional `connected`

This keeps raw Socket.IO event handling out of React components while avoiding a new dependency.

## Role-Specific Orchestration

### Broadcaster

The operator app uses a dedicated broadcaster Socket.IO connection with `role=broadcaster`. Existing operator service traffic still uses the existing `role=operator` socket.

Broadcaster UI can:

- create a signalling session;
- expose a share identifier in `broadcastId/sessionId` form;
- observe listener joins;
- close the session;
- recover after reconnect by explicitly creating a fresh session;
- avoid duplicate active session creation.

### Listener

The listener app reuses its existing `role=listener` Socket.IO connection. The new controller attaches only its own P4.2 event listeners and preserves existing translation, generated-audio, media-state and language-room subscriptions.

Listener UI can:

- enter a broadcaster share identifier;
- join the signalling session;
- leave the signalling session;
- recover after reconnect where session ownership still exists;
- observe broadcaster/session closure.

## Lifecycle States

Client states:

- `idle`
- `connecting`
- `connected`
- `creating-session`
- `joining-session`
- `joined`
- `ready`
- `reconnecting`
- `leaving`
- `closing`
- `disconnected`
- `closed`
- `failed`

State rules:

- listeners cannot become `joined` before a typed join acknowledgement;
- broadcasters cannot create duplicate active sessions from the same client;
- disconnect changes active sessions to `reconnecting` rather than leaving the UI ready;
- close and leave are idempotent;
- stale acknowledgements from old generations are rejected;
- session closure moves affected clients to `closed`;
- SDP and ICE events are tracked as lifecycle metadata only and are not surfaced as media readiness.

## Identity Model

The client tracks:

- protocol version `1`;
- role;
- `broadcastId`;
- `sessionId`;
- shareable `broadcastId/sessionId`;
- peer ID;
- message ID;
- correlation ID;
- revision;
- connection generation.

Generated IDs use `crypto.randomUUID` where available and a browser-safe fallback otherwise. Raw socket IDs are not used as permanent peer IDs.

## Acknowledgement And Timeout Design

Create, join, leave and close requests:

- include a generated message ID;
- include a generated correlation ID;
- wait for a typed acknowledgement;
- enforce a bounded timeout, defaulting to 5 seconds;
- reject malformed acknowledgements;
- reject unexpected acknowledgement types;
- ignore mismatched correlations;
- reject stale connection-generation acknowledgements;
- expose retryable and non-retryable client errors.

Requests do not wait indefinitely.

## Reconnect Policy

On socket disconnect:

- signalling state moves to `reconnecting` for active sessions or `disconnected` otherwise;
- pending acknowledgements are rejected as gateway unavailable;
- UI no longer claims readiness;
- local P4.1 capture is stopped by the operator wiring on broadcaster signalling teardown;
- listener audio queue and mixer remain unchanged.

On reconnect:

- the connection generation increments;
- the UI remains in `reconnecting` until explicit recovery succeeds or the operator/listener chooses a new action;
- stale acknowledgements from an old generation are rejected;
- broadcaster recovery creates a fresh session because P4.0 closes broadcaster sessions on disconnect;
- listener recovery reuses the entered session only through an explicit join request.

No protocol version change was required.

## Duplicate And Stale Event Handling

The client:

- deduplicates lifecycle events by message ID;
- ignores unrelated broadcast IDs;
- ignores unrelated session IDs;
- ignores stale revisions;
- rejects duplicate create and join attempts;
- rejects role-forbidden actions client-side;
- maps gateway errors into safe client-facing errors.

## Error Model

Client error codes include:

- `gateway-unavailable`
- `connection-timeout`
- `acknowledgement-timeout`
- `malformed-acknowledgement`
- `unsupported-protocol-version`
- `unauthorized`
- `forbidden-role`
- `session-not-found`
- `session-already-exists`
- `duplicate-broadcaster`
- `duplicate-peer`
- `stale-session`
- `stale-connection-generation`
- `invalid-transition`
- `session-closed`
- `reconnect-failed`
- `cleanup-failed`
- `internal-client-signalling-failure`

UI errors are concise and do not expose stack traces, socket IDs, SDP, ICE, tokens, or internals.

## Operator Integration

Added:

- `apps/operator-web/src/BroadcasterSignallingPanel.tsx`
- a dedicated broadcaster signalling socket option;
- broadcaster session create, close and recover controls;
- visible session share identifier;
- visible listener count;
- visible local capture state;
- explicit `Audio transport not started`.

The existing P4.1 capture panel now receives broadcaster signalling connectivity rather than the operator service socket state.

## Listener Integration

Added:

- `apps/listener-web/src/ListenerSignallingPanel.tsx`
- share identifier input;
- join, leave and recover controls;
- broadcaster availability state;
- explicit `WebRTC audio playback not active`.

The listener translated-audio queue, generated-audio playback, Interpretation Mode and Replacement Mode were not rewritten.

## Cleanup

Controller cleanup:

- removes only listeners it owns;
- clears pending acknowledgement timers;
- rejects obsolete pending requests;
- clears deduplication cache;
- clears session ownership state;
- avoids state updates after disposal;
- preserves unrelated Socket.IO subscriptions.

Gateway leave routing was adjusted so the leaving peer receives its own bounded `peer-disconnect` acknowledgement before it leaves the room.

## Accessibility

Operator and listener controls use native buttons, labels and inputs.

Added labels include:

- `Create broadcaster signalling session`
- `Close broadcaster signalling session`
- `Recover broadcaster signalling session`
- `Broadcast or session identifier`
- `Join listener signalling session`
- `Leave listener signalling session`
- `Recover listener signalling session`

Errors use `role="alert"`. Status is text-based and does not rely on color alone.

## Logging And Redaction

Client diagnostics are safe metadata only:

- role;
- lifecycle state;
- connection generation;
- whether a session exists;
- correlation ID;
- result category.

No SDP, ICE candidates, media stream objects, device IDs, tokens, cookies, credentials or private headers are logged.

## Tests Added

Shared client tests:

- initial idle state;
- successful socket connection;
- create-session request and acknowledgement;
- join-session request and acknowledgement;
- acknowledgement timeout;
- correlation mismatch;
- malformed acknowledgement;
- unsupported protocol;
- duplicate create/join prevention;
- unrelated event ignored;
- duplicate lifecycle event ignored;
- socket disconnect and reconnecting state;
- explicit recovery;
- leave idempotency;
- gateway error mapping;
- disposal without removing unrelated socket listeners.

Operator UI tests:

- create and close controls;
- session identifier presentation;
- listener joined label;
- capture and signalling separation;
- safe error presentation;
- no false `Live` status.

Listener UI tests:

- join and leave controls;
- broadcaster signalling availability;
- session closure error;
- no WebRTC playback claim.

Gateway integration:

- typed broadcaster client creates a session;
- typed listener client joins;
- broadcaster observes listener count;
- session close propagates to listener;
- no media transport flag is set.

## Files Changed

P4.2 files:

- `packages/shared-types/src/webrtc-signalling-client.ts`
- `packages/shared-types/src/__tests__/webrtc-signalling-client.test.ts`
- `packages/shared-types/src/index.ts`
- `apps/operator-web/src/BroadcasterSignallingPanel.tsx`
- `apps/operator-web/src/BroadcasterSignallingPanel.test.tsx`
- `apps/operator-web/src/App.tsx`
- `apps/operator-web/src/App.module.css`
- `apps/operator-web/src/socketConfig.ts`
- `apps/operator-web/src/socketConfig.test.ts`
- `apps/listener-web/src/ListenerSignallingPanel.tsx`
- `apps/listener-web/src/ListenerSignallingPanel.test.tsx`
- `apps/listener-web/src/App.tsx`
- `apps/listener-web/src/App.module.css`
- `services/realtime-gateway/src/gateway.ts`
- `services/realtime-gateway/src/__tests__/webrtc-signalling.integration.test.ts`
- `services/realtime-gateway/src/workspace-modules.d.ts`
- `docs/PHASE_4_WEBRTC_PLAN.md`
- `docs/PHASE_4_P4_2_SIGNALLING_CLIENT_LIFECYCLE.md`

Existing P4.0 and P4.1 files remain preserved.

## Known Limitations

- No `RTCPeerConnection` exists.
- No SDP or ICE generation exists.
- No media is sent or received.
- Broadcaster reconnect creates a fresh P4.0 session because the in-memory gateway closes broadcaster sessions on disconnect.
- Listener session lookup requires the broadcaster-provided `broadcastId/sessionId` share identifier.
- No production authorization, rate limiting or persistent signalling store was added.

## Explicit Exclusions

- No WebRTC media transport.
- No browser or backend audio-track transmission.
- No listener WebRTC playback.
- No STUN or TURN.
- No SFU or MCU.
- No video, screen sharing, recording, HLS, provider integrations, auth redesign, billing, subscriptions, analytics or deployment infrastructure.

## Preservation Status

Preserved:

- Phase 1.
- Closed Phase 2 upload, microphone ingest, transcription, translation, monitoring, recovery and exports.
- Closed Phase 3 TTS, generated-audio delivery, listener queue, Interpretation Mode and Replacement Mode.
- P4.0 contracts and gateway lifecycle.
- P4.1 local browser capture.
- Existing Socket.IO events and HTTP APIs.

## Readiness For P4.3

P4.2 provides typed client lifecycle orchestration and role-specific signalling UI. P4.3 can implement server-side audio access or an ingest bridge only after a backend media termination decision is made.

Recommended next milestone: P4.3 server-side audio access or ingest bridge.
