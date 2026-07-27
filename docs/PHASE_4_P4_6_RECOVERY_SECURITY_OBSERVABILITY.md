# Phase 4 P4.6 Recovery, Security, And Observability

Date: 2026-07-27

Branch: `phase-4-webrtc`

## Scope

P4.6 hardens the existing P4.0-P4.5 WebRTC path:

`capture -> signalling -> broadcaster WebRTC ingest -> transcription bridge -> listener WebRTC programme-audio delivery`

No video, recording, HLS, SFU/MCU, production TURN deployment, translated-audio WebRTC delivery, authentication redesign, plugins, public APIs, billing, analytics, queue rewrite, or mixer rewrite were added.

## Reconnect Policy

- Signalling recovery is explicit through `recoverSessionWithBackoff`.
- Recovery uses the existing connection generation and negotiation revision model.
- Stale acknowledgements from older connection generations are rejected.
- Broadcaster recovery creates a fresh signalling session because current in-memory gateway policy closes the old session on broadcaster disconnect.
- Listener recovery rejoins the selected signalling session and waits for a fresh backend offer.
- Browser transport recovery never reuses old SDP, ICE candidates, or peer connections.
- Teardown is idempotent and clears timers, queued candidates, media tracks, audio sinks, and peer connections.

## Retry Limits

- Signalling recovery defaults to 3 attempts.
- Browser media transport recovery defaults to 2 attempts.
- Backoff starts at 250 ms for signalling and 500 ms for media transport.
- Backoff doubles per attempt.
- Terminal failures stop retrying.
- Broadcaster transport retry only preserves local capture when exactly one live local audio track remains.
- Retry exhaustion is operator/listener visible as `transport retry exhausted`.

## Failure Isolation

- Transcription bridge frame handling is isolated from listener programme-audio fanout.
- A transcription bridge exception no longer prevents listener original programme audio delivery for the same frame.
- Listener fanout failure is isolated per listener peer.
- Listener delivery failure does not close the broadcaster backend ingest peer.
- Broadcaster audio-track end or broadcaster disconnect closes listener delivery for that session by policy.
- Failed backend peers release active capacity and retain only safe diagnostic snapshots.

## Security Hardening

- Raw signalling payloads are bounded before schema parsing.
- Socket-level WebRTC signalling rate limits are enforced.
- SDP and ICE length limits remain enforced by the existing Zod schemas.
- Role, peer ownership, broadcast/session ID, duplicate message, stale revision, and target-peer checks remain enforced.
- Oversized signalling receives `payload-too-large`.
- Rate bursts receive a retryable rate-limit error.
- Optional `INTERNAL_WEBRTC_TOKEN` protects gateway-to-media-ingest internal WebRTC endpoints when configured.
- Internal WebRTC chunk path validation remains enforced by media ingest against `WEBRTC_AUDIO_CHUNK_STAGING_DIR`.
- Logs do not include raw SDP, ICE candidates, private candidate addresses, audio, PCM, tokens, credentials, provider secrets, or local filesystem paths beyond existing safe operational paths.

## Observability

Added safe aggregate diagnostics for:

- active signalling session count;
- total signalling session count;
- peer counts by role;
- negotiating and ready session counts;
- broadcaster backend peer snapshots;
- listener backend peer snapshots;
- transcription bridge session, active, closed, failed, and queued chunk counts;
- retry attempt counts in browser transports;
- cleanup reasons in backend peer logs.

Diagnostics are intentionally aggregate/internal and do not expose SDP, ICE, media payloads, or secrets.

## UI Changes

- Operator signalling panel shows `Reconnecting`, `Recovering session`, uncertain ownership, and closed states truthfully.
- Operator backend transport panel shows `Recovering transport` and retry count.
- Listener signalling panel shows reconnecting, broadcaster unavailable, programme audio interrupted, recovering WebRTC programme audio, and retry count.
- Listener `LIVE` label is suppressed during disconnected/error states and replaced with `INTERRUPTED`.

## Tests Added Or Extended

- Shared signalling client bounded recovery and stale/lost acknowledgement handling.
- Gateway raw payload size rejection.
- Gateway signalling rate-limit rejection.
- Gateway safe WebRTC diagnostics.
- Session registry diagnostics and closed-session cleanup.
- Transcription bridge diagnostics and closed-session cleanup.
- Broadcaster transport bounded retry after ICE failure.
- Listener transport retry exhaustion.
- Existing P4.3-P4.5 backend media/listener peer tests were preserved.

## Browser Validation

P4.6 keeps the P4.5 real-browser topology:

`operator browser capture -> backend WebRTC ingest -> listener WebRTC delivery -> listener original-audio mixer path`

Validation evidence remains split between automated unit/integration coverage and the Chromium harness. The browser harness validates track receipt and media-element attachment; it does not prove physical speaker audibility.

## Known Limitations

- In-memory gateway state means a gateway restart cannot restore existing peer connections; browsers must explicitly recover.
- Broadcaster socket disconnect closes the current session by policy.
- No persistent session ownership token exists yet.
- No production TURN deployment or NAT matrix was added.
- Diagnostics are internal aggregate snapshots, not a monitoring platform.
- Optional internal token is shared-secret style configuration, not full authentication.

## Preservation

Phase 1, closed Phase 2, Phase 3 generated-audio queue/mixer/export behavior, P4.0-P4.5 signalling, capture, backend ingest, transcription bridge, and listener WebRTC programme-audio delivery remain preserved.

## P4.7 Readiness

P4.6 is ready for P4.7 browser end-to-end validation and Phase 4 closure once full validation commands and browser recovery evidence pass.
