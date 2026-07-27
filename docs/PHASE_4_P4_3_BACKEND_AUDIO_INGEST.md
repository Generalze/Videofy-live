# Phase 4 P4.3 Backend WebRTC Audio Ingest

Date: 2026-07-27

Branch: `phase-4-webrtc`

Baseline: completed Phase 1, closed Phase 2, closed Phase 3, P4.0 signalling contracts, P4.1 local broadcaster capture, and P4.2 client signalling lifecycle.

## Status

P4.3 implements the first real WebRTC media direction:

`operator browser -> backend WebRTC peer -> bounded internal audio ingest bridge`

No listener WebRTC playback, transcription integration, translation integration, TTS changes, generated-audio queue changes, mixer changes, recording, SFU, MCU, HLS, TURN deployment, plugins, public APIs, auth redesign, billing, subscriptions, or analytics were added.

## Backend Dependency Selection

Selected dependency:

- `@roamhq/wrtc@0.10.0`

Reason:

- exposes a Node `RTCPeerConnection` compatible with browser SDP/ICE;
- exposes `nonstandard.RTCAudioSink`, which gives backend access to decoded audio frames;
- supports deterministic unit and Socket.IO integration tests in the current Node/TypeScript workspace;
- keeps the backend implementation inside the existing realtime gateway instead of adding a second service;
- passes `npm audit --omit=dev` with zero production vulnerabilities.

Observed package details:

- License: BSD-2-Clause.
- Runtime: native optional platform packages for Windows x64, Linux x64, Linux arm64, macOS x64, and macOS arm64.
- Lockfile impact: one direct dependency plus platform-specific optional packages in `package-lock.json`.
- Deployment implication: production hosts must use a supported CPU/OS pair and install the matching native package. This is not a TURN/SFU deployment.

Alternatives evaluated:

- `werift@0.24.1`: pure TypeScript and attractive for portability, but production audit showed high-severity vulnerabilities through `werift-ice -> ip` in this workspace.
- `node-datachannel@0.32.3`: maintained native WebRTC/data-channel stack, but the media sink fit was less direct for decoded audio-frame access from a browser peer.
- `node-webrtc`: obsolete package state and not suitable for this milestone.
- mediasoup, Janus, Pion, managed WebRTC providers: operationally broader than P4.3 and would add SFU/service/vendor scope that is explicitly out of milestone.

## Browser Peer Architecture

Browser WebRTC transport is isolated in `apps/operator-web/src/broadcasterWebRtcTransport.ts`.

The controller owns:

- one browser `RTCPeerConnection`;
- attachment of the P4.1-owned audio track;
- offer creation and local description;
- backend answer validation and remote description;
- local and remote ICE handling;
- negotiation revision;
- answer and ICE timers;
- close, dispose, and recovery.

It uses the P4.2 `WebRtcSignallingClient` and does not create another Socket.IO client. It never requests microphone permission; P4.1 remains the capture owner.

Browser transport states:

- `idle`
- `preparing`
- `creating-offer`
- `awaiting-answer`
- `connecting`
- `connected`
- `disconnected`
- `failed`
- `closing`
- `closed`

## Backend Peer Architecture

Backend media termination is isolated in `services/realtime-gateway/src/webrtc-media-peer-registry.ts`.

The registry tracks:

- signalling session ID and broadcast ID;
- broadcaster peer ID and broadcaster socket ownership;
- backend media peer ID `peer_backend_media`;
- negotiation revision;
- backend `RTCPeerConnection`;
- connection and ICE state;
- audio track state;
- ingest bridge state;
- timestamps, last activity, and safe last error.

There is one active backend media peer per signalling session. Active peers are bounded to 25 by default. Peer objects are not stored in shared contract objects.

## Signalling Flow

The existing P4.0/P4.2 Socket.IO signalling channel carries SDP and ICE.

Flow:

1. Operator starts P4.1 local audio capture.
2. Operator creates a P4.2 broadcaster signalling session.
3. Browser transport attaches the single live local audio track.
4. Browser creates an SDP offer and sends it to `peer_backend_media`.
5. Gateway validates the typed signalling envelope, session ownership, and revision.
6. Backend registry creates the backend peer, applies the offer, creates an answer, and sets local description.
7. Gateway returns the answer only to the owning broadcaster.
8. Browser applies the answer, exchanges ICE, and waits for connection/media evidence.
9. Backend emits `peer-ready` only after decoded audio-frame activity is observed.

Receiving an answer does not mark the transport ready.

## SDP And ICE Handling

SDP remains opaque at the contract boundary. P4.3 applies SDP through WebRTC APIs without arbitrary SDP rewriting.

ICE behavior:

- candidates are routed only through the existing typed signalling protocol;
- stale negotiation revisions are rejected;
- remote candidates may be queued until the matching remote description exists;
- duplicate candidates are ignored through bounded caches;
- end-of-candidates is represented by `ice-complete`;
- raw SDP and ICE candidate strings are not logged.

ICE server configuration:

- browser: `VITE_WEBRTC_ICE_SERVERS`
- backend: `WEBRTC_ICE_SERVERS`

Both are JSON arrays. Empty configuration is supported for same-machine local tests. No STUN/TURN credentials were committed.

## Audio Track Policy

Browser side:

- exactly one live audio track is required;
- zero audio tracks are rejected;
- more than one live audio track is rejected;
- no video transceiver is added;
- local capture tracks are not stopped merely because negotiation fails.

Backend side:

- the first audio track is accepted;
- duplicate audio tracks fail the peer;
- video tracks fail the peer with a typed error;
- track-ended is surfaced as failure;
- audio activity is confirmed only when `RTCAudioSink` provides decoded frame data.

## Ingest Bridge

The internal bridge lives in `services/realtime-gateway/src/webrtc-audio-ingest-bridge.ts`.

States:

- `idle`
- `opened`
- `track-attached`
- `active`
- `ended`
- `failed`
- `closed`

The bridge records bounded metadata only:

- session ID, broadcast ID, broadcaster peer ID, and revision;
- frame sequence;
- server receive timestamp;
- relative ingest timestamp;
- sample rate;
- channel count;
- bits per sample;
- frame and sample counts.

It does not persist audio payloads, write files, call FFmpeg, or invoke transcription.

## Audio Representation

`@roamhq/wrtc` provides decoded PCM-like frame data through `nonstandard.RTCAudioSink`. P4.3 exposes that as metadata and activity evidence at the bridge boundary.

P4.4 must decide whether to retain PCM frames, normalize them, and chunk them into the existing transcription pipeline. P4.3 deliberately avoids that integration.

## Timestamp Model

P4.3 records:

- signalling session revision;
- peer creation/update timestamps;
- backend audio-track receipt through bridge state;
- first and latest decoded audio-frame timestamps;
- server relative ingest time from bridge open;
- monotonically increasing frame sequence.

The timestamp origin for P4.4 is the backend bridge open time plus the decoded frame sequence/activity timeline. The Phase 3 listener queue timestamp model was not modified.

## UI Integration

The operator UI adds `BroadcasterWebRtcTransportPanel`.

It displays separate state for:

- local capture;
- signalling session;
- peer negotiation;
- browser connection and ICE state;
- backend peer;
- backend audio track;
- backend audio activity;
- transport errors.

The UI uses truthful labels such as `Capturing locally`, `Signalling ready`, `Negotiating audio transport`, `Backend connected`, `Audio track received`, and `Audio activity detected`. It also explicitly says `No listener WebRTC playback`.

Listener WebRTC UI remains a signalling-only surface and still states that WebRTC audio playback is not active.

## Typed Errors

P4.3 adds typed errors for backend and browser transport failures, including:

- backend WebRTC unavailable;
- dependency initialization failure;
- peer already exists;
- missing audio track;
- duplicate audio track;
- unexpected video track;
- invalid offer or answer;
- remote/local description failure;
- ICE candidate or ICE connection failure;
- negotiation timeout;
- stale negotiation;
- connection closed;
- audio track ended;
- ingest bridge failure;
- cleanup failure;
- unsupported runtime.

Errors are mapped to safe operator-visible messages without SDP, ICE, stack traces, credentials, tokens, or private addresses.

## Timeouts And Limits

Defaults:

- browser answer timeout: 8 seconds;
- browser ICE timeout: 10 seconds;
- browser queued remote candidates: 32;
- backend offer-to-answer timeout: 8 seconds;
- backend first-audio timeout: 12 seconds;
- backend queued/seen remote candidates: 64;
- active backend peers: 25.

Failed and closed peer cleanup is idempotent.

## Teardown And Recovery

Cleanup closes:

- browser `RTCPeerConnection`;
- backend `RTCPeerConnection`;
- backend `RTCAudioSink`;
- bridge state;
- candidate queues and duplicate caches;
- timers;
- track-ended listeners.

Cleanup triggers include explicit stop, signalling session close, broadcaster socket disconnect, track end, backend failure, component unmount, and negotiation timeout.

Recovery creates a fresh negotiation revision after close or failure and does not reuse stale candidates or old answers.

## Security And Logging

P4.3 preserves role enforcement, socket ownership, session ownership, payload validation, protocol version validation, revision validation, and message deduplication.

Additional protections:

- no audio payload logging;
- no captured audio persistence;
- no SDP or ICE strings in diagnostics;
- no media diagnostics to unrelated sockets;
- no hard-coded TURN credentials;
- HTTPS/WSS remain required for production browser capture and signalling;
- production NAT traversal is not solved without TURN.

## Tests Added

Browser controller/UI:

- `apps/operator-web/src/broadcasterWebRtcTransport.test.ts`
- `apps/operator-web/src/BroadcasterWebRtcTransportPanel.test.tsx`

Backend bridge/registry:

- `services/realtime-gateway/src/__tests__/webrtc-audio-ingest-bridge.test.ts`
- `services/realtime-gateway/src/__tests__/webrtc-media-peer-registry.test.ts`

Gateway integration:

- `services/realtime-gateway/src/__tests__/webrtc-signalling.integration.test.ts` now includes a real backend media-path test using Socket.IO clients plus `@roamhq/wrtc.RTCPeerConnection` and deterministic `RTCAudioSource` frames.

Coverage includes peer creation, offer/answer, ICE exchange, stale and duplicate handling, audio-track validation, activity evidence, cleanup, active-peer bounds, truthful UI state, and preservation of signalling behavior.

## Browser Validation

Automated Node validation uses the same browser-facing SDP/ICE protocol with a deterministic `@roamhq/wrtc` broadcaster peer. It proves backend termination and audio activity without requiring a physical microphone.

Real browser closure validation was completed on 2026-07-27 with a real Chromium browser and deterministic fake audio.

Environment:

- OS: Windows, `win32 x64`.
- Node.js: `v24.18.0`.
- Native WebRTC load check: `@roamhq/wrtc@0.10.0` loaded successfully with `RTCPeerConnection` and `nonstandard.RTCAudioSink` both available.
- Browser: `Chrome/149.0.7827.55`.
- Mode: headless Chromium.
- Automation: Chrome DevTools Protocol from `.videofy-dev-logs/p4-3-browser-e2e.mjs`.
- Operator URL: `http://localhost:5174`.
- Gateway health URL: `http://localhost:3001/health`.
- Secure context: `true` for localhost.
- Media source: deterministic non-silent 440 Hz PCM WAV generated under ignored `.videofy-dev-logs/` and passed through Chromium fake-audio capture.

Commands:

- Gateway: `npm run dev -w services/realtime-gateway`.
- Operator app: `npm run dev -w apps/operator-web -- --host localhost`.
- Browser: `C:\Users\zoeme\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe --remote-debugging-port=9222 --headless=new --no-first-run --no-default-browser-check --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<ignored local wav> --autoplay-policy=no-user-gesture-required about:blank`.

Evidence from `.videofy-dev-logs/p4-3-browser-e2e-result.json`:

- Result: passed.
- Runtime window: `2026-07-27T13:50:04.876Z` to `2026-07-27T13:50:10.474Z`.
- Local capture requested audio only; `video: false`.
- Fake-source audio energy RMS: `0.11247697948099061`.
- Successful transport created exactly one browser `RTCPeerConnection`.
- Browser attached one audio sender and no video senders.
- Browser transceivers were audio only.
- Browser offer count was `1`; local description was `offer`; remote description was `answer`.
- Browser connection states reached `new -> connecting -> connected`.
- Browser ICE states reached `new -> checking -> connected`.
- Backend media peer creations: `3`.
- Backend audio-track receipts: `3`.
- Backend decoded audio-activity events: `3`.
- Backend media peer closures: `3`.
- Backend media failures: `0`.
- First success revision: `1`.
- Restart revision: `2`.
- Refresh cleanup revision: `3`.
- Final browser peer count after teardown: `0`.
- Final browser runtime errors: `0`.
- Final unhandled promise rejections: `0`.
- Final browser console errors and warnings after filtering expected dev-server noise: `0`.

Scenarios validated:

- Successful connection: local capture, signalling session, offer/answer, ICE, backend peer connection, one backend audio track, and decoded audio activity all succeeded.
- Duplicate transport start: the start button was disabled; no second browser peer, track, or backend peer was created.
- Explicit stop: browser peer closed and backend media peer plus ingest bridge closed with reason `operator stopped backend audio transport`.
- Restart after stop: a fresh revision `2` was negotiated, backend audio activity was detected again, and stale state was not reused.
- Capture track ended: stopping the source track moved the operator state to closed and closed backend resources with reason `local programme audio track ended`.
- Browser refresh: the broadcaster socket disconnected and backend resources closed with reason `broadcaster socket disconnected`.
- Backend unavailable: after the gateway was stopped, the operator showed disconnected state, start transport remained disabled, no browser peer was created, and local capture was stopped without leaking tracks.

The validation harness stores only safe evidence under ignored `.videofy-dev-logs/`. It does not print raw SDP, full ICE candidates, private IP addresses, cookies, credentials, or audio payloads.

## Closure Fixes

Real browser validation found and fixed two P4.3 closure defects:

- The backend runtime import used a namespace import for the CommonJS `@roamhq/wrtc` package. Under the realtime gateway dev ESM loader, this made `RTCPeerConnection` and `RTCAudioSink` appear unavailable even though the native package loaded correctly in Node. The registry now uses the package default export.
- Browser transport stop previously closed only the local browser peer. It now sends an explicit backend-targeted `peer-disconnect` over the existing typed signalling channel so the backend media peer and ingest bridge close immediately on explicit stop and local track end.

Additional validation hardening:

- Backend media-peer lifecycle logs were added for safe creation, track receipt, decoded audio activity, closure, and failure evidence.
- Gateway integration waiting now filters for the expected `peer-ready` media event instead of racing unrelated WebRTC session events.
- Regression coverage was added for backend-targeted peer disconnect, backend media peer disconnect/rejoin, and browser transport stop signalling.

## Files Changed

P4.3 files:

- `apps/operator-web/src/App.tsx`
- `apps/operator-web/src/BroadcasterSignallingPanel.tsx`
- `apps/operator-web/src/BroadcasterWebRtcTransportPanel.tsx`
- `apps/operator-web/src/BroadcasterWebRtcTransportPanel.test.tsx`
- `apps/operator-web/src/broadcasterWebRtcTransport.ts`
- `apps/operator-web/src/broadcasterWebRtcTransport.test.ts`
- `packages/shared-types/src/webrtc-signalling.ts`
- `packages/shared-types/src/webrtc-signalling-client.ts`
- `packages/media-contracts/src/webrtc-signalling-schema.ts`
- `services/realtime-gateway/package.json`
- `services/realtime-gateway/src/gateway.ts`
- `services/realtime-gateway/src/webrtc-session-registry.ts`
- `services/realtime-gateway/src/webrtc-audio-ingest-bridge.ts`
- `services/realtime-gateway/src/webrtc-media-peer-registry.ts`
- `services/realtime-gateway/src/__tests__/webrtc-audio-ingest-bridge.test.ts`
- `services/realtime-gateway/src/__tests__/webrtc-media-peer-registry.test.ts`
- `services/realtime-gateway/src/__tests__/webrtc-signalling.integration.test.ts`
- `services/realtime-gateway/src/workspace-modules.d.ts`
- `package-lock.json`
- `docs/PHASE_4_WEBRTC_PLAN.md`
- `docs/PHASE_4_P4_3_BACKEND_AUDIO_INGEST.md`

Earlier P4.0, P4.1, and P4.2 files remain preserved.

## Known Limitations

- Real browser validation covered same-machine Chromium fake-audio capture only; no physical microphone was used.
- No TURN server is configured; local host-candidate tests are the only verified NAT mode.
- The bridge records decoded-frame metadata/activity, not audio files or transcription-ready chunks.
- No persistent store exists for backend peer diagnostics.
- In-memory gateway state remains unsuitable for horizontal production scaling.
- Native WebRTC package support must be validated on every deployment OS/CPU pair.

## Explicit Exclusions

- No listener WebRTC playback.
- No server-to-listener WebRTC media.
- No video or screen sharing.
- No transcription or translation integration.
- No TTS changes.
- No generated-audio queue or listener mixer changes.
- No recording or audio persistence.
- No SFU, MCU, HLS, managed provider, public API, plugin, billing, subscription, analytics, or auth redesign.

## Preservation Status

Preserved:

- Phase 1.
- Closed Phase 2 media ingest, microphone capture, transcription, translation, monitoring, recovery, and exports.
- Closed Phase 3 Piper TTS, generated audio delivery, listener queue, Interpretation Mode, and Replacement Mode.
- P4.0 typed signalling contracts and gateway lifecycle.
- P4.1 local broadcaster capture ownership.
- P4.2 broadcaster/listener signalling lifecycle.
- Existing HTTP APIs and unrelated Socket.IO events.

## P4.4 Readiness

P4.3 is closed at 100% for local same-machine browser validation. It proves a real Chromium browser can capture deterministic audio, attach the P4.1 stream once, negotiate through the P4.0/P4.2 Socket.IO signalling path, terminate at the backend `@roamhq/wrtc` peer, and produce decoded audio-activity evidence through the bounded bridge. P4.4 can now integrate that bridge with the existing chunking/transcription path, preserving the existing timestamp and recovery contracts.

Recommended next milestone: P4.4 WebRTC audio chunking and transcription-pipeline bridge.
