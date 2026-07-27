# Phase 2 P2.1 - Media Ingest And Session Creation

## Scope

P2.1 replaces the Phase 1 mock-only media-selection foundation with local file ingest, validation, metadata extraction, and processing-session creation.

## Implemented

- Operator upload flow for local MP4, MOV, MP3, and WAV files.
- Internal media-ingest `/sessions` endpoint for multipart media submission.
- Server-side media validation with ffprobe.
- Metadata extraction for filename, file size, MIME type, duration, audio presence, video presence, and codecs when ffprobe reports them.
- Unique stream IDs and processing-session IDs.
- In-memory processing-session records.
- Approved stream lifecycle states:
  - created
  - validating
  - ready
  - processing
  - paused
  - completed
  - failed
  - cancelled
- Duplicate submission protection for active sessions.
- Operator-visible validation errors for unsupported, corrupt, duplicate, or missing-audio media.
- Gateway media-state broadcasting for accepted local-file sessions.

## Preserved From Phase 1

- Mock provider mode remains available.
- Operator mock stream and mock phrase controls remain available.
- Listener mock video playback remains available.
- Realtime gateway, language rooms, ordered translation delivery, and health status behavior remain in place.

## Explicitly Not Implemented

- Transcription.
- Translation.
- Synthetic voice generation.
- Third-party media integrations.
- Partner APIs or public APIs.
- Broadcasting, HLS, RTMP, or WebRTC.
- Persistent database-backed session storage.

## Validation

Automated coverage was added for:

- Valid video upload.
- Valid audio upload.
- Unsupported extension.
- Corrupt media.
- Missing audio.
- Session creation.
- State transitions.
- Duplicate submission protection.

## Known Limitations

- Session records are in memory and reset when media-ingest restarts.
- Uploaded files are stored on the local filesystem under the ignored `uploads/media-ingest` runtime directory.
- ffprobe must be available on the service host PATH.
- Accepted local media is validated and represented as a ready session, but no downstream transcription, translation, voice generation, or broadcast processing starts in P2.1.
