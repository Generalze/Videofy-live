# Phase 4 P4.1 Browser Broadcaster Capture

Date: 2026-07-27

Branch: `phase-4-webrtc`

Baseline: `4be4d62 feat: close Phase 2 and Phase 3 playback pipeline` plus completed P4.0 signalling contracts.

## Status

P4.1 is implemented as browser-side broadcaster programme-audio capture preparation only.

No real WebRTC transport was added.

## Objective

P4.1 adds an operator-side local capture foundation that can request browser audio permission, enumerate audio-input devices, create one owned audio-only `MediaStream`, expose truthful state and errors, and clean up deterministically.

The captured stream remains local to the operator browser. It is not transmitted, recorded, chunked, sent to media ingest, attached to a peer connection, or played through local speakers.

## UI Location

The UI lives in `apps/operator-web` because the existing operator app is the broadcaster-facing interface.

The new panel is `Broadcaster programme audio` and sits above the existing `Media ingest` panel. Existing upload and Phase 2 browser-microphone-to-ingest workflows are preserved and remain separate.

## Capture Architecture

Core capture lifecycle is isolated in:

- `apps/operator-web/src/broadcasterCapture.ts`

The React panel is isolated in:

- `apps/operator-web/src/BroadcasterCapturePanel.tsx`

`App.tsx` owns only wiring:

- instantiate the controller;
- render the panel;
- forward button and device-selection actions;
- stop local capture on gateway signalling disconnect or app unmount.

The controller exposes a safe snapshot rather than raw browser errors or raw stream internals.

## Capture States

P4.1 states:

- `idle`
- `requesting-permission`
- `ready`
- `capturing`
- `paused`
- `stopping`
- `stopped`
- `permission-denied`
- `device-unavailable`
- `failed`

Legal behavior:

- capture cannot start before permission reaches `ready` or a previous stream reaches `stopped`;
- duplicate starts are rejected without creating another stream and without destroying the current stream;
- stop is idempotent;
- retry returns through `idle` and then `requesting-permission`;
- unexpected track end moves to `failed`;
- selected-device disappearance moves to `device-unavailable`;
- teardown stops all owned tracks.

`paused` is included in the model for compatibility with future lifecycle work, but P4.1 does not add a pause button because browser track-level pause semantics would be misleading for this local preparation milestone.

## Browser API Usage

P4.1 uses:

- `navigator.mediaDevices.getUserMedia`
- `navigator.mediaDevices.enumerateDevices`
- `devicechange` listeners where supported
- `MediaStream` and `MediaStreamTrack` cleanup APIs

P4.1 does not use:

- `RTCPeerConnection`
- SDP offer or answer generation
- ICE candidate generation
- STUN or TURN
- server-side WebRTC media termination
- listener WebRTC playback

## Media Constraints

Default constraints are explicit and audio-only:

- `video: false`
- `audio.channelCount: { ideal: 1 }`
- `audio.echoCancellation: true`
- `audio.noiseSuppression: true`
- `audio.autoGainControl: true`
- optional exact `deviceId` when selected

The defaults are a microphone speech preset suitable for initial local programme-speech capture. The browser may ignore or adjust requested settings. P4.1 does not claim a guaranteed sample rate, channel count, or processing behavior.

P4.1 intentionally does not request video permission.

## Device Selection

Device behavior:

- labels are expected to be empty before permission in some browsers;
- devices are listed after permission where `enumerateDevices` is supported;
- selected device is preserved where possible;
- missing selected devices are reported as `device-unavailable`;
- active capture does not silently switch devices;
- raw device IDs are not persisted outside browser memory.

The selector includes `Browser default input` and discovered `audioinput` devices.

## Capture And Signalling Separation

P4.1 keeps capture readiness separate from P4.0 signalling readiness.

The operator UI shows:

- local capture state;
- gateway signalling connectivity;
- whether an owned local stream exists.

The UI uses labels such as `Microphone ready`, `Capturing locally`, `Not connected`, and `Permission denied`. It does not show `Live` for local capture.

Gateway disconnect triggers local capture cleanup. Capture failure does not mutate gateway signalling registry state.

## Error Mapping

Typed capture error codes:

- `media-api-unavailable`
- `insecure-context`
- `permission-denied`
- `permission-dismissed`
- `no-audio-input-device`
- `requested-device-missing`
- `device-busy`
- `constraint-unsupported`
- `stream-creation-failure`
- `track-ended`
- `browser-capture-failure`
- `cleanup-failure`
- `duplicate-capture`

Browser exceptions are mapped safely:

- `NotAllowedError` and `PermissionDeniedError` to `permission-denied`
- `NotFoundError` to missing audio input or requested-device missing
- `NotReadableError` to `device-busy`
- `OverconstrainedError` to `constraint-unsupported`
- `AbortError` to `permission-dismissed`
- `SecurityError` to `insecure-context`

The UI shows concise error messages and does not expose raw stacks.

## Cleanup Policy

Cleanup occurs on:

- stop button;
- retry reset;
- gateway signalling disconnect;
- component unmount;
- controller disposal;
- unexpected track end.

Cleanup removes track `ended` listeners and stops every owned `MediaStreamTrack`. Repeated stop calls are safe.

No local speaker monitoring, analyser loop, audio meter, recording, upload, or transmission is created in P4.1, so there is no AudioContext or animation loop to release.

## Accessibility

The panel uses native buttons and select controls, explicit labels, `aria-label` attributes for capture actions, and `role="alert"` for errors.

State is communicated with text, not color alone.

## Security Notes

Browser capture requires a secure context. Production requires HTTPS and WSS. Localhost is normally treated as secure for development by modern browsers.

Embedded contexts may require permission-policy headers. Permission prompts and device-label behavior vary by browser.

P4.1 does not add production authorization or deployment infrastructure.

## Tests Added

Controller tests:

- initial idle state;
- browser media API unavailable;
- insecure context;
- successful permission and stream creation;
- permission denied;
- no input device;
- device busy;
- unsupported constraints;
- successful start;
- duplicate start prevention;
- stop closes tracks;
- repeated stop idempotency;
- dispose and signalling teardown cleanup;
- unexpected track-ended event;
- retry after recoverable error;
- device selection;
- selected-device removal;
- no video constraint requested;
- browser returned video tracks rejected.

UI tests:

- permission button;
- device selector after permission;
- start and stop controls;
- truthful local-capture state;
- permission-denied state;
- retry control;
- accessibility labels;
- no false `Live` status;
- explicit no-transmission wording.

The tests use mocked browser media APIs and React server rendering. They do not claim physical microphone or real browser-device coverage.

## Files Changed

- `apps/operator-web/src/broadcasterCapture.ts`
- `apps/operator-web/src/broadcasterCapture.test.ts`
- `apps/operator-web/src/BroadcasterCapturePanel.tsx`
- `apps/operator-web/src/BroadcasterCapturePanel.test.tsx`
- `apps/operator-web/src/App.tsx`
- `apps/operator-web/src/App.module.css`
- `docs/PHASE_4_WEBRTC_PLAN.md`
- `docs/PHASE_4_P4_1_BROADCASTER_CAPTURE.md`

P4.0 files remain preserved.

## Known Limitations

- No real `RTCPeerConnection` exists yet.
- No server receives or decodes broadcaster audio.
- No physical microphone/browser fake-device E2E run is claimed.
- No audio level meter was added; this is deferred because capture success does not require a meter and adding Web Audio metering would expand cleanup complexity.
- No device preference is persisted.
- No production authorization or permission-policy configuration was added.

## Explicit Exclusions

- No SDP or ICE generation.
- No STUN or TURN.
- No backend WebRTC termination.
- No listener WebRTC playback.
- No server audio-track consumption.
- No video capture.
- No screen sharing.
- No recording.
- No HLS.
- No SFU or MCU.
- No external WebRTC provider.
- No auth redesign, billing, subscriptions, analytics, or deployment work.

## Preservation Status

Preserved:

- Phase 1 behavior.
- Closed Phase 2 upload, microphone ingest, transcription, translation, monitoring, recovery, and exports.
- Closed Phase 3 TTS, generated-audio delivery, listener queue, Interpretation Mode, and Replacement Mode.
- P4.0 protocol version, signalling contracts, gateway registry, and signalling lifecycle.
- Existing Socket.IO events and HTTP APIs.
- Listener app behavior.

## Readiness For P4.2

P4.1 prepares a validated local audio-only stream and truthful operator state. P4.2 can add mocked browser `RTCPeerConnection` signalling lifecycle around this local stream, while still avoiding backend media termination and listener WebRTC playback.

Recommended next milestone: P4.2 signalling and peer lifecycle.
