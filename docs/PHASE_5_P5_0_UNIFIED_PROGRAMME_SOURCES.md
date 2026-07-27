# Phase 5 P5.0 - Unified Programme Sources

Date: 2026-07-27

Branch: `phase-5-partner-preview`

Baseline: `07592ae0d7f62caf9bcf2ce1e17db7987d8f4120`

## Scope

P5.0 makes live camera, screen or tab capture, and uploaded browser-playable video first-class programme sources. It does not add permanent video storage, recording, editing, RTMP, HLS, SFU/MCU, production TURN changes, external integrations, billing, account systems, or AI-provider replacement.

The implemented path is:

`camera / screen / uploaded video -> ProgrammeSourceManager -> broadcaster WebRTC transport -> backend media peer -> listener WebRTC transport`

The existing programme-audio path remains authoritative for transcription, translation, generated speech, Interpretation Mode, and Replacement Mode.

## Source Architecture

`apps/operator-web/src/programmeSourceManager.ts` owns source lifecycle outside React components.

Every selected source exposes a consistent snapshot:

- Source type and identity.
- Audio and video track detection.
- Readiness and playback state.
- Programme timestamp and optional duration.
- Revision number for discontinuities.
- Start, pause, resume, seek, restart, stop, clear, and teardown behavior where supported.
- Track-ended and failure reporting.

React uses `ProgrammeSourcePanel` as a thin control surface. The panel passes a muted preview element to the manager. The manager owns object URLs, media streams, preview attachment, and track cleanup.

## Supported Sources And Formats

Supported source types:

- Camera or browser capture device using `getUserMedia`.
- Screen or browser-tab capture using `getDisplayMedia`.
- Uploaded/pre-recorded video using a browser media element and `captureStream`.

Uploaded video prioritizes browser-supported MP4 and WebM. MOV is accepted only as a browser-decodable QuickTime video candidate. Validation is intentionally conservative: a familiar extension alone does not guarantee playback.

Unsupported uploaded files are rejected with a clear operator-visible error.

## Operator Controls

The operator programme-source panel supports:

- Source selection for camera, screen/tab, and uploaded video.
- Camera audio/video device selectors.
- Uploaded video file picker.
- Muted preview before broadcast.
- Track detection for audio and video.
- Start programme, pause, resume, seek, restart, stop, and clear source.
- Readiness, broadcasting, paused, ended, failed, and revision display.

Live preview is muted to prevent local speaker feedback. Uploaded video uses the media element timeline as the playback authority.

## WebRTC Video Topology

P5.0 extends the completed Phase 4 backend-terminated topology:

1. The broadcaster browser creates one peer connection to `peer_backend_media`.
2. The browser publishes exactly one programme-audio track and one optional programme-video track.
3. The gateway validates signalling through the existing typed Socket.IO contract.
4. The backend accepts one audio track and one optional video track.
5. Audio frames continue feeding transcription and listener original-audio delivery.
6. Video frames are relayed to listener peers with `RTCVideoSink` and `RTCVideoSource`.
7. Listener peers receive one original programme-audio track and one programme-video track where available.

Audio-only operation remains valid when no video is available. Missing programme audio prevents backend programme transport because the downstream speech pipeline still depends on authoritative audio.

## Listener Playback

The listener WebRTC transport now receives:

- One original programme-audio track.
- One programme-video track where available.
- Translated generated audio through the existing HTTP WAV queue.

The listener UI surfaces waiting, negotiating, audio connected, video connected, video unavailable, playback blocked, source ended, and broadcaster unavailable states.

Interpretation Mode still mixes original and translated audio. Replacement Mode still mutes original audio without stopping the media element or renegotiating video. Audio-mode switching does not renegotiate WebRTC media.

## Timeline And Synchronization

There is one programme timeline:

- Uploaded video uses the media element `currentTime` as authority.
- Live camera and screen sources use a monotonic programme-relative clock anchored when broadcasting starts.
- Pause and resume preserve elapsed programme time.
- Seek and restart create revision boundaries.
- Source switching stops the old source and creates a clean transport boundary.

The browser media element and WebRTC RTP timestamps may still have implementation-specific jitter. P5.0 documents and exposes revision changes but does not add SFU-level timestamp rewriting.

## Source Switching

The operator app supports controlled source switching by closing the backend transport, clearing the current source, releasing tracks/object URLs, and selecting the next source.

Covered switches include:

- Camera to uploaded video.
- Uploaded video to camera.
- Uploaded video A to uploaded video B.
- Active source to screen capture.

P5.0 does not mix two programme sources simultaneously.

## Failure Handling

The implementation handles:

- Permission denial.
- Missing camera, microphone, or screen media.
- Screen capture ending from browser UI.
- Unsupported or undecodable uploaded video.
- Missing audio or video track detection.
- Duplicate source selection.
- Duplicate audio/video WebRTC tracks.
- Track end and teardown.
- Object URL revocation.
- Listener autoplay blocking.

SDP, ICE, raw media, generated browser evidence, local uploads, and secrets remain excluded from committed files.

## Browser Validation

The P5.0 browser validation extends the ignored local Chrome harness pattern from Phase 4. Temporary scripts, generated media, Chrome profiles, logs, and JSON evidence are stored only under ignored `.videofy-dev-logs/`.

Closure run:

- Browser: Chrome `149.0.0.0` on Windows x64.
- Fixture: deterministic WebM, VP8 video, Opus mono audio, 320x180, 15 fps, 4.008 seconds.
- Browser media support: the same Chrome build loaded the fixture outside Videofy and reported `canPlayType` support, `loadedmetadata`, duration, and one audio plus one video `captureStream()` track.
- Operator upload flow: native Chrome file input selection through DevTools `DOM.setFileInputFiles`, object URL creation, media element `load()`, `loadedmetadata`, `loadeddata`, `canplay`, and `playing`.
- Uploaded preview evidence: `readyState=4`, `networkState=1`, `duration=4.008`, one live audio track, and one live video track.
- Controls evidence: seek to 2 seconds created a revision, restart returned the uploaded source to a startable preview revision, start published the programme, pause and resume worked without changing tracks.
- Listener evidence: one live original programme-audio track and one live programme-video track received from the uploaded source.
- Transcription evidence: media-ingest received WebRTC audio chunks and produced mock transcripts from uploaded-video audio.
- Mode evidence: Interpretation Mode and Replacement Mode toggled without renegotiating the WebRTC peer; Replacement Mode muted original audio without stopping video.
- Source-switch evidence: uploaded video switched to browser camera, the uploaded object URL was revoked, and the camera source published one live audio and one live video track.
- Cleanup evidence: Stop and Clear left no selected source, no preview tracks, and object URL counts `created=1`, `revoked=1`, `active=0`.

Root causes fixed during closure:

- The original uploaded-video browser failure was caused by validation harness behavior, not codec support: the early harness used synthetic `DataTransfer` file injection and later called `captureStream()` from diagnostic `loadstart` handlers. The closure harness now uses Chrome's native file-input path and avoids early diagnostic `captureStream()` calls.
- The listener join harness truncated UUID session IDs by excluding hyphens from the share-ID regex. The harness now preserves full `broadcast_id/wrs_uuid` identifiers.
- Uploaded-video seek/restart inferred programme state from whether the preview media element was playing. Since previews may autoplay, seek/restart now create a clean revision boundary and return to `preview-ready`.
- Backend-to-listener WebRTC delivery was advancing the broadcaster's global source-offer revision. Listener-delivery negotiation now uses its offer revision without advancing the broadcaster source revision.
- Late ICE/ICE-complete messages from a completed negotiation could fail the signalling client during source switching. The gateway now ignores stale late ICE at the gateway boundary while preserving strict validation for active offers.

The final browser validation distinguishes:

- Media-track validation: browser publishes and listener receives live audio/video tracks.
- Display or speaker quality: not claimed by automated track inspection alone.

Local runtime support was confirmed for:

- `@roamhq/wrtc` `RTCPeerConnection`.
- `RTCAudioSource` and `RTCAudioSink`.
- `RTCVideoSource` and `RTCVideoSink`.

One non-fatal gateway warning remains possible on the first browser audio frame: `WebRTC audio frame must be 16-bit PCM.` Subsequent frames were accepted and transcription completed in the closure run.

## Limitations

- No permanent uploaded-video storage.
- No recording or video editing.
- No multiple simultaneous programme sources.
- No SFU, MCU, RTMP, HLS, or external managed provider.
- No production TURN change.
- No persistent peer state or horizontal scaling.
- Browser codec support determines uploaded-video playability.
- Real speaker quality and physical display quality require manual QA beyond automated track assertions.
- Gateway restart still requires explicit session recovery, as in Phase 4.

## Readiness For Real Open-Source AI Integration

P5.0 preserves the existing audio pipeline that feeds faster-whisper transcription, Argos translation, Piper TTS, generated-audio delivery, listener queue synchronization, Interpretation Mode, and Replacement Mode. The unified source manager makes partner-preview input sources usable without changing those AI provider interfaces.

P5.0 closure status: complete.

Exact next milestone: `P5.1 OBS/capture-device partner-preview hardening`.
