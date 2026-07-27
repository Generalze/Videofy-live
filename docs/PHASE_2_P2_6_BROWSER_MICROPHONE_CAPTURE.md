# Phase 2 P2.6 - Browser Microphone Capture

## Scope

P2.6 adds operator browser microphone capture as a live audio source for the existing media ingest, transcription, translation, monitoring and recovery pipeline.

## Implemented

- Microphone permission request and audio-input device selection in the operator upload flow.
- Browser `MediaRecorder` capture using 15-second ordered chunks.
- Microphone processing sessions with unique session and stream IDs.
- Per-session target language reuse for live capture.
- Ordered microphone chunk ingest with timestamp continuity validation.
- Duplicate active capture-session protection.
- Duplicate chunk-processing protection.
- Device disconnection reporting.
- Start, pause, resume and stop controls.
- Capture duration, active device, chunk count, current transcription, current translation, latency and errors in the operator UI.
- Microphone capture state included in media-state events and contract validation.

## Capture Format

- Browser capture uses the first supported `MediaRecorder` format from:
  - `audio/webm;codecs=opus`
  - `audio/webm`
  - `audio/ogg;codecs=opus`
- Chunks are accepted by media ingest as browser-captured audio blobs and stored with deterministic server-side filenames.

## Preservation

- Phase 1 mock operator controls and listener behavior remain available.
- P2.1 file media validation and session creation remain in place.
- P2.2 file audio extraction and chunking remain in place.
- P2.3 timestamped transcription and transcript export remain in place.
- P2.4 timestamped translation and paired export remain in place.
- P2.5 unified monitoring and recovery remain in place.
- No synthetic speech, voice cloning, multiple target languages, plugins, partner APIs, broadcasting or billing were added.

## Known Limitations

- Live microphone chunks are not server-normalized to WAV in P2.6; they are browser `MediaRecorder` blobs.
- Capture sessions remain in memory with the existing Phase 2 session store.
- Pause/resume controls pause browser capture and session progression, but already-running provider calls may finish before the pause state is reflected.
