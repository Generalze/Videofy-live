# Phase 4 WebRTC Plan

Date: 2026-07-27

Baseline: `4be4d62 feat: close Phase 2 and Phase 3 playback pipeline`

Branch: `phase-4-webrtc`

## 1. Current Architecture Summary

Videofy Live is currently a local, multi-service monorepo:

- `services/realtime-gateway`: Express + Socket.IO event gateway. It validates inbound events, tracks connected roles, orders worker translation events, orders generated-audio-ready events, and broadcasts to listener language rooms and the operator room.
- `services/media-ingest`: Express HTTP API plus Socket.IO ingest client. It accepts uploaded media and browser microphone chunks, validates media with FFmpeg/ffprobe, stores per-session state in memory, runs transcription, translation, text-to-speech, emits monitoring state, and serves generated WAV audio safely.
- `apps/operator-web`: React operator UI. It uploads files, starts browser microphone capture through `MediaRecorder`, sends 15-second chunks to media ingest over HTTP, shows session state and recovery controls, and receives operator events through Socket.IO.
- `apps/listener-web`: React listener UI. It uses a mock canvas video feed, connects to the gateway with Socket.IO, joins one language room, receives translations and generated-audio-ready events, schedules generated audio by timestamp, and mixes original and translated audio with the Web Audio API.
- `packages/shared-types`: TypeScript contracts for media state, transcription, translation, generated audio, microphone capture, audio sync, and Socket.IO names.
- `packages/media-contracts`: Zod schemas for gateway-facing event validation.
- `services/speech-worker`: Phase 1 Python mock worker. It remains present for mock translation events, but Phase 2 and Phase 3 local provider work is now in `media-ingest`.

State is in memory. There is no production authentication, database, Redis, HLS, RTMP, WebRTC, TURN, SFU, CDN, or cloud deployment implementation in the repository.

## 2. Current Media And Translation Flow

The current end-to-end flow has two source paths.

Uploaded media:

1. Operator uploads MP4, MOV, MP3, or WAV to `POST /sessions`.
2. Media ingest rejects unsafe filenames, unsupported extensions/MIME types, corrupt files, missing audio, and duplicates.
3. FFmpeg extracts mono, 16 kHz, PCM 16-bit WAV chunks in ordered 15-second segments.
4. Chunks marked `ready` are transcribed.
5. Transcribed segments are translated using the session target language.
6. Piper or mock TTS generates one WAV per translated segment.
7. Media ingest stores generated audio in the session processing directory.
8. Media ingest emits `ingest:generated-audio` to the gateway.
9. Gateway validates and orders `audio:generated-ready` events per `sessionId + targetLanguage`.
10. Listener receives ordered generated-audio metadata, fetches WAV files through a safe HTTP route, and schedules playback by `startMs`/`endMs`.

Browser microphone:

1. Operator selects a microphone and target language.
2. Operator app requests browser permission through `navigator.mediaDevices.getUserMedia`.
3. `MediaRecorder` captures WebM/Ogg Opus chunks every 15 seconds.
4. Chunks are sent to `POST /microphone/sessions/:sessionId/chunks` with sequence, `startMs`, and `endMs`.
5. Media ingest validates ordering and timestamp continuity.
6. The same transcription, translation, TTS, monitoring, generated-audio event, and listener queue path is reused.

Listener playback:

- The current programme video is a deterministic `canvas.captureStream()` mock feed.
- The translated audio queue is the scheduling authority for generated audio.
- Interpretation Mode reduces original programme gain and plays translated audio at listener volume.
- Replacement Mode keeps the original media timeline running while setting original gain to zero.

## 3. Recommended WebRTC Scope

The smallest safe Phase 4 scope is WebRTC signalling and lifecycle first, followed by browser broadcaster audio ingest, then server-side audio access.

Initial WebRTC should support:

- A broadcaster/operator role that can create one WebRTC broadcast session.
- Socket.IO signalling through the existing realtime gateway.
- Peer lifecycle state visible to the operator.
- Browser capture of programme audio as the intended source, but not full media processing in P4.0.

Initial WebRTC should not support:

- Listener WebRTC playback.
- Translated-audio WebRTC delivery.
- Bidirectional calls.
- Group calls.
- Screen sharing.
- Video streaming.
- SFU deployment.
- TURN in local development.

The first implementation milestone should be P4.0: architecture and signalling contracts. P4.1 can add browser broadcaster capture. P4.2 can establish peer lifecycle. P4.3 can add server-side audio access or an ingest bridge.

## 4. Recommended First Implementation Milestone

P4.0 should implement only WebRTC architecture contracts and signalling tests.

P4.0 objective:

- Add typed WebRTC signalling event contracts.
- Add gateway routing for broadcaster, listener, and operator signalling roles.
- Validate room/session IDs, offer/answer shapes, ICE candidates, duplicate sessions, stale sessions, and teardown.
- Show truthful operator signalling state if UI changes are included.
- Avoid actual `RTCPeerConnection` media transport until signalling contracts are proven.

P4.0 should preserve all Phase 1, Phase 2, and Phase 3 behavior and keep generated audio delivery unchanged.

## 5. Topology Decision

Recommended topology for the first real media milestone: WebRTC peer connection terminated at the backend, with the backend extracting programme audio for the existing pipeline.

Comparison:

| Topology | Fit | Rationale |
| --- | --- | --- |
| Direct browser-to-browser peer-to-peer | Poor for translation pipeline | The server must access programme audio for transcription and translation. Pure peer-to-peer bypasses media ingest, makes recording/transcription unreliable, and becomes complex for multiple listeners. |
| Backend-terminated WebRTC | Best first fit | Keeps the server as the trusted media ingress point and lets existing media ingest own timestamps, segmentation, transcription, translation, TTS, monitoring, and recovery. |
| SFU | Later fit | Useful for multi-listener low-latency original programme delivery, but operationally heavier and not required before server-side audio ingest is proven. |
| MCU | Not recommended | Mixing/decoding all streams is expensive and unnecessary for the current one-broadcaster translation pipeline. |
| External managed WebRTC provider | Later decision | Reduces media infrastructure burden but adds cost, secrets, vendor dependency, and unclear access to raw programme audio. |

Pure peer-to-peer does not fit the current translation architecture because the transcription pipeline is server-side and depends on ordered, timestamped audio chunks. If broadcaster audio goes only to listeners, the backend cannot reliably segment, transcribe, translate, synthesize, monitor, retry, or export.

## 6. Signalling Design

Use the existing Socket.IO realtime gateway unless implementation evidence proves it insufficient. This avoids a second unrelated gateway and preserves existing operator/listener connection diagnostics.

Recommended roles:

- `broadcaster`: operator browser that owns a WebRTC programme source.
- `listener`: audience browser, initially unchanged.
- `operator`: monitoring and recovery UI, initially unchanged or lightly extended.
- `ingest`: media-ingest service or backend media terminator.

Recommended signalling events:

- `webrtc:session-create`
- `webrtc:session-created`
- `webrtc:session-join`
- `webrtc:session-left`
- `webrtc:offer`
- `webrtc:answer`
- `webrtc:ice-candidate`
- `webrtc:connection-state`
- `webrtc:media-state`
- `webrtc:error`
- `webrtc:session-end`

Recommended message fields:

- `sessionId`
- `streamId`
- `roomId`
- `role`
- `peerId`
- `revision`
- `sdp` for offers/answers
- `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment` for ICE
- `createdAt`
- `expiresAt`

Lifecycle:

1. Broadcaster asks gateway to create a WebRTC session.
2. Gateway validates the request, assigns `sessionId`, `streamId`, `peerId`, and `revision`.
3. Broadcaster sends offer.
4. Backend media endpoint or ingest role answers.
5. Both sides exchange ICE candidates.
6. Gateway broadcasts truthful state to operators.
7. Disconnect, timeout, cancellation, or restart ends the session and invalidates stale offers/candidates.

Reconnection:

- Use a new `revision` for each renegotiation.
- Reject stale offers and ICE candidates for older revisions.
- Allow broadcaster reconnect only when the previous peer is ended, expired, or explicitly replaced.
- Do not show "live" until ICE and media flow are confirmed, not merely when signalling connects.

Authentication assumptions:

- Planning assumes no production authentication exists.
- P4.0 may validate opaque room IDs and roles, but must not redesign auth.
- Production authorization for broadcaster sessions remains a blocker before public use.

## 7. Session Lifecycle

Recommended WebRTC session states:

- `idle`
- `creating`
- `signalling`
- `connecting`
- `connected`
- `media-flowing`
- `reconnecting`
- `failed`
- `ended`
- `cancelled`

State rules:

- `media-flowing` requires confirmed inbound audio packets or equivalent backend evidence.
- `connected` only means peer connection state is connected.
- `failed` must preserve last error and ICE/signalling details.
- `ended` must clean peer resources and reject late candidates.
- Duplicate active broadcaster sessions for the same room must be rejected unless an explicit replace operation is implemented.

## 8. STUN And TURN Strategy

Local development:

- Use host candidates and optional public STUN only.
- Do not require TURN for localhost or same-LAN tests.
- Provide configuration for an empty ICE server list and for STUN URLs.

Production:

- Configure STUN servers through environment variables.
- TURN becomes mandatory when broadcasters or listeners are behind symmetric NAT, strict corporate firewalls, carrier-grade NAT, or UDP-blocking networks.
- TURN credentials must be short-lived, generated server-side, and never hard-coded in frontend code or docs.
- Prefer time-limited TURN REST credentials if using coturn.
- Treat TURN URLs, usernames, credential TTL, and transport policy as deploy-time config.

Failure behavior:

- Surface `ice-failed`, `turn-unavailable`, `permission-denied`, and `media-flow-timeout` distinctly.
- Do not claim the event is live if only signalling succeeded.
- Operator UI should show whether failure is permission, signalling, ICE, TURN, or backend media ingest.

Privacy and security:

- TURN relays expose metadata and carry encrypted DTLS-SRTP packets.
- Avoid logging candidate IPs unless diagnostics mode is explicitly enabled.
- Never log TURN credentials.

## 9. Codec And Audio Constraints

Browser WebRTC audio is normally Opus over RTP. The existing transcription pipeline wants mono, 16 kHz WAV chunks.

Recommended microphone speech constraints:

- `audio: true` or selected `deviceId`
- `echoCancellation: true`
- `noiseSuppression: true`
- `autoGainControl: true`
- mono if available

Recommended programme-audio constraints:

- Avoid aggressive echo cancellation and noise suppression when capturing mixed programme audio or line-in audio.
- Prefer explicit audio-only capture for P4 audio ingest.
- Use Opus in WebRTC transport and convert at the backend boundary to mono, 16 kHz, PCM 16-bit WAV for the existing pipeline.

Conversion boundary:

- WebRTC Opus/RTP should be decoded by the backend media terminator or ingest bridge.
- Decoded PCM should be chunked into the same ordered 15-second timeline used by P2/P3.
- Piper output remains WAV and is delivered through the existing generated-audio route until listener WebRTC delivery is intentionally planned.

Timestamp continuity:

- Preserve both capture-time wall clock and media timeline offset.
- Convert RTP/WebRTC timestamps into the current `startMs`/`endMs` session timeline.
- The first accepted audio frame defines session timeline zero unless a broadcaster media clock is explicitly provided.

## 10. Timestamp And Synchronization Design

The Phase 3 listener queue should remain the scheduling authority.

Mapping:

- `webrtcSessionStartedAt` is recorded when backend media flow begins.
- Each decoded audio frame maps to `mediaTimeMs = frameCaptureTimeMs - firstFrameCaptureTimeMs`.
- The ingest bridge groups frames into chunks with `sequence`, `startMs`, and `endMs`.
- Generated audio events preserve the same `startMs` and `endMs`.
- Listener scheduling continues to compare generated segment timestamps against the listener programme clock.

If WebRTC original programme playback is added later, the listener media element or WebRTC receiver clock should replace the current mock-video clock in `getListenerClockMs`. The queue and mixer do not need to be rewritten for that change.

## 11. Integration With Transcription And Translation

Incoming WebRTC audio should enter the existing microphone/upload processing model as another source kind, not a separate speech pipeline.

Recommended source kind:

- Add `sourceKind: 'webrtc'` later, after P4.0 planning/contracts.

Pipeline:

1. Backend receives WebRTC Opus/RTP audio.
2. Backend decodes to PCM.
3. Ingest bridge emits ordered chunks equivalent to current microphone chunks.
4. Media ingest validates sequence and timestamps.
5. Chunks enter transcription only when `ready`.
6. Translation uses the per-session target language.
7. TTS generates WAV files.
8. Gateway emits generated-audio-ready events.
9. Listener queue schedules generated WAV playback.

Preserve:

- Retry failed transcription and translation segments.
- No silent fallback from real providers to mock providers.
- Monitoring visibility for provider errors and latency.
- Transcript and translation exports.

## 12. Listener Mixer Compatibility

P4 should not rewrite the completed Phase 3 mixer.

If WebRTC is used only for broadcaster-to-server ingest:

- Listener keeps the existing mock/original media element path until listener delivery is planned.
- Interpretation and Replacement Mode remain unchanged.

If WebRTC original programme delivery is added later:

- Attach the listener WebRTC `MediaStream` to the same `<video>` or `<audio>` media element currently passed to `attachOriginalElement`.
- Interpretation Mode keeps original gain at the selected reduced level.
- Replacement Mode sets original gain to zero while the programme timeline continues.
- The generated-audio queue continues to use `startMs` and `endMs`.

Translated audio should not initially move to WebRTC. Existing generated WAV delivery already has ordering, range support, safe paths, manual playback verification, queue reset, replay, and failure visibility.

## 13. Failure-State Design

Truthful UI states are required:

- `permission-denied`: browser rejected capture permission.
- `device-unavailable`: selected capture device missing or disconnected.
- `unsupported-browser`: required WebRTC or media API unavailable.
- `signalling-disconnected`: Socket.IO signalling unavailable.
- `offer-timeout`: offer was not answered before expiry.
- `answer-timeout`: answer did not arrive before expiry.
- `ice-gathering-failed`: local ICE candidate gathering failed.
- `ice-connection-failed`: ICE could not connect.
- `turn-unavailable`: configured TURN could not relay.
- `media-flow-timeout`: peer connected but no audio reached backend.
- `duplicate-broadcaster`: active broadcaster already owns the room.
- `stale-offer`: revision or session expired.
- `server-restarted`: gateway or ingest lost peer state.
- `provider-failed`: downstream transcription, translation, or TTS failed.
- `translated-audio-delayed`: generated audio is late but pipeline still running.

Browser suspension and network changes should move to `reconnecting` and show elapsed time. Listener refresh should replay state from gateway/media ingest snapshots where available. Broadcaster reconnect should require either the same session token/revision or an explicit replace action.

## 14. Security Considerations

Required before public WebRTC:

- HTTPS for browser capture and WebRTC in production.
- WSS for Socket.IO signalling.
- DTLS-SRTP for media transport.
- Authorization for broadcaster session creation.
- Room IDs that are unguessable and validated.
- Replay protection through `sessionId`, `peerId`, `revision`, and expiry.
- Input validation for SDP, ICE candidate fields, roles, and room IDs.
- Rate limiting for signalling events and session creation.
- TURN credentials generated server-side with short TTL.
- Logs must avoid media payloads, full SDP by default, TURN credentials, secrets, and unnecessary IP addresses.

Planning must not implement auth redesign. It should mark auth as a deployment blocker for public Phase 4 use.

## 15. Dependency Assessment

No dependency should be installed during planning.

Potential dependencies:

| Dependency or service | Purpose | Maintenance / impact | Security implications | Alternatives | Required for P4.0 |
| --- | --- | --- | --- | --- | --- |
| Native browser WebRTC APIs | Browser capture, RTCPeerConnection, ICE | Built into browsers, no npm runtime cost | Requires secure context and permission handling | None for browser side | No for contracts, yes later |
| Existing Socket.IO | Signalling | Already installed and tested | Needs validation/rate limiting/auth before production | Dedicated WebSocket endpoint | Yes |
| `wrtc` / `@roamhq/wrtc` style Node bindings | Backend WebRTC peer termination in Node | Native bindings can be brittle and platform-sensitive | Expands native attack/patch surface | GStreamer, FFmpeg bridge, mediasoup | No |
| mediasoup | SFU and server-side WebRTC transport | Mature but complex, native build and operational overhead | Exposes UDP/media service requiring hardening | Janus, LiveKit, Pion | No |
| Janus | WebRTC gateway/SFU | Mature C service, separate ops model | Additional daemon, plugin config, UDP/TLS hardening | mediasoup, LiveKit, Pion | No |
| Pion | Go WebRTC backend | Active, good server-side media access | Adds Go service/runtime | mediasoup, Janus | No |
| GStreamer | Media decode/bridge | Powerful but operationally heavy | Native plugins and pipeline hardening | FFmpeg subprocess, media server | No |
| coturn | Production TURN server | Standard TURN server | Credential protection, abuse prevention, bandwidth cost | Managed TURN | No |
| Managed WebRTC provider | Hosted signalling/media/TURN | Low ops, vendor-dependent | Secrets, vendor lock-in, media access constraints | Self-hosted SFU/TURN | No |

P4.0 should require no new runtime dependency. P4.3 is the milestone where backend media termination technology must be selected with evidence.

## 16. Testing Strategy

Unit tests:

- Signalling event schemas.
- Role validation.
- Room ID and peer ID validation.
- SDP and ICE candidate shape validation.
- Duplicate broadcaster rejection.
- Stale revision rejection.
- Lifecycle transition rules.

Gateway integration tests:

- Broadcaster creates session.
- Ingest/backend receives offer.
- Answer routes back only to the correct peer.
- ICE candidates route only within the session.
- Disconnect and session-end cleanup.
- Reconnect creates a new revision.
- Invalid signalling emits clear `error` events.

Browser tests:

- Permission granted and denied.
- Missing microphone.
- Mocked `RTCPeerConnection` offer/answer lifecycle.
- Mocked ICE candidate flow.
- Browser capture stop/teardown.
- Operator state display.

Two-browser validation:

- Real broadcaster browser and receiving backend/listener browser where applicable.
- Timestamp preservation under real browser clocks.
- Refresh and reconnect behavior.

Pipeline integration:

- WebRTC decoded chunks preserve sequence and `startMs`/`endMs`.
- Existing transcription, translation, TTS, generated-audio delivery, queue scheduling, Interpretation Mode, and Replacement Mode regressions all pass.

Regression:

- Existing 201 tests must remain passing.
- Build, lint, typecheck, and `npm audit --omit=dev` remain required.

Real-network validation:

- Same-machine host candidates.
- Same-LAN with STUN.
- NAT/firewall case requiring TURN.
- TURN credential expiry.

## 17. Deployment Requirements

Current deployment evidence is local development only. The repository documents local HTTP services on ports `3001`, `3002`, `5173`, `5174`, and `8001`. Do not assume production WebRTC support exists.

Likely requirements:

- HTTPS termination for frontend and APIs.
- WSS support for Socket.IO signalling.
- UDP ingress for WebRTC media if backend termination or SFU is used.
- TURN server, likely coturn or managed TURN.
- Reverse proxy support for WebSocket upgrade.
- Separate media process or service if Node WebRTC bindings are not selected.
- Health checks for signalling, media ingest, media terminator, and TURN reachability.
- Environment variables for ICE servers, TURN TTL, WebRTC room/session expiry, and public hostnames.
- Observability for peer connection state, ICE state, media packet flow, jitter, packet loss, reconnection, provider latency, and generated-audio delay.
- Scaling plan for in-memory state before multi-instance deployment.

Deployment blockers:

- No auth/authorization.
- No production HTTPS/WSS config.
- No TURN server or credentials.
- No backend media termination choice.
- No persistent session store.
- No documented production process model.

## 18. Milestone Breakdown

### P4.0 Architecture And Signalling Contracts

Objective: Add typed WebRTC signalling contracts and gateway lifecycle tests without media transport.

Likely files:

- `packages/shared-types/src/socket-events.ts`
- `packages/shared-types/src/webrtc-signalling.ts`
- `packages/media-contracts/src/webrtc-signalling-schema.ts`
- `services/realtime-gateway/src/gateway.ts`
- `services/realtime-gateway/src/webrtc-session-store.ts`
- `services/realtime-gateway/src/__tests__/webrtc-signalling.test.ts`
- `docs/PHASE_4_P4_0_WEBRTC_SIGNALLING.md`

Acceptance criteria:

- Signalling events are validated.
- Offers, answers, candidates, disconnect, and session-end route only to intended roles.
- Duplicate sessions and stale revisions are rejected.
- Operator-visible state is truthful if UI is touched.
- No media capture or peer media handling is implemented.

Tests:

- Unit tests for schemas/store.
- Gateway Socket.IO integration tests.
- Full regression suite.

Preservation:

- Existing translation/generated-audio events unchanged.
- Existing listener queue and mixer unchanged.

Exclusions:

- No real `RTCPeerConnection`.
- No media forwarding.
- No TURN credentials.

### P4.1 Browser Broadcaster Media Capture

Objective: Add browser programme-audio capture controls behind an explicit broadcaster/operator flow.

Likely files:

- `apps/operator-web/src/webrtcCapture.ts`
- `apps/operator-web/src/App.tsx`
- `apps/operator-web/src/App.module.css`
- `apps/operator-web/src/webrtcCapture.test.ts`

Acceptance criteria:

- Permission/device states are visible.
- Duplicate capture is prevented.
- Audio constraints distinguish speech microphone from programme audio.
- Capture can start, pause, resume, and stop locally.

Tests:

- Permission granted/denied.
- Missing device.
- Duplicate session guard.
- Browser API unavailable.

Preservation:

- Existing P2.6 microphone capture remains unchanged.

Exclusions:

- No server peer connection yet.
- No listener delivery.

### P4.2 Signalling And Peer Lifecycle

Objective: Connect browser `RTCPeerConnection` signalling through the gateway using mocked media tracks.

Likely files:

- `apps/operator-web/src/webrtcPeer.ts`
- `services/realtime-gateway/src/webrtc-session-store.ts`
- shared signalling contracts and tests

Acceptance criteria:

- Offer/answer and ICE flow complete in browser-level tests.
- Reconnect and teardown are explicit.
- Stale offers/candidates are rejected.

Tests:

- Mock `RTCPeerConnection`.
- Gateway integration.
- Browser harness where available.

Preservation:

- No effect on file upload, microphone HTTP chunks, or listener generated-audio queue.

Exclusions:

- No decoded server audio.
- No SFU.

### P4.3 Backend WebRTC Termination And Audio Ingest Bridge

Objective: Select and implement backend-terminated broadcaster-to-server WebRTC audio access, ending at a bounded internal ingest bridge.

Likely files:

- New backend media peer registry in `services/realtime-gateway`.
- New internal audio ingest bridge in `services/realtime-gateway`.
- Operator browser WebRTC transport controller.
- gateway signalling integration.

Acceptance criteria:

- Browser creates a real audio-only `RTCPeerConnection`.
- SDP and ICE use the existing typed signalling channel.
- Backend terminates the peer connection.
- Backend receives exactly one broadcaster programme-audio track.
- Backend observes audio frame or packet activity through a bounded bridge.
- Session identity, negotiation revision, and ingest timestamps are preserved.
- Media-flow state is visible in the operator UI.
- No listener WebRTC playback is added.
- No transcription, translation, TTS, listener queue, or mixer integration is added.

Tests:

- Browser peer-controller unit tests.
- Backend media peer registry tests.
- Audio ingest bridge tests.
- Gateway integration using real backend WebRTC termination where practical.
- Browser validation where practical.

Preservation:

- Existing HTTP upload and microphone paths remain passing.

Exclusions:

- No transcription or translation integration.
- No listener WebRTC playback unless proven necessary.

### P4.4 Transcription Pipeline Integration

Objective: Convert WebRTC audio bridge output into ordered chunks and route ready chunks through faster-whisper/mock transcription with monitoring and retry.

Acceptance criteria:

- Decoded audio becomes ordered chunks with `startMs` and `endMs`.
- Chunks enter the existing session pipeline.
- Only ready WebRTC chunks are transcribed.
- Ordering and timestamps match the WebRTC session timeline.
- Provider errors remain visible.

Tests:

- Success, empty speech, provider timeout/failure, retry, duplicate processing.

Exclusions:

- No translation provider changes.

### P4.5 Listener Delivery Integration

Objective: Deliver the broadcaster original programme audio to listeners through backend-terminated WebRTC while keeping generated translated audio on the Phase 3 HTTP WAV queue.

Acceptance criteria:

- Listener joins an existing WebRTC signalling session as a receive-only peer.
- Backend creates one listener-facing peer connection per listener after broadcaster audio activity is confirmed.
- Backend relays decoded broadcaster audio frames through `RTCAudioSource` to listener peers.
- Listener creates no microphone, video, or publishing track.
- Listener original programme audio uses the existing media element already connected to the Phase 3 mixer.
- Interpretation Mode and Replacement Mode switch gain only and do not renegotiate WebRTC.
- Generated translated audio queue, timestamp scheduling, exports, and HTTP WAV delivery remain unchanged.
- Listener UI distinguishes signalling, track receipt, playback started, autoplay blocked, failure, and closed states.
- Teardown closes listener peer resources on leave, refresh, broadcaster disconnect, and session close.

Tests:

- Backend listener peer offer, ICE, frame fanout, duplicate prevention, stale answer rejection, and cleanup.
- Gateway integration for listener joined before broadcaster audio becomes ready.
- Listener browser transport answer generation, receive-only transceiver, duplicate-track rejection, stale offer handling, and playback-blocked state.
- Listener signalling UI state rendering.

Exclusions:

- No translated-audio WebRTC delivery.
- No listener microphone publishing, video, screen sharing, HLS, SFU, MCU, TURN deployment, queue rewrite, mixer rewrite, plugins, public APIs, billing, analytics, or auth redesign.

### P4.6 Reconnect, Failure Recovery, And Observability

Objective: Harden lifecycle, failures, and operator diagnostics.

Acceptance criteria:

- ICE failure, signalling disconnect, peer disconnect, browser refresh, network change, and gateway restart limitations are visible.
- Recovery uses connection generations and fresh negotiation revisions.
- Duplicate retries, duplicate broadcaster sessions, duplicate listener peers, stale acknowledgements, stale candidates, and stale peer events are prevented.
- Transcription bridge failures are isolated from listener programme-audio delivery.
- Listener delivery failures are isolated from broadcaster ingest and from other listeners.
- Aggregate diagnostics expose counts, states, revisions, retry attempts, cleanup reasons, and resource counts without SDP, ICE, audio, PCM, tokens, credentials, provider secrets, or private addresses.
- Socket rate limits, payload limits, optional internal WebRTC token checks, and staging-directory path validation are enforced.

Tests:

- Shared signalling bounded recovery and stale/lost acknowledgement handling.
- Gateway rate and payload limits.
- Backend peer cleanup and resource count return.
- Browser transport retry limits and exhaustion.
- P4.3-P4.5 regression coverage.

Exclusions:

- No analytics product feature.
- No new authentication system.
- No monitoring platform.

P4.6 implementation decisions:

- Shared signalling client added `recovering-session` plus `recoverSessionWithBackoff`.
- Signalling recovery defaults to 3 attempts with exponential backoff.
- Broadcaster and listener browser transports have bounded media retry counters.
- Broadcaster transport preserves local capture only when one live audio track remains.
- Listener transport closes only its listener peer and rejoins explicitly before waiting for a fresh backend offer.
- Gateway raw signalling payload limit is `WEBRTC_SIGNALLING_LIMITS.rawPayloadMaxBytes`.
- Gateway socket signalling rate limit is `WEBRTC_SIGNALLING_LIMITS.maxMessagesPerSocketWindow` per `rateLimitWindowMs`.
- Gateway frame handling isolates transcription bridge failures from listener programme-audio fanout.
- Backend failed peers release timers, candidate queues, sinks/tracks, peer connections, and active capacity.
- Media ingest internal WebRTC routes can require `INTERNAL_WEBRTC_TOKEN`.
- Operator/listener UIs show reconnecting, recovering, unavailable/interrupted, retry-exhausted, and closed states without claiming live status during uncertainty.
- Detailed closure notes live in `docs/PHASE_4_P4_6_RECOVERY_SECURITY_OBSERVABILITY.md`.

### P4.7 Browser End-To-End Validation And Phase 4 Closure

Objective: Validate Phase 4 as an integrated browser workflow.

Acceptance criteria:

- Uploaded media, browser microphone, WebRTC broadcaster audio, local providers, generated audio, listener queue, Interpretation Mode, Replacement Mode, pause/resume/cancel/retry, exports, and failure visibility all pass.
- Phase 1 through Phase 3 remain preserved.

Tests:

- Full regression.
- Browser E2E.
- Real local network smoke.
- Audit.

Exclusions:

- No Phase 5 external integrations.

## 19. Risks And Mitigations

- Backend WebRTC termination choice can create native dependency risk. Mitigation: keep P4.0 dependency-free and defer selection until a small spike proves audio access.
- WebRTC "connected" can be misleading without media packets. Mitigation: separate signalling, peer connection, and media-flow states.
- TURN can become a bandwidth and abuse vector. Mitigation: short-lived credentials, rate limits, and no hard-coded credentials.
- In-memory session state cannot scale horizontally. Mitigation: keep Phase 4 local/MVP scoped and record Redis/persistent state as Phase 6 work.
- Browser autoplay and AudioContext policies can block playback. Mitigation: keep explicit user gesture and visible audio-context errors.
- Clock drift can break synchronization. Mitigation: derive all translated audio timestamps from the backend media timeline and keep listener queue tolerance rules.
- Existing mock video lacks original audio. Mitigation: P4 listener validation must use a real audio-bearing programme source before claiming original-audio mixing is fully verified.

## 20. Explicit Non-Goals

- Video streaming in the first WebRTC milestone.
- Listener WebRTC playback in P4.0.
- Translated-audio delivery over WebRTC in P4.0.
- Group calls.
- Screen sharing.
- Recording studio features.
- HLS.
- SFU deployment in P4.0.
- Billing.
- Subscriptions.
- Analytics.
- Social features.
- Mobile apps.
- Unrelated UI redesign.
- Production authentication redesign.
- Third-party plugin integrations.
- Public partner APIs.

## 21. Open Decisions Requiring Evidence

- Which backend media termination technology best fits this repository: Node bindings, mediasoup, Janus, Pion, GStreamer, FFmpeg bridge, or managed provider.
- Whether P4 should deliver original programme audio/video to listeners over WebRTC or keep listener delivery separate until HLS/SFU evidence exists.
- Whether WebRTC source chunks should be processed at 15 seconds initially or whether smaller chunks are needed for acceptable live latency.
- Exact production TURN provider and credential generation strategy.
- Whether the current in-memory gateway state is acceptable for the first real WebRTC smoke or needs a persistent session store first.
- Whether the existing `media-ingest` process should terminate WebRTC directly or whether a separate media terminator service should feed media ingest.
- How to test real NAT/TURN behavior in CI or release validation.

## 22. Phase 4 Readiness Decision

Phase 4 is ready to begin with P4.0 architecture and signalling contracts only.

Do not begin WebRTC media transport until P4.0 proves:

- Typed signalling contracts are stable.
- Gateway lifecycle state is reliable.
- Duplicate and stale sessions are rejected.
- Failure states are truthful.
- Existing 201 tests still pass.
- No Phase 1, Phase 2, or Phase 3 behavior regresses.

Recommended exact next milestone: P4.0 architecture and signalling contracts.

## P4.0 Implementation Decisions

P4.0 made the following planning decisions concrete:

- Signalling contracts live in `packages/shared-types/src/webrtc-signalling.ts`.
- Runtime validation lives in `packages/media-contracts/src/webrtc-signalling-schema.ts`.
- Protocol version is `1`.
- Gateway event names are:
  - `webrtc:session:create`
  - `webrtc:session:join`
  - `webrtc:signal`
  - `webrtc:session:leave`
  - `webrtc:session:close`
  - `webrtc:session:event`
  - `webrtc:error`
- Roles are limited to `broadcaster`, `listener`, and `server`.
- The first registry is in-memory only and isolated in `services/realtime-gateway/src/webrtc-session-registry.ts`.
- SDP and ICE payloads are opaque validated strings/fields only.
- No WebRTC media APIs, browser capture APIs, STUN, TURN, SFU, MCU, or backend media termination were implemented.
- P4.1 remains the next milestone and should add browser broadcaster capture without changing listener playback or generated-audio delivery.

## P4.1 Implementation Decisions

P4.1 made the following planning decisions concrete:

- Browser broadcaster capture lives in `apps/operator-web`.
- Local capture lifecycle is isolated in `apps/operator-web/src/broadcasterCapture.ts`.
- Operator UI is isolated in `apps/operator-web/src/BroadcasterCapturePanel.tsx`.
- Capture states are `idle`, `requesting-permission`, `ready`, `capturing`, `paused`, `stopping`, `stopped`, `permission-denied`, `device-unavailable`, and `failed`.
- Default constraints are audio-only with mono preference, echo cancellation, noise suppression, and automatic gain control for microphone speech capture.
- The browser may choose actual sample rate and channel behavior.
- Device IDs are retained only in browser memory.
- Gateway signalling connectivity and local capture readiness are shown separately.
- Gateway disconnect and component teardown stop owned local tracks.
- No local speaker monitoring, audio meter, recording, upload, SDP, ICE, `RTCPeerConnection`, STUN, TURN, backend WebRTC termination, or listener WebRTC playback was implemented.
- P4.2 remains the next milestone and should add signalling and peer lifecycle around the local stream, still without backend media termination or listener WebRTC playback unless explicitly scoped.

## P4.2 Implementation Decisions

P4.2 made the following planning decisions concrete:

- Shared browser signalling orchestration lives in `packages/shared-types/src/webrtc-signalling-client.ts`.
- The client uses P4.0 protocol version `1` and the existing Socket.IO event names.
- The client owns message IDs, correlation IDs, acknowledgement timeouts, duplicate-event protection, stale-event rejection, and connection-generation tracking.
- Client lifecycle states are `idle`, `connecting`, `connected`, `creating-session`, `joining-session`, `joined`, `ready`, `reconnecting`, `leaving`, `closing`, `disconnected`, `closed`, and `failed`.
- The operator app uses a dedicated `role=broadcaster` Socket.IO connection for broadcaster signalling, separate from the existing `role=operator` service socket.
- The listener app reuses its existing `role=listener` Socket.IO connection and preserves all language-room, translation, generated-audio, queue and mixer subscriptions.
- Broadcaster share identifiers use `broadcastId/sessionId`.
- Reconnect recovery is explicit. Broadcaster recovery creates a fresh P4.0 session because broadcaster disconnect closes the old in-memory session.
- Gateway leave routing now broadcasts the `peer-disconnect` acknowledgement before the leaving socket exits the session room.
- P4.1 local capture and P4.2 signalling state remain separate in the operator UI.
- Listener UI states explicitly say WebRTC audio playback is not active.
- No `RTCPeerConnection`, SDP generation, ICE generation, STUN, TURN, media transmission, backend media termination, listener WebRTC playback, SFU, MCU, HLS, auth redesign, billing, subscriptions, analytics or deployment work was implemented.
- P4.3 remains the next milestone and should select and implement server-side audio access or an ingest bridge.

## P4.3 Implementation Decisions

P4.3 made the following planning decisions concrete:

- Backend WebRTC termination uses `@roamhq/wrtc@0.10.0` in `services/realtime-gateway`.
- `@roamhq/wrtc` was selected because it provides Node `RTCPeerConnection` plus `nonstandard.RTCAudioSink` decoded audio-frame access and passed production audit in this workspace.
- Rejected options were `werift` because production audit exposed high-severity `ip` vulnerabilities through `werift-ice`, `node-datachannel` because decoded audio sink access was less direct for this milestone, obsolete `node-webrtc`, and SFU/provider stacks because they exceed P4.3 scope.
- Backend media peer lifecycle is isolated in `services/realtime-gateway/src/webrtc-media-peer-registry.ts`.
- The internal ingest bridge is isolated in `services/realtime-gateway/src/webrtc-audio-ingest-bridge.ts`.
- Browser peer lifecycle is isolated in `apps/operator-web/src/broadcasterWebRtcTransport.ts`.
- The backend media peer ID is `peer_backend_media`.
- The gateway routes backend-targeted SDP offers and ICE through the existing typed signalling protocol; no second Socket.IO channel was added.
- ICE server configuration is environment-driven through `VITE_WEBRTC_ICE_SERVERS` for the browser and `WEBRTC_ICE_SERVERS` for the backend.
- The only implemented media direction is broadcaster browser to backend.
- The browser attaches exactly one live audio track from the P4.1 capture stream and never requests microphone permission itself.
- The backend accepts one audio track, rejects duplicate audio, rejects video, and emits readiness only after decoded audio-frame activity.
- The bridge records bounded decoded-frame metadata and activity evidence only; it does not store audio payloads, write files, run FFmpeg, or invoke transcription.
- Operator UI now separates capture, signalling, peer negotiation, backend connection, audio track receipt, audio activity, and transport failure.
- Listener UI remains signalling-only for WebRTC and still does not receive WebRTC playback.
- P4.3 adds no transcription, translation, TTS, generated-audio queue, Interpretation Mode, Replacement Mode, HLS, SFU, MCU, plugin, public API, billing, subscription, analytics, auth redesign, recording, or listener WebRTC work.
- Real browser closure validation passed on Windows `win32 x64` with Node.js `v24.18.0`, `@roamhq/wrtc@0.10.0`, and headless `Chrome/149.0.7827.55`.
- The real browser validation used a deterministic 440 Hz PCM WAV fake-audio source through Chromium fake-media flags and CDP automation.
- The validated local service commands were `npm run dev -w services/realtime-gateway` and `npm run dev -w apps/operator-web -- --host localhost`.
- The browser path was `operator browser capture -> browser RTCPeerConnection -> Socket.IO signalling -> backend RTCPeerConnection -> backend audio track -> decoded audio activity evidence`.
- Successful validation observed one browser peer, one audio sender, no video sender, one offer, one backend answer, connected browser peer state, connected ICE state, one backend audio track, and decoded audio activity.
- Duplicate transport start was blocked without creating a second browser peer or backend peer.
- Explicit stop, local track end, and browser refresh all closed the backend media peer and ingest bridge.
- Backend-unavailable validation surfaced disconnected state, kept backend transport disabled, created no browser peer, and did not leak local capture.
- The browser runtime reported zero uncaught errors, zero unhandled promise rejections, and zero unresolved console errors or warnings after expected dev-server noise was filtered.
- Backend runtime validation confirmed `RTCPeerConnection` and `nonstandard.RTCAudioSink` were available from the native package.
- P4.3 closure fixes included using the default CommonJS export for `@roamhq/wrtc`, adding backend-targeted peer disconnect from the browser transport, adding safe backend lifecycle logs, and tightening gateway media-path event matching.
- P4.3 is closed at 100% for same-machine Chromium fake-audio validation.
- P4.4 is the next milestone and should connect WebRTC bridge output to ordered audio chunking and transcription-pipeline ingest.

## P4.4 Implementation Decisions

P4.4 made the following planning decisions concrete:

- WebRTC transcription chunking lives in `services/realtime-gateway/src/webrtc-transcription-chunker.ts`.
- WebRTC-to-media-ingest submission lives in `services/realtime-gateway/src/webrtc-transcription-bridge.ts`.
- Backend peer lifecycle still lives in `services/realtime-gateway/src/webrtc-media-peer-registry.ts`; it now exposes decoded audio frames and teardown events through callbacks.
- The gateway does not call a transcription provider directly.
- Media ingest owns WebRTC processing sessions, transcript event creation, provider invocation and media-state publication.
- Internal WebRTC media ingest endpoints are under `/internal/media/...`.
- The internal handoff uses normalized WAV chunks in `WEBRTC_AUDIO_CHUNK_STAGING_DIR`; media-ingest verifies the resolved path is inside that directory before moving the file.
- WebRTC chunks are normalized to WAV mono 16 kHz PCM 16-bit before transcription.
- Default WebRTC transcription chunk duration is 5 seconds through `WEBRTC_TRANSCRIPTION_CHUNK_MS`.
- Real-browser validation can lower chunk duration to 1 second to prove live event flow without changing committed defaults.
- Final partial chunks are flushed on stop, track end and teardown.
- WebRTC transcript events preserve WebRTC session ID, broadcast ID, sequence, timestamps, detected language, confidence when available, status and provider latency.
- WebRTC processing sessions stop at transcription for P4.4; translation, TTS, generated-audio delivery, listener playback, queue synchronization and mixing are unchanged.
- Operator UI now shows WebRTC transcription bridge status, chunk progress, latest transcript and bridge errors in the backend transport panel.
- Existing transcription UI continues to show chunk events and retry/failure status.
- P4.4 adds no listener WebRTC playback, server-to-listener media, recording, raw audio payload logging, video, HLS, SFU, MCU, TURN deployment, new transcription vendor, translation provider work, TTS work, generated-audio queue work, mixer work, plugin, public API, billing, subscription, analytics, or auth redesign.
- P4.5 is the next milestone and should address listener delivery integration without changing the P4.4 transcription bridge contract.

## P4.5 Implementation Decisions

P4.5 made the following planning decisions concrete:

- Listener WebRTC delivery is backend fanout of the original broadcaster programme audio, not translated generated audio.
- Listener transport lives in `apps/listener-web/src/listenerWebRtcTransport.ts`.
- Listener signalling UI lives in `apps/listener-web/src/ListenerSignallingPanel.tsx`.
- Backend listener peer lifecycle lives in `services/realtime-gateway/src/webrtc-listener-peer-registry.ts`.
- Listener peers are receive-only and create no microphone, video, screen-share, or publishing tracks.
- The backend creates listener offers only after broadcaster audio activity is confirmed.
- The listener accepts exactly one live audio track and attaches it to the same media element used by the Phase 3 queue and mixer.
- Listener mode switching between Interpretation and Replacement changes mixer gain only and does not renegotiate WebRTC.
- Gateway delivery rejects duplicate listener peers and stale answers.
- Listener leave, refresh, broadcaster disconnect, session close, and backend teardown close listener peer resources.
- Generated translated audio remains delivered through the existing safe HTTP WAV path and timestamp queue.
- P4.5 added no translated-audio WebRTC delivery, video delivery, SFU, MCU, HLS, TURN deployment, plugins, public APIs, billing, analytics, or auth redesign.

## P4.6 Implementation Decisions

P4.6 made the following planning decisions concrete:

- Shared signalling recovery uses `recovering-session`, connection generations, acknowledgement cleanup, and bounded `recoverSessionWithBackoff`.
- Browser media transports have bounded retry counters and explicit recovery/failed states.
- Gateway signalling applies raw payload limits, per-socket rate limits, role checks, protocol checks, optional internal WebRTC token checks, and safe error envelopes.
- Stale acknowledgements, stale SDP/ICE, stale translation events, stale generated-audio events, duplicate broadcasters, duplicate listener peers, and duplicate processing attempts are rejected.
- Transcription bridge failure is isolated from listener programme-audio fanout.
- Listener delivery failure is isolated from broadcaster ingest, transcription, and other listeners.
- Failed backend peers release timers, candidate queues, audio sinks, tracks, peer connections, and active capacity.
- Operator and listener UIs surface reconnecting, recovering, unavailable/interrupted, retry exhaustion, provider errors, and cleanup state without claiming live status during uncertainty.
- Runtime diagnostics expose counts and state metadata without raw SDP, ICE candidates, audio, PCM, tokens, credentials, provider secrets, or private candidate details.
- Detailed notes live in `docs/PHASE_4_P4_6_RECOVERY_SECURITY_OBSERVABILITY.md`.

## P4.7 Closure Decisions

P4.7 closed the remaining Phase 4 validation work:

- Real-browser normal-flow validation passed in headless `Chrome/149.0.7827.55` on Windows `win32 x64` with Node.js `v24.18.0`.
- The browser harness used deterministic 440 Hz PCM WAV fake microphone input through Chromium fake-media flags.
- The validated path was `operator capture -> signalling -> backend ingest -> decoded frame activity -> transcription bridge -> listener WebRTC programme-audio delivery -> Interpretation/Replacement mixer`.
- Automated gateway-interruption recovery passed.
- Gateway restart recovery creates a fresh broadcaster signalling session, then listener refresh/rejoin receives one live audio track.
- Normal and recovered mode switching did not renegotiate or duplicate listener peers/tracks.
- Browser evidence observed two backend media peer creations and two audio-activity detections across the restart.
- Browser evidence observed exactly one connected broadcaster peer after recovery, exactly one listener peer after refresh/rejoin, and exactly one live listener audio track.
- Focused P4.6/P4.7 browser validation, P4.0-P4.5 regression tests, listener queue/mixer tests, transcription tests, gateway integration tests, `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`, and `npm audit --omit=dev` passed.
- Dirty-tree and ignored-artifact classification is documented in `docs/PHASE_4_CLOSURE_REPORT.md`.
- No production code defect was found during P4.7; the only new artifact is ignored validation automation/evidence under `.videofy-dev-logs/`.

## Phase 4 Closure Decision

Phase 4 is closed at 100% for the local WebRTC scope.

P4.6 is now closed at 100% because automated real-browser gateway-interruption recovery passed in P4.7.

Phase 5 should not begin until the Phase 4 worktree is reviewed, committed, and pushed without generated/local artifacts.

Recommended exact next action: controlled reviewed commit and push for completed Phase 4 only.
