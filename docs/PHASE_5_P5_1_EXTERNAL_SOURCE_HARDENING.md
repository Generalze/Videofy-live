# Phase 5 P5.1 - External Source Hardening

Date: 2026-07-28

Branch: `phase-5-partner-preview`

Baseline: `2ef046e3b2fd80954bc2f2e604263749b748d681`

## Scope

P5.1 hardens the P5.0 unified programme-source system for partner-preview demonstrations with webcams, capture devices, OBS Virtual Camera, screen or browser-tab capture, external meeting/video platforms through browser capture, and uploaded video.

P5.1 does not add native Zoom, Teams, Meet, YouTube, RTMP, SFU, MCU, HLS, external APIs, or platform-specific integrations.

## Supported Demonstration Setups

Supported source paths:

- Webcam or built-in camera with browser microphone.
- Professional camera or capture card exposed by the OS as a standard `videoinput`.
- OBS Virtual Camera exposed by the OS as a standard `videoinput`.
- Separate programme-audio device exposed as `audioinput`, including capture-card audio, loopback devices, and virtual audio cable devices.
- Screen, window, or browser-tab capture through `getDisplayMedia`.
- Zoom, Teams, Meet, YouTube, and similar platforms through screen/tab capture, OBS, or capture devices.
- Uploaded browser-playable video from P5.0.

The browser path remains intentionally generic: if the source appears to Chrome as a normal camera, microphone, display, or uploaded media element, Videofy can use it without a native partner integration.

## Source Selection

The operator source panel now keeps pending video and audio device choices independently from the active source snapshot. This supports selecting, for example:

- Video: `OBS Virtual Camera`
- Audio: `VB-Audio Virtual Cable`

After the operator selects a camera source, the active snapshot stores the selected device IDs and resolved labels. A selected OBS camera is treated as a normal camera source with an OBS diagnostic flag. Capture-card and virtual-audio labels are surfaced as capture-device candidates without changing WebRTC topology.

## Diagnostics

The programme source snapshot now reports:

- Video source label.
- Audio source label.
- Audio and video track IDs.
- Audio and video track state.
- Video width and height where available.
- Frame rate where available.
- Audio-present or missing status.
- Missing-audio reason.
- Source-ended state.
- Capture-interrupted state.
- Browser limitation notes.
- OBS Virtual Camera detection.
- Capture-device candidate detection.

The operator UI shows these fields directly in the programme-source panel. Missing screen audio is reported as a browser or platform limitation rather than being treated as silent audio.

## Screen And Browser-Tab Capture

Screen capture requires video. Audio remains optional because browser and platform support differs:

- Chrome tab capture may provide tab audio when the user enables audio sharing.
- Window or full-screen capture may provide no audio depending on OS/browser support.
- Meeting platforms may block or omit audio from screen capture.

When no screen audio track is present, Videofy keeps the preview truthful and reports that no programme audio is available for transcription. Backend programme transport still requires exactly one live audio track because transcription and original-audio listener delivery depend on authoritative programme audio.

If the user stops screen sharing through browser UI, track-ended handling marks the source ended, records capture interruption, and creates a revision boundary.

## Device Removal And Cleanup

The operator app listens for browser `devicechange` events and refreshes source devices through the programme source manager. If a specifically selected video or audio device disappears while active, the source is marked ended/interrupted with a clear operator-visible error and a revision boundary.

Source switching preserves P5.0 cleanup behavior:

- Backend transport is closed before source replacement.
- Tracks from the previous source are stopped.
- Uploaded-video object URLs are revoked.
- Preview media is detached when clearing or switching.
- Duplicate active source selection is rejected.
- Only one live audio track and at most one live video track are accepted for backend WebRTC publishing.

## PCM First-Frame Handling

Root cause:

Some browser/WebRTC runtime combinations can report stale or misleading `bitsPerSample` metadata on an initial decoded audio frame even though later frames are valid for transcription. In P5.0 this surfaced as the non-fatal warning `WebRTC audio frame must be 16-bit PCM`.

Resolution:

- The transcription normalizer now accepts and normalizes real `Int16Array` PCM samples even when the runtime reports a 32-bit first-frame metadata mismatch.
- Runtime `Float32Array` frames are converted to mono 16 kHz PCM16 through the existing normalization path.
- Unsupported formats such as 24-bit metadata remain rejected.
- The WebRTC transcription bridge now skips malformed individual frames, marks the next chunk as a discontinuity, and records skipped-frame diagnostics without throwing back into the WebRTC peer path.

This containment ensures a bad first frame cannot interrupt later transcription.

## Browser Validation Evidence

Real-browser evidence remains stored only under ignored `.videofy-dev-logs/`.

Validated in Chrome on the development machine:

- Uploaded video path remains playable and deliverable from P5.0.
- Generic camera path works through browser `getUserMedia`.
- Separate video/audio source selection is covered by deterministic device-selection tests and browser fake-device validation.
- Screen/tab capture selected successfully through Chrome fake screen sharing; the harness reported video and audio tracks, `1920x1200`, and `30 fps`.
- Screen/tab capture semantics are represented truthfully in code and tests: video is required and audio is optional.
- Listener WebRTC delivery still receives one audio and one video track when the selected programme source provides both.
- Transcription continues from live programme audio.
- Interpretation Mode and Replacement Mode remain UI-level listener modes and do not renegotiate WebRTC media.
- Stop, clear, source switch, and source-ended paths clean resources and preserve revision boundaries.
- The P5.1 real-browser gateway log had no `WebRTC audio frame must be 16-bit PCM` warning and no unexpected warn/error/failure entries.

Physical-device follow-up still required on hardware that was not present on the development machine:

- OBS Virtual Camera installed as an OS camera device.
- Capture-card video device.
- Capture-card or loopback programme-audio device.
- Meeting-platform tab/window capture with and without browser-provided audio.

Where these devices are unavailable, P5.1 validates the generic browser device path and documents the physical confirmation requirement honestly.

## Tests

Focused tests cover:

- Camera source selection with separate audio and video devices.
- OBS-style camera detection.
- Virtual-audio/capture-device candidate detection.
- Screen capture with missing audio.
- Screen-share track end.
- Selected-device disappearance.
- Uploaded-video cleanup before switching to a live source.
- PCM16 normalization.
- Float32 frame conversion.
- 32-bit first-frame metadata tolerance.
- Unsupported 24-bit frame rejection.
- Skipped-frame recovery without interrupting transcription.

P5.0 and Phase 4 WebRTC regression tests remain part of the validation suite.

## Limitations

- No native Zoom, Teams, Meet, YouTube, RTMP, SFU, MCU, or external platform API integration.
- Browser and OS policy determine whether screen or tab audio is available.
- Device labels may remain generic until the browser grants capture permission.
- OBS and capture-card detection is label-based because browsers expose them as generic media devices.
- Backend programme transport still requires one live programme-audio track.
- Physical OBS/capture-card validation must be repeated on partner-demo hardware with those devices installed.
- No production TURN, persistent peer state, or horizontal scaling changes in P5.1.

## Preservation

P5.1 preserves:

- Uploaded-video playback.
- WebRTC audio/video delivery.
- Transcription.
- Translation.
- TTS.
- Interpretation Mode.
- Replacement Mode.
- Source revisions.
- Stale-result rejection.
- Cleanup behavior.
- Phase 1 through P5.0 behavior.

Validation completed:

- Focused P5.1 source-manager and PCM tests passed.
- P5.0 and Phase 4 WebRTC regressions passed.
- Real Chrome P5.1 browser harness passed.
- `npm test` passed.
- `npm run build` passed.
- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm audit --omit=dev` passed with 0 vulnerabilities.

P5.1 completion status: complete.

Exact next milestone: `P5.2 meeting-platform operator runbooks through browser or screen capture`.
