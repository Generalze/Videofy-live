# Phase 4 P4.4 WebRTC Transcription Bridge

Date: 2026-07-27

Branch: `phase-4-webrtc`

Baseline: completed Phase 1, closed Phase 2, closed Phase 3, and P4.0-P4.3.

## Status

P4.4 connects backend WebRTC audio frames to the existing transcription pipeline:

`operator browser -> backend RTCAudioSink -> PCM chunker -> media-ingest WebRTC session -> existing TranscriptionProvider -> operator transcript events`

No listener WebRTC playback, server-to-listener media, recording, raw audio logging, video, HLS, SFU, MCU, TURN deployment, new transcription vendor, translation redesign, TTS redesign, queue redesign, mixer redesign, billing, analytics, auth redesign, plugins, or public partner APIs were added.

## Architecture Decisions

- Decoded WebRTC frame metadata remains in `services/realtime-gateway/src/webrtc-audio-ingest-bridge.ts`.
- PCM validation, downmixing, resampling, ordering and chunk timing live in `services/realtime-gateway/src/webrtc-transcription-chunker.ts`.
- Media-ingest submission lives in `services/realtime-gateway/src/webrtc-transcription-bridge.ts`.
- The backend peer registry emits decoded frames through callbacks; it does not call transcription providers.
- The transcription boundary remains `services/media-ingest/src/media-session.ts` and `TranscriptionProvider`.
- WebRTC sessions use safe `wrs_...` processing IDs so transcript events preserve WebRTC session identity.
- The internal handoff is `/internal/webrtc/...` on media-ingest, with a staging-directory path check before any chunk is moved.
- WebRTC chunks are WAV, mono, 16 kHz, PCM 16-bit before provider submission.
- Default WebRTC chunk size is 5 seconds; local browser validation can set `WEBRTC_TRANSCRIPTION_CHUNK_MS=1000`.
- Final partial chunks are flushed on stop/track end/session teardown.
- WebRTC transcription stops at transcript events for this milestone; translation and TTS are not started from WebRTC chunks.

## Safety And Limits

- WebRTC session IDs, broadcast IDs and peer IDs are constrained to safe identifier characters.
- Staged chunk paths must resolve under `WEBRTC_AUDIO_CHUNK_STAGING_DIR`.
- The gateway writes only normalized WAV chunks required for transcription; raw PCM frames are not persisted or logged.
- Chunker limits cover buffered duration, queued chunks and queued bytes.
- Submission retries are bounded and failures are logged without silently falling back.
- Stop/track end/socket close flushes or stops the bridge idempotently.
- Restart revisions use separate chunker state, so stale audio cannot mix into the new revision.

## Operator Visibility

- The backend transport panel now shows transcription bridge status, chunk progress and latest transcript.
- Existing transcription panel shows queued/transcribing/transcribed/failed chunk events.
- Media state includes `webrtcTranscriptionBridge` metadata with chunk counts and last error.

## Tests Added

- `services/realtime-gateway/src/__tests__/webrtc-transcription-chunker.test.ts`
- `services/realtime-gateway/src/__tests__/webrtc-transcription-bridge.test.ts`
- WebRTC cases in `services/media-ingest/src/__tests__/media-session.test.ts`
- WebRTC schema case in `packages/media-contracts/src/__tests__/media-state-schema.test.ts`
- Operator bridge-status case in `apps/operator-web/src/BroadcasterWebRtcTransportPanel.test.tsx`

## Known Limitations

- P4.4 uses the existing mock or faster-whisper transcription provider configuration only.
- Browser validation uses the mock transcription provider unless local faster-whisper is explicitly configured.
- WebRTC chunks are handed off through a local internal HTTP route and shared staging directory.
- No listener WebRTC playback or original programme delivery is implemented in P4.4.

## Completion

P4.4 is complete when focused tests, P4.3 regressions, full workspace tests/build/typecheck/lint/audit, and real-browser validation pass.

Exact next recommended milestone: P4.5 listener delivery integration planning/implementation, preserving the P4.4 transcription bridge.
